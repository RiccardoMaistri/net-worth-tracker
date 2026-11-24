import { NextRequest, NextResponse } from 'next/server';
import { getApiAuthErrorResponse, requireFirebaseAuth } from '@/lib/server/apiAuth';
import {
  fetchAndBuildInflationIndex,
  isInflationCacheStale,
  readInflationIndexFromFirestore,
  writeInflationIndexToFirestore,
} from '@/lib/server/inflationService';
import { resolveLatestInflationMonth } from '@/lib/utils/inflation';
import type { InflationIndexResponse, InflationMonthlyIndex } from '@/types/benchmarks';

function toResponse(
  monthlyIndex: InflationMonthlyIndex[],
  cachedAt: Date,
  stale: boolean,
): InflationIndexResponse {
  return {
    monthlyIndex,
    latestMonth: resolveLatestInflationMonth(monthlyIndex),
    cachedAt: cachedAt.toISOString(),
    stale,
  };
}

/**
 * GET /api/benchmarks/inflation
 *
 * The HICP Italy monthly index (all items, 2015 = 100) from FRED series CP0000ITM086NEST,
 * cached in the shared `inflation-cache/hicp-it` document (Admin SDK only, TTL 7 days).
 *
 * Degradation: FRED failure (or a missing key) with a cache → the older data, flagged
 *              `stale: true`; without any cache → 503. A month Eurostat has not published is
 *              absent from the series — never carried forward.
 *
 * Auth: any authenticated user. No owner: the index is a public macro figure.
 */
export async function GET(request: NextRequest) {
  try {
    await requireFirebaseAuth(request);

    const cached = await readInflationIndexFromFirestore();

    if (cached && !isInflationCacheStale(cached.cachedAt)) {
      return NextResponse.json(toResponse(cached.monthlyIndex, cached.cachedAt, false));
    }

    if (!process.env.FRED_API_KEY) {
      if (cached) {
        return NextResponse.json(toResponse(cached.monthlyIndex, cached.cachedAt, true));
      }
      return NextResponse.json({ error: 'Inflation index unavailable' }, { status: 503 });
    }

    let monthlyIndex: InflationMonthlyIndex[];
    try {
      monthlyIndex = await fetchAndBuildInflationIndex();
    } catch (fredError) {
      console.error('[inflation] FRED fetch failed:', fredError);
      if (cached) {
        return NextResponse.json(toResponse(cached.monthlyIndex, cached.cachedAt, true));
      }
      return NextResponse.json({ error: 'Inflation index unavailable' }, { status: 503 });
    }

    // The write is a cache, not part of the answer: don't block the response on it.
    writeInflationIndexToFirestore(monthlyIndex).catch((err: unknown) => {
      console.error('[inflation] Failed to write cache:', err);
    });

    return NextResponse.json(toResponse(monthlyIndex, new Date(), false));
  } catch (error) {
    const authError = getApiAuthErrorResponse(error);
    if (authError) return authError;
    console.error('[inflation] Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
