import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The broker import's IDEMPOTENCY, and the provenance fields it writes.
 *
 * This is the test that pins the one property the whole feature rests on: running the import twice
 * must not double a position. The failure it guards against is not hypothetical — a user who
 * presses «Importa» again, or opens the preview in two tabs, would otherwise re-write every trade
 * in their history, and the replay would then report double the quantity, double the cost basis and
 * a realized P&L that is simply wrong.
 *
 * It runs the REAL use-case transaction body against the same in-memory Firestore harness as
 * `assetTransactionWriteTx.test.ts`, including the SDK's «all reads before all writes» rule, so the
 * guard is proven to sit INSIDE the transaction and not in a pre-flight read that a concurrent sync
 * could interleave with.
 */

const mocks = vi.hoisted(() => ({
  store: new Map<string, Record<string, unknown>>(),
  counter: { next: 0 },
  invalidate: vi.fn().mockResolvedValue(undefined),
}));
const store = mocks.store;
const docKey = (collection: string, id: string) => `${collection}/${id}`;

vi.mock('server-only', () => ({}));

vi.mock('@/lib/server/tradeFxService', () => ({
  resolveTradePriceEur: vi.fn(async (_currency: string, pricePerUnit: number) => pricePerUnit),
  resolveRateToEur: vi.fn(async (currency: string) => (currency.toUpperCase() === 'EUR' ? 1 : 0.87)),
  resolveBaselinePriceEur: vi.fn(
    async (asset: { averageCost?: number; currentPrice: number }) => asset.averageCost ?? asset.currentPrice
  ),
  TradeFxUnavailableError: class TradeFxUnavailableError extends Error {},
}));

vi.mock('@/lib/services/dashboardOverviewInvalidation.server', () => ({
  invalidateDashboardOverviewSummaryServer: (...args: unknown[]) => mocks.invalidate(...args),
}));

vi.mock('@/lib/server/assetAdminRepository', () => ({
  getUserAssetsAdmin: vi.fn(async () => []),
}));

vi.mock('@/lib/firebase/admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { FieldValue } = require('firebase-admin/firestore');
  const key = (collection: string, id: string) => `${collection}/${id}`;
  type Filter = { field: string; value: unknown };
  const { store, counter } = mocks;

  const makeDocRef = (collection: string, id: string) => ({
    id,
    _collection: collection,
    get: async () => {
      const data = store.get(key(collection, id));
      return { exists: data !== undefined, id, data: () => data };
    },
  });
  const makeQuery = (collection: string, filters: Filter[]): Record<string, unknown> => ({
    _collection: collection,
    _filters: filters,
    where: (field: string, _op: string, value: unknown) =>
      makeQuery(collection, [...filters, { field, value }]),
    run: () => {
      const docs: { id: string; data: () => Record<string, unknown> }[] = [];
      for (const [k, value] of store) {
        if (!k.startsWith(`${collection}/`)) continue;
        if (filters.every((f) => value[f.field] === f.value)) {
          docs.push({ id: k.slice(collection.length + 1), data: () => value });
        }
      }
      return { docs };
    },
  });

  const adminDb = {
    collection: (name: string) => ({
      doc: (id?: string) => makeDocRef(name, id ?? `auto-${++counter.next}`),
      where: (field: string, _op: string, value: unknown) => makeQuery(name, [{ field, value }]),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      let hasWritten = false;
      const pending: { type: 'set' | 'update' | 'delete'; collection: string; id: string; data?: Record<string, unknown> }[] = [];
      const tx = {
        get: async (refOrQuery: { _collection: string; id?: string; _filters?: Filter[]; run?: () => unknown }) => {
          if (hasWritten) {
            throw new Error('Firestore transactions require all reads to be executed before all writes.');
          }
          if (refOrQuery._filters) return refOrQuery.run!();
          const data = store.get(key(refOrQuery._collection, refOrQuery.id as string));
          return { exists: data !== undefined, id: refOrQuery.id, data: () => data };
        },
        set: (ref: { _collection: string; id: string }, data: Record<string, unknown>) => {
          hasWritten = true;
          pending.push({ type: 'set', collection: ref._collection, id: ref.id, data });
        },
        update: (ref: { _collection: string; id: string }, data: Record<string, unknown>) => {
          hasWritten = true;
          pending.push({ type: 'update', collection: ref._collection, id: ref.id, data });
        },
        delete: (ref: { _collection: string; id: string }) => {
          hasWritten = true;
          pending.push({ type: 'delete', collection: ref._collection, id: ref.id });
        },
      };

      await fn(tx);

      for (const write of pending) {
        const k = key(write.collection, write.id);
        if (write.type === 'delete') {
          store.delete(k);
          continue;
        }
        if (write.type === 'set') {
          store.set(k, { ...(write.data as Record<string, unknown>) });
          continue;
        }
        const merged = { ...(store.get(k) ?? {}) };
        for (const [field, value] of Object.entries(write.data as Record<string, unknown>)) {
          if (value instanceof FieldValue) delete merged[field];
          else merged[field] = value;
        }
        store.set(k, merged);
      }
    },
  };

  return { adminDb };
});

