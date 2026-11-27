/**
 * OKX bridge tile — read-only read endpoint for the Collegamenti tile.
 *
 * Maps the POC output for the bridge tile: reads the trading account, funding,
 * Simple Earn, and active On-chain Earn orders, and answers ONE row per coin —
 * trading + funding + savings + earn merged, with OKX's own spot P&L.
 *
 * Body: { ownerId: string }
 * Answer: { portfolio, meta: { baseUrl, demo, usdEur, fetchedAt } }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  assertCanAccessAccount,
  getApiAuthErrorResponse,
  requireFirebaseAuth,
} from '@/lib/server/apiAuth';
import { startTiming } from '@/lib/server/serverTiming';
import { parseOr400 } from '@/lib/server/validation';
import {
  isOkxConfigured,
  isOkxDemo,
  okxBaseUrl,
  OkxConfigError,
  OkxReadError,
  readOkxAccount,
} from '@/lib/server/okxClient';
import { canUseOkx } from '@/lib/utils/okxAccess';
import {
  buildOkxPortfolio,
  OkxParseError,
  parseOkxBalance,
  parseOkxFundingBalances,
  parseOkxPositions,
  parseOkxSavingsBalances,
  parseOkxStakingOrders,
  parseOkxTickers,
} from '@/lib/utils/okxPortfolio';
import { getExchangeRateToEur } from '@/lib/services/currencyConversionService';

const bodySchema = z.object({ ownerId: z.string().min(1) });

/** EUR per USD, or `null` with the reason: an estimated FX rate must never paint a euro figure. */
async function readUsdEur(): Promise<number | null> {
  try {
    const rate = await getExchangeRateToEur('USD');
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch (error) {
    console.error('[okx/read] USD→EUR rate unavailable', error);
    return null;
  }
}

/** A wallet whose read failed comes back empty here: the client already named it in `warnings`. */
function rows(value: unknown[] | null | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const timing = startTiming();

  let decoded;
  try {
    decoded = await requireFirebaseAuth(request);
  } catch (error) {
    return getApiAuthErrorResponse(error) ?? NextResponse.json({ error: 'Non autenticato.' }, { status: 401 });
  }

  if (!canUseOkx(decoded.email)) {
    return NextResponse.json({ error: 'Accesso negato.' }, { status: 403 });
  }
  timing.mark('auth');

  const body: unknown = await request.json().catch(() => null);
  const validated = parseOr400(bodySchema, body);
  if (!validated.ok) return validated.response;

  try {
    await assertCanAccessAccount(decoded, validated.data.ownerId);
  } catch (error) {
    return getApiAuthErrorResponse(error) ?? NextResponse.json({ error: 'Accesso negato.' }, { status: 403 });
  }

  if (!isOkxConfigured()) {
    return NextResponse.json({ error: new OkxConfigError().message }, { status: 503 });
  }

  try {
    const [raw, usdEur] = await Promise.all([readOkxAccount(), readUsdEur()]);
    timing.mark('read');

    const portfolio = buildOkxPortfolio({
      balance: parseOkxBalance(raw.balance),
      funding: parseOkxFundingBalances(rows(raw.funding)),
      savings: parseOkxSavingsBalances(rows(raw.savings)),
      staking: parseOkxStakingOrders(rows(raw.staking)),
      positions: parseOkxPositions(rows(raw.positions)),
      tickers: parseOkxTickers(rows(raw.tickers)),
      usdEur,
    });
    const warnings = [...raw.warnings, ...portfolio.warnings];

    timing.mark('compute');
    return NextResponse.json(
      {
        portfolio: { ...portfolio, warnings },
        meta: {
          baseUrl: okxBaseUrl(),
          demo: isOkxDemo(),
          usdEur,
          fetchedAt: new Date().toISOString(),
        },
      },
      { headers: { 'Server-Timing': timing.toHeader({ source: 'okx' }) } }
    );
  } catch (error) {
    if (error instanceof OkxConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof OkxReadError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status === 401 ? 401 : error.status === 429 ? 429 : 502 }
      );
    }
    if (error instanceof OkxParseError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error('[okx/read] unexpected failure', error);
    return NextResponse.json({ error: 'Lettura non riuscita: riprova.' }, { status: 500 });
  }
}