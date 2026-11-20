/**
 * Tests for the Trade Republic CARD-EXPENSE path: the deterministic merchant rules, the raw
 * timeline parser and the plan that makes a re-sync idempotent.
 *
 * The timeline fixtures mirror what the broker actually sends: `eventType` selects the family,
 * `amount.value` is already in MAJOR units with a separate `fractionDigits`, and there is no MCC
 * or category — only a title, a subtitle and an icon. A fixture that invented a `category` field
 * would let the parser pass while importing nothing real.
 *
 * The three ref sets in the plan are the whole idempotency promise, so each gets its own test:
 * a document that exists wins, a row undone or deleted stays out, and everything else is new.
 */

import { describe, expect, it } from 'vitest';

import { detectTrCardCategory } from '@/lib/constants/trMerchantCategoryRules';
import {
  buildTrCardExpensePlan,
  cardExpenseDocId,
  parseTrCardExpenses,
  TR_CARD_EXPENSE_WINDOW_MONTHS,
  trCardExpenseWindowStart,
  restrictTrCardPlanToApproved,
  type TrCardExpensePlanState,
  type TrCardExpenseRow,
} from '@/lib/utils/tradeRepublicCardExpenses';
import type { ExpenseCategory } from '@/types/expenses';

/**
 * The parser also enforces the read's 12-month window as a second line of defence. Most tests pin
 * it far back so their fixtures keep testing what they say; the scope suite passes a real window.
 */
const NO_WINDOW = { from: new Date('2000-01-01T00:00:00.000Z') };
const parse = (timeline: unknown) => parseTrCardExpenses(timeline, NO_WINDOW);

function category(
  id: string,
  name: string,
  type: ExpenseCategory['type'],
  subCategories: { id: string; name: string }[] = [],
  createdAt = '2024-01-01T00:00:00.000Z'
): ExpenseCategory {
  return {
    id,
    userId: 'owner',
    name,
    type,
    subCategories,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function row(sourceRef: string, overrides: Partial<TrCardExpenseRow> = {}): TrCardExpenseRow {
  return {
    sourceRef,
    date: new Date('2026-10-14T10:00:00.000Z'),
    merchant: 'Esselunga',
    eventType: 'CARD_TRANSACTION',
    amount: -42.5,
    currency: 'EUR',
    amountSign: 'expense',
    fingerprint: `${sourceRef}-fingerprint`,
    ...overrides,
  };
}

function state(overrides: Partial<TrCardExpensePlanState> = {}): TrCardExpensePlanState {
  return {
    existingCategories: [],
    existingSourceRefs: new Set<string>(),
    importedSourceRefs: new Set<string>(),
    tombstonedSourceRefs: new Set<string>(),
    ...overrides,
  };
}

function timelineRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tr-1',
    timestamp: '2026-10-14T10:00:00.000+0000',
    title: 'Esselunga',
    subtitle: 'Carta di debito •••• 4242',
    icon: 'logos/esselunga',
    eventType: 'CARD_TRANSACTION',
    status: 'EXECUTED',
    hidden: false,
    deleted: false,
    amount: { value: -42.5, currency: 'EUR', fractionDigits: 2 },
    ...overrides,
  };
}

describe('detectTrCardCategory', () => {
  it('uses the merchant name before the icon', () => {
    expect(
      detectTrCardCategory({ merchant: 'Esselunga', subtitle: 'Spesa', icon: 'card/restaurant' })
    ).toMatchObject({ categoryName: 'Alimentari', type: 'variable', ruleId: 'groceries' });
  });

  it('falls back to the icon only when no merchant rule matched', () => {
    const detected = detectTrCardCategory({ merchant: 'Unknown Shop', icon: 'card/coffee' });
    expect(detected).toMatchObject({ categoryName: 'Ristorazione', ruleId: 'icon-restaurants' });
    expect(detected.fallback).toBe(false);
  });

  it('declares an unrecognized movement instead of inventing a category', () => {
    const detected = detectTrCardCategory({ merchant: 'Mistero Srl', icon: 'card/default' });
    expect(detected).toEqual({
      categoryName: 'Altro',
      type: 'variable',
      fallback: true,
    });
  });

  it('does not match a generic word like "card" as a merchant', () => {
    // Every card path starts with `card/`: a naive `car` pattern would categorize everything.
    expect(detectTrCardCategory({ merchant: 'CARD PAYMENT', icon: 'card/default' }).fallback).toBe(true);
  });

  it('asks for the fixed type on a recurring subscription', () => {
    expect(detectTrCardCategory({ merchant: 'Netflix', icon: 'card/subscription' })).toMatchObject({
      categoryName: 'Abbonamenti',
      type: 'fixed',
      subCategoryName: 'Streaming',
    });
  });
});

