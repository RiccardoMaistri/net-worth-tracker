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
import { canUseOkx } from '@/lib/utils/okxAccess';
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
} from '@/lib/utils/okxImport';
import { createAsset, updateAsset } from '@/lib/services/assetService';
import { getExchangeRateToEur } from '@/lib/services/currencyConversionService';

const ASSETS_COLLECTION = 'assets';

const bodySchema = z.object({ ownerId: z.string().min(1) });

/** Persist OKX-synced assets into the owner's Firestore `assets` collection.
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
  // raw.balance is unknown[] from the OKX client; guard before accessing .details
  const rawBalance = raw.balance;
  const rawDetails = typeof rawBalance === 'object' && rawBalance !== null && 'details' in rawBalance
    ? (rawBalance as Record<string, unknown>).details
    : [];
  const detailsArray: Array<Record<string, unknown>> = (
    typeof rawDetails === 'object' && rawDetails !== null && Array.isArray(rawDetails)
      ? rawDetails
      : []
  );

  for (const detail of portfolio.holdings) {
    const ccy = detail.ccy;
    // Determine the OKX instrument identifier for this coin
    let okxInstId = ccy; // fallback: use ccy itself
    // Look for a matching entry in the balance array by ccy
    for (const balanceRow of detailsArray) {
      if (
        typeof balanceRow === 'object' && balanceRow !== null &&
        'ccy' in balanceRow && typeof (balanceRow as Record<string, unknown>).ccy === 'string' &&
        (balanceRow as Record<string, unknown>).ccy === ccy
      ) {
        // This row may have a nested 'details' array with more granular data
        const rowDetails = (balanceRow as Record<string, unknown>).details;
        if (Array.isArray(rowDetails)) {
          for (const rawDetail of rowDetails) {
            if (
              typeof rawDetail === 'object' && rawDetail !== null &&
              'ccy' in rawDetail && typeof (rawDetail as Record<string, unknown>).ccy === 'string' &&
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
}

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
    const err = error as OkxReadError | Error;
    if (err instanceof OkxReadError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status === 401 ? 401 : err.status === 429 ? 429 : 502 }
      );
    }
    if ((err as Error).message.includes('Parse Error') || (err as Error).message.includes('parse error')) {
      return NextResponse.json({ error: (err as Error).message }, { status: 502 });
    }
    console.error('[okx/read] unexpected failure', error);
    return NextResponse.json({ error: 'Lettura non riuscita: riprova.' }, { status: 500 });
  }
}