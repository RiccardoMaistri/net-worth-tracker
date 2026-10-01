/**
 * The sub-line COMPOSITION (`describeAssetRowSubLine`, components/assets/AssetRow.tsx).
 *
 * Pure on purpose, but it lives in the component because that is where the row's facts are
 * assembled (doc/guide/patrimonio.md § per-page blind spots). This file exists because that
 * wiring was UNTESTED: a falsification that disabled the crowdfunding branch stayed green here.
 * The words themselves are pinned in `__tests__/patrimonioNarrative.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Asset } from '@/types/assets';

vi.mock('@/lib/firebase/config', () => ({ db: {} }));
vi.mock('@/lib/utils/authFetch', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('@/lib/services/dashboardOverviewInvalidation', () => ({
  invalidateDashboardOverviewSummary: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteField: vi.fn(),
  collection: vi.fn(),
  addDoc: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: vi.fn(),
}));

import { describeAssetRowSubLine } from '@/components/assets/AssetRow';

const NOW = new Date(Date.UTC(2026, 8, 14, 10, 0));

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'a1',
    userId: 'u1',
    ticker: 'ISIN',
    name: 'Asset',
    type: 'stock',
    assetClass: 'equity',
    currency: 'EUR',
    quantity: 1,
    currentPrice: 100,
    lastPriceUpdate: new Date(Date.UTC(2026, 7, 12, 11)),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe('describeAssetRowSubLine', () => {
  it('names the capital and the maturity of a crowdfunding project', () => {
    const subLine = describeAssetRowSubLine(
      makeAsset({ type: 'crowdfunding', assetClass: 'realestate', investedCapital: 10000, maturityDate: '2027-06-30' }),
      NOW
    );
    expect(subLine).toContain('investito');
    expect(subLine).toContain('scade il 30/06/2027');
  });

  it('carries the three crowdfunding facts in one sub-line, ROI included', () => {
    const subLine = describeAssetRowSubLine(
      makeAsset({
        type: 'crowdfunding',
        assetClass: 'realestate',
        investedCapital: 10000,
        expectedRoi: 8.5,
        maturityDate: '2027-06-30',
      }),
      NOW
    );
    expect(subLine).toBe('investito 10.000,00\u00a0€ · atteso 8,5% · scade il 30/06/2027');
  });

  it('keeps the crowdfunding line AHEAD of the hand-typed value, which would hide it', () => {
    // Both apply to a manually valued holding: only one sub-line exists, and the project's own
    // facts are the ones the reader asked for.
    const subLine = describeAssetRowSubLine(
      makeAsset({ type: 'crowdfunding', assetClass: 'realestate', maturityDate: '2027-06-30' }),
      NOW
    );
    expect(subLine).not.toContain('valore a mano');
  });

  it('falls back to the hand-typed value when a crowdfunding row has neither fact', () => {
    const subLine = describeAssetRowSubLine(
      makeAsset({ type: 'crowdfunding', assetClass: 'realestate' }),
      NOW
    );
    expect(subLine).toContain('valore a mano');
  });

  it('leaves a plain quoted instrument alone', () => {
    expect(describeAssetRowSubLine(makeAsset(), NOW)).toBeNull();
  });
});
