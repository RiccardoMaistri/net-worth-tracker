/**
 * The geographic classification rules. Pure, so the two properties that matter are testable
 * without a browser or a Firestore:
 *
 *  1. a fund's area comes from WHERE ITS POSITIONS ARE, not from where the fund is domiciled — the
 *     whole Scalable/Trade Republic catalogue is Irish or Luxembourgish and holds the planet;
 *  2. a PARTIAL country lookup must produce an ABSENT area, never a wrong one. That is the
 *     `MIN_FUND_COVERAGE` guard, and it is the one line a future reader is most likely to delete
 *     as an optimisation.
 */

import { describe, it, expect } from 'vitest';
import {
  MIN_FUND_COVERAGE,
  countryToRegion,
  inferGeographicArea,
  splitFundHoldingsByRegion,
  type GeographicArea,
} from '@/lib/constants/geographicAreas';

const countries = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('countryToRegion', () => {
  it('maps the countries it claims and refuses the ones it does not', () => {
    expect(countryToRegion('United States')).toBe('northAmerica');
    expect(countryToRegion('Italy')).toBe('italy');
    expect(countryToRegion('Japan')).toBe('asiaPacific');
    expect(countryToRegion('Brazil')).toBe('emergingMarkets');
  });

  it('never answers `other` — an unknown country is a claim the map cannot support', () => {
    // The load-bearing line: `?? 'other'` here is what put 87% of a real portfolio in «Altro».
    expect(countryToRegion('Freedonia')).toBeNull();
    expect(countryToRegion('')).toBeNull();
    expect(countryToRegion(null)).toBeNull();
    expect(countryToRegion(undefined)).toBeNull();
  });
});

describe('inferGeographicArea', () => {
  it('reads a direct listing as the country that issued it', () => {
    expect(inferGeographicArea({ isin: 'IT0005451880', type: 'bond' })).toBe('italy');
    expect(inferGeographicArea({ isin: 'DE0001102580', type: 'bond' })).toBe('europe');
    expect(inferGeographicArea({ isin: 'US0378331005', type: 'stock' })).toBe('northAmerica');
  });

  it('asks Yahoo for a stock whose ISIN head it does not carry', () => {
    expect(inferGeographicArea({ isin: 'BRPETRACNPR6', country: 'Brazil', type: 'stock' })).toBe('emergingMarkets');
    expect(inferGeographicArea({ type: 'stock', country: 'Germany' })).toBe('europe');
  });

  it('calls crypto global — the one exposure that is everywhere at once', () => {
    expect(inferGeographicArea({ type: 'crypto' })).toBe('global');
    expect(inferGeographicArea({ isin: 'XF000BTC', type: 'crypto' })).toBe('global');
  });

  it('answers nothing for the instruments that have no place at all', () => {
    // These four were 250.000 € of «Altro» in a real portfolio. No area is the true reading.
    for (const type of ['cash', 'realestate', 'pensionFund', 'crowdfunding']) {
      expect(inferGeographicArea({ type })).toBeNull();
    }
  });

  it('refuses to read a FUND off its ISIN head, which is its domicile', () => {
    // Called directly the function cannot tell a fund from a bond, so this pins the rule the
    // SERVICE relies on: a fund never reaches here. IE and LU are absent from the prefix map
    // precisely so that a leak of a fund into this function reads as unknown, not as Europe.
    expect(inferGeographicArea({ isin: 'IE00BK5BQT80', type: 'etf' })).toBeNull();
    expect(inferGeographicArea({ isin: 'LU0356591882', type: 'etf' })).toBeNull();
    // An IE/LU bond that is not a UCITS wrapper still has no head here.
    expect(inferGeographicArea({ isin: 'IE1234567890', type: 'bond' })).toBeNull();
  });

  it('rejects a string that only looks like an ISIN', () => {
    expect(inferGeographicArea({ isin: 'IT', type: 'bond' })).toBeNull();
    expect(inferGeographicArea({ isin: '12345678901234', type: 'bond' })).toBeNull();
  });
});

