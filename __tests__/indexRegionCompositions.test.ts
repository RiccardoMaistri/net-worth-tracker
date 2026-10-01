/**
 * The index a fund's NAME declares, and that index's regional composition.
 *
 * Every name in `NAMES_FROM_YAHOO` is a `price.longName` copied from Yahoo itself for a UCITS ETF an
 * Italian broker actually sells, so the table is tested against the strings it will really be asked
 * about rather than against names invented for the test.
 *
 * The two properties that matter are both about ORDER, because the first matching pattern wins:
 * a family that CONTAINS another must not be shadowed by it, and a name that declares NO index must
 * stay unmatched so the caller falls back to the positions sample.
 */

import { describe, it, expect } from 'vitest';
import {
  INDEX_REGION_COMPOSITIONS,
  matchIndexRegionComposition,
} from '@/lib/constants/indexRegionCompositions';
import type { GeographicArea } from '@/lib/constants/geographicAreas';

/** Verbatim `price.longName` values read from Yahoo for the funds this app holds. */
const NAMES_FROM_YAHOO = {
  ftseAllWorld: 'Vanguard FTSE All-World UCITS ETF USD Accumulation',
  ftseAllWorldHighDividend: 'Vanguard FTSE All-World UCITS ETF',
  msciWorld: 'iShares Core MSCI World UCITS ETF USD (Acc)',
  msciWorldSwap: 'Amundi Index Solutions - Amundi MSCI World Swap UCITS ETF EUR Acc',
  acwi: 'Amundi Index Solutions - Amundi MSCI All Country World Swap UCITS ETF EUR Acc',
  sp500: 'iShares Core S&P 500 UCITS ETF USD (Acc)',
  nasdaq100: 'iShares NASDAQ 100 UCITS ETF USD (Acc)',
  sp500Financials: 'iShares S&P 500 Financials Sector UCITS ETF USD (Acc)',
  sp500It: 'iShares S&P 500 Information Technology Sector UCITS ETF USD (Acc)',
  euroStoxx: 'Xtrackers Euro Stoxx 50 UCITS ETF 1D',
  stoxxEurope600: 'Amundi Core Stoxx Europe 600 UCITS ETF Acc',
  euroGovBond: 'iShares VII PLC - iShares € Govt Bond 1-3yr ETF EUR Acc',
  emImi: 'iShares Core MSCI EM IMI UCITS ETF USD (Acc)',
  emSwap: 'Amundi Index Solutions - Amundi MSCI Emerging Markets Swap UCITS ETF EUR Acc',
  pacExJapan: 'iShares VII PLC - iShares Core MSCI Pac ex-Jpn ETF USD Acc',
  japanHedged: 'iShares MSCI Japan EUR Hedged UCITS ETF (Acc)',
  asx200: 'Xtrackers S&P ASX 200 UCITS ETF 1D',
  thematic: 'VanEck Uranium and Nuclear Technologies UCITS ETF A USD Acc',
} as const;

const areasOf = (name: string): GeographicArea[] => {
  const match = matchIndexRegionComposition(name);
  return match ? (Object.keys(match.weights) as GeographicArea[]) : [];
};

