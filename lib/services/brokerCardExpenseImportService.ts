import { authenticatedFetch } from '@/lib/utils/authFetch';
import type {
  TrCardExpenseApplyResultDto,
  TrCardExpensePlannedRowDto,
  TrCardExpensePreviewDto,
  TrCardExpenseRowDto,
  TrCardExpenseUndoResultDto,
} from '@/lib/types/tradeRepublicCardImport';

/**
 * The client's half of the Trade Republic card-expense import: one route, three actions.
 *
 * DATES CROSS JSON AS STRINGS and are converted ONCE, here, on the way in. The dialog formats them
 * and groups them by month; a `date` left as a string is a `NaN` day and a thrown
 * `toLocaleDateString` at the worst moment — the same lesson as `brokerTradeImportService`.
 *
 * A row whose date does not parse is DROPPED from the preview rather than passed on half-formed.
 * That can only make the preview show fewer rows than the server would write, and `apply` names
 * the ids the user could actually see, so the server never writes an invisible row.
 *
 * NO CACHE, deliberately: the preview must reflect the broker's timeline at the moment it opens.
 */

const ROUTE = '/api/broker/traderepublic/card-expenses';

export interface TrCardExpenseRow {
  sourceRef: string;
  date: Date;
  merchant: string;
  subtitle?: string;
  amount: number;
  currency: string;
  amountSign: 'expense' | 'refund';
  originalAmount?: number;
  originalCurrency?: string;
}

export interface TrCardExpensePlannedRow extends TrCardExpenseRow {
  type: TrCardExpensePlannedRowDto['type'];
  categoryName: string;
  categoryId?: string;
  subCategoryName?: string;
  notes?: string;
}

export interface TrCardExpensePreview extends Omit<
  TrCardExpensePreviewDto,
  'toImport' | 'alreadyImported' | 'removed' | 'summary'
> {
  toImport: TrCardExpensePlannedRow[];
  alreadyImported: TrCardExpenseRow[];
  removed: TrCardExpenseRow[];
  summary: {
    totalExpense: number;
    totalRefund: number;
    dateFrom?: Date;
    dateTo?: Date;
  };
}

function readError(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    return (data as { error: string }).error;
  }
  return fallback;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toRow(dto: TrCardExpenseRowDto): TrCardExpenseRow | null {
  const date = parseDate(dto.date);
  if (!date) return null;
  return {
    sourceRef: dto.sourceRef,
    date,
    merchant: dto.merchant,
    ...(dto.subtitle ? { subtitle: dto.subtitle } : {}),
    amount: dto.amount,
    currency: dto.currency,
    amountSign: dto.amountSign,
    ...(dto.originalAmount !== undefined ? { originalAmount: dto.originalAmount } : {}),
    ...(dto.originalCurrency ? { originalCurrency: dto.originalCurrency } : {}),
  };
}

function toPlannedRow(dto: TrCardExpensePlannedRowDto): TrCardExpensePlannedRow | null {
  const row = toRow(dto);
  if (!row) return null;
  return {
    ...row,
    type: dto.type,
    categoryName: dto.categoryName,
    ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
    ...(dto.subCategoryName ? { subCategoryName: dto.subCategoryName } : {}),
    ...(dto.notes ? { notes: dto.notes } : {}),
  };
}

function keepRows<T>(rows: (T | null)[]): T[] {
  return rows.filter((row): row is T => row !== null);
}

/** Preview only. NO WRITES — the caller must still confirm with `applyCardExpenses`. */
export async function fetchCardExpensePreview(ownerId: string): Promise<TrCardExpensePreview> {
  const response = await authenticatedFetch(ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, action: 'preview' }),
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(readError(data, 'Lettura dei movimenti carta non riuscita: riprova.'));
  }
  const payload = data as TrCardExpensePreviewDto;
  if (!Array.isArray(payload?.toImport)) {
    throw new Error('Lettura dei movimenti carta non riuscita: riprova.');
  }
  const dateFrom = parseDate(payload.summary?.dateFrom);
  const dateTo = parseDate(payload.summary?.dateTo);
  return {
    toImport: keepRows((payload.toImport ?? []).map(toPlannedRow)),
    alreadyImported: keepRows((payload.alreadyImported ?? []).map(toRow)),
    removed: keepRows((payload.removed ?? []).map(toRow)),
    skipped: payload.skipped ?? [],
    categoriesToCreate: payload.categoriesToCreate ?? [],
    notices: payload.notices ?? [],
    brokerCount: payload.brokerCount ?? 0,
    summary: {
      totalExpense: payload.summary?.totalExpense ?? 0,
      totalRefund: payload.summary?.totalRefund ?? 0,
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    },
  };
}

/**
 * Write exactly the approved sourceRefs. The server rebuilds the plan against the CURRENT state
 * and writes only the intersection, so a stale preview cannot write a row that stopped being
 * importable — or overwrite one the user edited.
 */
export async function applyCardExpenses(
  ownerId: string,
  refs: readonly string[]
): Promise<TrCardExpenseApplyResultDto> {
  const response = await authenticatedFetch(ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, action: 'apply', refs: [...refs] }),
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(readError(data, 'Importazione dei movimenti carta non riuscita: riprova.'));
  }
  return data as TrCardExpenseApplyResultDto;
}

/** Undo an apply: deletes the rows and records the tombstone, so the next sync leaves them out. */
export async function undoCardExpenses(
  ownerId: string,
  refs: readonly string[]
): Promise<TrCardExpenseUndoResultDto> {
  const response = await authenticatedFetch(ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, action: 'undo', refs: [...refs] }),
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(readError(data, 'Annullamento dei movimenti carta non riuscito: riprova.'));
  }
  return data as TrCardExpenseUndoResultDto;
}
