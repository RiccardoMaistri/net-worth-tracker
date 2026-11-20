/**
 * The fixed-income savings-rate series: one declared income per month, overrides winning, and
 * NO rate before activation. No expense is summed for a month the reader never configured —
 * the chart must not invent a "0 €" history from a setting that did not exist yet.
 *
 * Calendar fixtures name their Italian wall clock with `fromZonedTime`: the rule reads the
 * Italian month, so a local midnight is the previous day whenever the suite runs in UTC.
 */

import { describe, expect, it } from 'vitest';
import { fromZonedTime } from 'date-fns-tz';
import type { Expense } from '@/types/expenses';
import {
  buildFixedIncomeSavingsSeries,
  isValidMonthKey,
  monthKeyOf,
  resolveMonthIncome,
} from '@/lib/utils/fixedIncomeSavingsRate';
import { summarizeSavingsHistory } from '@/lib/utils/tracciamentoSummary';

function makeExpense(overrides: Partial<Expense> & { amount: number; date: Date }): Expense {
  return {
    id: crypto.randomUUID(),
    userId: 'u1',
    type: 'variable',
    categoryId: 'cat',
    categoryName: 'Spesa',
    currency: 'EUR',
    ...overrides,
    createdAt: overrides.date,
    updatedAt: overrides.date,
  } as Expense;
}

const italy = (iso: string) => fromZonedTime(iso, 'Europe/Rome');
const NOW = italy('2026-08-22T12:00:00');
const FIXED = 2500;
const ACTIVATION = '2026-06';

const ROWS: Expense[] = [
  // A recorded salary must NOT become the denominator of this series.
  makeExpense({ type: 'income', amount: 4200, categoryId: 'salary', categoryName: 'Stipendio', date: italy('2026-08-03T12:00:00') }),
  makeExpense({ type: 'income', amount: 4200, categoryId: 'salary', categoryName: 'Stipendio', date: italy('2026-06-03T12:00:00') }),
  makeExpense({ type: 'fixed', amount: -1000, categoryId: 'home', categoryName: 'Casa', date: italy('2026-06-05T12:00:00') }),
  makeExpense({ type: 'variable', amount: -500, categoryId: 'food', categoryName: 'Spesa', date: italy('2026-07-10T12:00:00') }),
  makeExpense({ type: 'variable', amount: -600, categoryId: 'food', categoryName: 'Spesa', date: italy('2026-08-10T12:00:00') }),
  // Transfers are never spending, even inside the activated window.
  makeExpense({ type: 'transfer', amount: 900, categoryId: 'transfer', categoryName: 'Giroconto', date: italy('2026-08-11T12:00:00') }),
  // An expense in a pre-activation month is not summed at all.
  makeExpense({ type: 'variable', amount: -7777, categoryId: 'old', categoryName: 'Vecchia spesa', date: italy('2026-04-10T12:00:00') }),
];

const build = (overrides: Partial<Parameters<typeof buildFixedIncomeSavingsSeries>[0]> = {}) =>
  buildFixedIncomeSavingsSeries({
    expenses: ROWS,
    fixedIncomeEur: FIXED,
    activationMonth: ACTIVATION,
    overrides: {},
    now: NOW,
    endYear: 2026,
    endMonth: 8,
    count: 5,
    ...overrides,
  });

describe('month keys and income resolution', () => {
  it('validates only real Italian months', () => {
    expect(isValidMonthKey('2026-06')).toBe(true);
    expect(isValidMonthKey('2026-13')).toBe(false);
    expect(isValidMonthKey('2026-6')).toBe(false);
    expect(isValidMonthKey(null)).toBe(false);
    expect(monthKeyOf(2026, 6)).toBe('2026-06');
  });

  it('lets the override win, and ignores a non-positive one', () => {
    expect(resolveMonthIncome('2026-06', FIXED, { '2026-06': 3100 })).toEqual({ income: 3100, source: 'override', corrected: true });
    expect(resolveMonthIncome('2026-06', FIXED, { '2026-06': 0 })).toEqual({ income: FIXED, source: 'fixed', corrected: false });
    expect(resolveMonthIncome('2026-06', undefined, {})).toEqual({ income: 0, source: 'none', corrected: false });
  });
});

describe('buildFixedIncomeSavingsSeries', () => {
  it('walks a gap-free axis across the year boundary', () => {
    const series = build({ endYear: 2026, endMonth: 2, count: 4 });
    expect(series.months.map((m) => m.key)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(series.months[0].longLabel).toBe('Nov 25');
  });

  it('gives NO figures and no rate to months before activation', () => {
    const series = build();
    const april = series.months.find((m) => m.key === '2026-04')!;
    const may = series.months.find((m) => m.key === '2026-05')!;

    expect(april.reason).toBe('before-activation');
    expect(april.savingsRate).toBeNull();
    expect(april.income).toBe(0);
    expect(april.expenses).toBe(0);
    expect(may.reason).toBe('before-activation');
    expect(series.activeMonths.map((m) => m.key)).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('uses the declared income, not the recorded salary, from the activation month on', () => {
    const series = build();
    const june = series.months.find((m) => m.key === '2026-06')!;
    const august = series.months.find((m) => m.key === '2026-08')!;

    expect(june.income).toBe(FIXED);
    expect(june.expenses).toBe(1000);
    expect(june.savingsRate).toBeCloseTo(60, 5);
    expect(june.source).toBe('fixed');
    // Income rows and transfers are both outside the spending side.
    expect(august.expenses).toBe(600);
    expect(august.savingsRate).toBeCloseTo(76, 5);
  });

  it('applies an override to one month only', () => {
    const series = build({ overrides: { '2026-07': 2000 } });
    const july = series.months.find((m) => m.key === '2026-07')!;
    const june = series.months.find((m) => m.key === '2026-06')!;

    expect(july.income).toBe(2000);
    expect(july.corrected).toBe(true);
    expect(july.source).toBe('override');
    expect(july.savingsRate).toBeCloseTo(75, 5);
    expect(june.source).toBe('fixed');
    expect(series.correctedCount).toBe(1);
  });

  it('marks the running and the not-yet-started month without ranking them as closed', () => {
    const series = build({ count: 4 });
    const august = series.months.find((m) => m.key === '2026-08')!;
    const september = build({ endYear: 2026, endMonth: 9, count: 4 }).months.find((m) => m.key === '2026-09')!;

    expect(august.ongoing).toBe(true);
    expect(august.scheduled).toBe(false);
    expect(september.ongoing).toBe(false);
    expect(september.scheduled).toBe(true);

    const history = summarizeSavingsHistory(series.activeMonths, NOW);
    expect(history.ongoing?.key).toBe('2026-08');
    expect(history.measuredCount).toBe(2);
    expect(history.closedCount).toBe(2);
  });

  it('has no rate at all without a configuration, even with a full ledger', () => {
    const series = build({ fixedIncomeEur: undefined, activationMonth: undefined });
    expect(series.configured).toBe(false);
    expect(series.activationMonth).toBeNull();
    expect(series.months.every((m) => m.reason === 'before-activation' && m.savingsRate === null)).toBe(true);
    expect(summarizeSavingsHistory(series.activeMonths, NOW).measuredCount).toBe(0);
  });

  it('treats an activation on an Italian midnight as that month, not the previous one', () => {
    const series = build({
      now: italy('2026-09-01T00:30:00'),
      endYear: 2026,
      endMonth: 9,
      count: 2,
      activationMonth: '2026-09',
      expenses: [],
    });
    expect(series.months.map((m) => m.reason)).toEqual(['before-activation', null]);
    expect(series.months[1].income).toBe(FIXED);
  });
});
