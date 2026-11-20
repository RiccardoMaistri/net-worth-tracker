/**
 * The SERVER half of the Trade Republic card-expense import.
 *
 * The route is auth → validate → read the timeline → delegate; every decision that touches
 * Firestore lives here. Two rules shape the whole module:
 *
 * 1. **`create()` only, on a deterministic id.** `tr_${ownerId}_${sourceRef}` is the idempotency
 *    key. An existing document — edited by the user or not — is never touched. A re-sync finds it,
 *    calls it «già importata» and moves on.
 * 2. **A deleted row never comes back.** The ledger `brokerCardExpenseImports/{ownerId}` remembers
 *    every sourceRef imported at least once; if the document is gone on a later sync, the row is
 *    «rimossa», not re-created. An explicit undo also writes `brokerExpenseTombstones`, so the
 *    intent survives even if the ledger is ever rebuilt.
 *
 * The preview branch NEVER writes: the category creation and the expenses happen only after the
 * user approves, and the server re-derives the plan from the CURRENT state before writing, so a
 * stale preview cannot write a row that stopped being importable.
 *
 * Admin SDK on purpose: the ledger and the tombstones are server-owned (rules `if false`), and the
 * card route must be able to create a category and its expense in one flow without the client
 * SDK's rules round trip.
 */

import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/firebase/admin';
import { invalidateDashboardOverviewSummaryServer } from '@/lib/services/dashboardOverviewInvalidation.server';
import { removeUndefinedDeep } from '@/lib/utils/firestoreData';
import { categoryMatchKey } from '@/lib/utils/expenseImport';
import {
  buildTrCardExpensePlan,
  cardExpenseDocId,
  parseTrCardExpenses,
  restrictTrCardPlanToApproved,
  type TrCardExpensePlan,
  type TrCardExpensePlanState,
  type TrCardExpenseRow,
} from '@/lib/utils/tradeRepublicCardExpenses';
import type {
  TrCardExpenseApplyResultDto,
  TrCardExpensePreviewDto,
  TrCardExpenseRowDto,
  TrCardExpenseUndoResultDto,
} from '@/lib/types/tradeRepublicCardImport';
import type { ExpenseCategory } from '@/types/expenses';

const EXPENSES_COLLECTION = 'expenses';
const CATEGORIES_COLLECTION = 'expenseCategories';
const IMPORT_LEDGER_COLLECTION = 'brokerCardExpenseImports';
const TOMBSTONES_COLLECTION = 'brokerExpenseTombstones';

/** Firestore hard limit is 500 ops/batch; stay below it. */
const WRITE_CHUNK = 400;
/** One `getAll` call stays well under the server's document-read batch. */
const READ_CHUNK = 300;

const norm = (value: string): string => value.trim().toLowerCase();
const genSubId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function toDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }
  return fallback;
}

function toCategory(id: string, data: Record<string, unknown>): ExpenseCategory {
  return {
    id,
    userId: typeof data['userId'] === 'string' ? data['userId'] : '',
    name: typeof data['name'] === 'string' ? data['name'] : '',
    type: (data['type'] as ExpenseCategory['type']) ?? 'variable',
    ...(typeof data['color'] === 'string' ? { color: data['color'] } : {}),
    ...(typeof data['icon'] === 'string' ? { icon: data['icon'] } : {}),
    ...(data['spendingRole'] ? { spendingRole: data['spendingRole'] as ExpenseCategory['spendingRole'] } : {}),
    subCategories: Array.isArray(data['subCategories'])
      ? (data['subCategories'] as ExpenseCategory['subCategories'])
      : [],
    createdAt: toDate(data['createdAt'], new Date(0)),
    updatedAt: toDate(data['updatedAt'], new Date(0)),
  };
}

interface OwnerState {
  categories: ExpenseCategory[];
  existingSourceRefs: Set<string>;
  importedSourceRefs: Set<string>;
  tombstonedSourceRefs: Set<string>;
}

