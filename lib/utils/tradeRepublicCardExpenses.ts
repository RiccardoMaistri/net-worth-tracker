/**
 * Trade Republic CARD EXPENSES — the pure parser, the category detector and the import plan.
 *
 * The source is the same raw `timelineTransactions` the trade importer reads (see
 * `lib/server/tradeRepublicClient.ts`): one row per event, with `id`, `timestamp`, `title`,
 * `subtitle`, `icon`, `amount`, `subAmount`, `eventType`, `status`, `hidden`, `deleted`. A card
 * purchase is `CARD_TRANSACTION`; refunds and card fees arrive under the same `CARD_` family, so
 * the family is selected by prefix and the SIGN decides purchase vs refund. Cash withdrawals are
 * NOT expenses — they move money from the broker's cash balance into the user's hand — and are
 * excluded before anything else, with a declared reason.
 *
 * The import is windowed to the last 12 MONTHS: the server asks the broker for that range, and the
 * helper `trCardExpenseWindowStart` is the one definition of the boundary.
 *
 * WHY THE DOC ID IS DETERMINISTIC: a re-sync must never duplicate a row, and the write must never
 * overwrite a row the user edited. `tr_${ownerId}_${sourceRef}` makes the Firestore document the
 * idempotency key: the write is `create()` only, so an existing document — edited or not — is
 * left alone. The ledger (`brokerCardExpenseImports/{ownerId}`) remembers what was imported once,
 * which is how a row DELETED from Cashflow stays deleted instead of coming back on the next sync.
 *
 * PURE: no Firestore, no server-only import. The server service and the tests share this module.
 */

import { subMonths } from 'date-fns';
import { parseBrokerDate, toFiniteNumber } from '@/lib/utils/brokerTrade';
import { categoryMatchKey } from '@/lib/utils/expenseImport';
import { detectTrCardCategory } from '@/lib/constants/trMerchantCategoryRules';
import type { ImportableExpenseType } from '@/types/expenseImport';
import type { ExpenseCategory } from '@/types/expenses';

