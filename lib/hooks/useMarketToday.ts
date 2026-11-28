'use client';

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/queryKeys';
import { MARKET_TODAY_CLIENT_STALE_TIME_MS } from '@/lib/constants/marketToday';
import { authenticatedFetch } from '@/lib/utils/authFetch';
import type { MarketTodayResponse } from '@/types/market';

async function fetchMarketToday(): Promise<MarketTodayResponse> {
  const response = await authenticatedFetch('/api/market/today');
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? 'Impossibile leggere il mercato di oggi');
  }
  return response.json();
}

/**
 * The Panoramica's market snapshot, read by the page beside the overview and passed to
 * `MercatoOggiTile`.
 *
 * The ONE read on the page outside the overview payload, and deliberately so: these are
 * global quotes, not the owner's data — a failure costs the tile, never the page, and the
 * cache belongs to the server. `staleTime` is shorter than the server TTL so a reopened tab
 * rereads before the cache expires (AGENTS.md § Caching).
 */
export function useMarketToday() {
  const query = useQuery({
    queryKey: queryKeys.market.today(),
    queryFn: fetchMarketToday,
    staleTime: MARKET_TODAY_CLIENT_STALE_TIME_MS,
    retry: 1,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
