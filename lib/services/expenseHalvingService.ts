/**
 * «Dividi a metà» — halve the amount of ONE existing cashflow row.
 *
 * The row keeps its date, category, account, cost center and owner; only its amount changes.
 * What the amount carries with it is reconciled the same way the expense form's edit path does
 * (components/expenses/ExpenseDialog.tsx): the account gives back the difference it had already
 * moved (or waits for its date, lib/utils/cashSettlement.ts), and a mortgage instalment linked
 * to a property splits its principal again on the debt as it stands
 * (lib/services/debtRepaymentService.ts). A transfer is refused: halving it would leave the
 * other half of the movement nowhere to land, and the row is not a spending at all.
 *
 * The write and the balances are separate Firestore transactions (the form's order): a failure
 * after the write is reported by the caller, whose refresh shows the amount that did land.
 */

import { applyBalanceEffects } from '@/lib/services/cashBalanceReconciliation';
import { applyDebtRepaymentEdit } from '@/lib/services/debtRepaymentService';
import { updateExpense } from '@/lib/services/expenseService';
import { editBalanceEffects } from '@/lib/utils/cashSettlement';
import { halvedAmount } from '@/lib/utils/expenseHalving';
import type { Expense } from '@/types/expenses';

export interface HalveExpenseResult {
  /** The row's new amount, as printed (positive magnitude). */
  amount: number;
  /** A cash account or a property's outstanding debt moved. */
  assetsMoved: boolean;
}

/** Halve one row, its account(s) and, when it repays one, its property's debt. */
export async function halveExpenseAmount(expense: Expense, now: Date): Promise<HalveExpenseResult> {
  if (expense.type === 'transfer') throw new Error('A transfer cannot be halved');
  const halved = halvedAmount(expense.amount);
  if (halved === null) throw new Error('The amount is too small to be halved');

  // The row as the accounts will see it after the edit: same date and links, new signed amount.
  const after = {
    type: expense.type,
    amount: expense.type === 'income' ? halved : -halved,
    date: expense.date,
    linkedCashAssetId: expense.linkedCashAssetId,
    debtAssetId: expense.debtAssetId,
  };
  const settlement = editBalanceEffects(expense, after, now);

  // The row first, then the accounts, then the property's debt — the edit path's order, so the
  // new principal is split on a debt the old one has just been given back from.
  await updateExpense(expense.id, {
    amount: halved,
    type: expense.type,
    date: expense.date,
    balancePending: settlement.pending,
  });
  const balancesMoved = await applyBalanceEffects(settlement.effects);
  const debtMoved = await applyDebtRepaymentEdit(expense.id, expense, after, now);

  return { amount: halved, assetsMoved: balancesMoved || debtMoved };
}
