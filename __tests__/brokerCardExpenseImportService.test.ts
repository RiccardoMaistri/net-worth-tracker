/**
 * Tests for the SERVER half of the Trade Republic card import — the write decisions the pure plan
 * cannot cover: `create()`-only (never overwrite an edit), only the approved refs, a deleted row
 * remembered by the ledger and the undo tombstone.
 *
 * Firestore is an in-memory fake, so these are tests of the service's DECISIONS, not of Firestore.
 * The in-memory `audit` of writes is load-bearing: a preview that writes, or an apply that writes
 * an unapproved ref, is caught by the audit even when the resulting data happens to look right.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  interface Ref {
    id: string;
    path: string;
    kind: 'expense' | 'category' | 'ledger' | 'tombstone';
    owner?: string;
  }

  const state = {
    expenses: new Map<string, Record<string, unknown>>(),
    categories: new Map<string, Record<string, unknown>>(),
    ledger: new Map<string, string[]>(),
    tombstones: new Map<string, Record<string, unknown>>(),
    categorySeq: 0,
    /** Simulates the read/write race: the existence check hides a ref that `create()` still sees. */
    hiddenFromGetAll: new Set<string>(),
    audit: [] as string[],
  };

  const snapshot = (id: string, data: Record<string, unknown> | undefined) => ({
    id,
    exists: data !== undefined,
    get: (field: string) => data?.[field],
    data: () => data,
  });

  function makeDoc(name: string, id: string): Ref & Record<string, unknown> {
    const base: Ref = {
      id,
      path: `${name}/${id}`,
      kind:
        name === 'expenses'
          ? 'expense'
          : name === 'expenseCategories'
            ? 'category'
            : name === 'brokerCardExpenseImports'
              ? 'ledger'
              : 'tombstone',
    };
    return {
      ...base,
      get: async () => {
        if (base.kind === 'expense') return snapshot(id, state.expenses.get(id));
        if (base.kind === 'ledger') {
          return snapshot(id, state.ledger.has(id) ? { sourceRefs: state.ledger.get(id) } : undefined);
        }
        if (base.kind === 'category') return snapshot(id, state.categories.get(id));
        return snapshot(id, state.tombstones.get(`${id}`));
      },
      create: async (data: Record<string, unknown>) => {
        state.audit.push(`create:expense:${id}`);
        if (state.expenses.has(id)) throw Object.assign(new Error('already exists'), { code: 6 });
        state.expenses.set(id, data);
      },
      update: async (patch: Record<string, unknown>) => {
        state.audit.push(`update:category:${id}`);
        const current = state.categories.get(id);
        if (current) state.categories.set(id, { ...current, ...patch });
      },
      set: async (data: Record<string, unknown>) => {
        state.audit.push(`set:ledger:${id}`);
        const union = (data['sourceRefs'] as { __arrayUnion?: string[] } | undefined)?.__arrayUnion ?? [];
        state.ledger.set(id, [...new Set([...(state.ledger.get(id) ?? []), ...union])]);
      },
      collection: (sub: string) => ({
        doc: (refId: string) => makeSubDoc(refId, id, sub),
        get: async () => ({
          docs: [...state.tombstones.entries()]
            .filter(([key]) => key.startsWith(`${name}/${id}/`))
            .map(([key, data]) => snapshot(key.split('/').pop() ?? key, data)),
        }),
      }),
    };
  }

  function makeSubDoc(refId: string, owner: string, sub: string): Ref & Record<string, unknown> {
    const path = `brokerExpenseTombstones/${owner}/${sub}/${refId}`;
    return {
      id: refId,
      path,
      kind: 'tombstone',
      owner,
      get: async () => snapshot(refId, state.tombstones.get(path)),
    };
  }

  const adminDb = {
    collection: (name: string) => ({
      doc: (id: string) => makeDoc(name, id),
      where: (_field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: [...state.categories.entries()]
            .filter(([, data]) => data['userId'] === value)
            .map(([id, data]) => snapshot(id, data)),
        }),
      }),
      add: async (data: Record<string, unknown>) => {
        const id = `cat-${++state.categorySeq}`;
        state.categories.set(id, data);
        state.audit.push(`add:category:${id}`);
        return { id };
      },
    }),
    getAll: async (...refs: { path: string; id: string }[]) =>
      refs.map((ref) =>
        snapshot(ref.id, state.hiddenFromGetAll.has(ref.id) ? undefined : state.expenses.get(ref.id))
      ),
    batch: () => {
      const ops: (() => void)[] = [];
      return {
        create: (ref: Ref, data: Record<string, unknown>) => {
          ops.push(() => {
            state.audit.push(`batchCreate:expense:${ref.id}`);
            if (state.expenses.has(ref.id)) throw Object.assign(new Error('already exists'), { code: 6 });
            state.expenses.set(ref.id, data);
          });
        },
        set: (ref: Ref, data: Record<string, unknown>) => {
          ops.push(() => {
            if (ref.kind === 'tombstone') {
              state.audit.push(`set:tombstone:${ref.path}`);
              state.tombstones.set(ref.path, data);
            } else if (ref.kind === 'ledger') {
              state.audit.push(`set:ledger:${ref.id}`);
              const union = (data['sourceRefs'] as { __arrayUnion?: string[] } | undefined)?.__arrayUnion ?? [];
              state.ledger.set(ref.id, [...new Set([...(state.ledger.get(ref.id) ?? []), ...union])]);
            }
          });
        },
        delete: (ref: Ref) => {
          ops.push(() => {
            state.audit.push(`delete:expense:${ref.id}`);
            state.expenses.delete(ref.id);
          });
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
  };

  return { state, adminDb, invalidate: vi.fn(async () => undefined) };
});

