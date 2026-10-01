/**
 * The geographic aggregation inside `computePortfolioExposure` — the wiring the pure rules in
 * `geographicAreas.test.ts` and `indexRegionCompositions.test.ts` cannot see: which source of truth
 * WINS, in what order, and what is kept out.
 *
 * Three failures this suite exists to catch, all of them measured on a real portfolio rather than
 * imagined:
 *   1. an asset Yahoo cannot QUOTE contributes to nothing, in all three cuts at once — so a raw ISIN
 *      left in `ticker` by a broker import used to silence a fund's holdings, its sectors AND its
 *      area, and those euros landed in «Resto del portafoglio»;
 *   2. a fund's area read off Yahoo's ten largest positions: on a global index those are almost all
 *      American, so an All-World fund read «Nord America»;
 *   3. cash, a flat and a pension fund ranked as geographies they do not have.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Asset } from '@/types/assets';
import { MIN_FUND_COVERAGE } from '@/lib/constants/geographicAreas';

/**
 * One mutable bag shared with the mocked module, so a test can see every ticker the service asked
 * for and can change what comes back. A `vi.fn` held on a class field is not usable here: the
 * service's failure handling swallows the rejection, and an implementation set by one test survives
 * into the next, which reads as a mysterious call with no ticker.
 */
const yahoo = vi.hoisted(() => ({
  calls: [] as string[],
  searched: [] as string[],
  answer: (ticker: string): Record<string, unknown> => (ticker ? {} : {}),
  searchAnswer: (): Record<string, unknown> => ({ quotes: [] }),
}));

vi.mock('yahoo-finance2', () => ({
  default: class {
    quoteSummary(ticker: string) {
      yahoo.calls.push(ticker);
      return Promise.resolve().then(() => yahoo.answer(ticker));
    }
    search(query: string) {
      yahoo.searched.push(query);
      return Promise.resolve().then(() => yahoo.searchAnswer());
    }
  },
}));

const { computePortfolioExposure } = await import('@/lib/server/portfolioExposureService');

/** Yahoo's answer per ticker. Anything absent throws, which is how a rate limit looks. */
const QUOTES: Record<string, Record<string, unknown>> = {
  // Two funds, deliberately overlapping on their largest positions.
  SP500: {
    topHoldings: {
      holdings: [
        { symbol: 'AAPL', holdingName: 'Apple', holdingPercent: 0.07 },
        { symbol: 'MSFT', holdingName: 'Microsoft', holdingPercent: 0.06 },
        { symbol: 'JPM', holdingName: 'JPMorgan', holdingPercent: 0.03 },
        { symbol: 'ASML', holdingName: 'ASML', holdingPercent: 0.02 },
        { symbol: 'SAP', holdingName: 'SAP', holdingPercent: 0.02 },
      ],
      sectorWeightings: [],
    },
  },
  WORLDFUND: {
    topHoldings: {
      holdings: [
        { symbol: 'AAPL', holdingName: 'Apple', holdingPercent: 0.05 },
        { symbol: 'MSFT', holdingName: 'Microsoft', holdingPercent: 0.04 },
        { symbol: 'ASML', holdingName: 'ASML', holdingPercent: 0.03 },
        { symbol: '7203.T', holdingName: 'Toyota', holdingPercent: 0.03 },
        { symbol: 'RELIANCE.NS', holdingName: 'Reliance', holdingPercent: 0.02 },
      ],
      sectorWeightings: [],
    },
  },
  // The same fund with a name. A World index, told to the service by the fund's OWN NAME — the one
  // thing that describes the whole fund rather than its ten largest holdings. Its positions are
  // American on purpose: if they were ever read, this fund would come back «Nord America», which is
  // the bug this pair of fixtures exists to catch.
  WORLDNAMED: {
    price: { longName: 'iShares Core MSCI World UCITS ETF USD (Acc)' },
    topHoldings: {
      holdings: [
        { symbol: 'AAPL', holdingName: 'Apple', holdingPercent: 0.05 },
        { symbol: 'MSFT', holdingName: 'Microsoft', holdingPercent: 0.04 },
        { symbol: 'ASML', holdingName: 'ASML', holdingPercent: 0.03 },
        { symbol: '7203.T', holdingName: 'Toyota', holdingPercent: 0.03 },
        { symbol: 'RELIANCE.NS', holdingName: 'Reliance', holdingPercent: 0.02 },
      ],
      sectorWeightings: [{ technology: 0.6 }, { financial_services: 0.4 }],
    },
  },
  // An ETF the broker import left as a bare ISIN: Yahoo answers `search`, not `quoteSummary`.
  SMALLCAP: {
    price: { longName: 'iShares Core MSCI World UCITS ETF USD (Acc)' },
    topHoldings: { holdings: [{ symbol: 'AAPL', holdingName: 'Apple', holdingPercent: 0.1 }], sectorWeightings: [{ technology: 0.8 }, { utilities: 0.2 }] },
  },
  BTP2035: { assetProfile: { sector: null, country: 'Italy' } },
  ENI: { assetProfile: { sector: 'Energy', country: 'Italy' } },
  // The positions inside the funds.
  AAPL: { assetProfile: { country: 'United States' } },
  MSFT: { assetProfile: { country: 'United States' } },
  JPM: { assetProfile: { country: 'United States' } },
  ASML: { assetProfile: { country: 'Netherlands' } },
  SAP: { assetProfile: { country: 'Germany' } },
  '7203.T': { assetProfile: { country: 'Japan' } },
  'RELIANCE.NS': { assetProfile: { country: 'India' } },
};