describe('parseTrCardExpenses', () => {
  it('reads only the CARD_ family and normalizes the amount to EUR', () => {
    const result = parse({
      items: [
        timelineRow(),
        timelineRow({ id: 'tr-2', eventType: 'BANK_TRANSFER', title: 'Bonifico' }),
        timelineRow({ id: 'tr-3', eventType: 'INTEREST_PAID', title: 'Interessi' }),
      ],
    });
    expect(result.rows.map((entry) => entry.sourceRef)).toEqual(['tr-1']);
    expect(result.rows[0]).toMatchObject({
      merchant: 'Esselunga',
      subtitle: 'Carta di debito •••• 4242',
      amount: -42.5,
      currency: 'EUR',
      amountSign: 'expense',
    });
  });

  it('reads a refund as a positive amount in the same family', () => {
    const result = parse({
      items: [timelineRow({ id: 'tr-r', title: 'Rimborso Amazon', amount: { value: 19.9, currency: 'EUR' } })],
    });
    expect(result.rows[0]).toMatchObject({ amount: 19.9, amountSign: 'refund' });
  });

  it('uses the EUR subAmount when the primary amount is in another currency', () => {
    const result = parse({
      items: [
        timelineRow({
          id: 'tr-fx',
          amount: { value: 45, currency: 'USD' },
          subAmount: { value: 41.3, currency: 'EUR' },
        }),
      ],
    });
    expect(result.rows[0]).toMatchObject({
      amount: 41.3,
      currency: 'EUR',
      originalAmount: 45,
      originalCurrency: 'USD',
    });
  });

  it('skips pending, cancelled, hidden and deleted rows with a reason', () => {
    const result = parse({
      items: [
        timelineRow({ id: 'pending', status: 'PENDING' }),
        timelineRow({ id: 'cancelled', status: 'CANCELLED' }),
        timelineRow({ id: 'hidden', hidden: true }),
        timelineRow({ id: 'deleted', deleted: true }),
      ],
    });
    expect(result.rows).toHaveLength(0);
    expect(result.skipped.map((skip) => skip.sourceRef)).toEqual([
      'pending',
      'cancelled',
      'hidden',
      'deleted',
    ]);
    expect(result.skipped.every((skip) => skip.reason.length > 0)).toBe(true);
  });

  it('skips a foreign amount with no EUR leg instead of importing a wrong currency', () => {
    const result = parse({
      items: [timelineRow({ amount: { value: 45, currency: 'USD' } })],
    });
    expect(result.rows).toHaveLength(0);
    expect(result.skipped[0].reason).toContain('USD');
  });

  it('drops a duplicate broker id and orders the rest newest first', () => {
    const result = parse({
      items: [
        timelineRow({ id: 'old', timestamp: '2026-01-01T10:00:00.000+0000' }),
        timelineRow({ id: 'tr-1', timestamp: '2026-10-14T10:00:00.000+0000' }),
        timelineRow({ id: 'tr-1', timestamp: '2026-10-14T10:00:00.000+0000' }),
        timelineRow({ id: 'new', timestamp: '2026-10-15T10:00:00.000+0000' }),
      ],
    });
    expect(result.rows.map((entry) => entry.sourceRef)).toEqual(['new', 'tr-1', 'old']);
  });
});

