'use client';

/**
 * React Query reader and writers for the owner's monthly income corrections
 * (lib/services/monthlyIncomeOverrideService.ts). One key per owner, invalidated by both writers.
 *
 * Every id passed in is the OWNER's (`useActiveAccount().ownerId`), never the viewer's: a delegated
 * member may correct a shared account, and the Firestore rules — not a uid comparison here — decide
 * who may write. The one refusal that belongs to this layer is demo mode: that account's data is
 * shared by every visitor, so a write must be blocked outright even if a caller forgets to disable
 * its control. There is no `onSnapshot` and no mount-time loader: React Query owns the read.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDemoMode } from '@/lib/hooks/useDemoMode';
import { queryKeys } from '@/lib/query/queryKeys';
import { userFacingError } from '@/lib/utils/dialogNarrative';
import {
  deleteMonthlyIncomeOverride,
  getMonthlyIncomeOverrides,
  setMonthlyIncomeOverride,
} from '@/lib/services/monthlyIncomeOverrideService';

/** The correction a caller holds in its form: an Italian month key and a positive EUR amount. */
export interface MonthlyIncomeOverrideSave {
  monthKey: string;
  amount: number;
}

/** The overrides lookup as options, for an imperative `queryClient.fetchQuery` on the same key. */
export function monthlyIncomeOverridesQueryOptions(ownerId: string) {
  return queryOptions<Record<string, number>>({
    queryKey: queryKeys.monthlyIncomeOverrides.all(ownerId),
    queryFn: () => getMonthlyIncomeOverrides(ownerId),
  });
}

/**
 * All corrections of an owner, keyed by `YYYY-MM`.
 *
 * @param ownerId - Whose overrides (`useActiveAccount().ownerId`, never the viewer's uid)
 */
export function useMonthlyIncomeOverrides(ownerId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    ...monthlyIncomeOverridesQueryOptions(ownerId || ''),
    enabled: !!ownerId && (options?.enabled ?? true),
  });
}

function assertWritable(isDemo: boolean): void {
  if (isDemo) {
    throw userFacingError('Le modifiche non sono disponibili in modalità demo.');
  }
}

/** Set or replace one month's correction. */
export function useSaveMonthlyIncomeOverride(ownerId: string) {
  const queryClient = useQueryClient();
  const isDemo = useDemoMode();

  return useMutation({
    mutationFn: ({ monthKey, amount }: MonthlyIncomeOverrideSave) => {
      assertWritable(isDemo);
      return setMonthlyIncomeOverride(ownerId, monthKey, amount);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.monthlyIncomeOverrides.all(ownerId) });
    },
  });
}

/** Remove one month's correction, restoring the fixed salary for that month. */
export function useRemoveMonthlyIncomeOverride(ownerId: string) {
  const queryClient = useQueryClient();
  const isDemo = useDemoMode();

  return useMutation({
    mutationFn: (monthKey: string) => {
      assertWritable(isDemo);
      return deleteMonthlyIncomeOverride(ownerId, monthKey);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.monthlyIncomeOverrides.all(ownerId) });
    },
  });
}
