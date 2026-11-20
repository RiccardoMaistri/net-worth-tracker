'use client';

/** The shared state + writers behind both chart-side «Correggi reddito del mese» dialogs. */

import { useState } from 'react';
import { useRemoveMonthlyIncomeOverride, useSaveMonthlyIncomeOverride } from '@/lib/hooks/useMonthlyIncomeOverrides';
import type { FixedIncomeMonth } from '@/lib/utils/fixedIncomeSavingsRate';

export interface MonthlyIncomeOverrideEdit {
  month: FixedIncomeMonth;
  origin: string | undefined;
}

export interface MonthlyIncomeOverrideTarget {
  key: string;
  year: number;
  month: number;
  /** The income currently used, before this dialog changes it. */
  effectiveIncome: number;
  /** Whether that value already comes from an override. */
  corrected: boolean;
  defaultIncome: number;
}

export function useMonthlyIncomeOverrideEditor(ownerId: string | undefined, defaultIncome: number | undefined) {
  const [selection, setSelection] = useState<MonthlyIncomeOverrideEdit | null>(null);
  const saveMutation = useSaveMonthlyIncomeOverride(ownerId ?? '');
  const removeMutation = useRemoveMonthlyIncomeOverride(ownerId ?? '');

  const month = selection?.month;
  const target: MonthlyIncomeOverrideTarget | null = month
    ? {
        key: month.key,
        year: month.year,
        month: month.month,
        effectiveIncome: month.income,
        corrected: month.corrected,
        defaultIncome: defaultIncome ?? 0,
      }
    : null;

  return {
    target,
    origin: selection?.origin,
    close: () => setSelection(null),
    edit: (edit: MonthlyIncomeOverrideEdit) => setSelection(edit),
    save: (monthKey: string, amount: number) => saveMutation.mutateAsync({ monthKey, amount }),
    remove: (monthKey: string) => removeMutation.mutateAsync(monthKey),
  };
}