describe('splitFundHoldingsByRegion', () => {
  it('divides a fund by where its own positions are', () => {
    // The S&P fund an Italian investor actually holds: ten stones, seven American.
    const split = splitFundHoldingsByRegion(
      [
        { symbol: 'AAPL', holdingPercent: 0.07 },
        { symbol: 'MSFT', holdingPercent: 0.06 },
        { symbol: 'NVDA', holdingPercent: 0.05 },
        { symbol: 'AMZN', holdingPercent: 0.04 },
        { symbol: 'GOOGL', holdingPercent: 0.03 },
        { symbol: 'META', holdingPercent: 0.025 },
        { symbol: 'AVGO', holdingPercent: 0.02 },
        { symbol: 'JPM', holdingPercent: 0.015 },
        { symbol: 'ASML', holdingPercent: 0.01 },
        { symbol: 'SAP', holdingPercent: 0.01 },
      ],
      countries({ AAPL: 'United States', MSFT: 'United States', NVDA: 'United States', AMZN: 'United States', GOOGL: 'United States', META: 'United States', AVGO: 'United States', JPM: 'United States', ASML: 'Netherlands', SAP: 'Germany' })
    );
    expect(split.area).toBe('northAmerica');
    expect(split.coverage).toBe(1);
    // Weights are normalised over what was recognised, so they sum to 1 whatever the fund's tail.
    const total = Object.values(split.weights).reduce((sum, w) => sum + (w ?? 0), 0);
    expect(total).toBeCloseTo(1, 10);
    expect(split.weights.europe).toBeCloseTo(0.02 / 0.33, 10);
  });

  it('is the FALLBACK for a fund, never the answer: the index name comes first', () => {
    // The ten stones below read «Nord America» — and the fund is not. `matchIndexRegionComposition`
    // answers on the fund's own name BEFORE this function is ever reached, so the sample is what a
    // fund with no recognised index gets, and the tile's method line says so.
    const stones = [
      { symbol: 'AAPL', holdingPercent: 0.05 },
      { symbol: 'MSFT', holdingPercent: 0.04 },
      { symbol: 'ASML', holdingPercent: 0.03 },
      { symbol: 'SAP', holdingPercent: 0.02 },
    ];
    const byCountry = countries({ AAPL: 'United States', MSFT: 'United States', ASML: 'Netherlands', SAP: 'Germany' });
    expect(splitFundHoldingsByRegion(stones, byCountry).area).toBe('northAmerica');
  });

  it('drops an unplaceable position from BOTH sides of the divide', () => {
    // Two American stones came back, eight did not. The honest answer is not «Nord America 100%».
    const split = splitFundHoldingsByRegion(
      [
        { symbol: 'AAPL', holdingPercent: 0.05 },
        { symbol: 'MSFT', holdingPercent: 0.05 },
        { symbol: 'NOPE1', holdingPercent: 0.04 },
        { symbol: 'NOPE2', holdingPercent: 0.04 },
        { symbol: 'NOPE3', holdingPercent: 0.04 },
        { symbol: 'NOPE4', holdingPercent: 0.03 },
      ],
      countries({ AAPL: 'United States', MSFT: 'United States' })
    );
    // FALSIFICATION: with the guard deleted this returns northAmerica 1.0 and the tile prints a
    // fund as wholly American because two of six lookups came back. The floor is the whole point.
    expect(split.area).toBeNull();
    expect(split.weights).toEqual({});
    expect(split.coverage).toBe(0);
  });

  it('classifies once the recognised share clears the floor, and reports how much it saw', () => {
    const holdings = [
      { symbol: 'AAPL', holdingPercent: 0.05 },
      { symbol: 'MSFT', holdingPercent: 0.05 },
      { symbol: 'NOPE1', holdingPercent: 0.02 },
      { symbol: 'NOPE2', holdingPercent: 0.02 },
    ];
    const split = splitFundHoldingsByRegion(holdings, countries({ AAPL: 'United States', MSFT: 'United States' }));
    expect(split.coverage).toBeCloseTo(10 / 14, 10);
    expect(split.coverage).toBeGreaterThanOrEqual(MIN_FUND_COVERAGE);
    expect(split.area).toBe('northAmerica');
  });

  it('answers nothing when Yahoo has no positions for the fund at all', () => {
    expect(splitFundHoldingsByRegion([], countries({}))).toEqual({ weights: {}, coverage: 0, area: null });
  });

  it('ignores a position Yahoo reports with no weight or a broken one', () => {
    const split = splitFundHoldingsByRegion(
      [
        { symbol: 'AAPL', holdingPercent: 0 },
        { symbol: 'MSFT', holdingPercent: Number.NaN },
        { symbol: '', holdingPercent: 0.5 },
      ],
      countries({ AAPL: 'United States', MSFT: 'United States' })
    );
    expect(split.area).toBeNull();
  });

  it('gives every key a real area, so a bad row cannot be typed into the tile', () => {
    const known: GeographicArea[] = ['northAmerica', 'europe', 'asiaPacific', 'emergingMarkets', 'italy'];
    const split = splitFundHoldingsByRegion(
      [
        { symbol: 'A', holdingPercent: 0.3 },
        { symbol: 'B', holdingPercent: 0.2 },
        { symbol: 'C', holdingPercent: 0.1 },
        { symbol: 'D', holdingPercent: 0.08 },
        { symbol: 'E', holdingPercent: 0.05 },
      ],
      countries({ A: 'United States', B: 'Germany', C: 'Japan', D: 'India', E: 'Italy' })
    );
    expect(Object.keys(split.weights).every((key) => known.includes(key as GeographicArea))).toBe(true);
  });
});
