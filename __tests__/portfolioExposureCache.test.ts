/**
 * The 24 h cache in front of `/api/portfolio/exposure`.
 *
 * This suite exists because the cache was DEAD for its whole life and nothing noticed. The route
 * and the service each built the key separately, so they never matched, so every page visit
 * re-fetched every fund from Yahoo. A cache that never hits still returns correct data — it only
 * costs — so no assertion anywhere could see it. The one that can is an assertion about the
 * MOCK'S CALL COUNT across two requests, which is what the tests below make.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Asset } from '@/types/assets';

// One mutable bag shared with the mocked modules, so a test can count Yahoo lookups across two
// requests and count the cache writes.
const bag = vi.hoisted(() => ({
  yahooCalls: [] as string[],
  assetDoc: null as Record<string, unknown> | null,
  adminGet: 0,
  adminSet: 0,
}));

vi.mock('yahoo-finance2', () => ({
  default: class {
    quoteSummary(ticker: string) {
      bag.yahooCalls.push(ticker);
      return Promise.resolve({
        topHoldings: { holdings: [{ symbol: 'AAPL', holdingName: 'Apple', holdingPercent: 0.6 }], sectorWeightings: [] },
        assetProfile: { country: 'United States' },
      });
    }
  },
}));

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({
        get: async () => {
          bag.adminGet += 1;
          return { exists: bag.assetDoc !== null, data: () => bag.assetDoc };
        },
        set: async (data: Record<string, unknown>) => {
          bag.adminSet += 1;
          bag.assetDoc = data;
        },
      }),
    }),
  },
}));

vi.mock('@/lib/server/apiAuth', () => ({
  requireFirebaseAuth: async () => ({ uid: 'u1' }),
  getApiAuthErrorResponse: () => null,
}));

vi.mock('@/lib/server/assetAdminRepository', () => ({
  getUserAssetsAdmin: async () => [
    { id: 'e1', userId: 'u1', name: 'World', ticker: 'VWCE.MI', type: 'etf', assetClass: 'equity', quantity: 10, currentPrice: 100, currency: 'EUR' } as Asset,
  ],
}));

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => ({ toMillis: () => Date.now() }) },
}));

const { GET } = await import('@/app/api/portfolio/exposure/route');
const { buildExposureCacheKey } = await import('@/lib/server/portfolioExposureService');

// The handler reads `request.nextUrl`, which a WHATWG `Request` does not carry — it is a
// NextRequest. Auth is mocked, so the only field the route touches is the URL.
const request = (query = '') =>
  ({ nextUrl: new URL(`http://localhost/api/portfolio/exposure${query}`) }) as never;

beforeEach(() => {
  bag.yahooCalls = [];
  bag.assetDoc = null;
  bag.adminGet = 0;
  bag.adminSet = 0;
});

describe('GET /api/portfolio/exposure — the cache', () => {
  it('serves the second identical request from Firestore instead of Yahoo', async () => {
    const first = await (await GET(request())).json();
    expect(first.cached).toBe(false);
    const afterFirst = bag.yahooCalls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await (await GET(request())).json();
    // THE assertion the dead cache could not pass. Without it this file would be a comment.
    expect(second.cached).toBe(true);
    expect(bag.yahooCalls.length).toBe(afterFirst);
    expect(second.exposure.regions).toBeDefined();
  });

  it('stamps the document with the same key it will later compare against', async () => {
    await GET(request());
    // One function builds both sides, so this cannot drift the way the two inline copies did.
    expect(bag.assetDoc?.cacheKey).toBe(
      buildExposureCacheKey([
        { id: 'e1', userId: 'u1', name: 'World', ticker: 'VWCE.MI', type: 'etf', assetClass: 'equity', quantity: 10, currentPrice: 100, currency: 'EUR' } as Asset,
      ])
    );
  });

  it('treats a document written before the area view existed as a miss', async () => {
    // A cached payload with no `regions` would render the Aree geografiche view empty for 24 h with
    // nothing on screen to say why. One recompute, then it caches like any other.
    await GET(request());
    const { regions, ...withoutRegions } = (bag.assetDoc?.exposure ?? {}) as Record<string, unknown>;
    void regions;
    bag.assetDoc = { ...bag.assetDoc, exposure: withoutRegions };
    bag.yahooCalls = [];

    const response = await (await GET(request())).json();
    expect(response.cached).toBe(false);
    expect(bag.yahooCalls.length).toBeGreaterThan(0);
    expect(response.exposure.regions).toBeDefined();
  });

  it("recomputes when the user changes an area, instead of serving a stale ranking", async () => {
    await GET(request());
    bag.assetDoc = { ...bag.assetDoc, cacheKey: 'a-stale-signature' };
    bag.yahooCalls = [];
    const response = await (await GET(request())).json();
    expect(response.cached).toBe(false);
    expect(bag.yahooCalls.length).toBeGreaterThan(0);
  });

  it('bypasses the cache read on force, and writes the fresh result back', async () => {
    await GET(request());
    bag.yahooCalls = [];
    const forced = await (await GET(request('?force=true'))).json();
    expect(forced.cached).toBe(false);
    expect(bag.yahooCalls.length).toBeGreaterThan(0);
    expect(bag.adminSet).toBe(2);
  });
});

describe('buildExposureCacheKey', () => {
  const etf = (over: Partial<Asset> = {}) =>
    ({ id: 'e1', userId: 'u', name: 'W', ticker: 'VWCE.MI', type: 'etf', assetClass: 'equity', quantity: 10, currentPrice: 100, currency: 'EUR', ...over }) as Asset;

  it('is stable for the same portfolio and does not depend on order', () => {
    expect(buildExposureCacheKey([etf()])).toBe(buildExposureCacheKey([etf()]));
    expect(buildExposureCacheKey([etf(), etf({ id: 'e2', ticker: 'CSSPX.MI' })])).toBe(
      buildExposureCacheKey([etf({ id: 'e2', ticker: 'CSSPX.MI' }), etf()])
    );
  });

  it('changes when an area is declared, and when a ticker is repaired', async () => {
    // The two writes that change the area view without changing the portfolio's value: the dialog
    // and the broker bridge. Either has to move the signature or the tab serves a stale ranking.
    const before = buildExposureCacheKey([etf()]);
    expect(buildExposureCacheKey([etf({ geographicArea: 'global' })])).not.toBe(before);
    expect(buildExposureCacheKey([etf({ ticker: 'IE00BK5BQT80' })])).not.toBe(before);
    expect(buildExposureCacheKey([etf({ quantity: 11 })])).not.toBe(before);
    // A SOLD position is not in the signature: it carries no value and no exposure.
    expect(buildExposureCacheKey([etf(), etf({ id: 'e9', quantity: 0 })])).toBe(before);
  });
});
