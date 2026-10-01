/**
 * Contract test for POST /api/broker/scalable/read.
 *
 * The route once answered `{ plan }` for `holdings` and `overview` while the client read
 * `res.holdings` / `res.overview`. Both keys arrived `undefined`, and the client defaulted
 * them to `[]` / `null`: the preview showed ZERO positions and NO cash while reporting a
 * successful sync. Nothing else caught it, so the response shape is pinned here per command —
 * one command, one parsed payload, under its own key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  runScalableReadCommand: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/firebase/config', () => ({ auth: { currentUser: null }, db: {} }));
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }));
vi.mock('@/lib/server/apiAuth', () => ({
  requireFirebaseAuth: vi.fn(async () => ({ uid: 'owner-1', email: 'rykymai@gmail.com' })),
  assertCanAccessAccount: vi.fn(async () => undefined),
  getApiAuthErrorResponse: vi.fn(() => null),
}));
// Only the `sc` execution itself is stubbed: path resolution and the config-file
// ensure run for real (under a tmp XDG set per test), so the service under test keeps
// its real profile → directory wiring and only the broker I/O is fake.
vi.mock('@/lib/server/scalableCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/scalableCli')>();
  return {
    ...actual,
    runScalableReadCommand: mocks.runScalableReadCommand,
    scalableCliPath: () => 'sc',
    ScalableCliError: class ScalableCliError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    },
  };
});

const HOLDINGS_STDOUT = JSON.stringify({
  ok: true,
  data: { result: { items: [{ isin: 'IE00B3VTMJ91', name: 'Bond', quantity: 10, price: 115.85 }] } },
});
const OVERVIEW_STDOUT = JSON.stringify({
  ok: true,
  data: { result: { valuation: { securities: 138626.79, crypto: 0, total: 138746.79 } } },
});
const OVERNIGHT_STDOUT = JSON.stringify({
  ok: true,
  data: {
    account: { display_name: 'Deposito non vincolato', is_active: true },
    result: { balance: 59201.61, interest_rate: 0.026 },
  },
});

function request(command: string): NextRequest {
  return new NextRequest('http://localhost/api/broker/scalable/read', {
    method: 'POST',
    body: JSON.stringify({ ownerId: 'owner-1', command }),
  });
}

async function post(command: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import('@/app/api/broker/scalable/read/route');
  const response = await POST(request(command));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('POST /api/broker/scalable/read', () => {
  const savedEnv = { ...process.env };
  let fakeXdg: string;

  beforeEach(async () => {
    mocks.runScalableReadCommand.mockReset();
    // The service caches readings per profile for 60s: drop them so each case
    // observes the mocked CLI, not the previous case.
    const { clearScalableCache } = await import('@/lib/server/scalableService');
    clearScalableCache();
    // The route ensures the profile config under XDG: keep that write in a tmpdir,
    // never in the developer's real home.
    fakeXdg = mkdtempSync(join(tmpdir(), 'sc-read-xdg-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    process.env.SCALABLE_PROFILES = 'riccardo:rykymai@gmail.com';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(fakeXdg, { recursive: true, force: true });
  });

  it('answers `holdings` with the parsed rows under `holdings`, not a plan', async () => {
    mocks.runScalableReadCommand.mockResolvedValue(HOLDINGS_STDOUT);
    const { status, body } = await post('holdings');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('plan');
    expect(Array.isArray(body.holdings)).toBe(true);
    expect(body.holdings).toHaveLength(1);
  });

  it('answers `overview` with the parsed totals under `overview`, not a plan', async () => {
    mocks.runScalableReadCommand.mockResolvedValue(OVERVIEW_STDOUT);
    const { status, body } = await post('overview');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('plan');
    expect(body.overview).toMatchObject({ valuation: 138746.79, securitiesValuation: 138626.79 });
  });

  it('answers `overnight` with the parsed deposit under `overnight`', async () => {
    mocks.runScalableReadCommand.mockResolvedValue(OVERNIGHT_STDOUT);
    const { status, body } = await post('overnight');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('plan');
    expect(body.overnight).toMatchObject({ balance: 59201.61, interestRate: 0.026 });
  });

  it('runs only the whitelisted command for the requested verb', async () => {
    mocks.runScalableReadCommand.mockResolvedValue(OVERNIGHT_STDOUT);
    await post('overnight');
    // The first argument is the whole command surface: no caller input may reach the CLI.
    expect(mocks.runScalableReadCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runScalableReadCommand.mock.calls[0][0]).toBe('overnight');
  });

  it('rejects an unknown command with 400', async () => {
    const { status } = await post('sell-everything');
    expect(status).toBe(400);
    expect(mocks.runScalableReadCommand).not.toHaveBeenCalled();
  });
});
