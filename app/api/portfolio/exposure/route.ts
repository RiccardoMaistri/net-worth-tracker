import { NextRequest, NextResponse } from 'next/server';
import { getApiAuthErrorResponse, requireFirebaseAuth } from '@/lib/server/apiAuth';
import { getUserAssetsAdmin } from '@/lib/server/assetAdminRepository';
import { buildExposureCacheKey, computePortfolioExposure } from '@/lib/server/portfolioExposureService';
import { adminDb } from '@/lib/firebase/admin';
import { Timestamp } from 'firebase-admin/firestore';
import { PortfolioExposureData, PortfolioExposureResponse } from '@/types/exposure';

const EXPOSURE_CACHE_COLLECTION = 'exposure-cache';
// Cache ETF holdings for 24h — fund compositions change rarely (typically monthly).
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * GET /api/portfolio/exposure
 *
 * Returns a breakdown of the user's portfolio exposure by:
 * - Top company holdings (cross-ETF aggregated, direct stocks at 100%)
 * - Sector weights, and geographic macro-regions (from Yahoo Finance topHoldings)
 *
 * Data is computed server-side from Yahoo Finance quoteSummary and cached
 * in Firestore `exposure-cache/{userId}` for 24h (Admin SDK write only).
 *
 * The cache key encodes the ETF and stock composition, the total portfolio value and every
 * asset's declared geographic area, so it auto-invalidates when the user adds/removes ETFs, makes
 * significant trades, or changes an area on an asset.
 *
 * Auth: authenticated user — returns only their own exposure data.
 */
export async function GET(request: NextRequest) {
  try {
    const decodedToken = await requireFirebaseAuth(request);
    const userId = decodedToken.uid;

    // Force refresh bypasses the Firestore cache read but still writes the
    // recomputed result back. Used by the "Aggiorna" button in the UI when the
    // user explicitly wants fresh data even though the portfolio composition
    // hasn't changed.
    const forceRefresh = request.nextUrl.searchParams.get('force') === 'true';

    const assets = await getUserAssetsAdmin(userId);

    // The expected cache key, built by the SAME function the service stamps into the document.
    // It used to be re-derived here — with its own value arithmetic and a shorter key — so the two
    // could never be equal and the cache below never hit. See `buildExposureCacheKey`.
    const expectedCacheKey = buildExposureCacheKey(assets);

    // Attempt to serve from cache (skipped on force refresh)
    if (!forceRefresh) {
      const cacheRef = adminDb.collection(EXPOSURE_CACHE_COLLECTION).doc(userId);
      const cacheSnap = await cacheRef.get();

      if (cacheSnap.exists) {
        const cached = cacheSnap.data()!;
        const cachedAt: Timestamp = cached.cachedAt;
        const ageMs = Date.now() - cachedAt.toMillis();

        // A payload field that arrived after the first cached documents is a MISS, not a partial
        // hit: `etfHoldings`/`directStocks` would starve the Sovrapposizioni tile, and `regions`
        // would show the Aree geografiche view empty for a day with no way to tell it from a real
        // answer. One recompute after the deploy, then the cache works.
        if (
          ageMs < CACHE_TTL_MS &&
          cached.cacheKey === expectedCacheKey &&
          cached.exposure?.etfHoldings != null &&
          cached.exposure?.regions != null
        ) {
          const response: PortfolioExposureResponse = {
            exposure: cached.exposure as PortfolioExposureData,
            cached: true,
          };
          return NextResponse.json(response);
        }
      }
    }

    // Cache miss, stale, or force refresh — recompute from Yahoo Finance
    const exposure = await computePortfolioExposure(assets);

    // Persist to Firestore (fire-and-forget — cache failure must never break the response)
    adminDb.collection(EXPOSURE_CACHE_COLLECTION).doc(userId).set({
      cachedAt: Timestamp.now(),
      cacheKey: exposure.cacheKey,
      exposure,
    }).catch((err: unknown) => {
      console.error('[exposure] Failed to write cache for', userId, err);
    });

    const response: PortfolioExposureResponse = { exposure, cached: false };
    return NextResponse.json(response);

  } catch (error) {
    const authError = getApiAuthErrorResponse(error);
    if (authError) return authError;

    console.error('[exposure] Error computing portfolio exposure:', error);
    return NextResponse.json(
      { error: 'Failed to compute portfolio exposure' },
      { status: 500 }
    );
  }
}