import {
  createAssetTransaction,
  DuplicateBrokerTradeError,
} from '@/lib/server/assetTransactionUseCase';

const OWNER = 'owner-1';

function seedLedger() {
  store.set(docKey('assetTransactionsMeta', OWNER), {
    userId: OWNER,
    baselineDate: new Date(2024, 0, 1),
  });
  store.set(docKey('assets', 'asset-1'), {
    userId: OWNER,
    type: 'etf',
    assetClass: 'equity',
    currency: 'EUR',
    quantity: 0,
  });
}

/** One imported BUY, exactly as the importer writes it. */
function importedBuy(sourceRef: string, overrides: Record<string, unknown> = {}) {
  return {
    assetId: 'asset-1',
    type: 'buy' as const,
    date: new Date(2026, 0, 15),
    quantity: 10,
    pricePerUnit: 100,
    source: 'scalable' as const,
    sourceRef,
    ...overrides,
  };
}

describe('broker trade import — idempotency and provenance', () => {
  beforeEach(() => {
    store.clear();
    mocks.counter.next = 0;
    seedLedger();
  });

  it('writes the provenance pair onto the trade doc', async () => {
    const result = await createAssetTransaction(OWNER, importedBuy('tr-1'));
    const doc = store.get(docKey('assetTransactions', result.transactionId))!;
    expect(doc.source).toBe('scalable');
    expect(doc.sourceRef).toBe('tr-1');
  });

  it('refuses a second import of the same broker id instead of duplicating the position', async () => {
    await createAssetTransaction(OWNER, importedBuy('tr-1'));
    // The ledger now holds 10 units. A second write would double it AND corrupt the cost basis,
    // so the guard has to fire before any write, not after.
    expect(store.get(docKey('assets', 'asset-1'))!.quantity).toBe(10);

    await expect(createAssetTransaction(OWNER, importedBuy('tr-1'))).rejects.toBeInstanceOf(
      DuplicateBrokerTradeError
    );

    // Untouched: one trade, 10 units.
    const trades = [...store.entries()].filter(([key]) => key.startsWith('assetTransactions/'));
    expect(trades).toHaveLength(1);
    expect(store.get(docKey('assets', 'asset-1'))!.quantity).toBe(10);
  });

  it('treats the same id from a DIFFERENT broker as a different trade', async () => {
    await createAssetTransaction(OWNER, importedBuy('shared-id'));
    // Broker ids are per-broker, so the key is (source, sourceRef) and not sourceRef alone.
    // Without the source in the key, importing from Trade Republic after Scalable would be a
    // silent no-op — and a user's real TR history would never land.
    await expect(
      createAssetTransaction(OWNER, importedBuy('shared-id', { source: 'traderepublic' }))
    ).resolves.toBeTruthy();
    expect(store.get(docKey('assets', 'asset-1'))!.quantity).toBe(20);
  });

  it('never lets a hand-entered trade (no provenance) claim a broker key', async () => {
    await createAssetTransaction(OWNER, importedBuy('tr-1'));
    // A manual trade carries no source, so it cannot collide with the import's identity and is not
    // blocked by it. Only the import path is guarded.
    const manual = await createAssetTransaction(OWNER, {
      assetId: 'asset-1',
      type: 'buy',
      date: new Date(2026, 1, 1),
      quantity: 5,
      pricePerUnit: 50,
    });
    expect(store.get(docKey('assetTransactions', manual.transactionId))!.source).toBeUndefined();
    expect(store.get(docKey('assets', 'asset-1'))!.quantity).toBe(15);
  });

  it('preserves provenance when the user later EDITS the imported trade', async () => {
    const created = await createAssetTransaction(OWNER, importedBuy('tr-1'));
    // The edit path builds its doc data from the stored trade, so source/sourceRef must survive it:
    // losing them would make the next sync re-import the trade on top of the user's correction.
    const { updateAssetTransaction } = await import('@/lib/server/assetTransactionUseCase');
    await updateAssetTransaction(OWNER, created.transactionId, { quantity: 12 });
    const doc = store.get(docKey('assetTransactions', created.transactionId))!;
    expect(doc.source).toBe('scalable');
    expect(doc.sourceRef).toBe('tr-1');
    expect(doc.quantity).toBe(12);
  });
});