/**
 * Read the owner's categories, the documents that still exist for the current timeline, the
 * import ledger and the tombstones — FOUR reads, in parallel, no write.
 *
 * The existence check is a `getAll` on the deterministic refs of the CURRENT timeline, not a
 * `where('source','==',…)` query: that filter beside `userId` needs a composite index, and this
 * codebase does not add one for an import. The ledger is what turns «the document is gone» into
 * «the user deleted it», because a ref that was never imported is simply new.
 */
async function readOwnerState(ownerId: string, rows: TrCardExpenseRow[]): Promise<OwnerState> {
  const byDocId = new Map(rows.map((row) => [cardExpenseDocId(ownerId, row.sourceRef), row.sourceRef]));
  const refs = [...byDocId.keys()].map((id) => adminDb.collection(EXPENSES_COLLECTION).doc(id));

  const [categoriesSnap, ledgerSnap, tombstonesSnap] = await Promise.all([
    adminDb.collection(CATEGORIES_COLLECTION).where('userId', '==', ownerId).get(),
    adminDb.collection(IMPORT_LEDGER_COLLECTION).doc(ownerId).get(),
    adminDb.collection(TOMBSTONES_COLLECTION).doc(ownerId).collection('refs').get(),
  ]);

  const existingSourceRefs = new Set<string>();
  for (const group of chunk(refs, READ_CHUNK)) {
    if (group.length === 0) continue;
    const snapshots = await adminDb.getAll(...group);
    for (const snapshot of snapshots) {
      if (!snapshot.exists) continue;
      const sourceRef = byDocId.get(snapshot.id);
      if (sourceRef) existingSourceRefs.add(sourceRef);
    }
  }

  const imported = ledgerSnap.get('sourceRefs');
  const importedSourceRefs = new Set<string>(
    Array.isArray(imported) ? imported.filter((value): value is string => typeof value === 'string') : []
  );
  const tombstonedSourceRefs = new Set<string>(
    tombstonesSnap.docs
      .map((doc) => doc.get('sourceRef'))
      .filter((value): value is string => typeof value === 'string')
  );

  return {
    categories: categoriesSnap.docs.map((doc) => toCategory(doc.id, doc.data())),
    existingSourceRefs,
    importedSourceRefs,
    tombstonedSourceRefs,
  };
}

function planStateOf(state: OwnerState): TrCardExpensePlanState {
  return {
    existingCategories: state.categories,
    existingSourceRefs: state.existingSourceRefs,
    importedSourceRefs: state.importedSourceRefs,
    tombstonedSourceRefs: state.tombstonedSourceRefs,
  };
}

function rowDto(row: TrCardExpenseRow): TrCardExpenseRowDto {
  return {
    sourceRef: row.sourceRef,
    date: row.date.toISOString(),
    merchant: row.merchant,
    ...(row.subtitle ? { subtitle: row.subtitle } : {}),
    amount: row.amount,
    currency: row.currency,
    amountSign: row.amountSign,
    ...(row.originalAmount !== undefined ? { originalAmount: row.originalAmount } : {}),
    ...(row.originalCurrency ? { originalCurrency: row.originalCurrency } : {}),
  };
}

