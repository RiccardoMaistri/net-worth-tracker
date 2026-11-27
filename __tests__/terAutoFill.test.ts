/**
 * `lib/utils/terAutoFill.ts` — the ONE rule shared by the form's visible prefill and the one-shot
 * backfill. The cases that matter are the ones that look like absences but are answers: an explicit
 * TER of 0, a provider fraction that must become a percent number, and a hand-edited value that
 * must lose the provider's provenance. A falsification that drops the 0 guard or the unit change
 * turns a user's figure into a provider's estimate here.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTerWriteFields,
  hasStoredTer,
  isTerBackfillCandidate,
  normalizeTerPercent,
  resolveProviderTer,
  TER_ELIGIBLE_TYPES,
  type TerAssetFields,
} from '@/lib/utils/terAutoFill';

const FETCHED_AT = '2026-10-20T08:00:00.000Z';

function asset(overrides: Partial<TerAssetFields> = {}): TerAssetFields {
  return { type: 'etf', quantity: 2, ticker: 'VWCE.DE', ...overrides };
}

describe('normalizeTerPercent', () => {
  it("turns Yahoo's fraction into the app's percent number, without binary artefacts", () => {
    expect(normalizeTerPercent(0.0025)).toBe(0.25);
    expect(normalizeTerPercent(0.0078)).toBe(0.78);
    expect(normalizeTerPercent(0.19)).toBe(19);
  });

  it('refuses unusable fields instead of writing a plausible number', () => {
    for (const raw of [undefined, null, '0.25', NaN, Infinity, -0.001, 1.01]) {
      expect(normalizeTerPercent(raw)).toBeNull();
    }
    expect(normalizeTerPercent(1)).toBe(100);
  });
});

describe('resolveProviderTer', () => {
  it('takes the fund profile first, then the annual report, then the quote', () => {
    const answer = {
      fundProfile: { feesExpensesInvestment: { netExpRatio: 0.0025 } },
      fundPerformance: { annualReportExpenseRatio: 0.0078 },
      price: { netExpenseRatio: 0.0099 },
    };
    expect(resolveProviderTer(answer, FETCHED_AT)).toEqual({
      value: 0.25,
      source: 'yahoo-fund-profile',
      fetchedAt: FETCHED_AT,
    });
    expect(resolveProviderTer({ ...answer, fundProfile: null }, FETCHED_AT)).toEqual({
      value: 0.78,
      source: 'yahoo-fund-performance',
      fetchedAt: FETCHED_AT,
    });
    expect(
      resolveProviderTer(
        { fundProfile: { feesExpensesInvestment: { netExpRatio: 'nope' } }, price: { netExpenseRatio: 0.0099 } },
        FETCHED_AT
      )
    ).toEqual({ value: 0.99, source: 'yahoo-quote', fetchedAt: FETCHED_AT });
  });

  it('answers nothing when every candidate is unusable', () => {
    expect(resolveProviderTer(null, FETCHED_AT)).toBeNull();
    expect(resolveProviderTer({}, FETCHED_AT)).toBeNull();
    expect(resolveProviderTer({ price: { netExpenseRatio: 2 } }, FETCHED_AT)).toBeNull();
  });
});

describe('hasStoredTer / isTerBackfillCandidate', () => {
  it('treats an explicit zero as a stored answer', () => {
    expect(hasStoredTer({ totalExpenseRatio: 0 })).toBe(true);
    expect(hasStoredTer({ totalExpenseRatio: undefined })).toBe(false);
    expect(hasStoredTer({ totalExpenseRatio: null })).toBe(false);
  });

  it('covers every fund-like type and no hand-valued type', () => {
    expect(TER_ELIGIBLE_TYPES).toEqual(['etf', 'fund', 'commodity', 'crypto']);
    for (const type of TER_ELIGIBLE_TYPES) {
      expect(isTerBackfillCandidate(asset({ type }))).toBe(true);
    }
    expect(isTerBackfillCandidate(asset({ type: 'stock' }))).toBe(false);
    expect(isTerBackfillCandidate(asset({ type: 'cash', ticker: '' }))).toBe(false);
  });

  it('requires a held, investable, identifiable position with no TER of its own', () => {
    expect(isTerBackfillCandidate(asset())).toBe(true);
    expect(isTerBackfillCandidate(asset({ totalExpenseRatio: 0 }))).toBe(false);
    expect(isTerBackfillCandidate(asset({ totalExpenseRatio: 1.25 }))).toBe(false);
    expect(isTerBackfillCandidate(asset({ quantity: 0 }))).toBe(false);
    expect(isTerBackfillCandidate(asset({ allocationRole: 'excluded' }))).toBe(false);
    expect(isTerBackfillCandidate(asset({ excludeFromAllocation: true }))).toBe(false);
    expect(isTerBackfillCandidate(asset({ subCategory: 'Private Equity' }))).toBe(false);
    expect(isTerBackfillCandidate(asset({ ticker: '  ', isin: undefined }))).toBe(false);
  });
});

describe('buildTerWriteFields', () => {
  const provenance = { value: 0.25, source: 'yahoo-fund-profile' as const, fetchedAt: FETCHED_AT };

  it('carries the source and the read time only with the exact value it read', () => {
    expect(buildTerWriteFields(0.25, provenance)).toEqual({
      totalExpenseRatio: 0.25,
      terSource: 'yahoo-fund-profile',
      terFetchedAt: new Date(FETCHED_AT),
    });
    expect(buildTerWriteFields(0.25, null)).toEqual({
      totalExpenseRatio: 0.25,
      terSource: undefined,
      terFetchedAt: undefined,
    });
    expect(buildTerWriteFields(0.26, provenance)).toEqual({
      totalExpenseRatio: 0.26,
      terSource: undefined,
      terFetchedAt: undefined,
    });
  });

  it('preserves an explicit zero and refuses values outside the form’s range', () => {
    expect(buildTerWriteFields(0, { ...provenance, value: 0 })).toEqual({
      totalExpenseRatio: 0,
      terSource: 'yahoo-fund-profile',
      terFetchedAt: new Date(FETCHED_AT),
    });
    expect(buildTerWriteFields(undefined, provenance).totalExpenseRatio).toBeUndefined();
    expect(buildTerWriteFields(NaN, provenance).totalExpenseRatio).toBeUndefined();
    expect(buildTerWriteFields(101, provenance).terSource).toBeUndefined();
  });

  it('never claims an unparseable read time', () => {
    const result = buildTerWriteFields(0.25, { ...provenance, fetchedAt: 'not a date' });
    expect(result.totalExpenseRatio).toBe(0.25);
    expect(result.terFetchedAt).toBeUndefined();
  });
});
