'use client';

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/queryKeys';
import { authenticatedFetch } from '@/lib/utils/authFetch';
import type { InflationIndexResponse } from '@/types/benchmarks';

async function fetchInflationIndex(): Promise<InflationIndexResponse> {
  const response = await authenticatedFetch('/api/benchmarks/inflation');

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? 'Inflazione non disponibile');
  }

  return response.json() as Promise<InflationIndexResponse>;
}

/**
 * The shared HICP Italy index. One read per browser session (6 h), like the benchmarks: the
 * server refreshes the catalogue weekly and the client never writes it.
 *
 * A failure is a surface's own state, not the page's: the surfaces that use inflation are
 * enhancements, and they drop or disable their real-value view when this read fails
 * (doc/guide/stati.md).
 */
export function useInflationIndex() {
  return useQuery({
    queryKey: queryKeys.benchmarks.inflation(),
    queryFn: fetchInflationIndex,
    staleTime: 1000 * 60 * 60 * 6,
    retry: 1,
  });
}