describe('the card-import window and the cash-withdrawal exclusion', () => {
  it('defines the window once, as a rolling 12 months', () => {
    expect(TR_CARD_EXPENSE_WINDOW_MONTHS).toBe(12);
    expect(trCardExpenseWindowStart(new Date('2026-11-20T12:00:00.000Z')).toISOString()).toBe(
      '2025-11-20T12:00:00.000Z'
    );
    // Twelve months back keeps the same day; a leap day clamps to February 28 instead of spilling
    // into March.
    expect(trCardExpenseWindowStart(new Date('2024-02-29T12:00:00.000Z')).toISOString()).toBe(
      '2023-02-28T12:00:00.000Z'
    );
  });

  it('excludes rows older than the window without calling them skipped', () => {
    const from = new Date('2025-11-20T00:00:00.000Z');
    const result = parseTrCardExpenses(
      {
        items: [
          timelineRow({ id: 'older', timestamp: '2025-11-19T23:59:00.000+0000' }),
          timelineRow({ id: 'inside', timestamp: '2025-11-20T00:01:00.000+0000' }),
        ],
      },
      { from }
    );
    expect(result.rows.map((entry) => entry.sourceRef)).toEqual(['inside']);
    // Out of scope is not a rejected row: the dialog must not list a year of "saltati".
    expect(result.skipped).toEqual([]);
  });

  it.each([
    ['event type', { eventType: 'CARD_ATM_WITHDRAWAL' }],
    ['a broker event-type variant', { eventType: 'CARD_CASH_WITHDRAWAL_EXECUTED' }],
    ['the broker card icon', { icon: 'card/atm' }],
    ['a compound card icon', { icon: 'card/cash-withdrawal' }],
    ['the title', { title: 'Cash Withdrawal' }],
    ['the subtitle', { subtitle: 'Prelievo contanti' }],
  ])('excludes a cash withdrawal recognised by %s', (_label, overrides) => {
    const result = parse({ items: [timelineRow({ id: 'atm', ...overrides })] });
    expect(result.rows).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ sourceRef: 'atm' });
    expect(result.skipped[0].reason).toContain('contanti');
  });

  it('keeps a merchant named ATM as a real expense', () => {
    // ATM is also Milan's transport company: a bare word in the title is not enough, and a merchant
    // logo (`logos/…`) is never the broker's own `card/…` action icon.
    const result = parse({
      items: [timelineRow({ id: 'bus', title: 'ATM Milano', subtitle: 'Biglietto', icon: 'logos/atm' })],
    });
    expect(result.rows.map((entry) => entry.sourceRef)).toEqual(['bus']);
    expect(result.skipped).toEqual([]);
  });
});

describe('cardExpenseDocId', () => {
  it('is deterministic and owner-scoped', () => {
    const id = cardExpenseDocId('owner-1', 'tr-42');
    expect(id).toBe('tr_owner-1_tr-42');
    expect(cardExpenseDocId('owner-2', 'tr-42')).not.toBe(id);
  });
});