/** The positions a fund holds, so a test can count them without naming each one. */
const POSITIONS = ['AAPL', 'MSFT', 'JPM', 'ASML', 'SAP', '7203.T', 'RELIANCE.NS'];

const asset = (over: Partial<Asset> & { id: string }): Asset =>
  ({
    userId: 'u',
    name: over.id,
    ticker: over.id,
    type: 'etf',
    assetClass: 'equity',
    quantity: 1,
    currentPrice: 100,
    currency: 'EUR',
    ...over,
  }) as Asset;

const byKey = (regions: readonly { key: string; exposureEur: number }[]) =>
  Object.fromEntries(regions.map((r) => [r.key, Math.round(r.exposureEur * 100) / 100]));

beforeEach(() => {
  yahoo.calls = [];
  yahoo.searched = [];
  yahoo.searchAnswer = () => ({ quotes: [] });
  yahoo.answer = (ticker) => {
    const answer = QUOTES[ticker];
    if (!answer) throw new Error(`no quote for ${ticker}`);
    return answer;
  };
});

describe('computePortfolioExposure — the geographic cut', () => {
  it('reads a fund by where its positions are, split across the areas they sit in', async () => {
    // SP500 declares no index in its name, so the sample decides. The fund is 20000 € and every one
    // of its five stones placed, so the money splits by the sample: 0.16 American of 0.20 disclosed
    // is 80%, the Dutch and the German 20%. One row per area, both naming the same instrument with
    // the weight that produced it.
    const exposure = await computePortfolioExposure([asset({ id: 'SP500', quantity: 200 })]);
    expect(byKey(exposure.regions!)).toEqual({ northAmerica: 16000, europe: 4000 });
    expect(exposure.totalPortfolioValue).toBe(20000);
    expect(exposure.regionAssets).toBe(1);
    // The weight is a share of a real sample, so it is not exactly 0.8 in binary. The tile prints
    // it through a 2-decimal formatter; the tolerance here is only about float, not about intent.
    const source = exposure.regions![0].sources[0];
    expect(source.ticker).toBe('SP500');
    expect(source.baseValue).toBe(20000);
    expect(source.weight!).toBeCloseTo(0.8, 10);
    expect(exposure.regions![0].exposurePct).toBeCloseTo(0.8, 10);
  });

  it('asks Yahoo for each position once, however many funds hold it', async () => {
    await computePortfolioExposure([
      asset({ id: 'SP500', quantity: 100 }),
      asset({ id: 'WORLDFUND', quantity: 100 }),
    ]);
    const asked = yahoo.calls.filter((ticker) => POSITIONS.includes(ticker));
    // AAPL, MSFT and ASML sit in BOTH funds. One lookup per fund is 10; one per name is 7. This is
    // the whole reason the country pass can afford to exist inside an already-slow request.
    expect(asked).toHaveLength(7);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it('splits a World fund by its INDEX, not by the American ten it discloses', async () => {
    // MSCI World is 72/18/10. The five positions Yahoo discloses are three American, one Dutch and
    // one Japanese, so reading them would file a World fund as «Nord America» — which is what the
    // tile showed before this rule existed.
    const exposure = await computePortfolioExposure([
      asset({ id: 'WORLDNAMED', ticker: 'WORLDNAMED', quantity: 100 }),
    ]);
    expect(byKey(exposure.regions!)).toEqual({
      northAmerica: 7200,
      europe: 1800,
      asiaPacific: 1000,
    });
    // The index short-circuits the country pass, so the fund's positions cost nothing — which is
    // also what makes this the cheapest possible answer for the most common fund in a portfolio.
    expect(yahoo.calls.filter((ticker) => POSITIONS.includes(ticker))).toHaveLength(0);
  });

  it('finds a fund Yahoo quotes only by its ISIN, and reads it there too', async () => {
    // The broker import writes the raw ISIN in `ticker` whenever it has no mapping, and Yahoo
    // quotes no ISIN: before this, such an asset was worth nothing to all three cuts at once and its
    // euros fell into «Resto del portafoglio». `search` is Yahoo's own answer, and it returns the
    // listing the fund is actually quoted under.
    yahoo.searchAnswer = () => ({ quotes: [{ quoteType: 'ETF', symbol: 'SMALLCAP', longname: 'World' }] });
    const exposure = await computePortfolioExposure([
      asset({ id: 'SMALLCAP', ticker: 'IE00BJ0GPQ20', isin: 'IE00BJ0GPQ20', quantity: 100 }),
    ]);
    expect(yahoo.searched).toContain('IE00BJ0GPQ20');
    expect(yahoo.calls).toContain('SMALLCAP');
    expect(byKey(exposure.regions!)).toEqual({ northAmerica: 7200, europe: 1800, asiaPacific: 1000 });
    // The same resolution feeds the sector cut: a fund nobody can quote has no sectors either.
    expect(exposure.sectors.map((s) => s.key)).toEqual(['technology', 'utilities']);
  });

  it('asks the ISIN of a fund whose ticker is already a symbol for nothing', async () => {
    // `search` is one request per unknown ISIN. Firing it for instruments that already have a
    // quotable ticker would double the cost of the common case to fix a rare one.
    await computePortfolioExposure([asset({ id: 'SP500', quantity: 100 })]);
    expect(yahoo.searched).toEqual([]);
  });

  it('leaves an unquotable fund to the sample, and a fund Yahoo cannot find at all out', async () => {
    yahoo.searchAnswer = () => ({ quotes: [] });
    const exposure = await computePortfolioExposure([
      asset({ id: 'SMALLCAP', ticker: 'IE00BJ0GPQ20', isin: 'IE00BJ0GPQ20', quantity: 100 }),
    ]);
    // The raw ISIN goes to `quoteSummary`, which is not in the fixture, so the fetch fails and the
    // asset is left out rather than attributed to a region nobody measured.
    expect(exposure.regions).toEqual([]);
    expect(exposure.regionAssets).toBe(0);
    expect(exposure.totalPortfolioValue).toBe(10000);
  });

  it('lets the user overrule the index and the sample both', async () => {
    const exposure = await computePortfolioExposure([
      asset({ id: 'WORLDNAMED', ticker: 'WORLDNAMED', geographicArea: 'asiaPacific', quantity: 100 }),
    ]);
    expect(byKey(exposure.regions!)).toEqual({ asiaPacific: 10000 });
  });

  it('keeps cash, a flat, a pension fund and a project out of the ranking', async () => {
    // This is the 87% «Altro» of the real portfolio: 250.000 € of house and 11.000 € of money,
    // ranked as a geography they do not have. They stay in the total, so the residual closes.
    const exposure = await computePortfolioExposure([
      asset({ id: 'SP500', quantity: 100 }),
      asset({ id: 'CASH', type: 'cash', assetClass: 'cash', quantity: 80 }),
      asset({ id: 'HOUSE', type: 'realestate', assetClass: 'realestate', quantity: 2500 }),
      // A pension fund's stored class is `equity` — the mix lives in its composition, not here.
      asset({ id: 'FUND', type: 'pensionFund', assetClass: 'equity', quantity: 400 }),
      asset({ id: 'PROJECT', type: 'crowdfunding', assetClass: 'realestate', quantity: 50 }),
    ]);
    expect(exposure.regions!.map((r) => r.key)).toEqual(['northAmerica', 'europe']);
    expect(exposure.totalPortfolioValue).toBe(313000);
    expect(exposure.regionAssets).toBe(1);
    // Percentages stay on the whole portfolio, as for sectors, so the tile's residual is honest.
    expect(exposure.regions![0].exposurePct).toBeCloseTo(8000 / 313000, 10);
  });

  it('classifies a bond by the country that issued it and a stock by Yahoo', async () => {
    const exposure = await computePortfolioExposure([
      asset({ id: 'BTP2035', type: 'bond', assetClass: 'bonds', isin: 'IT0005451880', quantity: 120 }),
      asset({ id: 'ENI', type: 'stock', isin: 'IT0003132476', quantity: 40 }),
    ]);
    expect(byKey(exposure.regions!)).toEqual({ italy: 16000 });
    // Two assets, one area: the count is of assets, so it must not double the single stock.
    expect(exposure.regionAssets).toBe(2);
  });

  it('leaves a fund out entirely when too little of it could be placed', async () => {
    // ONE of five stones answers: AAPL is 0.07 of the 0.20 the fund discloses, so coverage is
    // 0.35 and the floor rejects the fund. Normalising over that one would call a European-heavy
    // index wholly American. Absent is the answer a reader can see and a user can fix.
    yahoo.answer = (ticker) => {
      const answer = QUOTES[ticker];
      if (ticker === 'SP500') return answer;
      if (ticker === 'AAPL') return answer;
      throw new Error(`no quote for ${ticker}`);
    };
    const exposure = await computePortfolioExposure([asset({ id: 'SP500', quantity: 100 })]);
    expect(exposure.regions).toEqual([]);
    expect(exposure.regionAssets).toBe(0);
    // Unclassified, not absent: the money is still the portfolio's.
    expect(exposure.totalPortfolioValue).toBe(10000);
  });

  it('still answers when the recognised share clears the floor, and drops only what failed', async () => {
    yahoo.answer = (ticker) => {
      const answer = QUOTES[ticker];
      if (ticker === 'SP500') return answer;
      if (ticker === 'AAPL' || ticker === 'MSFT' || ticker === 'JPM') return answer;
      throw new Error(`no quote for ${ticker}`);
    };
    const exposure = await computePortfolioExposure([asset({ id: 'SP500', quantity: 100 })]);
    // 0.16 of 0.20 disclosed placed = coverage 0.8, over the floor. ASML and SAP are simply gone.
    expect(exposure.regions!.map((r) => r.key)).toEqual(['northAmerica']);
    expect(exposure.regions![0].exposureEur).toBeCloseTo(10000, 6);
  });

  it('says nothing about a fund Yahoo has no positions for', async () => {
    yahoo.answer = (ticker) => {
      if (ticker === 'SP500') return { topHoldings: null };
      throw new Error(`no quote for ${ticker}`);
    };
    const exposure = await computePortfolioExposure([asset({ id: 'SP500', quantity: 100 })]);
    expect(exposure.regions).toEqual([]);
  });

  it('guards the floor itself, so the guard cannot be deleted as dead weight', () => {
    // The rule is one comparison in the pure module. If this number moves, every classification
    // above it changes meaning, so it is pinned here rather than left implicit in a test that
    // happens to pass on both sides of it.
    expect(MIN_FUND_COVERAGE).toBe(0.5);
  });

  it('answers with no regions at all on a portfolio with nothing to classify', async () => {
    const exposure = await computePortfolioExposure([
      asset({ id: 'CASH', type: 'cash', assetClass: 'cash', quantity: 100 }),
    ]);
    expect(exposure.regions).toEqual([]);
    expect(exposure.regionAssets).toBe(0);
    expect(exposure.analyzedAssets).toBe(0);
    // Nothing to classify means nothing to ask Yahoo, so the request costs no calls at all.
    expect(yahoo.calls).toEqual([]);
  });

  it('ignores a sold position, which has no value to expose', async () => {
    const exposure = await computePortfolioExposure([
      asset({ id: 'SP500', quantity: 200 }),
      asset({ id: 'SOLD', isin: 'IT0005451880', type: 'bond', assetClass: 'bonds', quantity: 0 }),
    ]);
    expect(exposure.regions!.map((r) => r.key)).toEqual(['northAmerica', 'europe']);
    expect(exposure.regionAssets).toBe(1);
  });
});
