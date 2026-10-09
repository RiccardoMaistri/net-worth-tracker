'use client';

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/queryKeys';
import {
  fetchUnbookedBrokerSells,
  type UnbookedSellsReadingResult,
} from '@/lib/services/unbookedBrokerSellsService';

/**
 * The Trade Republic sells of `year` the ledger has not booked, read from the broker's own session.
 *
 * GATED BY `enabled`, and that is the point: the read pages the whole broker timeline and fetches a
 * detail per trade, so it must not run on a page mount — only while the modal that shows it is open.
 *
 * NO `staleTime` (the sibling service's reason, and it is the whole point of this query): the
 * question is «is my ledger complete?», and a cached answer is wrong exactly when it matters —
 * right after an import, and right after a sale at the broker.
 *
 * A re-linkable session (401) and a never-linked one (409) come back as `state`, never as
 * `isError`: both are things the user can act on, and a red error would read as a broken page.
 * Everything else IS an error, because a failed read must not be shown as an empty list.
 */
export function useUnbookedBrokerSells(ownerId: string | undefined, year: number, enabled: boolean) {
  return useQuery<UnbookedSellsReadingResult>({
    queryKey: queryKeys.broker.unbookedSells(ownerId ?? '', year),
    queryFn: () => fetchUnbookedBrokerSells(ownerId!, year),
    enabled: !!ownerId && enabled && year > 0,
    retry: false,
  });
}