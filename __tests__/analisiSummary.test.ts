/**
 * Tests for lib/utils/analisiSummary.ts — every number the Analisi page prints that is not
 * already born in comparisonDeltas / cashflowComposition / expenseEntityStats: the period's
 * month count and single-month context, the top expenses, the spending series (per month
 * against the previous year, per year), the flow summary and the year-over-year movers.
 */

import { describe, expect, it } from 'vitest';
import type { Expense, ExpenseType } from '@/types/expenses';
import type { CategoryDeltaRow } from '@/lib/utils/comparisonDeltas';
import {
  buildMonthlySpending,
  buildTypeFlowBreakdown,
  buildYearlySpending,
  isPeriodOngoing,
  rankTopExpenses,
  resolveCategoryMovers,
  resolvePeriodThroughMonth,
  resolveSingleMonth,
  summarizeFlow,
  type AnalisiPeriod,
} from '@/lib/utils/analisiSummary';

function makeExpense(overrides: Partial<Expense> & { type: ExpenseType; amount: number; date: Date }): Expense {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'u1',
    categoryId: 'cat-cibo',
    categoryName: 'Cibo',
    currency: 'EUR',
    createdAt: new Date(2025, 0, 1),
    updatedAt: new Date(2025, 0, 1),
    ...overrides,
  } as Expense;
}

/** A row on `day` (default 15) of `month` (1-12) in `year`. */
function on(year: number, month: number, overrides: Partial<Expense> & { type: ExpenseType; amount: number }, day = 15): Expense {
  return makeExpense({ ...overrides, date: new Date(year, month - 1, day, 12) });
}

// Fixtures are local-time dates at noon, so the local getters are TZ-safe here.
const monthOf = (expense: Expense) => {
  const date = expense.date as Date;
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
};
const dayOf = (expense: Expense) => {
  const date = expense.date as Date;
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
};

const TODAY = { year: 2026, month: 8 };
const CURRENT: AnalisiPeriod = { mode: 'current', year: 2026, month: null };
const CURRENT_MONTH: AnalisiPeriod = { mode: 'current', year: 2026, month: 8 };
const PAST_MONTH: AnalisiPeriod = { mode: 'current', year: 2026, month: 3 };
const PAST_YEAR: AnalisiPeriod = { mode: 'year', year: 2025, month: null };
const HISTORY: AnalisiPeriod = { mode: 'history', year: null, month: null };

describe('resolveSingleMonth', () => {
  it('should fall back to the running month for the bare current year', () => {
    expect(resolveSingleMonth(CURRENT, TODAY)).toEqual({ year: 2026, month: 8 });
  });

  it('should take an explicitly picked month, in either year mode', () => {
    expect(resolveSingleMonth(PAST_MONTH, TODAY)).toEqual({ year: 2026, month: 3 });
    expect(resolveSingleMonth({ mode: 'year', year: 2025, month: 11 }, TODAY)).toEqual({ year: 2025, month: 11 });
  });

  it('should return null for a past year without a month and for the history', () => {
    expect(resolveSingleMonth(PAST_YEAR, TODAY)).toBeNull();
    expect(resolveSingleMonth(HISTORY, TODAY)).toBeNull();
  });

  it('should mean no month for a month that has not started — its calendar has no average to run hot against', () => {
    expect(resolveSingleMonth({ mode: 'current', year: 2026, month: 12 }, TODAY)).toBeNull();
    expect(resolveSingleMonth({ mode: 'year', year: 2027, month: 1 }, TODAY)).toBeNull();
    expect(resolveSingleMonth(CURRENT_MONTH, TODAY)).toEqual({ year: 2026, month: 8 });
  });
});

