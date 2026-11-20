/**
 * The wire shapes of `POST /api/broker/traderepublic/card-expenses`, mirrored on the client.
 *
 * They live here rather than importing the server service because that module is `server-only`
 * (Admin SDK). Dates cross JSON as ISO strings: the dialog only formats them, and a `Date` typed
 * as a string is how an «Invalid time value» gets shipped, so the type says `string` on purpose.
 */

import type { ImportableExpenseType } from '@/types/expenseImport';

export interface TrCardExpenseRowDto {
  sourceRef: string;
  /** ISO string. */
  date: string;
  merchant: string;
  subtitle?: string;
  amount: number;
  currency: string;
  amountSign: 'expense' | 'refund';
  originalAmount?: number;
  originalCurrency?: string;
}

export interface TrCardExpensePlannedRowDto extends TrCardExpenseRowDto {
  type: ImportableExpenseType;
  categoryName: string;
  categoryId?: string;
  subCategoryName?: string;
  notes?: string;
}

export interface TrCardExpenseSkipDto {
  sourceRef: string;
  label: string;
  reason: string;
}

export interface TrCardExpenseCategoryToCreateDto {
  name: string;
  type: ImportableExpenseType;
  subCategories: string[];
}

export interface TrCardExpenseNoticeDto {
  message: string;
}

export interface TrCardExpensePreviewDto {
  toImport: TrCardExpensePlannedRowDto[];
  alreadyImported: TrCardExpenseRowDto[];
  removed: TrCardExpenseRowDto[];
  skipped: TrCardExpenseSkipDto[];
  categoriesToCreate: TrCardExpenseCategoryToCreateDto[];
  notices: TrCardExpenseNoticeDto[];
  /** Every card movement the broker's timeline carried, imported or not. */
  brokerCount: number;
  summary: {
    totalExpense: number;
    totalRefund: number;
    dateFrom?: string;
    dateTo?: string;
  };
}

export interface TrCardExpenseApplyResultDto {
  imported: number;
  duplicates: number;
  failed: { sourceRef: string; message: string }[];
  /** Exactly the rows that landed, so the toast's «Annulla» undoes the right ones. */
  importedRefs: string[];
  /** Card expenses now in the Cashflow (previous + imported), for the tile's metadata. */
  totalCardExpenses: number;
  createdCategories: number;
}

export interface TrCardExpenseUndoResultDto {
  deleted: number;
}
