'use client';

/**
 * The shared state + writers behind every «Correggi reddito del mese» entry: the compact box
 * beside Tracciamento's add button and the row of month controls under the Analisi chart.
 *
 * The edit carries the month's FACTS (key, year, month, the income in use, whether it is already
 * a correction), so a caller that holds no `FixedIncomeMonth` — the box reads the month from the
 * page's period axis — opens the same dialog.
 */

import { useState } from 'react';
import { useRemoveMonthlyIncomeOverride, useSaveMonthlyIncomeOverride } from '@/lib/hooks/useMonthlyIncomeOverrides';

export interface MonthlyIncomeOverrideEdit {
  /** The Italian `YYYY-MM` of the month being corrected. */
  key: string;
  year: number;
  month: number;
  /** The income currently used, before this dialog changes it. */
  effectiveIncome: number;
  /** Whether that value already comes from an override. */
  corrected: boolean;
  /** The trigger's viewport rect, resolved to a transform-origin at click time. */
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

  const target: MonthlyIncomeOverrideTarget | null = selection
    ? {
        key: selection.key,
        year: selection.year,
        month: selection.month,
        effectiveIncome: selection.effectiveIncome,
        corrected: selection.corrected,
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
