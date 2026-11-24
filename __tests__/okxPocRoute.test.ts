/**
 * Contract test for POST /api/broker/okx/poc.
 *
 * Pins the answer the future tile will read: the coins merged per currency with OKX's own spot
 * P&L, the derivatives kept apart, the read warnings surfaced, and the error mapping (503 when the
 * key is missing, 401 when OKX refuses it). The credentials never travel in the body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  canUseOkx: vi.fn(() => true),
  isOkxConfigured: vi.fn(() => true),
  readOkxAccount: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/firebase/config', () => ({ auth: { currentUser: null }, db: {} }));
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }));
vi.mock('@/lib/server/apiAuth', () => ({
  requireFirebaseAuth: vi.fn(async () => ({ uid: 'owner-1', email: 'rykymai@gmail.com' })),
  assertCanAccessAccount: vi.fn(async () => undefined),
  getApiAuthErrorResponse: vi.fn(() => null),
}));
vi.mock('@/lib/utils/okxAccess', () => ({ canUseOkx: mocks.canUseOkx }));
vi.mock('@/lib/services/currencyConversionService', () => ({
  getExchangeRateToEur: vi.fn(async () => 0.9),
}));
vi.mock('@/lib/server/okxClient', async () => {
  class OkxConfigError extends Error {
    constructor() {
      super('Collegamento OKX non configurato.');
    }
  }
  class OkxReadError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    OkxConfigError,
    OkxReadError,
    isOkxConfigured: mocks.isOkxConfigured,
    isOkxDemo: () => false,
    okxBaseUrl: () => 'https://eea.okx.com',
    readOkxAccount: mocks.readOkxAccount,
  };
});

async function post(body: unknown = { ownerId: 'owner-1' }): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const { POST } = await import('@/app/api/broker/okx/poc/route');
  const response = await POST(
    new NextRequest('http://localhost/api/broker/okx/poc', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    headers: response.headers,
  };
}

describe('POST /api/broker/okx/poc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canUseOkx.mockReturnValue(true);
    mocks.isOkxConfigured.mockReturnValue(true);
    mocks.readOkxAccount.mockResolvedValue({
      balance: [
        {
          totalEq: '7800',
          details: [
            {
              ccy: 'BTC',
              cashBal: '0.1',
              spotBal: '0.1',
              eqUsd: '6500',
              openAvgPx: '60000',
              spotUpl: '500',
              spotUplRatio: '0.0833',
              accAvgPx: '59000',
              totalPnl: '600',
              totalPnlRatio: '0.1',
            },
            {
              ccy: 'USDT',
              cashBal: '1300',
              spotBal: '',
              eqUsd: '1300',
              openAvgPx: '',
              spotUpl: '',
              spotUplRatio: '',
              accAvgPx: '',
              totalPnl: '',
              totalPnlRatio: '',
            },
          ],
        },
      ],
      funding: [{ ccy: 'BTC', bal: '0.02', availBal: '0.02' }],
      positions: [
        {
          instId: 'ETH-USDT-SWAP',
          instType: 'SWAP',
          posSide: 'long',
          pos: '2',
          avgPx: '3000',
          markPx: '3100',
          notionalUsd: '6200',
          upl: '200',
          uplRatio: '0.033',
          lever: '3',
          mgnMode: 'cross',
        },
      ],
      tickers: [{ instId: 'BTC-USDT', last: '65000' }],
      warnings: ['Conto funding non letto: timeout'],
    });
  });

  it('answers the holdings with OKX’s spot P&L, the derivatives apart and the read warnings', async () => {
    const { status, body, headers } = await post();
    expect(status).toBe(200);

    const portfolio = body['portfolio'] as Record<string, unknown>;
    const holdings = portfolio['holdings'] as Array<Record<string, unknown>>;
    const btc = holdings.find((holding) => holding['ccy'] === 'BTC');
    expect(btc?.quantity).toBeCloseTo(0.12);
    expect(btc).toMatchObject({
      valueUsd: 7800,
      valueEur: 7020,
      unrealizedPnlUsd: 500,
      cumulativeCostPnlUsd: 600,
    });
    expect((portfolio['totals'] as Record<string, unknown>)['derivativesUnrealizedPnlUsd']).toBe(200);
    expect(portfolio['warnings']).toContain('Conto funding non letto: timeout');
    expect(body['meta']).toMatchObject({ baseUrl: 'https://eea.okx.com', demo: false, usdEur: 0.9 });
    expect(headers.get('Server-Timing')).toContain('read');
  });

  it('answers 503 with the tile’s words when the key is missing', async () => {
    mocks.isOkxConfigured.mockReturnValue(false);
    const { status, body } = await post();
    expect(status).toBe(503);
    expect(String(body['error'])).toContain('OKX non configurato');
    expect(mocks.readOkxAccount).not.toHaveBeenCalled();
  });

  it('maps a refused key to 401 and a rate limit to 429', async () => {
    const { OkxReadError } = await import('@/lib/server/okxClient');
    mocks.readOkxAccount.mockRejectedValueOnce(new OkxReadError('chiave rifiutata', 401));
    expect((await post()).status).toBe(401);
    mocks.readOkxAccount.mockRejectedValueOnce(new OkxReadError('troppe richieste', 429));
    expect((await post()).status).toBe(429);
  });

  it('refuses a caller outside the allowlist before reading anything', async () => {
    mocks.canUseOkx.mockReturnValue(false);
    const { status } = await post();
    expect(status).toBe(403);
    expect(mocks.readOkxAccount).not.toHaveBeenCalled();
  });

  it('rejects a body with no ownerId', async () => {
    const { status } = await post({});
    expect(status).toBe(400);
  });
});
