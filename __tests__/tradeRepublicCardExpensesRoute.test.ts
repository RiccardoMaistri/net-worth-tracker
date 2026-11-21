/**
 * Contract test for POST /api/broker/traderepublic/card-expenses.
 *
 * The three actions share one route and one owner check, but they must NOT share a write path:
 * `preview` never writes, `apply` re-reads the broker timeline and writes only the approved refs,
 * and `undo` deletes + tombstones WITHOUT reading the broker at all (a dead session must never
 * stop a user from undoing an import). Those dispatch guarantees are pinned here; the money math
 * and idempotency live in the pure-plan suite and the server-service suite.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  readTrCardExpenseTimeline: vi.fn(async (): Promise<unknown> => ({ items: [] })),
  buildCardExpensePreview: vi.fn(async () => ({ brokerCount: 0, toImport: [] })),
  applyCardExpenses: vi.fn(async () => ({ imported: 0 })),
  undoCardExpenses: vi.fn(async () => ({ deleted: 0 })),
  requireFirebaseAuth: vi.fn(async () => ({ uid: 'viewer-1' })),
  assertCanAccessAccount: vi.fn(async () => undefined),
  getApiAuthErrorResponse: vi.fn(() => null),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/firebase/config', () => ({ auth: { currentUser: null }, db: {} }));
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }));
vi.mock('@/lib/server/apiAuth', () => ({
  requireFirebaseAuth: mocks.requireFirebaseAuth,
  assertCanAccessAccount: mocks.assertCanAccessAccount,
  getApiAuthErrorResponse: mocks.getApiAuthErrorResponse,
}));
vi.mock('@/lib/server/tradeRepublicClient', () => ({
  readTrCardExpenseTimeline: mocks.readTrCardExpenseTimeline,
  TradeRepublicAuthError: class TradeRepublicAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  TradeRepublicReadError: class TradeRepublicReadError extends Error {},
}));
vi.mock('@/lib/server/brokerCardExpenseImportService', () => ({
  buildCardExpensePreview: mocks.buildCardExpensePreview,
  applyCardExpenses: mocks.applyCardExpenses,
  undoCardExpenses: mocks.undoCardExpenses,
}));

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/broker/traderepublic/card-expenses', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import('@/app/api/broker/traderepublic/card-expenses/route');
  const response = await POST(request(body));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('POST /api/broker/traderepublic/card-expenses', () => {
  beforeEach(() => {
    mocks.readTrCardExpenseTimeline.mockReset();
    mocks.readTrCardExpenseTimeline.mockResolvedValue({ items: [] });
    mocks.buildCardExpensePreview.mockReset();
    mocks.buildCardExpensePreview.mockResolvedValue({ brokerCount: 0, toImport: [] });
    mocks.applyCardExpenses.mockReset();
    mocks.applyCardExpenses.mockResolvedValue({ imported: 0 });
    mocks.undoCardExpenses.mockReset();
    mocks.undoCardExpenses.mockResolvedValue({ deleted: 0 });
    mocks.requireFirebaseAuth.mockReset();
    mocks.requireFirebaseAuth.mockResolvedValue({ uid: 'viewer-1' });
    mocks.assertCanAccessAccount.mockReset();
    mocks.assertCanAccessAccount.mockResolvedValue(undefined);
    mocks.getApiAuthErrorResponse.mockReset();
    mocks.getApiAuthErrorResponse.mockReturnValue(null);
  });

  it('previews by reading the broker and planning — with no write', async () => {
    const { status } = await post({ ownerId: 'owner-1', action: 'preview' });
    expect(status).toBe(200);
    expect(mocks.readTrCardExpenseTimeline).toHaveBeenCalledWith('owner-1');
    expect(mocks.buildCardExpensePreview).toHaveBeenCalledWith('owner-1', { items: [] });
    expect(mocks.applyCardExpenses).not.toHaveBeenCalled();
    expect(mocks.undoCardExpenses).not.toHaveBeenCalled();
  });

  it('re-reads the broker on apply and writes only the approved refs', async () => {
    mocks.readTrCardExpenseTimeline.mockResolvedValue({ items: [{ id: 'tr-1' }] });
    const { status } = await post({ ownerId: 'owner-1', action: 'apply', refs: ['tr-1'] });
    expect(status).toBe(200);
    expect(mocks.readTrCardExpenseTimeline).toHaveBeenCalledWith('owner-1');
    expect(mocks.applyCardExpenses).toHaveBeenCalledWith('owner-1', { items: [{ id: 'tr-1' }] }, [
      'tr-1',
    ]);
  });

  it('undoes WITHOUT reading the broker, so a dead session cannot block a rollback', async () => {
    const { status } = await post({ ownerId: 'owner-1', action: 'undo', refs: ['tr-1'] });
    expect(status).toBe(200);
    expect(mocks.undoCardExpenses).toHaveBeenCalledWith('owner-1', ['tr-1']);
    expect(mocks.readTrCardExpenseTimeline).not.toHaveBeenCalled();
    expect(mocks.applyCardExpenses).not.toHaveBeenCalled();
  });

  it('checks ownership with the OWNER id, never the viewer uid', async () => {
    await post({ ownerId: 'owner-1', action: 'preview' });
    expect(mocks.assertCanAccessAccount).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'viewer-1' }),
      'owner-1'
    );
  });

  it('rejects a missing action or empty refs with 400, before reading anything', async () => {
    expect((await post({ ownerId: 'owner-1' })).status).toBe(400);
    expect((await post({ ownerId: 'owner-1', action: 'sell' })).status).toBe(400);
    expect((await post({ ownerId: 'owner-1', action: 'apply', refs: [] })).status).toBe(400);
    expect(mocks.readTrCardExpenseTimeline).not.toHaveBeenCalled();
    expect(mocks.assertCanAccessAccount).not.toHaveBeenCalled();
  });

  it('maps an unauthorized viewer to 403 and reads nothing', async () => {
    mocks.assertCanAccessAccount.mockRejectedValue(new Error('no'));
    const { status } = await post({ ownerId: 'owner-1', action: 'preview' });
    expect(status).toBe(403);
    expect(mocks.readTrCardExpenseTimeline).not.toHaveBeenCalled();
  });

  it('maps a dead session to its own status and a broker outage to 502', async () => {
    const { TradeRepublicAuthError, TradeRepublicReadError } = await import(
      '@/lib/server/tradeRepublicClient'
    );
    mocks.readTrCardExpenseTimeline.mockRejectedValueOnce(
      new TradeRepublicAuthError('La sessione Trade Republic è scaduta.', 401)
    );
    expect((await post({ ownerId: 'owner-1', action: 'preview' })).status).toBe(401);

    mocks.readTrCardExpenseTimeline.mockRejectedValueOnce(new TradeRepublicReadError('offline'));
    expect((await post({ ownerId: 'owner-1', action: 'preview' })).status).toBe(502);
  });

  it('answers an unauthenticated request with 401', async () => {
    mocks.requireFirebaseAuth.mockRejectedValue(new Error('no token'));
    const { status } = await post({ ownerId: 'owner-1', action: 'preview' });
    expect(status).toBe(401);
  });
});