/** Preview only: reads and plans, never writes. */
export async function buildCardExpensePreview(
  ownerId: string,
  timeline: unknown
): Promise<TrCardExpensePreviewDto> {
  // The state needs the parsed rows to know which refs to check, so parse once here and reuse.
  const parsed = parseTrCardExpenses(timeline);
  const state = await readOwnerState(ownerId, parsed.rows);
  const plan = buildTrCardExpensePlan(parsed.rows, planStateOf(state), parsed.skipped);

  return {
    toImport: plan.toImport.map((entry) => ({
      ...rowDto(entry.row),
      type: entry.type,
      categoryName: entry.categoryName,
      ...(entry.categoryId ? { categoryId: entry.categoryId } : {}),
      ...(entry.subCategoryName ? { subCategoryName: entry.subCategoryName } : {}),
      ...(entry.notes ? { notes: entry.notes } : {}),
    })),
    alreadyImported: plan.alreadyImported.map(rowDto),
    removed: plan.removed.map(rowDto),
    skipped: plan.skipped.map((skip) => ({
      sourceRef: skip.sourceRef,
      label: skip.label,
      reason: skip.reason,
    })),
    categoriesToCreate: plan.categoriesToCreate.map((category) => ({
      name: category.name,
      type: category.type,
      subCategories: category.subCategories,
    })),
    notices: plan.notices,
    brokerCount: parsed.rows.length + parsed.skipped.length,
    summary: {
      totalExpense: plan.summary.totalExpense,
      totalRefund: plan.summary.totalRefund,
      ...(plan.summary.dateFrom ? { dateFrom: plan.summary.dateFrom.toISOString() } : {}),
      ...(plan.summary.dateTo ? { dateTo: plan.summary.dateTo.toISOString() } : {}),
    },
  };
}

interface CategoryWriteResult {
  categories: ExpenseCategory[];
  created: number;
}

/**
 * Create the categories/subcategories the approved rows need, and return the owner's whole
 * category list — the ones that already existed plus the new ones — because a row can point at
 * either.
 *
 * The category documents keep the app's own shape (`userId`, `name`, `type`, `subCategories`,
 * `createdAt`, `updatedAt`) so every existing reader sees them without a special case.
 */
async function ensureCategories(
  ownerId: string,
  plan: TrCardExpensePlan,
  existingCategories: ExpenseCategory[]
): Promise<CategoryWriteResult> {
  const now = new Date();
  const merged: ExpenseCategory[] = [...existingCategories];
  const byId = new Map<string, ExpenseCategory>(existingCategories.map((category) => [category.id, category]));

  for (const entry of plan.categoriesToCreate) {
    const subCategories = entry.subCategories.map((name) => ({ id: genSubId(), name }));
    const ref = await adminDb.collection(CATEGORIES_COLLECTION).add(
      removeUndefinedDeep({
        userId: ownerId,
        name: entry.name,
        type: entry.type,
        subCategories,
        createdAt: now,
        updatedAt: now,
      })
    );
    const category: ExpenseCategory = {
      id: ref.id,
      userId: ownerId,
      name: entry.name,
      type: entry.type,
      subCategories,
      createdAt: now,
      updatedAt: now,
    };
    merged.push(category);
    byId.set(category.id, category);
  }

  for (const entry of plan.subCategoriesToCreate) {
    const category = byId.get(entry.categoryId);
    if (!category) continue;
    const existingNames = new Set(category.subCategories.map((sub) => norm(sub.name)));
    const additions = entry.subCategoryNames
      .filter((name) => !existingNames.has(norm(name)))
      .map((name) => ({ id: genSubId(), name }));
    if (additions.length === 0) continue;
    const subCategories = [...category.subCategories, ...additions];
    await adminDb.collection(CATEGORIES_COLLECTION).doc(category.id).update({ subCategories, updatedAt: now });
    category.subCategories = subCategories;
  }

  return { categories: merged, created: plan.categoriesToCreate.length };
}

interface ExpenseWrite {
  ref: FirebaseFirestore.DocumentReference;
  data: Record<string, unknown>;
  sourceRef: string;
}

function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: number | string }).code;
  return code === 6 || code === 'ALREADY_EXISTS' || code === 'already-exists';
}

/**
 * Write the approved rows with `create()`, in batches, falling back to per-document creates only
 * when a batch hits an existing id. A duplicate is COUNTED, never overwritten.
 */
