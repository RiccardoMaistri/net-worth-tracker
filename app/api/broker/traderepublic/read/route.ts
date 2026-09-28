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
  TradeRepublicAuthError,
  TradeRepublicReadError,
  TR_READ_COMMANDS,
} from '@/lib/server/tradeRepublicClient';
import {
  parseTrCash,
  parseTrHoldings,
  parseTrSavingsPlans,
  TrParseError,
  type TrHoldingInput,
} from '@/lib/utils/tradeRepublicImport';

const bodySchema = z.object({
  ownerId: z.string().min(1),
  command: z.enum(TR_READ_COMMANDS),
});

/**
 * Fill each position's price from the ordinary Yahoo service, keyed by ISIN.
 *
 * Trade Republic publishes NO quote with a position, and `AssetFormData.currentPrice` is required —
 * so without this a synced portfolio would be created at 0 and the user's net worth would drop by
 * the value of everything they own until the next price run. The same service prices these assets
 * on every later refresh, so creation and refresh read one source.
 *
 * FAILURE IS NOT FATAL AND NOT SILENT: a quote that cannot be fetched leaves `price` absent, and
 * `buildTrImportPlan` turns that into a warning naming the position. A broker sync that fetched
 * positions must not be lost because one ticker is not on Yahoo (an offshore bond, a crypto).
 */
async function withQuotes(holdings: TrHoldingInput[]): Promise<TrHoldingInput[]> {
  if (holdings.length === 0) return holdings;
  const quotes = await getMultipleQuotes(holdings.map((holding) => holding.isin));
  return holdings.map((holding) => {
    const price = quotes.get(holding.isin)?.price;
    return price !== null && price !== undefined && price > 0 ? { ...holding, price } : holding;
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
      return NextResponse.json({ positions: await withQuotes(holdings), skipped });
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
