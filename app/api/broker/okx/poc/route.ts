/**
 * OKX read-only POC — POST /api/broker/okx/poc.
 *
 * Reads the trading account, the funding account, Simple Earn, the active On-chain Earn orders
 * and the open positions of ONE OKX account (the server's key), and answers ONE row per coin —
 * trading + funding + savings + earn merged, with OKX's own spot P&L — plus the derivatives in
 * their own section. No credential crosses this route: the key lives in the server environment
 * (`lib/server/okxClient.ts`).
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
import { adminDb } from '@/lib/firebase/admin';

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
import {
  buildOkxPortfolio,
  OkxPortfolio,
  OkxParseError,
  parseOkxBalance,
  parseOkxFundingBalances,
  parseOkxPositions,
  parseOkxSavingsBalances,
  parseOkxStakingOrders,
  parseOkxTickers,
} from '@/lib/utils/okxPortfolio';
import { getExchangeRateToEur } from '@/lib/services/currencyConversionService';
import { createAsset, updateAsset } from '@/lib/services/assetService';

const ASSETS_COLLECTION = 'assets';

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

/** A wallet whose read failed comes back empty here: the client already named it in `warnings`. */
function rows(value: unknown[] | null | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Check if a payload record has an `ordId` field (used as a fallback instrument identifier). */
function hasOrdId(record: unknown): record is Record<string, unknown> {
  return (
    typeof record === 'object' &&
    record !== null &&
    !Array.isArray(record) &&
    'ordId' in record
  );
}

/**
 * Persist OKX-synced assets into the owner's Firestore `assets` collection.
 * Each coin from the balance/funding/savings/staking becomes an asset with
 * `okxInstrumentId` set to the OKX instrument identifier, so the app can track
 * the source and later read the linkage.
 */
async function persistOkxAssets(
  userId: string,
  portfolio: OkxPortfolio,
  raw: Awaited<ReturnType<typeof readOkxAccount>>,
  usdEur: number | null
): Promise<void> {
  const now = new Date();
  const assetsRef = adminDb.collection(ASSETS_COLLECTION);

  // Build a map: OKX ticker (ccy) → instrument identifier (instId or ordId fallback)
  const instrumentMap: Record<string, string> = {};

  // Collect instrument IDs from positions (these have instId)
  for (const pos of portfolio.positions) {
    if (pos.instId) {
      instrumentMap[pos.instId] = pos.instId;
    }
  }

  // Process balance details: each currency becomes an asset
  // raw.balance is unknown[]; each element may have a 'details' sub-array for per-currency data
  const balanceArray: unknown[] = typeof raw.balance === 'object' && raw.balance !== null && Array.isArray(raw.balance)
    ? raw.balance
    : [];

  for (const detail of portfolio.holdings) {
    const ccy = detail.ccy;
    // Determine the OKX instrument identifier for this coin
    let okxInstId = ccy; // fallback: use ccy itself
    // Look for a matching entry in the balance array by ccy
    for (const balanceRow of balanceArray) {
      if (
        typeof balanceRow === 'object' && balanceRow !== null &&
        typeof (balanceRow as Record<string, unknown>).ccy === 'string' &&
        (balanceRow as Record<string, unknown>).ccy === ccy
      ) {
        // This row may have a nested 'details' array with more granular data
        const rowDetails = (balanceRow as Record<string, unknown>).details;
        if (Array.isArray(rowDetails)) {
          for (const rawDetail of rowDetails) {
            if (
              typeof rawDetail === 'object' && rawDetail !== null &&
              typeof (rawDetail as Record<string, unknown>).ccy === 'string' &&
              (rawDetail as Record<string, unknown>).ccy === ccy &&
              'ordId' in rawDetail
            ) {
              okxInstId = String((rawDetail as Record<string, unknown>).ordId);
              break;
            }
          }
        }
        break;
      }
    }
    instrumentMap[ccy] = okxInstId;

    // Check if an asset with this ticker already exists for this user
    // Use Admin SDK pattern: collection().where().get()
    const assetSnapshot = await adminDb
      .collection(ASSETS_COLLECTION)
      .where('userId', '==', userId)
      .where('ticker', '==', ccy)
      .get();

    const existingAssetDoc = assetSnapshot.docs[0];

    // Build asset data without server-side fields (createAsset adds lastPriceUpdate, createdAt, updatedAt)
    const assetData: import('@/types/assets').AssetFormData = {
      ticker: ccy,
      name: ccy,
      type: 'crypto' as const,
      assetClass: 'crypto',
      currency: 'EUR',
      quantity: detail.quantity ?? 0,
      currentPrice: detail.priceUsd ?? 0,
      // okxInstrumentId is the new linkage field added to Asset interface
      okxInstrumentId: okxInstId,
    };

    if (existingAssetDoc.exists) {
      // Update existing asset with the linkage
      await updateAsset(existingAssetDoc.id, assetData);
    } else {
      // Create new asset - createAsset will add lastPriceUpdate, createdAt, updatedAt internally
      await createAsset(userId, assetData);
    }
  }

  // Funding balances are already represented in portfolio.holdings via the merge logic,
  // so no separate loop is needed here.
  // Note: query invalidation is handled by the React Query cache on the client side
  // when the assets fetch key changes; the server-side write does not need to
  // explicitly invalidate here because the route response already carries the fresh portfolio.
}

/** POST /api/broker/okx/poc */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const timing = startTiming();

  let decoded;
  try {
    decoded = await requireFirebaseAuth(request);
  } catch (error) {
    return getApiAuthErrorResponse(error) ?? NextResponse.json({ error: 'Non autenticato.' }, { status: 401 });
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

    // ─── Persist OKX-synced assets with linkage ──────────────────────────────────────
    // Only write when the owner matches the authenticated user (ownerId is the deploy owner).
    // Each OKX coin becomes an asset with okxInstrumentId set so the app can track the source.
    if (validated.data.ownerId === decoded.uid) {
      await persistOkxAssets(decoded.uid, portfolio, raw, usdEur);
    }
    // If ownerId differs from decoded.uid, the route is being called for a shared account:
    // we do not write to that account's assets (shared-account safety).

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
    // error is typed as `unknown` by the catch clause; narrow before using it
    const errorMessage =
      error instanceof Error ? error.message : 'Lettura non riuscita: riprova.';
    console.error('[okx/poc] unexpected failure', error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}