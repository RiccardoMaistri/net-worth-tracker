/**
 * OKX read-only POC — POST /api/broker/okx/poc.
 *
 * Reads the trading account, the funding account and the open positions of ONE OKX account (the
 * server's key), and answers the coins merged per currency with OKX's own spot P&L, plus the
 * derivatives in their own section. No credential crosses this route: the key lives in the server
 * environment (`lib/server/okxClient.ts`).
 *
 * Body: { ownerId: string }
 * Answer: { portfolio, meta: { baseUrl, demo, usdEur, fetchedAt } }
 *
 * WHY `ownerId` EXISTS even though nothing is written: the route is a read of the DEPLOY OWNER's
 * account, and a shared account must not hand that read to a viewer who merely has a session.
 * Owner-scoped like every broker route.
 *
 * A wallet that could not be read comes back as a WARNING, never as an empty wallet: a quantity
 * that is silently short would read as a drift against the Registro.
 */

export const runtime = 'nodejs';

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
    console.error('[okx/poc] USD→EUR rate unavailable', error);
    return null;
  }
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
      funding: raw.funding === null ? [] : parseOkxFundingBalances(raw.funding),
      positions: raw.positions === null ? [] : parseOkxPositions(raw.positions),
      tickers: raw.tickers.length === 0 ? {} : parseOkxTickers(raw.tickers),
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
    console.error('[okx/poc] unexpected failure', error);
    return NextResponse.json({ error: 'Lettura non riuscita: riprova.' }, { status: 500 });
  }
}
