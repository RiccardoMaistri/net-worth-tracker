/**
 * Tests for lib/utils/overlapInput.ts — the Sovrapposizioni input from the SAME payload
 * Esposizione reads: ETF vectors from the answered fund profiles, direct stocks from the
 * assets, the total from the base.
 *
 * Same mocking as exposureEngine.test.ts: `expandAssetExposure` reaches `calculateAssetValue`,
 * which pulls the client SDK at module load.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Asset } from '@/types/assets';
import type { InstrumentProfile } from '@/types/exposure';

vi.mock('@/lib/firebase/config', () => ({ db: {} }));
vi.mock('@/lib/utils/authFetch', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('@/lib/services/dashboardOverviewInvalidation', () => ({ invalidateDashboardOverviewSummary: vi.fn() }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), getDoc: vi.fn(), setDoc: vi.fn(), deleteField: vi.fn() }));

import { buildOverlapInput } from '@/lib/utils/overlapInput';

function asset(overrides: Partial<Asset> & { id: string; name: string }): Asset {
  return {
    userId: 'u',
    ticker: overrides.id.toUpperCase(),
    type: 'etf',
    assetClass: 'equity',
    currency: 'EUR',
    quantity: 10,
    currentPrice: 100,
    lastPriceUpdate: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Asset;
}

const FETCHED = '2026-09-03T08:00:00.000Z';

function fundProfile(holdings: Array<{ key: string; label: string; weight: number }>, basis: 'sleeve' | 'fund' = 'sleeve'): InstrumentProfile {
  return { ticker: 'X', fund: { fetchedAt: FETCHED, holdingsBasis: basis, holdings, family: 'Famiglia' } };
}

describe('buildOverlapInput', () => {
  it('builds ETF vectors from the answered profiles and stocks from the assets', () => {
    const assets = [
      asset({ id: 'vwce', name: 'Vanguard FTSE All-World', quantity: 100, currentPrice: 100 }),
      asset({ id: 'aapl', name: 'Apple', type: 'stock', quantity: 3, currentPrice: 100, isin: 'US0378331005' }),
      asset({ id: 'btp', name: 'BTP Valore', type: 'bond', assetClass: 'bonds', quantity: 40, currentPrice: 100, isin: 'IT0001234567' }),
    ];
    const profiles = {
      VWCE: fundProfile([{ key: 'AAPL', label: 'Apple Inc.', weight: 0.04 }]),
    };
    const input = buildOverlapInput(assets, profiles);
    expect(input.etfs).toEqual([
      {
        ticker: 'VWCE',
        assetName: 'Vanguard FTSE All-World',
        assetValueEur: 10000,
        holdings: [{ symbol: 'AAPL', name: 'Apple Inc.', weight: 0.04 }],
      },
    ]);
    expect(input.stocks).toEqual([{ ticker: 'AAPL', name: 'Apple', valueEur: 300 }]);
    // The bond joins neither list but counts in the total, like the stocks and the fund.
    expect(input.totalPortfolioValue).toBe(10000 + 300 + 4000);
  });

  it('scales sleeve weights back to fund fractions on a composite, and skips what cannot be read', () => {
    const assets = [
      asset({
        id: 'mix',
        name: 'Bilanciato 60/40',
        quantity: 10,
        currentPrice: 100,
        composition: [
          { assetClass: 'equity', percentage: 60 },
          { assetClass: 'bonds', percentage: 40 },
        ],
      }),
      asset({ id: 'swap', name: 'Mystery Synthetic', quantity: 7, currentPrice: 100 }),
      asset({ id: 'cash', name: 'Conto', type: 'cash', assetClass: 'cash', quantity: 800, currentPrice: 1 }),
    ];
    const profiles = {
      MIX: fundProfile([{ key: 'MSFT', label: 'Microsoft', weight: 0.05 }]),
    };
    const input = buildOverlapInput(assets, profiles);
    // 5% of the equity sleeve on a 60% equity fund: 3% of the fund.
    expect(input.etfs).toEqual([
      {
        ticker: 'MIX',
        assetName: 'Bilanciato 60/40',
        assetValueEur: 1000,
        holdings: [{ symbol: 'MSFT', name: 'Microsoft', weight: 0.03 }],
      },
    ]);
    // No profile, no vector; cash counts in the total without one either.
    expect(input.stocks).toEqual([]);
    expect(input.totalPortfolioValue).toBe(1000 + 700 + 800);
  });

  it('leaves out excluded assets, sold ones and non-positive values', () => {
    const assets = [
      asset({ id: 'home', name: 'Casa', type: 'realestate', assetClass: 'realestate', allocationRole: 'excluded', quantity: 1, currentPrice: 250000 }),
      asset({ id: 'sold', name: 'Venduto', quantity: 0 }),
    ];
    expect(buildOverlapInput(assets, {})).toEqual({ etfs: [], stocks: [], totalPortfolioValue: 0 });
  });
});
