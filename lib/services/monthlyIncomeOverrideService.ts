/**
 * Client-SDK storage for the owner's manual monthly income corrections:
 * monthlyIncomeOverrides/{ownerUid}/months/{YYYY-MM}.
 *
 * A document holds the corrected income for ONE Italian calendar month and wins over the fixed
 * salary setting. The month is the document id (zero-padded, so keys sort chronologically), the
 * `userId` stamp is what the Firestore rules check, and `updatedAt` records the correction's age.
 * Reads are one collection read under the owner, with no query constraints: the nested path already
 * carries the ownership the rules need, so a list hits no composite index and an owner with no
 * overrides simply gets an empty map. Failures propagate to the hook instead of becoming `{}`.
 *
 * Writes are deliberately tiny and unconditional: a correction is set or removed as a whole, so
 * there is no partial payload to reconcile and no server route in front of this service. The caller
 * (a hook mutation) invalidates `queryKeys.monthlyIncomeOverrides.all(ownerId)` after each write.
 */

import { collection, deleteDoc, doc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase/config';

export const MONTHLY_INCOME_OVERRIDES_COLLECTION = 'monthlyIncomeOverrides';
const MONTHS_SUBCOLLECTION = 'months';

/** A zero-padded Italian calendar month — the shape of every document id in this collection. */
const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Whether `key` names a calendar month as `YYYY-MM` (January is `01`, not `1`). */
export function isValidMonthKey(key: string): boolean {
  return MONTH_KEY_PATTERN.test(key);
}

/** Refuse a key that cannot be a document id here, before any I/O. */
export function assertMonthKey(key: string): void {
  if (!isValidMonthKey(key)) {
    throw new Error(`Invalid monthly income override month key: ${key}`);
  }
}

/**
 * A correction of zero or less is meaningless: removing the override restores the fixed salary,
 * which is the caller's action for "no income this month". Reject non-finite amounts too — a
 * `NaN` written to Firestore would poison every figure that reads the map.
 */
export function assertOverrideAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('A monthly income override amount must be a positive finite number');
  }
}

/**
 * Stored documents → the `YYYY-MM` → EUR lookup the pages read. A stored doc with a broken key or
 * amount throws: swallowing it would show the fixed salary as if the user had never corrected it.
 * `updatedAt` is metadata only and needs no conversion for this map.
 */
export function toOverrideAmountMap(
  docs: ReadonlyArray<{ id: string; data: () => Record<string, unknown> }>,
): Record<string, number> {
  const amounts: Record<string, number> = {};
  for (const snap of docs) {
    assertMonthKey(snap.id);
    const storedAmount = snap.data().amount;
    const amount = typeof storedAmount === 'number' ? storedAmount : Number.NaN;
    assertOverrideAmount(amount);
    amounts[snap.id] = amount;
  }
  return amounts;
}

function overridesCollection(ownerId: string) {
  return collection(db, MONTHLY_INCOME_OVERRIDES_COLLECTION, ownerId, MONTHS_SUBCOLLECTION);
}

function overrideDoc(ownerId: string, monthKey: string) {
  assertMonthKey(monthKey);
  return doc(db, MONTHLY_INCOME_OVERRIDES_COLLECTION, ownerId, MONTHS_SUBCOLLECTION, monthKey);
}

/** Every override of the owner, keyed by its Italian calendar month. */
export async function getMonthlyIncomeOverrides(ownerId: string): Promise<Record<string, number>> {
  const snapshot = await getDocs(overridesCollection(ownerId));
  return toOverrideAmountMap(snapshot.docs);
}

/** Create or replace the correction for one month. A non-positive amount is refused. */
export async function setMonthlyIncomeOverride(
  ownerId: string,
  monthKey: string,
  amount: number,
): Promise<void> {
  assertOverrideAmount(amount);
  await setDoc(overrideDoc(ownerId, monthKey), {
    amount,
    userId: ownerId,
    updatedAt: serverTimestamp(),
  });
}

/** Remove a correction, restoring the fixed salary for that month. Missing docs are a no-op. */
export async function deleteMonthlyIncomeOverride(ownerId: string, monthKey: string): Promise<void> {
  await deleteDoc(overrideDoc(ownerId, monthKey));
}
