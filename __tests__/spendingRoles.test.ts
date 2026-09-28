import { describe, expect, it } from 'vitest';
import {
  categoryRoleColor,
  isSpendingType,
  labelRoleSlices,
  resolveFlowAbsence,
  resolveSpendingRole,
  SPENDING_BUCKET_LABELS,
  SPENDING_EXPENSE_TYPES,
  SPENDING_ROLE_FLOW_ORDER,
  summarizeCategoryClassification,
  summarizeSpendingRoles,
  summarizeSpendingRoleShares,
  type SpendingRoleSource,
  type SpendingRolesSummary,
} from '@/lib/utils/spendingRoles';
import { summarizeFlow } from '@/lib/utils/analisiSummary';
import { Expense, ExpenseType, EXPENSE_TYPE_LABELS } from '@/types/expenses';

function makeExpense(overrides: Partial<Expense> & { type: ExpenseType; amount: number }): Expense {
  return {
    id: 'e1',
    userId: 'u1',
    categoryId: 'cat-casa',
    categoryName: 'Casa',
    currency: 'EUR',
    date: new Date('2026-06-15T12:00:00Z'),
    createdAt: new Date('2026-06-15T12:00:00Z'),
    updatedAt: new Date('2026-06-15T12:00:00Z'),
    ...overrides,
  } as Expense;
}

// A typical shape: Abbonamenti is a want, except WiFi, which is a need.
const CASA: SpendingRoleSource = { id: 'cat-casa', type: 'fixed', spendingRole: 'need', subCategories: [] };
const ABBONAMENTI: SpendingRoleSource = {
  id: 'cat-abbonamenti',
  type: 'fixed',
  spendingRole: 'want',
  subCategories: [
    { id: 'sub-wifi', name: 'WiFi', spendingRole: 'need' },
    { id: 'sub-streaming', name: 'Streaming' },
  ],
};
const PAC: SpendingRoleSource = { id: 'cat-pac', type: 'variable', spendingRole: 'saving', subCategories: [] };
const ALTRO: SpendingRoleSource = { id: 'cat-altro', type: 'variable', subCategories: [] };
const STIPENDIO: SpendingRoleSource = { id: 'cat-stipendio', type: 'income', subCategories: [] };
const CATEGORIES = [CASA, ABBONAMENTI, PAC, ALTRO, STIPENDIO];

/** Both sides of the Sankey carry the same money — the invariant the chart depends on. */
function expectBalanced(summary: SpendingRolesSummary): void {
  const left = summary.income + summary.deficit;
  const right =
    summary.byBucket.need.total +
    summary.byBucket.want.total +
    summary.byBucket.unclassified.total +
    summary.byBucket.saving.total +
    summary.surplus;
  expect(left).toBeCloseTo(right, 6);
}

describe('resolveSpendingRole', () => {
  it('reads the category role when the row has no subcategory', () => {
    expect(resolveSpendingRole(CASA)).toBe('need');
  });

  it('lets a subcategory override win over its category', () => {
    expect(resolveSpendingRole(ABBONAMENTI, 'sub-wifi')).toBe('need');
  });

  it('inherits the category role for a subcategory without an override', () => {
    expect(resolveSpendingRole(ABBONAMENTI, 'sub-streaming')).toBe('want');
  });

  it('inherits the category role for a subcategory id the category no longer has', () => {
    expect(resolveSpendingRole(ABBONAMENTI, 'sub-deleted')).toBe('want');
  });

  it('returns null for an unclassified category', () => {
    expect(resolveSpendingRole(ALTRO)).toBeNull();
  });

  it('classifies a subcategory of an unclassified category through its override alone', () => {
    const mixed: SpendingRoleSource = {
      id: 'c',
      type: 'variable',
      subCategories: [{ id: 's', name: 'S', spendingRole: 'want' }],
    };
    expect(resolveSpendingRole(mixed, 's')).toBe('want');
    expect(resolveSpendingRole(mixed)).toBeNull();
  });

  it('returns null for a missing category', () => {
    expect(resolveSpendingRole(undefined, 'sub-wifi')).toBeNull();
  });

  it('ignores a role left behind on a category that became income or transfer', () => {
    expect(resolveSpendingRole({ ...CASA, type: 'income' })).toBeNull();
    expect(resolveSpendingRole({ ...CASA, type: 'transfer' })).toBeNull();
  });

  it('treats debt as spending', () => {
    expect(resolveSpendingRole({ ...CASA, type: 'debt' })).toBe('need');
  });
});