async function writeExpenses(
  ownerId: string,
  plan: TrCardExpensePlan,
  approved: ReadonlySet<string>,
  existingCategories: ExpenseCategory[]
): Promise<{
  imported: number;
  duplicates: number;
  failed: { sourceRef: string; message: string }[];
  importedRefs: string[];
  createdCategories: number;
}> {
  const approvedRows = plan.toImport.filter((entry) => approved.has(entry.row.sourceRef));
  if (approvedRows.length === 0) {
    return { imported: 0, duplicates: 0, failed: [], importedRefs: [], createdCategories: 0 };
  }

  const ensured = await ensureCategories(ownerId, plan, existingCategories);
  const categories = ensured.categories;

  const byId = new Map<string, ExpenseCategory>(categories.map((category) => [category.id, category]));
  const byKey = new Map<string, ExpenseCategory>();
  // Oldest last → oldest wins, exactly like the CSV import.
  for (const category of [...categories].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    byKey.set(categoryMatchKey(category.name, category.type), category);
  }

  const now = new Date();
  const writes: ExpenseWrite[] = [];
  for (const entry of approvedRows) {
    const category = entry.categoryId ? byId.get(entry.categoryId) : byKey.get(categoryMatchKey(entry.categoryName, entry.type));
    if (!category) {
      // The plan said the category exists but it vanished between the read and the write: refuse
      // the row instead of writing an expense with no categoryId.
      continue;
    }
    const sub = entry.subCategoryName
      ? category.subCategories.find((candidate) => norm(candidate.name) === norm(entry.subCategoryName!))
      : undefined;
    const data = removeUndefinedDeep({
      userId: ownerId,
      type: entry.type,
      categoryId: category.id,
      categoryName: category.name,
      subCategoryId: sub?.id,
      subCategoryName: sub?.name,
      // Signed: a refund is POSITIVE in the spending category. `amountSign` makes the intent
      // explicit for a reader that only sees the document.
      amount: entry.row.amount,
      currency: entry.row.currency,
      date: Timestamp.fromDate(entry.row.date),
      notes: entry.notes,
      isRecurring: false,
      // No linkedCashAssetId: the broker's cash balance already reflects the card payment, and
      // moving a local cash account too would count the same euro twice.
      source: 'traderepublic-card',
      sourceRef: entry.row.sourceRef,
      sourceFingerprint: entry.row.fingerprint,
      amountSign: entry.row.amountSign,
      originalAmount: entry.row.originalAmount,
      originalCurrency: entry.row.originalCurrency,
      createdAt: now,
      updatedAt: now,
    });
    writes.push({
      ref: adminDb.collection(EXPENSES_COLLECTION).doc(cardExpenseDocId(ownerId, entry.row.sourceRef)),
      data,
      sourceRef: entry.row.sourceRef,
    });
  }

  let imported = 0;
  let duplicates = 0;
  const failed: { sourceRef: string; message: string }[] = [];
  const importedRefs: string[] = [];

  for (const group of chunk(writes, WRITE_CHUNK)) {
    const batch = adminDb.batch();
    for (const write of group) batch.create(write.ref, write.data);
    try {
      await batch.commit();
      imported += group.length;
      for (const write of group) importedRefs.push(write.sourceRef);
    } catch {
      // One existing id fails the whole batch; write the rest one by one so a single duplicate
      // cannot cost the user the other 399 rows.
      for (const write of group) {
        try {
          await write.ref.create(write.data);
          imported += 1;
          importedRefs.push(write.sourceRef);
        } catch (error) {
          if (isAlreadyExists(error)) duplicates += 1;
          else {
            failed.push({
              sourceRef: write.sourceRef,
              message: error instanceof Error ? error.message : 'Scrittura non riuscita.',
            });
          }
        }
      }
    }
  }

  return { imported, duplicates, failed, importedRefs, createdCategories: ensured.created };
}

/**
 * Apply the approved sourceRefs. The server re-derives the plan from the CURRENT timeline and
 * state, so only the intersection is written: a row that stopped being importable is refused.
 */