describe('matchIndexRegionComposition', () => {
  it('decomposes a global fund instead of calling it one place', () => {
    // The whole point of the file. The ten largest positions of an All-World fund are American, so
    // anything reading them says «Nord America»; the index says otherwise.
    const match = matchIndexRegionComposition(NAMES_FROM_YAHOO.ftseAllWorld);
    expect(match?.index).toBe('FTSE All-World');
    expect(match?.weights.northAmerica).toBeGreaterThan(match?.weights.europe ?? 0);
    // Emerging money is IN an All-World fund — the bucket a global-collapse reading forgets.
    expect(match?.weights.emergingMarkets).toBeGreaterThan(0);
  });

  it('tells a developed-world index from an all-country one, which is the easy pair to merge', () => {
    const world = matchIndexRegionComposition(NAMES_FROM_YAHOO.msciWorld);
    const acwi = matchIndexRegionComposition(NAMES_FROM_YAHOO.acwi);
    expect(world?.index).toBe('MSCI World');
    expect(acwi?.index).toBe('MSCI ACWI');
    // ACWI holds emerging markets and MSCI World does not: the one number that separates them.
    expect(world?.weights.emergingMarkets).toBeUndefined();
    expect(acwi?.weights.emergingMarkets).toBeGreaterThan(0);
  });

  it('puts every single-region index wholly in its own area', () => {
    const expected: Array<[string, GeographicArea]> = [
      [NAMES_FROM_YAHOO.sp500, 'northAmerica'],
      [NAMES_FROM_YAHOO.nasdaq100, 'northAmerica'],
      // A SECTOR index inside the S&P 500 is still an American index, and this name also carries
      // the words «S&P 500 Financials» that a name-only "financials" reading would file elsewhere.
      [NAMES_FROM_YAHOO.sp500Financials, 'northAmerica'],
      [NAMES_FROM_YAHOO.sp500It, 'northAmerica'],
      [NAMES_FROM_YAHOO.euroStoxx, 'europe'],
      [NAMES_FROM_YAHOO.stoxxEurope600, 'europe'],
      [NAMES_FROM_YAHOO.euroGovBond, 'europe'],
      [NAMES_FROM_YAHOO.emImi, 'emergingMarkets'],
      [NAMES_FROM_YAHOO.emSwap, 'emergingMarkets'],
      [NAMES_FROM_YAHOO.pacExJapan, 'asiaPacific'],
      [NAMES_FROM_YAHOO.japanHedged, 'asiaPacific'],
      [NAMES_FROM_YAHOO.asx200, 'asiaPacific'],
    ];
    for (const [name, area] of expected) {
      expect(areasOf(name), name).toEqual([area]);
    }
  });

  it('stands down for a fund that declares no index, so the caller can sample its positions', () => {
    // A thematic fund has no regional index to declare. Answering anyway would file it under
    // whichever family the name came closest to, which is a guess presented as a composition.
    expect(matchIndexRegionComposition(NAMES_FROM_YAHOO.thematic)).toBeNull();
    expect(matchIndexRegionComposition(null)).toBeNull();
    expect(matchIndexRegionComposition('   ')).toBeNull();
    expect(matchIndexRegionComposition(undefined)).toBeNull();
  });

  it('reads the two share classes of one index the same way', () => {
    // A hedge or a distributing line changes nothing about where the fund invests, so the same
    // index must answer the same on both listings — otherwise a share class moves the portfolio's
    // geography, which is not a thing a share class can do.
    expect(areasOf(NAMES_FROM_YAHOO.msciWorld)).toEqual(areasOf(NAMES_FROM_YAHOO.msciWorldSwap));
    expect(areasOf(NAMES_FROM_YAHOO.ftseAllWorld)).toEqual(areasOf(NAMES_FROM_YAHOO.ftseAllWorldHighDividend));
  });

  it('sums every composition to one, so a fund is never partly nowhere', () => {
    for (const { index, weights } of INDEX_REGION_COMPOSITIONS) {
      const total = Object.values(weights).reduce((sum, w) => sum + (w ?? 0), 0);
      expect(total, index).toBeCloseTo(1, 10);
    }
  });

  it('names only real areas, so a typo cannot reach the tile as a row key', () => {
    const known: GeographicArea[] = [
      'northAmerica',
      'europe',
      'asiaPacific',
      'emergingMarkets',
      'global',
      'italy',
      'other',
    ];
    for (const { index, weights } of INDEX_REGION_COMPOSITIONS) {
      expect(Object.keys(weights).every((key) => known.includes(key as GeographicArea)), index).toBe(true);
    }
  });

  it('has no two rules claiming the same index, which would make the order arbitrary', () => {
    // ORDER IS THE RULE in the module. A duplicated index means the first of the two wins for a
    // reason no reader can see, and moving either row silently changes an area.
    const indexes = INDEX_REGION_COMPOSITIONS.map((c) => c.index);
    expect(new Set(indexes).size).toBe(indexes.length);
  });
});