describe('same-named categories in one bucket (found on the owner’s tour, 2026-09-27)', () => {
  const casaFissa = makeExpense({ type: 'fixed', amount: -700, categoryId: 'cat-casa-fissa', categoryName: 'Casa' });
  const casaVariabile = makeExpense({ type: 'variable', amount: -90, categoryId: 'cat-casa-variabile', categoryName: 'Casa' });

  it('labelRoleSlices tells them apart by their type, and leaves a unique name alone', () => {
    const { unclassified } = summarizeSpendingRoles(
      [casaFissa, casaVariabile, makeExpense({ type: 'variable', amount: -55, categoryId: 'cat-altro', categoryName: 'Altro' })],
      CATEGORIES
    ).byBucket;

    expect(labelRoleSlices(unclassified.categories).map((slice) => [slice.categoryName, slice.value])).toEqual([
      [`Casa (${EXPENSE_TYPE_LABELS.fixed})`, 700],
      [`Casa (${EXPENSE_TYPE_LABELS.variable})`, 90],
      ['Altro', 55],
    ]);
  });

  it('keeps two LEGACY rows with one name and two types as two slices, each with its own type', () => {
    // No categoryId: the key falls back to the name, which both rows share. The type is what a
    // click hands to the Scheda, so merging them would open the wrong one for half the money.
    const { unclassified } = summarizeSpendingRoles(
      [{ ...casaFissa, categoryId: '' }, { ...casaVariabile, categoryId: '' }],
      CATEGORIES
    ).byBucket;

    expect(unclassified.categories.map((slice) => [slice.expenseType, slice.value])).toEqual([
      ['fixed', 700],
      ['variable', 90],
    ]);
  });
});

