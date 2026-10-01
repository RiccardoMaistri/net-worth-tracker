/**
 * Contract tests for the two broker TRADE routes (POST /api/broker/{scalable,traderepublic}/trades).
 *
 * Each route is a two-mode conversation — `{ ownerId }` previews, `{ ownerId, apply }` writes —
 * and the mode is what these pin. The dangerous misread is the opposite one: a client that meant
 * to preview and accidentally sends `apply: []`, or an empty list treated as «import everything».
 * So `apply: []` is asserted to reach the writer with an EMPTY selection, never to widen it.
 *
 * The broker reader and the import service are mocked: what is under test is the route's own
 * contract (auth → profile whitelist → ownership → validate → delegate), not the parsing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireFirebaseAuth: vi.fn(),
  assertCanAccessAccount: vi.fn(async () => undefined),
  getApiAuthErrorResponse: vi.fn(() => null),
  getScalableProfileForEmail: vi.fn(() => ({ profile: 'riccardo' })),
  getTrades: vi.fn(async () => ({ list: { items: [] }, details: {} })),
  readTrTradeHistory: vi.fn(async () => ({ timeline: [], details: {} })),
  buildBrokerTradePreview: vi.fn(async () => ({ toImport: [], alreadyImported: [], skipped: [], parserSkipped: [], brokerCount: 0 })),
  importBrokerTrades: vi.fn(async () => ({ imported: 0, duplicates: 0, failed: [], realizedPnlEur: 0 })),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/firebase/config', () => ({ auth: { currentUser: null }, db: {} }));
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }));
vi.mock('@/lib/server/apiAuth', () => ({
  requireFirebaseAuth: mocks.requireFirebaseAuth,
  assertCanAccessAccount: mocks.assertCanAccessAccount,
  getApiAuthErrorResponse: mocks.getApiAuthErrorResponse,
}));
vi.mock('@/lib/server/scalableService', () => ({
  getScalableProfileForEmail: mocks.getScalableProfileForEmail,
  ScalableService: { getTrades: mocks.getTrades },
}));
vi.mock('@/lib/server/scalableCli', () => ({
  ScalableCliError: class ScalableCliError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock('@/lib/server/tradeRepublicClient', () => ({
  readTrTradeHistory: mocks.readTrTradeHistory,
  TradeRepublicAuthError: class TradeRepublicAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  TradeRepublicReadError: class TradeRepublicReadError extends Error {},
}));
vi.mock('@/lib/server/brokerTradeImportService', () => ({
  buildBrokerTradePreview: mocks.buildBrokerTradePreview,
  importBrokerTrades: mocks.importBrokerTrades,
}));

function request(broker: 'scalable' | 'traderepublic', body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/broker/${broker}/trades`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function post(
  broker: 'scalable' | 'traderepublic',
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } =
    broker === 'scalable'
      ? await import('@/app/api/broker/scalable/trades/route')
      : await import('@/app/api/broker/traderepublic/trades/route');
  const response = await POST(request(broker, body));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe.each(['scalable', 'traderepublic'] as const)('POST /api/broker/%s/trades', (broker) => {
  beforeEach(() => {
    mocks.requireFirebaseAuth.mockReset().mockResolvedValue({ uid: 'owner-1', email: 'rykymai@gmail.com' });
    mocks.assertCanAccessAccount.mockReset().mockResolvedValue(undefined);
    mocks.getScalableProfileForEmail.mockReset().mockReturnValue({ profile: 'riccardo' });
    mocks.getTrades.mockReset().mockResolvedValue({ list: { items: [] }, details: {} });
    mocks.readTrTradeHistory.mockReset().mockResolvedValue({ timeline: [], details: {} });
    mocks.buildBrokerTradePreview.mockReset();
    mocks.importBrokerTrades.mockReset();
  });

  it('previews without writing when `apply` is absent', async () => {
    mocks.buildBrokerTradePreview.mockResolvedValue({ brokerCount: 3 } as never);
    const { status, body } = await post(broker, { ownerId: 'owner-1' });
    expect(status).toBe(200);
    expect(body.brokerCount).toBe(3);
    expect(mocks.importBrokerTrades).not.toHaveBeenCalled();
  });

  it('writes only the approved broker ids when `apply` is present', async () => {
    await post(broker, { ownerId: 'owner-1', apply: ['abc123', 'def456'] });
    expect(mocks.importBrokerTrades).toHaveBeenCalledTimes(1);
    expect((mocks.importBrokerTrades.mock.calls[0] as unknown[])[3]).toEqual(['abc123', 'def456']);
  });

  it('treats an EMPTY `apply` as «write nothing», not as «import everything»', async () => {
    await post(broker, { ownerId: 'owner-1', apply: [] });
    expect(mocks.importBrokerTrades).toHaveBeenCalledWith(expect.anything(), broker, expect.anything(), []);
    expect(mocks.buildBrokerTradePreview).not.toHaveBeenCalled();
  });

  it('refuses a body with no ownerId, without reading the broker', async () => {
    const { status } = await post(broker, { apply: ['abc123'] });
    expect(status).toBe(400);
    expect(mocks.getTrades).not.toHaveBeenCalled();
    expect(mocks.readTrTradeHistory).not.toHaveBeenCalled();
  });

  it('rejects an apply id that is not a bare broker id, so nothing reaches a shell or a path', async () => {
    const { status } = await post(broker, { ownerId: 'owner-1', apply: ['../etc/passwd'] });
    expect(status).toBe(400);
    expect(mocks.importBrokerTrades).not.toHaveBeenCalled();
  });

  it('refuses an account the caller does not own or share', async () => {
    mocks.assertCanAccessAccount.mockRejectedValue(new Error('Forbidden'));
    mocks.getApiAuthErrorResponse.mockReturnValueOnce(null);
    const { status } = await post(broker, { ownerId: 'someone-else' });
    expect(status).toBe(403);
    expect(mocks.importBrokerTrades).not.toHaveBeenCalled();
  });
});

describe('POST /api/broker/scalable/trades — profile gate', () => {
  beforeEach(() => {
    mocks.requireFirebaseAuth.mockReset().mockResolvedValue({ uid: 'owner-1', email: 'unknown@example.com' });
    mocks.getScalableProfileForEmail.mockReset().mockReturnValue(null as unknown as { profile: string });
  });

  it('refuses an email with no `sc` profile, before reading anything', async () => {
    // The CLI session lives in that profile's directory on this machine; an unlisted email has no
    // session to read, and a route that tried would be reaching into someone else's config.
    const { status } = await post('scalable', { ownerId: 'owner-1' });
    expect(status).toBe(403);
    expect(mocks.getTrades).not.toHaveBeenCalled();
  });
});

describe('POST /api/broker/traderepublic/trades — dead session', () => {
  beforeEach(() => {
    mocks.requireFirebaseAuth.mockReset().mockResolvedValue({ uid: 'owner-1', email: 'rykymai@gmail.com' });
    mocks.assertCanAccessAccount.mockReset().mockResolvedValue(undefined);
    mocks.getApiAuthErrorResponse.mockReset().mockReturnValue(null);
  });

  it('maps a dead session to its own status so the UI can ask for a re-link', async () => {
    const { TradeRepublicAuthError } = await import('@/lib/server/tradeRepublicClient');
    mocks.readTrTradeHistory.mockRejectedValueOnce(
      new TradeRepublicAuthError('La sessione Trade Republic è scaduta: ricollegati con il codice QR.', 401)
    );
    const { status, body } = await post('traderepublic', { ownerId: 'owner-1' });
    expect(status).toBe(401);
    expect(body.error).toContain('scaduta');
  });
});