vi.mock('server-only', () => ({}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { arrayUnion: (...values: string[]) => ({ __arrayUnion: values }) },
  Timestamp: { fromDate: (date: Date) => ({ __timestamp: date.toISOString() }) },
}));
vi.mock('@/lib/firebase/admin', () => ({ adminDb: h.adminDb }));
vi.mock('@/lib/services/dashboardOverviewInvalidation.server', () => ({
  invalidateDashboardOverviewSummaryServer: h.invalidate,
}));

import {
  applyCardExpenses,
  buildCardExpensePreview,
  undoCardExpenses,
} from '@/lib/server/brokerCardExpenseImportService';

const OWNER = 'owner-1';

function timeline(ids: string[]): { items: Record<string, unknown>[] } {
  return {
    items: ids.map((id) => ({
      id,
      timestamp: '2026-10-14T10:00:00.000+0000',
      title: 'Esselunga',
      eventType: 'CARD_TRANSACTION',
      status: 'EXECUTED',
      amount: { value: -42.5, currency: 'EUR', fractionDigits: 2 },
    })),
  };
}

beforeEach(() => {
  h.state.expenses.clear();
  h.state.categories.clear();
  h.state.ledger.clear();
  h.state.tombstones.clear();
  h.state.audit.length = 0;
  h.state.categorySeq = 0;
  h.state.hiddenFromGetAll.clear();
  h.invalidate.mockClear();
});

describe('buildCardExpensePreview', () => {
  it('reads and plans without writing anything', async () => {
    const preview = await buildCardExpensePreview(OWNER, timeline(['tr-1']));
    expect(preview.toImport).toHaveLength(1);
    expect(preview.brokerCount).toBe(1);
    expect(h.state.audit).toHaveLength(0);
  });

  it('leaves a cash withdrawal out and says why, instead of importing it as a purchase', async () => {
    const preview = await buildCardExpensePreview(OWNER, {
      items: [
        ...timeline(['tr-1']).items,
        {
          ...timeline(['atm']).items[0],
          eventType: 'CARD_ATM_WITHDRAWAL',
          title: 'Cash Withdrawal',
        },
      ],
    });
    expect(preview.toImport.map((row) => row.sourceRef)).toEqual(['tr-1']);
    expect(preview.skipped).toMatchObject([{ sourceRef: 'atm' }]);
    expect(preview.skipped[0].reason).toContain('contanti');
    expect(h.state.audit).toHaveLength(0);
  });
});