export async function applyCardExpenses(
  ownerId: string,
  timeline: unknown,
  approvedRefs: readonly string[]
): Promise<TrCardExpenseApplyResultDto> {
  const parsed = parseTrCardExpenses(timeline);
  const state = await readOwnerState(ownerId, parsed.rows);
  const plan = buildTrCardExpensePlan(parsed.rows, planStateOf(state), parsed.skipped);
  const approved = new Set(approvedRefs);
  // Narrow BEFORE writing: a category proposed for a row the user unchecked must not be created.
  const approvedPlan = restrictTrCardPlanToApproved(plan, approved);

  const written = await writeExpenses(ownerId, approvedPlan, approved, state.categories);

  // The ledger is what makes a later deletion stick. It is written only for rows that LANDED.
  if (written.importedRefs.length > 0) {
    await adminDb.collection(IMPORT_LEDGER_COLLECTION).doc(ownerId).set(
      {
        userId: ownerId,
        sourceRefs: FieldValue.arrayUnion(...written.importedRefs),
        updatedAt: new Date(),
      },
      { merge: true }
    );
  }

  // Rows that were imported once and are gone now: write the tombstone the preview only
  // inferred, so the state is explicit and survives a ledger rebuild.
  const newlyTombstoned = plan.removed
    .filter(
      (row) =>
        state.importedSourceRefs.has(row.sourceRef) &&
        !state.existingSourceRefs.has(row.sourceRef) &&
        !state.tombstonedSourceRefs.has(row.sourceRef)
    )
    .map((row) => row.sourceRef);
  if (newlyTombstoned.length > 0) await writeTombstones(ownerId, newlyTombstoned);

  if (written.imported > 0 || newlyTombstoned.length > 0) {
    await invalidateDashboardOverviewSummaryServer(ownerId, 'card_expenses_imported');
  }

  return {
    imported: written.imported,
    duplicates: written.duplicates,
    failed: written.failed,
    importedRefs: written.importedRefs,
    totalCardExpenses: state.existingSourceRefs.size + written.imported,
    createdCategories: written.createdCategories,
  };
}

async function writeTombstones(ownerId: string, sourceRefs: readonly string[]): Promise<void> {
  const now = new Date();
  for (const group of chunk([...new Set(sourceRefs)], WRITE_CHUNK)) {
    const batch = adminDb.batch();
    for (const sourceRef of group) {
      batch.set(
        adminDb.collection(TOMBSTONES_COLLECTION).doc(ownerId).collection('refs').doc(sourceRef),
        { userId: ownerId, sourceRef, deletedAt: now },
        { merge: true }
      );
    }
    await batch.commit();
  }
}

/**
 * Undo: delete the rows and record the tombstones in the same flow. The tombstones are written
 * even for a row that no longer exists, because the intent is what must survive the next sync.
 */
export async function undoCardExpenses(
  ownerId: string,
  sourceRefs: readonly string[]
): Promise<TrCardExpenseUndoResultDto> {
  const unique = [...new Set(sourceRefs)];
  if (unique.length === 0) return { deleted: 0 };

  const refs = unique.map((sourceRef) =>
    adminDb.collection(EXPENSES_COLLECTION).doc(cardExpenseDocId(ownerId, sourceRef))
  );
  let existing = 0;
  for (const group of chunk(refs, READ_CHUNK)) {
    if (group.length === 0) continue;
    const snapshots = await adminDb.getAll(...group);
    existing += snapshots.filter((snapshot) => snapshot.exists).length;
  }

  // 200 refs = 400 ops (delete + tombstone), under Firestore's 500-op batch limit.
  for (const group of chunk(unique, 200)) {
    const batch = adminDb.batch();
    for (const sourceRef of group) {
      batch.delete(adminDb.collection(EXPENSES_COLLECTION).doc(cardExpenseDocId(ownerId, sourceRef)));
      batch.set(
        adminDb.collection(TOMBSTONES_COLLECTION).doc(ownerId).collection('refs').doc(sourceRef),
        { userId: ownerId, sourceRef, deletedAt: new Date() },
        { merge: true }
      );
    }
    await batch.commit();
  }

  if (existing > 0) {
    await invalidateDashboardOverviewSummaryServer(ownerId, 'card_expenses_undone');
  }
  return { deleted: existing };
}