interface JsonObject {
  [key: string]: unknown;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(source: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** One card row, already normalized to the app's money convention (EUR, major units). */
export interface TrCardExpenseRow {
  sourceRef: string;
  date: Date;
  /** The merchant line the user recognizes: the row title, then the subtitle. */
  merchant: string;
  subtitle?: string;
  icon?: string;
  eventType: string;
  /** Signed: negative = purchase, positive = refund. EUR. */
  amount: number;
  currency: string;
  amountSign: 'expense' | 'refund';
  /** The original foreign-currency amount, when the card settled in EUR. Declared, never totalled. */
  originalAmount?: number;
  originalCurrency?: string;
  /** Stable content hash, stored for provenance and to spot a changed row without writing it. */
  fingerprint: string;
}

export interface TrCardExpenseSkip {
  sourceRef: string;
  label: string;
  reason: string;
}

export interface TrCardExpenseParseResult {
  rows: TrCardExpenseRow[];
  skipped: TrCardExpenseSkip[];
}

/**
 * A card row the broker will never settle, or one whose amount is unusable. `PENDING` is skipped
 * on purpose: the amount can still change, and the idempotent create would freeze the provisional
 * figure forever. The next sync imports it once it is executed.
 */
const SKIPPED_STATUSES = new Set(['CANCELLED', 'CANCELED', 'REJECTED', 'FAILED', 'PENDING']);

function readMoney(value: unknown): { amount: number; currency: string } | null {
  const money = asObject(value);
  if (!money) return null;
  const amount = toFiniteNumber(money['value']);
  if (amount === null) return null;
  const currency = typeof money['currency'] === 'string' && money['currency'] !== ''
    ? money['currency'].toUpperCase()
    : 'EUR';
  return { amount, currency };
}

function fingerprintOf(date: Date, amount: number, merchant: string): string {
  return `${date.toISOString()}|${amount.toFixed(2)}|${merchant.trim().toLowerCase()}`;
}

/** The one definition of the card-import window: a rolling year ending at read time. */
export const TR_CARD_EXPENSE_WINDOW_MONTHS = 12;

export function trCardExpenseWindowStart(now: Date = new Date()): Date {
  return subMonths(now, TR_CARD_EXPENSE_WINDOW_MONTHS);
}

/**
 * A cash withdrawal is not spending: the money leaves the broker's cash balance and ends up in the
 * user's hand, so writing it as an expense would invent a cost the Cashflow cannot reconcile.
 *
 * The timeline has no MCC, so the row is recognised from the STRUCTURAL signals it does send — the
 * event type and the broker's own `card/…` icon — plus unmissable phrases in the merchant line. A
 * bare word «ATM» is deliberately NOT enough: ATM is also Milan's transport company, and paying a
 * bus ticket with the card is a real expense. Merchant logos (`logos/…`) are never a signal either.
 */
const ATM_EVENT_TYPES = new Set(['CARD_ATM', 'CARD_ATM_WITHDRAWAL', 'CARD_CASH_WITHDRAWAL', 'CARD_WITHDRAWAL']);
const ATM_CARD_ICON_WORDS = new Set(['atm', 'cash', 'withdrawal', 'geldautomat']);
const ATM_MERCHANT_PHRASES = [
  'cash withdrawal',
  'cash advance',
  'prelievo contanti',
  'prelievo di contanti',
  'prelievo atm',
  'geldautomat',
  'barauszahlung',
];

function isTrCardAtmWithdrawal(row: JsonObject, merchantLine: string): boolean {
  const eventType = (readString(row, 'eventType') ?? '').toUpperCase();
  if (ATM_EVENT_TYPES.has(eventType)) return true;
  // A broker variant such as CARD_ATM_WITHDRAWAL_EXECUTED must still be recognised.
  if (/\b(ATM|WITHDRAWAL)\b/.test(eventType.replace(/_/g, ' '))) return true;

  const icon = (readString(row, 'icon') ?? '').toLowerCase();
  if (icon.startsWith('card/')) {
    const words = icon.slice('card/'.length).replace(/[-_/]/g, ' ').split(/\s+/);
    if (words.some((word) => ATM_CARD_ICON_WORDS.has(word))) return true;
  }

  const text = merchantLine.toLowerCase();
  return ATM_MERCHANT_PHRASES.some((phrase) => text.includes(phrase));
}

/**
 * Parse every card movement of a raw timeline.
 *
 * A row is imported only when it is NOT hidden/deleted, its status is not terminal/pending, it has
 * a readable date and a EUR amount (the primary `amount`, or the `subAmount` when the primary is in
 * a foreign currency). Everything else is skipped WITH A REASON — a card import that silently
 * dropped a row would make the Cashflow disagree with the broker. The two exceptions are rows
 * outside the window and rows that are not card events at all: they are OUT OF SCOPE, not rejected,
 * so they are neither imported nor listed as skipped.
 *
 * `options.from` pins the window for tests; production callers use the one rolling-year helper.
 */
export function parseTrCardExpenses(
  timeline: unknown,
  options: { from?: Date } = {}
): TrCardExpenseParseResult {
  const from = options.from ?? trCardExpenseWindowStart();
  const root = asObject(timeline);
  const items = asArray(root?.['items'] ?? timeline);
  const rows: TrCardExpenseRow[] = [];
  const skipped: TrCardExpenseSkip[] = [];
  const seen = new Set<string>();

  for (const raw of items) {
    const row = asObject(raw);
    if (!row) continue;
    const eventType = readString(row, 'eventType');
    // The whole CARD_ family: CARD_TRANSACTION is the purchase, and refunds/ATM/fees share the
    // prefix. Bank transfers and interest are NOT card rows and stay out.
    if (!eventType || !eventType.startsWith('CARD_')) continue;

    const sourceRef = readString(row, 'id');
    if (!sourceRef) continue;
    const label = readString(row, 'title') ?? sourceRef;

    if (row['hidden'] === true || row['deleted'] === true) {
      skipped.push({ sourceRef, label, reason: 'Movimento nascosto o eliminato sul broker.' });
      continue;
    }
    const status = readString(row, 'status')?.toUpperCase();
    if (status && SKIPPED_STATUSES.has(status)) {
      skipped.push({ sourceRef, label, reason: `Movimento non eseguito (${status}).` });
      continue;
    }
    const merchantLine = [readString(row, 'title'), readString(row, 'subtitle')]
      .filter((value): value is string => Boolean(value))
      .join(' ');
    if (isTrCardAtmWithdrawal(row, merchantLine)) {
      skipped.push({ sourceRef, label, reason: 'Prelievo di contanti (ATM): non è una spesa.' });
      continue;
    }
    const date = parseBrokerDate(readString(row, 'timestamp'));
    if (!date) {
      skipped.push({ sourceRef, label, reason: 'Data del movimento non leggibile.' });
      continue;
    }
    if (date < from) continue;

    const primary = readMoney(row['amount']);
    if (!primary || primary.amount === 0) {
      skipped.push({ sourceRef, label, reason: 'Importo assente o nullo.' });
      continue;
    }
    const sub = readMoney(row['subAmount']);
    let eur: { amount: number; currency: 'EUR' };
    let original: { amount: number; currency: string } | undefined;
    if (primary.currency === 'EUR') {
      eur = { amount: primary.amount, currency: 'EUR' };
      if (sub && sub.currency !== 'EUR') original = sub;
    } else if (sub && sub.currency === 'EUR') {
      eur = { amount: sub.amount, currency: 'EUR' };
      original = primary;
    } else {
      skipped.push({
        sourceRef,
        label,
        reason: `Importo in ${primary.currency} senza controvalore EUR: riga esclusa.`,
      });
      continue;
    }

    // The timeline is unique by id; a duplicated id would otherwise write the same doc twice.
    if (seen.has(sourceRef)) continue;
    seen.add(sourceRef);

    const merchant = readString(row, 'title') ?? readString(row, 'subtitle') ?? 'Movimento carta';
    const subtitle = readString(row, 'subtitle');
    rows.push({
      sourceRef,
      date,
      merchant,
      ...(subtitle ? { subtitle } : {}),
      ...(readString(row, 'icon') ? { icon: readString(row, 'icon') } : {}),
      eventType,
      amount: eur.amount,
      currency: 'EUR',
      amountSign: eur.amount < 0 ? 'expense' : 'refund',
      ...(original ? { originalAmount: original.amount, originalCurrency: original.currency } : {}),
      fingerprint: fingerprintOf(date, eur.amount, merchant),
    });
  }

  rows.sort((a, b) => b.date.getTime() - a.date.getTime());
  return { rows, skipped };
}

/**
 * The Firestore id of one card expense. The sourceRef is the broker's own id, so the document id
 * is the idempotency key: `create()` on an existing id is refused instead of overwriting the row.
 */
export function cardExpenseDocId(ownerId: string, sourceRef: string): string {
  return `tr_${ownerId}_${sourceRef}`;
}

export interface TrCardExpenseCategoryToCreate {
  name: string;
  type: ImportableExpenseType;
  subCategories: string[];
}

export interface TrCardExpenseSubCategoryToCreate {
  categoryId: string;
  categoryName: string;
  subCategoryNames: string[];
}

export interface TrCardExpensePlannedRow {
  row: TrCardExpenseRow;
  type: ImportableExpenseType;
  categoryName: string;
  /** Resolved when the category exists; absent when it is in `categoriesToCreate`. */
  categoryId?: string;
  subCategoryName?: string;
  /** True when the subcategory was detected on an EXISTING category that lacks it. */
  addSubCategory?: boolean;
  notes?: string;
}

export interface TrCardExpenseNotice {
  message: string;
}

export interface TrCardExpensePlan {
  toImport: TrCardExpensePlannedRow[];
  alreadyImported: TrCardExpenseRow[];
  /**
   * Rows that were imported once and are no longer in the Cashflow: deleted by the user, or undone
   * from the import dialog. They are NOT re-created — that is the whole promise of the ledger.
   */
  removed: TrCardExpenseRow[];
  skipped: TrCardExpenseSkip[];
  categoriesToCreate: TrCardExpenseCategoryToCreate[];
  subCategoriesToCreate: TrCardExpenseSubCategoryToCreate[];
  notices: TrCardExpenseNotice[];
  summary: {
    totalExpense: number;
    totalRefund: number;
    dateFrom?: Date;
    dateTo?: Date;
  };
}

export interface TrCardExpensePlanState {
  existingCategories: ExpenseCategory[];
  /** sourceRefs whose expense document exists right now. */
  existingSourceRefs: ReadonlySet<string>;
  /** sourceRefs the ledger says were imported at least once. */
  importedSourceRefs: ReadonlySet<string>;
  /** sourceRefs explicitly undone/deleted. */
  tombstonedSourceRefs: ReadonlySet<string>;
}

const norm = (value: string): string => value.trim().toLowerCase();

interface CategoryIndex {
  byKey: Map<string, ExpenseCategory[]>;
  bySubKey: Map<string, ExpenseCategory[]>;
}

function buildCategoryIndex(categories: ExpenseCategory[]): CategoryIndex {
  const byKey = new Map<string, ExpenseCategory[]>();
  const bySubKey = new Map<string, ExpenseCategory[]>();
  for (const category of categories) {
    const key = categoryMatchKey(category.name, category.type);
    byKey.set(key, [...(byKey.get(key) ?? []), category]);
    for (const sub of category.subCategories ?? []) {
      const subKey = `${category.type}::${norm(sub.name)}`;
      const list = bySubKey.get(subKey) ?? [];
      if (!list.some((entry) => entry.id === category.id)) list.push(category);
      bySubKey.set(subKey, list);
    }
  }
  // Oldest first: the duplicate resolution is deterministic, and the preview discloses it.
  for (const list of byKey.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  for (const list of bySubKey.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  return { byKey, bySubKey };
}

interface ResolvedCategory {
  category?: ExpenseCategory;
  subCategoryName?: string;
  create?: TrCardExpenseCategoryToCreate;
  /** The category exists but lacks the detected subcategory: add it in the same import. */
  addSubCategory?: boolean;
}

/**
 * Resolve a detected category against the user's own documents.
 *
 * Order, and each step is a real user shape:
 *   1. exact (name, type) — the category the rule names exists;
 *   2. an existing category that already has the detected SUBCATEGORY (a user's «Spesa» with
 *      «Supermercato» catches supermarket rows without renaming anything);
 *   3. a category whose NAME is the detected subcategory («Supermercato» as a category);
 *   4. create the rule's category — disclosed in the preview.
 */
function resolveCategory(detected: ReturnType<typeof detectTrCardCategory>, index: CategoryIndex): ResolvedCategory {
  const exact = index.byKey.get(categoryMatchKey(detected.categoryName, detected.type))?.[0];
  if (exact) {
    if (!detected.subCategoryName) return { category: exact };
    const sub = (exact.subCategories ?? []).find(
      (entry) => norm(entry.name) === norm(detected.subCategoryName!)
    );
    if (sub) return { category: exact, subCategoryName: sub.name };
    return { category: exact, subCategoryName: detected.subCategoryName, addSubCategory: true };
  }
  if (detected.subCategoryName) {
    const bySub = index.bySubKey.get(`${detected.type}::${norm(detected.subCategoryName)}`)?.[0];
    if (bySub) return { category: bySub, subCategoryName: detected.subCategoryName };
    const asName = index.byKey.get(categoryMatchKey(detected.subCategoryName, detected.type))?.[0];
    if (asName) return { category: asName };
  }
  return {
    create: {
      name: detected.categoryName,
      type: detected.type,
      subCategories: detected.subCategoryName ? [detected.subCategoryName] : [],
    },
  };
}

/**
 * Build the import plan against the user's current categories AND the import ledger.
 *
 * The three ref sets are the idempotency state, in priority order:
 *   - tombstoned → removed (the user undid it; never resurrect);
 *   - imported once but the document is gone → removed (deleted from Cashflow; never resurrect);
 *   - document exists → already imported (never overwritten, even if edited);
 *   - otherwise → to import.
 */
export function buildTrCardExpensePlan(
  rows: TrCardExpenseRow[],
  state: TrCardExpensePlanState,
  skipped: TrCardExpenseSkip[] = []
): TrCardExpensePlan {
  const index = buildCategoryIndex(state.existingCategories);
  const toImport: TrCardExpensePlannedRow[] = [];
  const alreadyImported: TrCardExpenseRow[] = [];
  const removed: TrCardExpenseRow[] = [];
  const categoriesToCreate: TrCardExpenseCategoryToCreate[] = [];
  const subCategoriesToCreate: TrCardExpenseSubCategoryToCreate[] = [];
  const notices: TrCardExpenseNotice[] = [];
  const newCategoryByKey = new Map<string, TrCardExpenseCategoryToCreate>();
  const subAddByCategoryId = new Map<string, TrCardExpenseSubCategoryToCreate>();
  const noticedDuplicateKeys = new Set<string>();
  let fallbackCount = 0;

  for (const row of rows) {
    if (
      state.tombstonedSourceRefs.has(row.sourceRef) ||
      (state.importedSourceRefs.has(row.sourceRef) && !state.existingSourceRefs.has(row.sourceRef))
    ) {
      removed.push(row);
      continue;
    }
    if (state.existingSourceRefs.has(row.sourceRef)) {
      alreadyImported.push(row);
      continue;
    }

    const detected = detectTrCardCategory({
      merchant: row.merchant,
      ...(row.subtitle ? { subtitle: row.subtitle } : {}),
      ...(row.icon ? { icon: row.icon } : {}),
    });
    if (detected.fallback) fallbackCount += 1;

    const resolved = resolveCategory(detected, index);
    const key = categoryMatchKey(detected.categoryName, detected.type);

    if (resolved.category) {
      const list = index.byKey.get(key);
      if (list && list.length > 1 && !noticedDuplicateKeys.has(key)) {
        noticedDuplicateKeys.add(key);
        notices.push({
          message: `Esistono ${list.length} categorie «${resolved.category.name}»: le spese carta verranno agganciate alla più vecchia.`,
        });
      }
      if (resolved.addSubCategory && resolved.subCategoryName) {
        const entry = subAddByCategoryId.get(resolved.category.id) ?? {
          categoryId: resolved.category.id,
          categoryName: resolved.category.name,
          subCategoryNames: [],
        };
        if (!entry.subCategoryNames.some((name) => norm(name) === norm(resolved.subCategoryName!))) {
          entry.subCategoryNames.push(resolved.subCategoryName);
        }
        subAddByCategoryId.set(resolved.category.id, entry);
      }
    } else if (resolved.create) {
      let entry = newCategoryByKey.get(key);
      if (!entry) {
        entry = { ...resolved.create, subCategories: [...resolved.create.subCategories] };
        newCategoryByKey.set(key, entry);
        categoriesToCreate.push(entry);
      } else {
        for (const name of resolved.create.subCategories) {
          if (!entry.subCategories.some((existing) => norm(existing) === norm(name))) {
            entry.subCategories.push(name);
          }
        }
      }
    }

    toImport.push({
      row,
      type: detected.type,
      categoryName: resolved.category?.name ?? detected.categoryName,
      ...(resolved.category ? { categoryId: resolved.category.id } : {}),
      ...(resolved.subCategoryName ? { subCategoryName: resolved.subCategoryName } : {}),
      ...(resolved.addSubCategory ? { addSubCategory: true } : {}),
      notes: row.subtitle && row.subtitle !== row.merchant
        ? `${row.merchant} · ${row.subtitle}`
        : row.merchant,
    });
  }

  for (const entry of subAddByCategoryId.values()) subCategoriesToCreate.push(entry);

  if (fallbackCount > 0) {
    notices.push({
      message: `${fallbackCount} ${fallbackCount === 1 ? 'movimento non ha' : 'movimenti non hanno'} un esercente riconosciuto e ${fallbackCount === 1 ? 'finirà' : 'finiranno'} in «Altro»: puoi riclassificarli dal Cashflow.`,
    });
  }

  let totalExpense = 0;
  let totalRefund = 0;
  let dateFrom: Date | undefined;
  let dateTo: Date | undefined;
  for (const { row } of toImport) {
    if (row.amount < 0) totalExpense += Math.abs(row.amount);
    else totalRefund += row.amount;
    if (!dateFrom || row.date < dateFrom) dateFrom = row.date;
    if (!dateTo || row.date > dateTo) dateTo = row.date;
  }

  return {
    toImport,
    alreadyImported,
    removed,
    skipped,
    categoriesToCreate,
    subCategoriesToCreate,
    notices,
    summary: {
      totalExpense,
      totalRefund,
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    },
  };
}

/**
 * Narrow a previewed plan to the sourceRefs the user actually approved.
 *
 * Without this, a user who unchecked every row of a proposed category would still have that
 * category created by the write — a silent side effect of a preview they rejected. The server
 * calls this on the CURRENT plan before writing, so both the expenses and the category writes
 * stay inside what the user confirmed.
 */
export function restrictTrCardPlanToApproved(
  plan: TrCardExpensePlan,
  approved: ReadonlySet<string>
): TrCardExpensePlan {
  const toImport = plan.toImport.filter((entry) => approved.has(entry.row.sourceRef));
  const newKeys = new Set(
    toImport.filter((entry) => !entry.categoryId).map((entry) => categoryMatchKey(entry.categoryName, entry.type))
  );
  const subCategoryIds = new Set(
    toImport.filter((entry) => entry.addSubCategory && entry.categoryId).map((entry) => entry.categoryId as string)
  );
  return {
    ...plan,
    toImport,
    categoriesToCreate: plan.categoriesToCreate.filter((candidate) =>
      newKeys.has(categoryMatchKey(candidate.name, candidate.type))
    ),
    subCategoriesToCreate: plan.subCategoriesToCreate.filter((candidate) =>
      subCategoryIds.has(candidate.categoryId)
    ),
  };
}
