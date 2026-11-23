import { beforeEach, describe, expect, it, vi } from 'vitest';

import { halvedAmount } from '@/lib/utils/expenseHalving';
import type { Expense } from '@/types/expenses';

const mocks = vi.hoisted(() => ({
  updateExpense: vi.fn(),
  applyBalanceEffects: vi.fn(),
  applyDebtRepaymentEdit: vi.fn(),
}));

vi.mock('@/lib/services/expenseService', () => ({ updateExpense: mocks.updateExpense }));
vi.mock('@/lib/services/cashBalanceReconciliation', () => ({ applyBalanceEffects: mocks.applyBalanceEffects }));
vi.mock('@/lib/services/debtRepaymentService', () => ({ applyDebtRepaymentEdit: mocks.applyDebtRepaymentEdit }));

import { halveExpenseAmount } from '@/lib/services/expenseHalvingService';

const NOW = new Date(2026, 8, 19, 12);
const PAST = new Date(2026, 8, 10, 12);
const FUTURE = new Date(2026, 8, 28, 12);

function row(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    userId: 'u1',
    type: 'variable',
    categoryId: 'cat1',
    categoryName: 'Alimentari',
    amount: -80,
    currency: 'EUR',
    date: PAST,
    createdAt: PAST,
    updatedAt: PAST,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.updateExpense.mockReset().mockResolvedValue(undefined);
  // Mirror the real commitNetDeltas: no non-zero effect means nothing moved.
  mocks.applyBalanceEffects.mockReset().mockImplementation(async (effects: { delta: number }[]) => effects.some(({ delta }) => delta !== 0));
  mocks.applyDebtRepaymentEdit.mockReset().mockResolvedValue(false);
});

describe('halvedAmount — half a row, to the cent, never to zero', () => {
  it('rounds the half to the cent', () => {
    expect(halvedAmount(373.81)).toBe(186.91);
    expect(halvedAmount(-100)).toBe(50);
    expect(halvedAmount(0.03)).toBe(0.02);
  });

  it('refuses an amount whose half would be zero or round back to itself', () => {
    expect(halvedAmount(0.01)).toBeNull();
    expect(halvedAmount(0)).toBeNull();
    expect(halvedAmount(Number.NaN)).toBeNull();
    expect(halvedAmount(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('halveExpenseAmount — the row, its account and its property', () => {
  it('writes the halved signed amount and gives the difference back to the account', async () => {
    const expense = row({ amount: -80, linkedCashAssetId: 'bnl' });

    const result = await halveExpenseAmount(expense, NOW);

    expect(mocks.updateExpense).toHaveBeenCalledWith('e1', {
      amount: 40,
      type: 'variable',
      date: PAST,
      balancePending: false,
    });
    expect(mocks.applyBalanceEffects).toHaveBeenCalledWith([{ assetId: 'bnl', delta: 40 }]);
    expect(mocks.applyDebtRepaymentEdit).toHaveBeenCalledWith(
      'e1',
      expense,
      expect.objectContaining({ type: 'variable', amount: -40, date: PAST, linkedCashAssetId: 'bnl' }),
      NOW,
    );
    expect(result).toEqual({ amount: 40, assetsMoved: true });
  });

  it('debits the account of an income row, since the income it received is now smaller', async () => {
    const expense = row({ type: 'income', amount: 2456, linkedCashAssetId: 'bnl' });

    const result = await halveExpenseAmount(expense, NOW);

    expect(mocks.updateExpense).toHaveBeenCalledWith('e1', {
      amount: 1228,
      type: 'income',
      date: PAST,
      balancePending: false,
    });
    expect(mocks.applyBalanceEffects).toHaveBeenCalledWith([{ assetId: 'bnl', delta: -1228 }]);
    expect(result.amount).toBe(1228);
  });

  it('leaves a row still waiting for its date pending, moving nothing yet', async () => {
    const expense = row({ amount: -80, date: FUTURE, balancePending: true, linkedCashAssetId: 'bnl' });

    const result = await halveExpenseAmount(expense, NOW);

    expect(mocks.updateExpense).toHaveBeenCalledWith('e1', {
      amount: 40,
      type: 'variable',
      date: FUTURE,
      balancePending: true,
    });
    expect(mocks.applyBalanceEffects).toHaveBeenCalledWith([]);
    expect(result.assetsMoved).toBe(false);
  });

  it('refuses a transfer and an amount too small to halve, writing nothing', async () => {
    await expect(halveExpenseAmount(row({ type: 'transfer', amount: 500 }), NOW)).rejects.toThrow();
    await expect(halveExpenseAmount(row({ amount: -0.01 }), NOW)).rejects.toThrow();
    expect(mocks.updateExpense).not.toHaveBeenCalled();
    expect(mocks.applyBalanceEffects).not.toHaveBeenCalled();
  });

  it('splits a mortgage instalment again and reports the debt it moved', async () => {
    const expense = row({ type: 'debt', amount: -500, debtAssetId: 'casa', linkedCashAssetId: 'bnl' });
    mocks.applyDebtRepaymentEdit.mockResolvedValue(true);

    const result = await halveExpenseAmount(expense, NOW);

    expect(mocks.applyDebtRepaymentEdit).toHaveBeenCalledWith(
      'e1',
      expense,
      expect.objectContaining({ type: 'debt', amount: -250, debtAssetId: 'casa' }),
      NOW,
    );
    expect(result).toEqual({ amount: 250, assetsMoved: true });
  });
});