describe('applyCardExpenses', () => {
  it('writes only approved refs, and creates only the categories those rows need', async () => {
    const result = await applyCardExpenses(OWNER, timeline(['tr-1', 'tr-2']), ['tr-1']);
    expect(result.imported).toBe(1);
    expect(h.state.expenses.has('tr_owner-1_tr-1')).toBe(true);
    expect(h.state.expenses.has('tr_owner-1_tr-2')).toBe(false);
    expect(h.state.audit.filter((entry) => entry.startsWith('batchCreate'))).toEqual([
      'batchCreate:expense:tr_owner-1_tr-1',
    ]);
    expect(result.createdCategories).toBe(1);
  });

  it('sees a second sync as already imported and never overwrites an edited document', async () => {
    await applyCardExpenses(OWNER, timeline(['tr-1']), ['tr-1']);
    (h.state.expenses.get('tr_owner-1_tr-1') as Record<string, unknown>)['notes'] = 'edited by user';

    const result = await applyCardExpenses(OWNER, timeline(['tr-1']), ['tr-1']);
    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(0);
    expect((h.state.expenses.get('tr_owner-1_tr-1') as Record<string, unknown>)['notes']).toBe(
      'edited by user'
    );
    expect(h.state.audit.filter((entry) => entry.startsWith('batchCreate'))).toHaveLength(1);
  });

  it('counts an ALREADY_EXISTS race as a duplicate, never an overwrite', async () => {
    await applyCardExpenses(OWNER, timeline(['tr-1']), ['tr-1']);
    // The document existed all along; only the read was stale. Clear the ledger too, so the plan
    // offers the row as NEW and the write reaches `create()` — the last line of defence.
    h.state.hiddenFromGetAll.add('tr_owner-1_tr-1');
    h.state.ledger.clear();

    const result = await applyCardExpenses(OWNER, timeline(['tr-1']), ['tr-1']);
    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(h.state.expenses.get('tr_owner-1_tr-1')).toBeDefined();
  });

  it('records the landed ref in the ledger, so a row deleted from Cashflow cannot be re-created', async () => {
    await applyCardExpenses(OWNER, timeline(['tr-1']), ['tr-1']);
    expect(h.state.ledger.get(OWNER)).toEqual(['tr-1']);

    // The user deletes the row in Cashflow; the broker still reports the movement.
    h.state.expenses.delete('tr_owner-1_tr-1');
    const preview = await buildCardExpensePreview(OWNER, timeline(['tr-1']));
    expect(preview.toImport).toHaveLength(0);
    expect(preview.removed.map((row) => row.sourceRef)).toEqual(['tr-1']);

    await applyCardExpenses(OWNER, timeline(['tr-1']), ['tr-1']);
    expect(h.state.expenses.has('tr_owner-1_tr-1')).toBe(false);
    expect(h.state.audit.some((entry) => entry.startsWith('set:tombstone'))).toBe(true);
  });
});

describe('undoCardExpenses', () => {
  it('deletes the rows and tombstones them, and the next apply cannot bring them back', async () => {
    await applyCardExpenses(OWNER, timeline(['tr-1']), ['tr-1']);
    const undone = await undoCardExpenses(OWNER, ['tr-1']);
    expect(undone.deleted).toBe(1);
    expect(h.state.expenses.has('tr_owner-1_tr-1')).toBe(false);
    expect([...h.state.tombstones.keys()].some((key) => key.endsWith('/tr-1'))).toBe(true);

    h.state.audit.length = 0;
    await applyCardExpenses(OWNER, timeline(['tr-1']), ['tr-1']);
    expect(h.state.audit.filter((entry) => entry.startsWith('batchCreate'))).toHaveLength(0);
    expect(h.state.expenses.has('tr_owner-1_tr-1')).toBe(false);
  });

  it('still tombstones a row that no longer exists, so the intent survives', async () => {
    const undone = await undoCardExpenses(OWNER, ['never-imported']);
    expect(undone.deleted).toBe(0);
    expect([...h.state.tombstones.keys()].some((key) => key.endsWith('/never-imported'))).toBe(true);
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
