/**
 * The pure rules of the monthly income override store plus the shape of its Firestore reads and
 * writes. The client SDK is mocked at the collection chain (the pensionContributionService pattern):
 * what is under test is the month key, the amount guard, the document path and the map a page reads.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'owner-uid';
const SERVER_TIMESTAMP = { __serverTimestamp: true };

const collectionMock = vi.fn();
const docMock = vi.fn();
const getDocsMock = vi.fn();
const setDocMock = vi.fn();
const deleteDocMock = vi.fn();

vi.mock('@/lib/firebase/config', () => ({ db: {} }));

vi.mock('firebase/firestore', () => ({
  collection: (...args: unknown[]) => collectionMock(...args),
  doc: (...args: unknown[]) => docMock(...args),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  deleteDoc: (...args: unknown[]) => deleteDocMock(...args),
  serverTimestamp: () => SERVER_TIMESTAMP,
}));

import {
  assertMonthKey,
  assertOverrideAmount,
  deleteMonthlyIncomeOverride,
  getMonthlyIncomeOverrides,
  isValidMonthKey,
  setMonthlyIncomeOverride,
  toOverrideAmountMap,
} from '@/lib/services/monthlyIncomeOverrideService';

function storedDoc(id: string, amount: unknown) {
  return {
    id,
    data: () => ({ amount, userId: OWNER, updatedAt: SERVER_TIMESTAMP }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  collectionMock.mockImplementation((_db: unknown, ...path: string[]) => ({ path }));
  docMock.mockImplementation((_db: unknown, ...path: string[]) => ({ path }));
  getDocsMock.mockResolvedValue({ docs: [] });
  setDocMock.mockResolvedValue(undefined);
  deleteDocMock.mockResolvedValue(undefined);
});

describe('the month key', () => {
  it('accepts only a zero-padded Italian calendar month', () => {
    expect(isValidMonthKey('2026-01')).toBe(true);
    expect(isValidMonthKey('2026-12')).toBe(true);
    for (const bad of ['2026-00', '2026-13', '2026-1', '26-01', '2026/01', '2026-01-01', '']) {
      expect(isValidMonthKey(bad), bad).toBe(false);
      expect(() => assertMonthKey(bad), bad).toThrow();
    }
  });
});

describe('the amount', () => {
  it('accepts any positive finite amount', () => {
    expect(() => assertOverrideAmount(0.01)).not.toThrow();
    expect(() => assertOverrideAmount(2500)).not.toThrow();
  });

  it('refuses non-positive and non-finite amounts — a caller removes the override instead', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => assertOverrideAmount(bad), String(bad)).toThrow();
    }
  });
});

describe('toOverrideAmountMap', () => {
  it('maps each stored month key to its amount, ignoring the metadata', () => {
    expect(
      toOverrideAmountMap([storedDoc('2026-01', 2500), storedDoc('2025-12', 1800.5)])
    ).toEqual({ '2026-01': 2500, '2025-12': 1800.5 });
  });

  it('throws on a broken stored month or amount instead of silently showing the fixed salary', () => {
    expect(() => toOverrideAmountMap([storedDoc('2026-13', 100)])).toThrow();
    expect(() => toOverrideAmountMap([storedDoc('2026-01', '2500')])).toThrow();
    expect(() => toOverrideAmountMap([storedDoc('2026-01', 0)])).toThrow();
  });
});

describe('getMonthlyIncomeOverrides', () => {
  it('reads the owner’s months subcollection and returns the month-keyed map', async () => {
    getDocsMock.mockResolvedValue({ docs: [storedDoc('2026-02', 3100)] });

    await expect(getMonthlyIncomeOverrides(OWNER)).resolves.toEqual({ '2026-02': 3100 });
    expect(collectionMock).toHaveBeenCalledWith(expect.anything(), 'monthlyIncomeOverrides', OWNER, 'months');
    expect(getDocsMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed read instead of answering an empty map', async () => {
    getDocsMock.mockRejectedValueOnce(new Error('firestore unavailable'));
    await expect(getMonthlyIncomeOverrides(OWNER)).rejects.toThrow('firestore unavailable');
  });
});

describe('setMonthlyIncomeOverride', () => {
  it('stamps the owner and the correction under the month document', async () => {
    await setMonthlyIncomeOverride(OWNER, '2026-03', 2750);

    expect(docMock).toHaveBeenCalledWith(expect.anything(), 'monthlyIncomeOverrides', OWNER, 'months', '2026-03');
    expect(setDocMock).toHaveBeenCalledTimes(1);
    expect(setDocMock.mock.calls[0][0]).toEqual({ path: ['monthlyIncomeOverrides', OWNER, 'months', '2026-03'] });
    expect(setDocMock.mock.calls[0][1]).toEqual({
      amount: 2750,
      userId: OWNER,
      updatedAt: SERVER_TIMESTAMP,
    });
  });

  it('refuses a bad key or amount before any write', async () => {
    await expect(setMonthlyIncomeOverride(OWNER, '2026-03-01', 100)).rejects.toThrow();
    await expect(setMonthlyIncomeOverride(OWNER, '2026-03', 0)).rejects.toThrow();
    expect(setDocMock).not.toHaveBeenCalled();
  });
});

describe('deleteMonthlyIncomeOverride', () => {
  it('deletes only that month document', async () => {
    await deleteMonthlyIncomeOverride(OWNER, '2026-04');

    expect(deleteDocMock).toHaveBeenCalledWith({
      path: ['monthlyIncomeOverrides', OWNER, 'months', '2026-04'],
    });
  });

  it('refuses a bad month key before any delete', async () => {
    await expect(deleteMonthlyIncomeOverride(OWNER, 'month')).rejects.toThrow();
    expect(deleteDocMock).not.toHaveBeenCalled();
  });
});