describe('resolvePeriodThroughMonth', () => {
  it('should stop «da inizio anno» at the current month and leave a whole year open', () => {
    expect(resolvePeriodThroughMonth({ mode: 'ytd', year: 2026, month: null }, TODAY)).toBe(8);
    // A whole year has no upper month: it runs to December, scheduled rows included.
    expect(resolvePeriodThroughMonth(CURRENT, TODAY)).toBeNull();
    expect(resolvePeriodThroughMonth(PAST_YEAR, TODAY)).toBeNull();
  });

  it('should let a picked month win over the mode, and have none for the history', () => {
    expect(resolvePeriodThroughMonth(PAST_MONTH, TODAY)).toBe(PAST_MONTH.month);
    expect(resolvePeriodThroughMonth(HISTORY, TODAY)).toBeNull();
  });
});

describe('isPeriodOngoing', () => {
  it('should be ongoing for the running year, the running month and the history', () => {
    expect(isPeriodOngoing(CURRENT, TODAY)).toBe(true);
    expect(isPeriodOngoing(CURRENT_MONTH, TODAY)).toBe(true);
    expect(isPeriodOngoing(HISTORY, TODAY)).toBe(true);
  });

  it('should be closed for a past month and a past year', () => {
    expect(isPeriodOngoing(PAST_MONTH, TODAY)).toBe(false);
    expect(isPeriodOngoing(PAST_YEAR, TODAY)).toBe(false);
  });
});

describe('rankTopExpenses', () => {
  const rows = [
    on(2026, 8, { type: 'variable', amount: -1180, categoryId: 'cat-vac', categoryName: 'Vacanze', subCategoryId: 'sub-volo', subCategoryName: 'Volo' }, 12),
    on(2026, 3, { type: 'fixed', amount: -940, categoryId: 'cat-auto', categoryName: 'Auto', subCategoryId: 'sub-ass', subCategoryName: 'Assicurazione' }, 3),
    on(2026, 7, { type: 'fixed', amount: -860, categoryId: 'cat-casa', categoryName: 'Casa' }),
    on(2026, 5, { type: 'variable', amount: -720, categoryId: 'cat-vac', categoryName: 'Vacanze', subCategoryId: 'sub-hotel', subCategoryName: 'Hotel' }, 22),
    on(2026, 1, { type: 'variable', amount: -650, categoryId: 'cat-sal', categoryName: 'Salute' }, 8),
    on(2026, 2, { type: 'variable', amount: -50, categoryId: 'cat-cibo', categoryName: 'Cibo' }),
    on(2026, 2, { type: 'income', amount: 2000, categoryId: 'cat-stip', categoryName: 'Stipendio' }),
    on(2026, 2, { type: 'transfer', amount: 500, categoryId: 'cat-giro', categoryName: 'Giroconto' }),
  ];

  it('should rank spending rows by magnitude, capped, with the share of the period spending', () => {
    // Act
    const top = rankTopExpenses(rows, dayOf, 5);

    // Assert
    expect(top.count).toBe(6);
    expect(top.total).toBe(4400);
    expect(top.rows).toHaveLength(5);
    expect(top.rows[0]).toMatchObject({
      label: 'Vacanze',
      subCategoryLabel: 'Volo',
      caption: '12 ago · Volo',
      amount: 1180,
      expenseType: 'variable',
      categoryKey: 'cat-vac',
      subCategoryKey: 'sub-volo',
    });
    expect(top.rows[0].percentage).toBeCloseTo((1180 / 4400) * 100, 5);
    expect(top.rows[2]).toMatchObject({ label: 'Casa', caption: '15 lug', subCategoryLabel: null, subCategoryKey: null });
    expect(top.shownTotal).toBe(4350);
  });

  it('should say in the caption when a ranked row is still in the calendar', () => {
    // The Scheduled-Is-Not-Spent Rule: a row dated ahead ranks (it is in the total) and says so.
    const top = rankTopExpenses(rows, dayOf, 5, (expense) => monthOf(expense).month >= 8);
    expect(top.rows[0]).toMatchObject({ caption: '12 ago · Volo · in calendario', scheduled: true });
    expect(top.rows[2]).toMatchObject({ caption: '15 lug', scheduled: false });
    // The default is nothing scheduled.
    expect(rankTopExpenses(rows, dayOf, 5).rows.every((row) => !row.scheduled)).toBe(true);
  });

  it('should treat a subcategory name without an id as no subcategory', () => {
    const top = rankTopExpenses([on(2026, 2, { type: 'variable', amount: -90, categoryId: 'cat-x', categoryName: 'Extra', subCategoryName: 'Orfana' })], dayOf);
    expect(top.rows[0]).toMatchObject({ caption: '15 feb', subCategoryLabel: null, subCategoryKey: null });
  });

  it('should never rank income or transfers', () => {
    const top = rankTopExpenses(rows, dayOf, 10);
    expect(top.rows.map((row) => row.label)).not.toContain('Stipendio');
    expect(top.rows.map((row) => row.label)).not.toContain('Giroconto');
  });

  it('should return an empty ranking without spending', () => {
    expect(rankTopExpenses([on(2026, 1, { type: 'income', amount: 100 })], dayOf)).toEqual({ rows: [], shownTotal: 0, total: 0, count: 0 });
  });
});

