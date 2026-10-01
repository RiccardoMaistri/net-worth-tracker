/**
 * Trade Republic read-only proxy — POST /api/broker/traderepublic/read.
 *
 * Runs ONE of the three whitelisted topic reads and returns the parsed payload. Owner-scoped:
 * the caller must own the account or hold a grant over it. No credential crosses this route — the
 * session cookie lives in `brokerSessions/{ownerId}`, written and read through the Admin SDK only.
 *
 * Body: { ownerId: string, command: 'positions' | 'cash' | 'savingsPlans' }
 *
 * Each command answers under its OWN key (`{ positions, skipped }` · `{ cash, skipped }` ·
 * `{ savingsPlans }`); the client composes the plan from the three. Never a `plan` — see the
 * postmortem in `__tests__/scalableReadRoute.test.ts` and the comment in `readTradeRepublic`.
 *
 * `savingsPlans` is a SEPARATE read on purpose: it needs the securities account number, and a
 * failure there must not cost the user their positions and cash the way a failed third read in a
 * `Promise.all` silently would.
 */

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  assertCanAccessAccount,
  getApiAuthErrorResponse,
  requireFirebaseAuth,
} from '@/lib/server/apiAuth';
import { parseOr400 } from '@/lib/server/validation';
import { getMultipleQuotes } from '@/lib/services/yahooFinanceService';
import {
  readTradeRepublic,
  readTrTickerQuotes,
  TradeRepublicAuthError,
  TradeRepublicReadError,
  TR_READ_COMMANDS,
} from '@/lib/server/tradeRepublicClient';
import {
  parseTrCash,
  parseTrHoldings,
  parseTrSavingsPlans,
  resolveTrYahooTicker,
  TrParseError,
  type TrHoldingInput,
} from '@/lib/utils/tradeRepublicImport';

const bodySchema = z.object({
  ownerId: z.string().min(1),
  command: z.enum(TR_READ_COMMANDS),
});

/**
 * Fill each position's price, three sources in order — and record the Yahoo symbol used.
 *
 * 1. **The broker's own ticker topic** (`readTrTickerQuotes`): authoritative, EUR, per ISIN.
 *    This is what prices stocks and ETFs the payload reports without a quote.
 * 2. **Yahoo, via the resolved symbol** (`resolveTrYahooTicker`) — the curated table and the
 *    crypto derivation. Quoted is the SYMBOL, never the raw ISIN: Yahoo answers no price for
 *    a bare ISIN (measured), so quoting `holding.isin` priced nothing and every synced
 *    position entered at 0 with a G/P of −100%. Anything without a resolved symbol keeps the
 *    preview's manual ticker field: removed the OpenFIGI layer as overkill (a third-party
 *    dependency to automate a per-new-buy typing), the field covers it.
 *
 * A price is attached ONLY in EUR: a foreign-currency quote under the EUR holding currency
 * would read as euros until the first refresh repaired it. Whatever symbol produced a price
 * (or simply resolved) travels on `holding.yahooTicker`, so the created asset's ticker keeps
 * working on every later refresh.
 *
 * Trade Republic publishes NO quote with a position, and `AssetFormData.currentPrice` is required —
 * so without this a synced portfolio would be created at 0 and the user's net worth would drop by
 * the value of everything they own until the next price run.
 *
 * FAILURE IS NOT FATAL AND NOT SILENT: a quote that cannot be fetched leaves `price` absent, and
 * `buildTrImportPlan` turns that into a warning naming the position. A broker sync that fetched
 * positions must not be lost because one ticker is not on Yahoo (an offshore bond, a private
 * company, an unmapped coin).
 */
async function withQuotes(ownerId: string, holdings: TrHoldingInput[]): Promise<TrHoldingInput[]> {
  if (holdings.length === 0) return holdings;
  const trQuotes = await readTrTickerQuotes(
    ownerId,
    holdings.map((holding) => holding.isin)
  );
  const toQuote = holdings
    .filter((holding) => !trQuotes.has(holding.isin))
    .map((holding) => resolveTrYahooTicker(holding) ?? holding.isin);
  const quotes = await getMultipleQuotes(toQuote);
  return holdings.map((holding) => {
    const brokerPrice = trQuotes.get(holding.isin)?.price;
    if (brokerPrice !== undefined) return { ...holding, price: brokerPrice };
    const symbol = resolveTrYahooTicker(holding) ?? holding.isin;
    const quote = quotes.get(symbol);
    const yahooTicker = symbol !== holding.isin ? symbol : undefined;
    // EUR only: a GBp quote under the EUR holding currency would read ~100x until the first
    // refresh normalized it. An LSE-only instrument keeps its (correct) ticker and prices on
    // refresh, which does normalize.
    if (quote?.price !== null && quote?.price !== undefined && quote.price > 0 && quote.currency === 'EUR') {
      return { ...holding, price: quote.price, ...(yahooTicker ? { yahooTicker } : {}) };
    }
    return yahooTicker ? { ...holding, yahooTicker } : holding;
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let decoded;
  try {
    decoded = await requireFirebaseAuth(request);
  } catch (error) {
    return getApiAuthErrorResponse(error) ?? NextResponse.json({ error: 'Non autenticato.' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const validated = parseOr400(bodySchema, body);
  if (!validated.ok) return validated.response;

  try {
    await assertCanAccessAccount(decoded, validated.data.ownerId);
  } catch (error) {
    return (
      getApiAuthErrorResponse(error) ??
      NextResponse.json({ error: 'Accesso negato.' }, { status: 403 })
    );
  }

  const { ownerId, command } = validated.data;
  try {
    const payload = await readTradeRepublic(ownerId, command);
    if (command === 'positions') {
      const { holdings, skipped } = parseTrHoldings(payload);
      return NextResponse.json({ positions: await withQuotes(ownerId, holdings), skipped });
    }
    if (command === 'cash') {
      const { balances, skipped } = parseTrCash(payload);
      // `balances` is a LIST: several EUR cash accounts are several accounts, never one figure
      // (the same lesson as the Scalable deposit). The plan tracks the first and declares the rest.
      return NextResponse.json({ balances, skipped });
    }
    return NextResponse.json({ savingsPlans: parseTrSavingsPlans(payload) });
  } catch (error) {
    if (error instanceof TradeRepublicAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof TrParseError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    if (error instanceof TradeRepublicReadError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error('[traderepublic/read] unexpected failure', error);
    return NextResponse.json({ error: 'Lettura non riuscita: riprova.' }, { status: 500 });
  }
}
