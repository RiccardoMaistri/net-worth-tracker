/**
 * Contract test for POST /api/broker/traderepublic/read.
 *
 * The response shape is pinned per command for the same reason as the Scalable route: that route
 * once answered `{ plan }` while the client read `res.holdings`, both keys arrived `undefined`,
 * and the client defaulted them to `[]` — the preview showed ZERO positions while reporting a
 * successful sync. Nothing else caught it.
 *
 * The envelope differs from Scalable's on purpose and the tests say so: `balances` is a LIST
 * (several EUR cash accounts are several accounts, never one figure) and the route fills the
 * prices, because this broker publishes no quote with a position.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  readTradeRepublic: vi.fn(),
  getMultipleQuotes: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/firebase/config', () => ({ auth: { currentUser: null }, db: {} }));
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }));
vi.mock('@/lib/server/apiAuth', () => ({
  requireFirebaseAuth: vi.fn(async () => ({ uid: 'owner-1' })),
  assertCanAccessAccount: vi.fn(async () => undefined),
  getApiAuthErrorResponse: vi.fn(() => null),
}));
vi.mock('@/lib/server/tradeRepublicClient', () => ({
  readTradeRepublic: mocks.readTradeRepublic,
  TR_READ_COMMANDS: ['positions', 'cash', 'savingsPlans'],
  TradeRepublicAuthError: class TradeRepublicAuthError extends Error {
    // The SAME argument order as the real class (`message`, then `status`). Inverting it here made
    // `status` a string and NextResponse threw a RangeError on an invalid HTTP status — a good
    // reminder that a mock which does not mirror the real signature tests nothing useful.
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  TradeRepublicReadError: class TradeRepublicReadError extends Error {},
}));
vi.mock('@/lib/services/yahooFinanceService', () => ({
  getMultipleQuotes: mocks.getMultipleQuotes,
}));

const POSITIONS_PAYLOAD = {
  categories: [
    {
      categoryType: 'etf',
      positions: [
        {
          isin: 'IE00B3VTMJ91',
          averageBuyIn: '112,44',
          netSize: '12,5',
          virtualSize: '12,5',
          status: 'active',
          instrumentType: 'etf',
          name: 'iShares Core MSCI World',
          derivativeInfo: null,
          bondInfo: null,
          imageId: 'i',
        },
      ],
    },
  ],
};

const CASH_PAYLOAD = [{ accountNumber: 'DE123', currencyId: 'EUR', amount: 1234.56 }];

const PLANS_PAYLOAD = {
  savingsPlans: [
    {
      id: '3f1b0a52-8c4d-4a1e-9b77-0f2d5e6a7c81',
      createdAt: 1750000000000,
      instrumentId: 'IE00B3VTMJ91.HAM',
      amount: 20000,
      interval: 'monthly',
      startDate: { type: 'x', value: 1, nextExecutionDate: '2026-10-01' },
      firstExecutionDate: null,
      nextExecutionDate: '2026-10-01',
      previousExecutionDate: '2026-09-01',
      virtualPreviousExecutionDate: '2026-09-01',
      finalExecutionDate: null,
      paymentMethodId: null,
      paymentMethodCode: null,
      lastPaymentExecutionDate: null,
      paused: false,
      fundingCashAccNo: 'DE123',
      secAccNo: 'DE999',
    },
  ],
};

function request(command: string): NextRequest {
  return new NextRequest('http://localhost/api/broker/traderepublic/read', {
    method: 'POST',
    body: JSON.stringify({ ownerId: 'owner-1', command }),
  });
}

async function post(command: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import('@/app/api/broker/traderepublic/read/route');
  const response = await POST(request(command));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('POST /api/broker/traderepublic/read', () => {
  beforeEach(() => {
    mocks.readTradeRepublic.mockReset();
    mocks.getMultipleQuotes.mockReset();
    mocks.getMultipleQuotes.mockResolvedValue(new Map());
  });

  it('answers `positions` with the parsed rows under `positions`, not a plan', async () => {
    mocks.readTradeRepublic.mockResolvedValue(POSITIONS_PAYLOAD);
    const { status, body } = await post('positions');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('plan');
    expect(body.positions).toHaveLength(1);
  });

  it('fills each position price from the ordinary Yahoo service, keyed by ISIN', async () => {
    // The broker publishes no quote, and `currentPrice` is required: without this a synced
    // portfolio is created at 0 and the net worth drops by everything the user owns.
    mocks.readTradeRepublic.mockResolvedValue(POSITIONS_PAYLOAD);
    mocks.getMultipleQuotes.mockResolvedValue(
      new Map([['IE00B3VTMJ91', { ticker: 'IE00B3VTMJ91', price: 130.2, currency: 'EUR' }]])
    );
    const { body } = await post('positions');
    expect(mocks.getMultipleQuotes).toHaveBeenCalledWith(['IE00B3VTMJ91']);
    expect((body.positions as { price?: number }[])[0].price).toBe(130.2);
  });

  it('leaves the price absent when the quote fails, instead of inventing a zero', async () => {
    // Absent is what the plan turns into a warning naming the position; a 0 here would be a
    // reading the broker never gave.
    mocks.readTradeRepublic.mockResolvedValue(POSITIONS_PAYLOAD);
    mocks.getMultipleQuotes.mockResolvedValue(
      new Map([['IE00B3VTMJ91', { ticker: 'IE00B3VTMJ91', price: null, currency: 'EUR', error: 'no' }]])
    );
    const { body } = await post('positions');
    expect((body.positions as { price?: number }[])[0].price).toBeUndefined();
  });

  it('answers `cash` with a LIST under `balances`, so two accounts never become one figure', async () => {
    mocks.readTradeRepublic.mockResolvedValue([
      ...CASH_PAYLOAD,
      { accountNumber: 'DE999', currencyId: 'EUR', amount: 59201.61 },
    ]);
    const { status, body } = await post('cash');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('plan');
    expect(body).not.toHaveProperty('cash');
    expect(body.balances).toHaveLength(2);
  });

  it('answers `savingsPlans` with the parsed plans, converting the instalment from minor units', async () => {
    mocks.readTradeRepublic.mockResolvedValue(PLANS_PAYLOAD);
    const { status, body } = await post('savingsPlans');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('plan');
    expect(body.savingsPlans).toEqual([
      expect.objectContaining({ isin: 'IE00B3VTMJ91', amount: 200, rawAmount: 20000 }),
    ]);
  });

  it('runs only the whitelisted command for the requested verb', async () => {
    mocks.readTradeRepublic.mockResolvedValue(PLANS_PAYLOAD);
    await post('savingsPlans');
    expect(mocks.readTradeRepublic).toHaveBeenCalledWith('owner-1', 'savingsPlans');
  });

  it('rejects an unknown command with 400 and reads nothing', async () => {
    const { status } = await post('sell-everything');
    expect(status).toBe(400);
    expect(mocks.readTradeRepublic).not.toHaveBeenCalled();
  });

  it('maps a dead session to its own status so the UI can ask for a re-link', async () => {
    const { TradeRepublicAuthError } = await import('@/lib/server/tradeRepublicClient');
    mocks.readTradeRepublic.mockRejectedValue(
      new TradeRepublicAuthError('La sessione Trade Republic è scaduta: ricollegati con il codice QR.', 401)
    );
    const { status, body } = await post('positions');
    expect(status).toBe(401);
    expect(body.error).toContain('scaduta');
  });
});
