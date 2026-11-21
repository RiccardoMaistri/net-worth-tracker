/**
 * The monthly savings-rate series of the fixed-income feature: one pure builder for the two
 * charts that show it (Analisi › Dettaglio and Tracciamento › «Risparmio nel tempo»).
 *
 * The income of a month is DECLARED, not read from the ledger: `fixedMonthlyIncomeEur` from
 * Impostazioni, or the month's override. Before the month the salary was activated there is no
 * rate at all — no backfill of a number the reader never configured (owner's decision). Spending
 * still comes from the expense rows of the Italian month, classified by `type` with transfers
 * excluded, exactly like `tracciamentoSummary.ts`.
 *
 * The shape extends `MonthFlow` so the existing `summarizeSavingsHistory` / `cashflowNarrative`
 * pair can judge the series without a second definition of "measured month". `activeMonths`
 * excludes the pre-activation gaps, which are drawn but never ranked.
 */

import type { Expense } from '@/types/expenses';
import { getItalyMonth, getItalyMonthYear, getItalyYear, toDate } from '@/lib/utils/dateHelpers';
import { MONTH_NAMES_SHORT } from '@/lib/utils/period';
import type { MonthFlow } from '@/lib/utils/tracciamentoSummary';

/** "2026-08" — the key of both a month and its override document. */
export function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonthKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && MONTH_KEY_PATTERN.test(key);
}

/**
 * Whether the feature is configured at all: a valid activation month AND a positive default.
 * ONE rule for the series builder and for the control that opens a month's correction — a month
 * before activation carries no declared income, so a control there would write something no chart
 * ever reads.
 */
export function isFixedIncomeConfigured(
  fixedIncomeEur: number | undefined | null,
  activationMonth: string | null | undefined,
): activationMonth is string {
  return (
    isValidMonthKey(activationMonth) &&
    typeof fixedIncomeEur === 'number' &&
    Number.isFinite(fixedIncomeEur) &&
    fixedIncomeEur > 0
  );
}

export type FixedIncomeSource = 'fixed' | 'override' | 'none';
export type FixedIncomeGapReason = 'before-activation' | 'no-income' | null;

export interface FixedIncomeMonth extends MonthFlow {
  /** Which declared income the month uses. */
  source: FixedIncomeSource;
  /** The reader corrected this month from the chart. */
  corrected: boolean;
  /** Why the rate is null; null when the month is measured. */
  reason: FixedIncomeGapReason;
  /** "Ago 26" — an axis label that stays unique when the window crosses a year. */
  longLabel: string;
  /** The month in progress: drawn, never ranked. */
  ongoing: boolean;
}

export interface FixedIncomeSeriesInput {
  expenses: Expense[];
  /** The default from Impostazioni; undefined/null means the feature is not configured. */
  fixedIncomeEur: number | undefined | null;
  /** 'YYYY-MM' of the first activation, never moved by later edits. */
  activationMonth: string | null | undefined;
  /** Overrides by 'YYYY-MM'. */
  overrides: Record<string, number>;
  now: Date;
  /** The axis ends here (the period's anchor month). */
  endYear: number;
  endMonth: number;
  /** Number of months drawn, oldest first. */
  count: number;
}

export interface FixedIncomeSeries {
  months: FixedIncomeMonth[];
  /** The months the reader configured — the only ones a ranking may judge. */
  activeMonths: FixedIncomeMonth[];
  activationMonth: string | null;
  configured: boolean;
  correctedCount: number;
}

/** The override wins; an invalid or non-positive override is ignored, never silently halved. */
export function resolveMonthIncome(
  key: string,
  fixedIncomeEur: number | undefined | null,
  overrides: Record<string, number>,
): { income: number; source: FixedIncomeSource; corrected: boolean } {
  const override = overrides[key];
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return { income: override, source: 'override', corrected: true };
  }
  if (typeof fixedIncomeEur === 'number' && Number.isFinite(fixedIncomeEur) && fixedIncomeEur > 0) {
    return { income: fixedIncomeEur, source: 'fixed', corrected: false };
  }
  return { income: 0, source: 'none', corrected: false };
}

/**
 * A gap-free axis, oldest first. A month before activation carries no rate AND no figures: the
 * expense rows of a month without a declared income are not summed into a misleading "0 €/0 €".
 * The current month is marked `ongoing`, a month that has not started `scheduled`, as elsewhere
 * in Cashflow.
 */
export function buildFixedIncomeSavingsSeries({
  expenses,
  fixedIncomeEur,
  activationMonth,
  overrides,
  now,
  endYear,
  endMonth,
  count,
}: FixedIncomeSeriesInput): FixedIncomeSeries {
  const configured = isFixedIncomeConfigured(fixedIncomeEur, activationMonth);
  const activationKey = configured ? activationMonth : null;
  const today = getItalyMonthYear(now);
  const startsAfterToday = (year: number, month: number) =>
    year > today.year || (year === today.year && month > today.month);

  const axis: Array<{ year: number; month: number }> = [];
  let year = endYear;
  let month = endMonth;
  for (let i = 0; i < count; i++) {
    axis.unshift({ year, month });
    month--;
    if (month < 1) {
      month = 12;
      year--;
    }
  }

  // One pass over the ledger, not one filter per month (a whole-history Analisi series can hold
  // thousands of rows).
  const spendingByKey = new Map<string, number>();
  for (const expense of expenses) {
    if (expense.type === 'transfer') continue;
    const date = toDate(expense.date);
    const key = monthKeyOf(getItalyYear(date), getItalyMonth(date));
    spendingByKey.set(key, (spendingByKey.get(key) ?? 0) + (expense.type === 'income' ? 0 : Math.abs(expense.amount)));
  }

  let correctedCount = 0;
  const months = axis.map((ref): FixedIncomeMonth => {
    const key = monthKeyOf(ref.year, ref.month);
    const label = MONTH_NAMES_SHORT[ref.month - 1];
    const base: FixedIncomeMonth = {
      ...ref,
      key,
      label,
      longLabel: `${label} ${String(ref.year).slice(2)}`,
      income: 0,
      expenses: 0,
      net: 0,
      savingsRate: null,
      scheduled: startsAfterToday(ref.year, ref.month),
      source: 'none',
      corrected: false,
      reason: null,
      ongoing: ref.year === today.year && ref.month === today.month,
    };
    if (activationKey === null || key < activationKey) {
      base.reason = 'before-activation';
      return base;
    }
    const resolved = resolveMonthIncome(key, fixedIncomeEur, overrides);
    base.income = resolved.income;
    base.source = resolved.source;
    base.corrected = resolved.corrected;
    if (resolved.corrected) correctedCount++;
    base.expenses = spendingByKey.get(key) ?? 0;
    base.net = base.income - base.expenses;
    if (base.income > 0) {
      base.savingsRate = (base.net / base.income) * 100;
    } else {
      base.reason = 'no-income';
    }
    return base;
  });

  return {
    months,
    activeMonths: months.filter((month) => month.reason !== 'before-activation'),
    activationMonth: activationKey,
    configured: activationKey !== null,
    correctedCount,
  };
}