describe('buildMonthlySpending', () => {
  const rows = [
    on(2026, 1, { type: 'variable', amount: -300 }),
    on(2026, 1, { type: 'fixed', amount: -100 }),
    on(2026, 3, { type: 'variable', amount: -250 }),
    on(2026, 3, { type: 'income', amount: 2000 }),
    on(2025, 1, { type: 'variable', amount: -350 }),
    on(2025, 2, { type: 'variable', amount: -120 }),
  ];

  it('should give one point per month up to the cut, with the same month of the previous year', () => {
    // Act
    const points = buildMonthlySpending(rows, 2026, 3, 2024, monthOf, TODAY);

    // Assert
    expect(points.map((p) => p.key)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(points.map((p) => p.label)).toEqual(['Gen', 'Feb', 'Mar']);
    expect(points.map((p) => p.value)).toEqual([400, 0, 250]);
    // A tracked previous year with no rows in a month is a real 0, not a gap.
    expect(points.map((p) => p.prevYearValue)).toEqual([350, 120, 0]);
    expect(points.every((p) => !p.ongoing)).toBe(true);
  });

  it('should mark the running month and leave the previous year null below the history floor', () => {
    const points = buildMonthlySpending(rows, 2026, 8, 2026, monthOf, TODAY);
    expect(points).toHaveLength(8);
    expect(points[7]).toMatchObject({ key: '2026-08', ongoing: true, prevYearValue: null });
    expect(points.every((p) => p.prevYearValue === null)).toBe(true);
  });

  it('should leave the previous year null when that year has no rows at all', () => {
    const onlyThisYear = rows.filter((row) => monthOf(row).year === 2026);
    const points = buildMonthlySpending(onlyThisYear, 2026, 3, 2024, monthOf, TODAY);
    expect(points.every((p) => p.prevYearValue === null)).toBe(true);
  });
});

describe('buildYearlySpending', () => {
  it('should give one point per year from the first tracked year to today, gap-free, flagging the running year', () => {
    const rows = [
      on(2024, 5, { type: 'variable', amount: -100 }),
      on(2026, 2, { type: 'fixed', amount: -40 }),
      on(2023, 2, { type: 'fixed', amount: -999 }),
    ];

    const points = buildYearlySpending(rows, 2024, monthOf, TODAY);

    expect(points.map((p) => p.key)).toEqual(['2024', '2025', '2026']);
    expect(points.map((p) => p.value)).toEqual([100, 0, 40]);
    expect(points.map((p) => p.ongoing)).toEqual([false, false, true]);
    expect(points.every((p) => p.prevYearValue === null)).toBe(true);
  });

  it('should start at the first year with data when the floor is older', () => {
    const points = buildYearlySpending([on(2025, 5, { type: 'variable', amount: -10 })], 2020, monthOf, TODAY);
    expect(points.map((p) => p.key)).toEqual(['2025', '2026']);
  });
});

describe('summarizeFlow', () => {
  const rows = [
    on(2026, 1, { type: 'income', amount: 3000, categoryId: 'cat-stip', categoryName: 'Stipendio' }),
    on(2026, 2, { type: 'income', amount: 200, categoryId: 'cat-div', categoryName: 'Dividendi' }),
    on(2026, 1, { type: 'fixed', amount: -1160, categoryId: 'cat-casa', categoryName: 'Casa' }),
    on(2026, 1, { type: 'variable', amount: -740, categoryId: 'cat-cibo', categoryName: 'Cibo' }),
    on(2026, 1, { type: 'variable', amount: -50, categoryId: 'cat-cibo', categoryName: 'Cibo' }),
    on(2026, 1, { type: 'debt', amount: -100, categoryId: 'cat-mutuo', categoryName: 'Mutuo' }),
    on(2026, 1, { type: 'transfer', amount: 400, categoryId: 'cat-giro', categoryName: 'Giroconto' }),
  ];

  it('should count sources, categories and the type shares of the spending', () => {
    const flow = summarizeFlow(rows);

    expect(flow.incomeTotal).toBe(3200);
    expect(flow.incomeSources).toBe(2);
    expect(flow.expensesTotal).toBe(2050);
    expect(flow.categoryCount).toBe(3);
    expect(flow.typeShares.map((share) => share.label)).toEqual(['Fisse', 'Variabili', 'Debiti']);
    expect(flow.typeShares.map((share) => share.amount)).toEqual([1160, 790, 100]);
    expect(flow.typeShares[0].percentage).toBeCloseTo((1160 / 2050) * 100, 5);
  });

  it('should omit a type with no spending and count a same-named category under two types twice', () => {
    const flow = summarizeFlow([
      on(2026, 1, { type: 'fixed', amount: -10, categoryId: 'cat-a', categoryName: 'Casa' }),
      on(2026, 1, { type: 'variable', amount: -10, categoryId: 'cat-b', categoryName: 'Casa' }),
    ]);
    expect(flow.typeShares.map((share) => share.type)).toEqual(['fixed', 'variable']);
    expect(flow.categoryCount).toBe(2);
    expect(flow.incomeSources).toBe(0);
  });

  it('should round the printed shares once, so three equal types print 34 + 33 + 33', () => {
    const flow = summarizeFlow([
      on(2026, 1, { type: 'fixed', amount: -1000, categoryId: 'cat-a', categoryName: 'Casa' }),
      on(2026, 1, { type: 'variable', amount: -1000, categoryId: 'cat-b', categoryName: 'Cibo' }),
      on(2026, 1, { type: 'debt', amount: -1000, categoryId: 'cat-c', categoryName: 'Mutuo' }),
    ]);
    expect(flow.typeShares.map((share) => share.printedPercentage)).toEqual([34, 33, 33]);
  });

  it('should take a negative drift off the largest share: 16.6 + 16.6 + 66.8 rounds to 101', () => {
    // 166 + 166 + 668 of 1000: 17 + 17 + 67 = 101, so the largest prints 66.
    const flow = summarizeFlow([
      on(2026, 1, { type: 'fixed', amount: -166, categoryId: 'cat-a', categoryName: 'Casa' }),
      on(2026, 1, { type: 'variable', amount: -668, categoryId: 'cat-b', categoryName: 'Cibo' }),
      on(2026, 1, { type: 'debt', amount: -166, categoryId: 'cat-c', categoryName: 'Mutuo' }),
    ]);
    expect(flow.typeShares.map((share) => [share.type, share.printedPercentage])).toEqual([
      ['variable', 66],
      ['fixed', 17],
      ['debt', 17],
    ]);
  });

  it('should hand the drift of an uneven period to the largest share too', () => {
    const flow = summarizeFlow(rows);
    // 1160 / 790 / 100 of 2050: 56.6 + 38.5 + 4.9 → 57 + 39 + 5 = 101, the largest takes it back.
    expect(flow.typeShares.map((share) => share.printedPercentage)).toEqual([56, 39, 5]);
    expect(flow.typeShares.reduce((sum, share) => sum + share.printedPercentage, 0)).toBe(100);
  });
});

describe('buildTypeFlowBreakdown', () => {
  const rows = [
    on(2026, 1, { type: 'income', amount: 3000, categoryId: 'cat-stip', categoryName: 'Stipendio' }),
    on(2026, 1, { type: 'fixed', amount: -1000, categoryId: 'cat-casa', categoryName: 'Casa' }),
    on(2026, 1, { type: 'fixed', amount: -200, categoryId: 'cat-luce', categoryName: 'Bollette' }),
    on(2026, 1, { type: 'variable', amount: -500, categoryId: 'cat-cibo', categoryName: 'Cibo' }),
    on(2026, 2, { type: 'variable', amount: -300, categoryId: 'cat-cibo', categoryName: 'Cibo' }),
    on(2026, 1, { type: 'variable', amount: -900, categoryId: 'cat-casa-v', categoryName: 'Casa' }),
    on(2026, 1, { type: 'transfer', amount: 400, categoryId: 'cat-giro', categoryName: 'Giroconto' }),
  ];

  it('should give the bar the very type shares the reading prints, in its order', () => {
    const flow = summarizeFlow(rows);
    const breakdown = buildTypeFlowBreakdown(rows, flow);

    expect(breakdown.blocks.map((block) => [block.type, block.amount, block.percentage])).toEqual(
      flow.typeShares.map((share) => [share.type, share.amount, share.percentage])
    );
    expect(breakdown.blocks.map((block) => block.type)).toEqual(['variable', 'fixed']);
  });

  // Two «Casa» documents with their own ids: the key already tells them apart. The case the
  // per-type map exists for — the same name-derived key under two types — is the legacy test below.
  it("should rank each type's categories and sum them to the type", () => {
    const breakdown = buildTypeFlowBreakdown(rows, summarizeFlow(rows));
    const [variable, fixed] = breakdown.blocks;

    expect(variable.categories).toEqual([
      { categoryKey: 'cat-casa-v', categoryName: 'Casa', value: 900 },
      { categoryKey: 'cat-cibo', categoryName: 'Cibo', value: 800 },
    ]);
    expect(fixed.categories.map((category) => category.categoryKey)).toEqual(['cat-casa', 'cat-luce']);
    for (const block of breakdown.blocks) {
      expect(block.categories.reduce((sum, category) => sum + category.value, 0)).toBe(block.amount);
    }
  });

  it('should put the surplus outside the bar, and the deficit when spending runs past income', () => {
    expect(buildTypeFlowBreakdown(rows, summarizeFlow(rows))).toMatchObject({ spending: 2900, income: 3000, surplus: 100, deficit: 0, incomeEdge: null, noIncome: false, absence: null });

    const short = [...rows, on(2026, 3, { type: 'debt', amount: -600, categoryId: 'cat-mutuo', categoryName: 'Mutuo' })];
    const breakdown = buildTypeFlowBreakdown(short, summarizeFlow(short));
    expect(breakdown).toMatchObject({ surplus: 0, deficit: 500 });
    expect(breakdown.blocks.map((block) => block.type)).toEqual(['variable', 'fixed', 'debt']);
  });

  it('should keep two legacy rows named «Casa», one fixed and one variable, in their own type blocks', () => {
    // No categoryId: both fall back to the name, so the key alone is «Casa» for both.
    const legacy = [
      on(2026, 1, { type: 'fixed', amount: -700, categoryId: undefined, categoryName: 'Casa' }),
      on(2026, 1, { type: 'variable', amount: -300, categoryId: undefined, categoryName: 'Casa' }),
    ];
    const breakdown = buildTypeFlowBreakdown(legacy, summarizeFlow(legacy));

    expect(breakdown.blocks.map((block) => [block.type, block.categories])).toEqual([
      ['fixed', [{ categoryKey: 'Casa', categoryName: 'Casa', value: 700 }]],
      ['variable', [{ categoryKey: 'Casa', categoryName: 'Casa', value: 300 }]],
    ]);
  });

  it('should place the income line where the income ends when spending runs past it', () => {
    const over = [
      on(2026, 1, { type: 'income', amount: 1000, categoryId: 'cat-stip', categoryName: 'Stipendio' }),
      on(2026, 1, { type: 'fixed', amount: -1250, categoryId: 'cat-casa', categoryName: 'Casa' }),
    ];
    expect(buildTypeFlowBreakdown(over, summarizeFlow(over))).toMatchObject({ deficit: 250, incomeEdge: 80, noIncome: false });
  });

  it('should draw no income line in a month with no income yet, and say so', () => {
    const beforePayday = [on(2026, 1, { type: 'variable', amount: -400, categoryId: 'cat-cibo', categoryName: 'Cibo' })];
    expect(buildTypeFlowBreakdown(beforePayday, summarizeFlow(beforePayday))).toMatchObject({
      income: 0,
      deficit: 400,
      incomeEdge: null,
      noIncome: true,
    });
  });

  it('should read a net reversal of income as signed, with no line left of the bar', () => {
    const reversed = [
      on(2026, 1, { type: 'income', amount: -200, categoryId: 'cat-stip', categoryName: 'Stipendio' }),
      on(2026, 1, { type: 'variable', amount: -400, categoryId: 'cat-cibo', categoryName: 'Cibo' }),
    ];
    expect(buildTypeFlowBreakdown(reversed, summarizeFlow(reversed))).toMatchObject({
      income: -200,
      spending: 400,
      deficit: 600,
      incomeEdge: null,
      noIncome: true,
    });
  });

  it('should name the absence when nothing flows: no row, or rows that come to nothing', () => {
    expect(buildTypeFlowBreakdown([], summarizeFlow([]))).toMatchObject({ blocks: [], absence: 'missing' });
    const cancelled = [
      on(2026, 1, { type: 'income', amount: 500, categoryId: 'cat-stip', categoryName: 'Stipendio' }),
      on(2026, 1, { type: 'income', amount: -500, categoryId: 'cat-stip', categoryName: 'Stipendio' }),
      on(2026, 1, { type: 'transfer', amount: 400, categoryId: 'cat-giro', categoryName: 'Giroconto' }),
    ];
    expect(buildTypeFlowBreakdown(cancelled, summarizeFlow(cancelled))).toMatchObject({ absence: 'zero' });
    // Only a transfer: nothing the flow counts was recorded.
    const onlyTransfer = [on(2026, 1, { type: 'transfer', amount: 400, categoryId: 'cat-giro', categoryName: 'Giroconto' })];
    expect(buildTypeFlowBreakdown(onlyTransfer, summarizeFlow(onlyTransfer))).toMatchObject({ absence: 'missing' });
  });
});

describe('resolveCategoryMovers', () => {
  const row = (label: string, delta: number, previous = 100): CategoryDeltaRow => ({
    key: `variable:${label}`,
    expenseType: 'variable',
    categoryKey: label,
    label,
    current: previous + delta,
    previous,
    delta,
    deltaPercent: previous === 0 ? null : (delta / previous) * 100,
    status: previous === 0 ? 'new' : 'ongoing',
  });

  it('should pick the largest rise and the largest fall', () => {
    const movers = resolveCategoryMovers([row('Alimentari', -400), row('Vacanze', 1100), row('Auto', 300), row('Sport', -30)]);
    expect(movers.grown).toMatchObject({ label: 'Vacanze', delta: 1100 });
    expect(movers.shrunk).toMatchObject({ label: 'Alimentari', delta: -400 });
  });

  it('should return null on a side with no mover', () => {
    expect(resolveCategoryMovers([row('Auto', 300)])).toMatchObject({ grown: { label: 'Auto' }, shrunk: null });
    expect(resolveCategoryMovers([])).toEqual({ grown: null, shrunk: null });
  });
});