describe('summarizeSpendingRoles', () => {
  it('splits spending by role and puts the surplus into savings', () => {
    const summary = summarizeSpendingRoles(
      [
        makeExpense({ type: 'income', amount: 3000, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
        makeExpense({ type: 'fixed', amount: -900 }),
        makeExpense({ type: 'fixed', amount: -30, categoryId: 'cat-abbonamenti', categoryName: 'Abbonamenti', subCategoryId: 'sub-wifi' }),
        makeExpense({ type: 'fixed', amount: -15, categoryId: 'cat-abbonamenti', categoryName: 'Abbonamenti', subCategoryId: 'sub-streaming' }),
        makeExpense({ type: 'variable', amount: -200, categoryId: 'cat-pac', categoryName: 'PAC' }),
        makeExpense({ type: 'variable', amount: -55, categoryId: 'cat-altro', categoryName: 'Altro' }),
      ],
      CATEGORIES
    );

    expect(summary.income).toBe(3000);
    expect(summary.spending).toBe(1200);
    expect(summary.byBucket.need.total).toBe(930);
    expect(summary.byBucket.want.total).toBe(15);
    expect(summary.byBucket.saving.total).toBe(200);
    expect(summary.byBucket.unclassified.total).toBe(55);
    expect(summary.surplus).toBe(1800);
    expect(summary.deficit).toBe(0);
    expect(summary.savings).toBe(2000);
    expectBalanced(summary);
  });

  it('lists a category split by an override in each bucket, largest first', () => {
    const summary = summarizeSpendingRoles(
      [
        makeExpense({ type: 'fixed', amount: -900 }),
        makeExpense({ type: 'fixed', amount: -30, categoryId: 'cat-abbonamenti', categoryName: 'Abbonamenti', subCategoryId: 'sub-wifi' }),
        makeExpense({ type: 'fixed', amount: -15, categoryId: 'cat-abbonamenti', categoryName: 'Abbonamenti', subCategoryId: 'sub-streaming' }),
      ],
      CATEGORIES
    );

    expect(summary.byBucket.need.categories).toEqual([
      { categoryKey: 'cat-casa', categoryName: 'Casa', expenseType: 'fixed', value: 900 },
      { categoryKey: 'cat-abbonamenti', categoryName: 'Abbonamenti', expenseType: 'fixed', value: 30 },
    ]);
    expect(summary.byBucket.want.categories).toEqual([
      { categoryKey: 'cat-abbonamenti', categoryName: 'Abbonamenti', expenseType: 'fixed', value: 15 },
    ]);
  });

  it('turns an overspent period into a deficit, with savings holding only saving rows', () => {
    const summary = summarizeSpendingRoles(
      [
        makeExpense({ type: 'income', amount: 1000, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
        makeExpense({ type: 'fixed', amount: -900 }),
        makeExpense({ type: 'variable', amount: -300, categoryId: 'cat-pac', categoryName: 'PAC' }),
      ],
      CATEGORIES
    );

    expect(summary.surplus).toBe(0);
    expect(summary.deficit).toBe(200);
    expect(summary.savings).toBe(300);
    expectBalanced(summary);
  });

  it('has no savings at all when overspent without saving rows', () => {
    const summary = summarizeSpendingRoles(
      [
        makeExpense({ type: 'income', amount: 500, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
        makeExpense({ type: 'fixed', amount: -800 }),
      ],
      CATEGORIES
    );
    expect(summary.savings).toBe(0);
    expect(summary.deficit).toBe(300);
    expectBalanced(summary);
  });

  it('is exactly balanced when income equals spending', () => {
    const summary = summarizeSpendingRoles(
      [
        makeExpense({ type: 'income', amount: 900, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
        makeExpense({ type: 'fixed', amount: -900 }),
      ],
      CATEGORIES
    );
    expect(summary.surplus).toBe(0);
    expect(summary.deficit).toBe(0);
    expectBalanced(summary);
  });

  it('skips transfers on both sides', () => {
    const summary = summarizeSpendingRoles(
      [
        makeExpense({ type: 'income', amount: 1000, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
        makeExpense({ type: 'transfer', amount: 400, categoryId: 'cat-trasf', categoryName: 'Trasferimenti' }),
      ],
      CATEGORIES
    );
    expect(summary.spending).toBe(0);
    expect(summary.income).toBe(1000);
    expect(summary.surplus).toBe(1000);
  });

  it('counts a row whose category document is gone as unclassified', () => {
    const summary = summarizeSpendingRoles(
      [makeExpense({ type: 'variable', amount: -40, categoryId: 'cat-deleted', categoryName: 'Vecchia' })],
      CATEGORIES
    );
    expect(summary.byBucket.unclassified.categories).toEqual([
      { categoryKey: 'cat-deleted', categoryName: 'Vecchia', expenseType: 'variable', value: 40 },
    ]);
  });

  it('lists income by category, largest first', () => {
    const summary = summarizeSpendingRoles(
      [
        makeExpense({ type: 'income', amount: 200, categoryId: 'cat-regali', categoryName: 'Regali' }),
        makeExpense({ type: 'income', amount: 1500, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
        makeExpense({ type: 'income', amount: 1500, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
      ],
      CATEGORIES
    );
    expect(summary.incomeCategories).toEqual([
      { categoryKey: 'cat-stipendio', categoryName: 'Stipendio', expenseType: 'income', value: 3000 },
      { categoryKey: 'cat-regali', categoryName: 'Regali', expenseType: 'income', value: 200 },
    ]);
  });

  it('treats spending as a magnitude: a positive spending row never turns into income', () => {
    const summary = summarizeSpendingRoles([makeExpense({ type: 'fixed', amount: 120 })], CATEGORIES);
    expect(summary.byBucket.need.total).toBe(120);
    expect(summary.income).toBe(0);
  });

  it('subtracts a reversal of income, so its income is the type reading’s and Periodo’s', () => {
    const rows = [
      makeExpense({ type: 'income', amount: 3000, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
      makeExpense({ type: 'income', amount: -500, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
      makeExpense({ type: 'fixed', amount: -1000 }),
    ];
    const summary = summarizeSpendingRoles(rows, CATEGORIES);

    expect(summary.income).toBe(2500);
    expect(summary.income).toBe(summarizeFlow(rows).incomeTotal);
    expect(summary.surplus).toBe(1500);
    expect(summary.incomeCategories).toEqual([
      { categoryKey: 'cat-stipendio', categoryName: 'Stipendio', expenseType: 'income', value: 2500 },
    ]);
    expectBalanced(summary);
  });

  it('keeps the balance when a reversal outweighs every receipt, and drops that category from the sources', () => {
    const summary = summarizeSpendingRoles(
      [
        makeExpense({ type: 'income', amount: -300, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
        makeExpense({ type: 'fixed', amount: -400 }),
      ],
      CATEGORIES
    );
    expect(summary.income).toBe(-300);
    expect(summary.deficit).toBe(700);
    expect(summary.incomeCategories).toEqual([]);
    expectBalanced(summary);
  });

  it('counts the income and spending rows it read, never the transfers', () => {
    const summary = summarizeSpendingRoles(
      [
        makeExpense({ type: 'income', amount: 1000, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
        makeExpense({ type: 'fixed', amount: -100 }),
        makeExpense({ type: 'transfer', amount: 400, categoryId: 'cat-trasf', categoryName: 'Trasferimenti' }),
      ],
      CATEGORIES
    );
    expect(summary.rowCount).toBe(2);
  });

  it('returns empty buckets for an empty period', () => {
    const summary = summarizeSpendingRoles([], CATEGORIES);
    expect(summary.income).toBe(0);
    expect(summary.savings).toBe(0);
    expect(summary.rowCount).toBe(0);
    expect(summary.byBucket.unclassified).toEqual({ total: 0, categories: [] });
    expectBalanced(summary);
  });
});

describe('the spending-type and bucket vocabulary', () => {
  it('declares the spending types once, in reading order', () => {
    expect(SPENDING_EXPENSE_TYPES).toEqual(['fixed', 'variable', 'debt']);
    expect((['income', 'transfer', 'fixed', 'variable', 'debt'] as ExpenseType[]).filter(isSpendingType)).toEqual(['fixed', 'variable', 'debt']);
  });

  it('orders the buckets as the flow draws them, savings last', () => {
    expect(SPENDING_ROLE_FLOW_ORDER).toEqual(['need', 'want', 'unclassified', 'saving']);
    expect(SPENDING_ROLE_FLOW_ORDER.map((bucket) => SPENDING_BUCKET_LABELS[bucket])).toEqual([
      'Necessità',
      'Desideri',
      'Da classificare',
      'Risparmi',
    ]);
  });
});

describe('resolveFlowAbsence', () => {
  it('tells nothing recorded from rows that come to nothing, and is null while there is a flow', () => {
    expect(resolveFlowAbsence(0, 0)).toBe('missing');
    expect(resolveFlowAbsence(2, 0)).toBe('zero');
    expect(resolveFlowAbsence(2, 100)).toBeNull();
  });
});

/** A summary built from bucket totals — the shares depend on nothing else. */
function rolesSummary(input: { income: number; need?: number; want?: number; saving?: number; unclassified?: number; rowCount?: number }): SpendingRolesSummary {
  const bucket = (total = 0) => ({ total, categories: [] });
  const spending = (input.need ?? 0) + (input.want ?? 0) + (input.saving ?? 0) + (input.unclassified ?? 0);
  const surplus = Math.max(0, input.income - spending);
  return {
    income: input.income,
    incomeCategories: [],
    spending,
    byBucket: { need: bucket(input.need), want: bucket(input.want), saving: bucket(input.saving), unclassified: bucket(input.unclassified) },
    surplus,
    deficit: Math.max(0, spending - input.income),
    savings: (input.saving ?? 0) + surplus,
    rowCount: input.rowCount ?? 1,
  };
}

const printed = (summary: SpendingRolesSummary) =>
  summarizeSpendingRoleShares(summary).shares.map((share) => [share.bucket, share.percentage]);

describe('summarizeSpendingRoleShares', () => {
  it('measures every bucket on what left the budget, in the flow order, Risparmi holding the surplus', () => {
    const shares = summarizeSpendingRoleShares(rolesSummary({ income: 2000, need: 1000, unclassified: 500 }));
    expect(shares.base).toBe(2000);
    expect(shares.shares).toEqual([
      { bucket: 'need', label: 'Necessità', amount: 1000, percentage: 50 },
      { bucket: 'unclassified', label: 'Da classificare', amount: 500, percentage: 25 },
      { bucket: 'saving', label: 'Risparmi', amount: 500, percentage: 25 },
    ]);
    expect(shares).toMatchObject({ deficit: 0, saved: 0, surplus: 500, incomeEdge: null, noIncome: false, absence: null });
  });

  it('gives the rounding drift to Risparmi when there is a surplus, so the printed shares add up to 100', () => {
    // Three thirds print 33 + 33 + 33 = 99; the surplus is the remainder by definition.
    expect(printed(rolesSummary({ income: 3000, need: 1000, want: 1000 }))).toEqual([
      ['need', 33],
      ['want', 33],
      ['saving', 34],
    ]);
  });

  it('gives it to «Da classificare» in a deficit — spending minus what was classified', () => {
    expect(printed(rolesSummary({ income: 100, need: 1000, want: 1000, unclassified: 1000 }))).toEqual([
      ['need', 33],
      ['want', 33],
      ['unclassified', 34],
    ]);
  });

  it('gives it to the largest bucket when no bucket is a remainder', () => {
    // A deficit with every category classified: the saving rows are not a remainder.
    expect(printed(rolesSummary({ income: 100, need: 1001, want: 1000, saving: 999 }))).toEqual([
      ['need', 34],
      ['want', 33],
      ['saving', 33],
    ]);
  });

  it('never rounds a share of one point down to zero to pay the drift: the largest pays instead', () => {
    // 45 + 55 + 1 = 101. Risparmi is the remainder, but at 1% it cannot give a point back without
    // printing as «meno dell'1%» over a share that is not: the point comes off the largest.
    const shares = summarizeSpendingRoleShares(
      summarizeSpendingRoles(
        [
          makeExpense({ type: 'income', amount: 1000, categoryId: 'cat-stipendio', categoryName: 'Stipendio' }),
          makeExpense({ type: 'fixed', amount: -446 }),
          makeExpense({ type: 'fixed', amount: -546, categoryId: 'cat-abbonamenti', categoryName: 'Abbonamenti', subCategoryId: 'sub-streaming' }),
        ],
        CATEGORIES
      )
    );

    expect(shares.shares.map((share) => [share.bucket, share.percentage])).toEqual([
      ['need', 45],
      ['want', 54],
      ['saving', 1],
    ]);
  });

  it('never prints a negative share when the remainder is too small to give a point back', () => {
    // 33.6 + 33.6 + 32.6 + 0.2 prints 34 + 34 + 33 + 0 = 101; Risparmi (0%) cannot go to −1.
    const shares = printed(rolesSummary({ income: 1000, need: 336, want: 336, unclassified: 326 }));
    expect(shares).toEqual([
      ['need', 33],
      ['want', 34],
      ['unclassified', 33],
      ['saving', 0],
    ]);
  });

  it('keeps the saving rows and the surplus apart for the reading', () => {
    expect(summarizeSpendingRoleShares(rolesSummary({ income: 3000, need: 1500, saving: 600 }))).toMatchObject({ saved: 600, surplus: 900 });
  });

  it('draws the income line where the income ends in a deficit', () => {
    const shares = summarizeSpendingRoleShares(rolesSummary({ income: 1000, need: 1250 }));
    expect(shares).toMatchObject({ base: 1250, deficit: 250, incomeEdge: 80, noIncome: false });
  });

  it('draws no income line without income, or with a net reversal, and says there was none', () => {
    expect(summarizeSpendingRoleShares(rolesSummary({ income: 0, want: 300 }))).toMatchObject({ base: 300, incomeEdge: null, noIncome: true });
    expect(summarizeSpendingRoleShares(rolesSummary({ income: -200, want: 500 }))).toMatchObject({
      base: 500,
      deficit: 700,
      incomeEdge: null,
      noIncome: true,
    });
  });

  it('has no shares and names the absence when nothing flows', () => {
    expect(summarizeSpendingRoleShares(rolesSummary({ income: 0, rowCount: 0 }))).toMatchObject({ base: 0, shares: [], absence: 'missing' });
    // A salary and its full reversal: rows exist, and they come to nothing.
    expect(summarizeSpendingRoleShares(rolesSummary({ income: 0, rowCount: 2 }))).toMatchObject({ shares: [], absence: 'zero' });
    // A lone reversal: base 0, not a negative bar.
    expect(summarizeSpendingRoleShares(rolesSummary({ income: -200, rowCount: 1 }))).toMatchObject({ base: 0, absence: 'zero' });
  });
});

describe('summarizeCategoryClassification', () => {
  it('counts only spending categories, classified by their own role', () => {
    const withOverrideOnly: SpendingRoleSource = {
      id: 'x',
      type: 'variable',
      subCategories: [{ id: 's', name: 'S', spendingRole: 'need' }],
    };
    expect(summarizeCategoryClassification([...CATEGORIES, withOverrideOnly, { ...CASA, type: 'transfer' }])).toEqual({
      spending: 5,
      classified: 3,
    });
  });
});

describe('categoryRoleColor', () => {
  it('keeps the saved hue while the roles are off', () => {
    expect(categoryRoleColor({ type: 'fixed', spendingRole: 'need' }, false)).toBeNull();
    expect(categoryRoleColor({ type: 'income' }, false)).toBeNull();
  });

  it('paints a spending category with its role, and an unclassified one as «Da classificare»', () => {
    expect(categoryRoleColor({ type: 'fixed', spendingRole: 'need' }, true)).toBe('var(--role-need)');
    expect(categoryRoleColor({ type: 'variable', spendingRole: 'want' }, true)).toBe('var(--role-want)');
    expect(categoryRoleColor({ type: 'debt', spendingRole: 'saving' }, true)).toBe('var(--role-saving)');
    expect(categoryRoleColor({ type: 'variable' }, true)).toBe('var(--role-unclassified)');
  });

  it('gives income the income colour and leaves a transfer its own, whatever role it carries', () => {
    expect(categoryRoleColor({ type: 'income', spendingRole: 'need' }, true)).toBe('var(--positive)');
    expect(categoryRoleColor({ type: 'transfer', spendingRole: 'want' }, true)).toBeNull();
  });
});