describe('buildTrCardExpensePlan', () => {
  it('attaches a row to a category already present with the same (name, type)', () => {
    const plan = buildTrCardExpensePlan(
      [row('a')],
      state({ existingCategories: [category('c1', 'Alimentari', 'variable')] })
    );
    expect(plan.toImport[0]).toMatchObject({
      categoryId: 'c1',
      categoryName: 'Alimentari',
      subCategoryName: 'Supermercato',
      type: 'variable',
    });
    expect(plan.subCategoriesToCreate).toEqual([
      { categoryId: 'c1', categoryName: 'Alimentari', subCategoryNames: ['Supermercato'] },
    ]);
    expect(plan.categoriesToCreate).toHaveLength(0);
  });

  it('proposes a category that does not exist instead of creating it silently', () => {
    const plan = buildTrCardExpensePlan([row('a')], state());
    expect(plan.categoriesToCreate).toEqual([
      { name: 'Alimentari', type: 'variable', subCategories: ['Supermercato'] },
    ]);
    expect(plan.toImport[0].categoryId).toBeUndefined();
  });

  it('finds a user category whose subcategory matches, even under another name', () => {
    const plan = buildTrCardExpensePlan(
      [row('a')],
      state({
        existingCategories: [category('mine', 'Spesa', 'variable', [{ id: 's1', name: 'Supermercato' }])],
      })
    );
    expect(plan.toImport[0]).toMatchObject({ categoryId: 'mine', subCategoryName: 'Supermercato' });
    expect(plan.subCategoriesToCreate).toHaveLength(0);
    expect(plan.categoriesToCreate).toHaveLength(0);
  });

  it('attaches to the oldest of two same-key categories and says so', () => {
    const plan = buildTrCardExpensePlan(
      [row('a')],
      state({
        existingCategories: [
          category('new', 'Alimentari', 'variable', [{ id: 's2', name: 'Supermercato' }], '2026-01-01T00:00:00.000Z'),
          category('old', 'Alimentari', 'variable', [{ id: 's1', name: 'Supermercato' }], '2023-01-01T00:00:00.000Z'),
        ],
      })
    );
    expect(plan.toImport[0].categoryId).toBe('old');
    expect(plan.notices.map((notice) => notice.message).join(' ')).toContain('2 categorie');
  });

  it('treats an existing document as already imported — never overwritten', () => {
    const plan = buildTrCardExpensePlan(
      [row('a')],
      state({ existingSourceRefs: new Set(['a']), importedSourceRefs: new Set(['a']) })
    );
    expect(plan.toImport).toHaveLength(0);
    expect(plan.alreadyImported.map((entry) => entry.sourceRef)).toEqual(['a']);
  });

  it('leaves a tombstoned row out, even when its document is gone', () => {
    const plan = buildTrCardExpensePlan(
      [row('a')],
      state({ tombstonedSourceRefs: new Set(['a']), importedSourceRefs: new Set(['a']) })
    );
    expect(plan.toImport).toHaveLength(0);
    expect(plan.removed.map((entry) => entry.sourceRef)).toEqual(['a']);
  });

  it('leaves out a row imported once and deleted from Cashflow', () => {
    const plan = buildTrCardExpensePlan([row('a')], state({ importedSourceRefs: new Set(['a']) }));
    expect(plan.removed.map((entry) => entry.sourceRef)).toEqual(['a']);
  });

  it('counts refunds positively and declares unrecognized rows', () => {
    const plan = buildTrCardExpensePlan(
      [
        row('spend', { amount: -30, merchant: 'Esselunga' }),
        row('refund', {
          amount: 12,
          amountSign: 'refund',
          merchant: 'Rimborso Esselunga',
        }),
        row('unknown', { amount: -8, merchant: 'Mistero Srl', icon: 'card/default' }),
      ],
      state()
    );
    expect(plan.summary.totalExpense).toBe(38);
    expect(plan.summary.totalRefund).toBe(12);
    expect(plan.notices.some((notice) => notice.message.includes('in «Altro»'))).toBe(true);
  });

  it('sets the summary window from the rows that would be written', () => {
    const plan = buildTrCardExpensePlan(
      [
        row('a', { date: new Date('2026-09-01T00:00:00.000Z') }),
        row('b', { date: new Date('2026-10-31T00:00:00.000Z') }),
      ],
      state()
    );
    expect(plan.summary.dateFrom?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(plan.summary.dateTo?.toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });
});

describe('restrictTrCardPlanToApproved', () => {
  it('does not create a category proposed only for rows the user unchecked', () => {
    const plan = buildTrCardExpensePlan(
      [row('approved', { merchant: 'Esselunga' }), row('unchecked', { merchant: 'Netflix' })],
      state()
    );
    const restricted = restrictTrCardPlanToApproved(plan, new Set(['approved']));
    expect(restricted.toImport.map((entry) => entry.row.sourceRef)).toEqual(['approved']);
    expect(restricted.categoriesToCreate.map((category) => category.name)).toEqual(['Alimentari']);
    expect(restricted.categoriesToCreate.some((category) => category.name === 'Abbonamenti')).toBe(
      false
    );
  });

  it('does not add a subcategory when every row of that category was unchecked', () => {
    const plan = buildTrCardExpensePlan(
      [row('a'), row('b', { merchant: 'Conad' })],
      state({ existingCategories: [category('c1', 'Alimentari', 'variable')] })
    );
    const none = restrictTrCardPlanToApproved(plan, new Set<string>());
    expect(none.subCategoriesToCreate).toHaveLength(0);
    const one = restrictTrCardPlanToApproved(plan, new Set(['a']));
    expect(one.subCategoriesToCreate).toHaveLength(1);
  });
});
