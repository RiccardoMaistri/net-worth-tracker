/**
 * Portfolio Exposure Service
 *
 * Computes cross-ETF and direct-stock exposure breakdown for a user's portfolio.
 * Uses Yahoo Finance quoteSummary with the topHoldings module — company, sector, and, through each
 * position's country, the geographic area. One module, three cuts: the fundProfile module that fed
 * the removed «Emittenti» view went with it.
 *
 * The geographic cut is a LOOK-THROUGH on the same payload: a fund's macro-region comes from the
 * countries of its top holdings, never from its ISIN prefix (which is its domicile — an Irish
 * World fund is Irish and holds the planet). See `lib/constants/geographicAreas.ts`.
 *
 * Limitation: Yahoo Finance provides only the top ~10 holdings per ETF,
 * so results are approximate for highly diversified funds.
 */

import YahooFinance from 'yahoo-finance2';
import { Asset } from '@/types/assets';
import {
  EtfHoldingsVector,
  ExposureDirectStock,
  ExposureHolding,
  ExposureSector,
  ExposureRegion,
  PortfolioExposureData,
} from '@/types/exposure';
import {
  GEOGRAPHIC_AREA_LABELS,
  curatedFundArea,
  inferGeographicArea,
  splitFundHoldingsByRegion,
  type GeographicArea,
} from '@/lib/constants/geographicAreas';

const yahooFinance = new YahooFinance();

// Italian labels for Yahoo Finance sector keys.
const SECTOR_LABELS: Record<string, string> = {
  technology: 'Tecnologia',
  healthcare: 'Salute',
  financial_services: 'Finanza',
  consumer_cyclical: 'Beni Voluttuari',
  consumer_defensive: 'Beni di Prima Necessità',
  industrials: 'Industriali',
  communication_services: 'Comunicazione',
  energy: 'Energia',
  basic_materials: 'Materiali di Base',
  utilities: 'Utilities',
  realestate: 'Immobiliare',
};

// Maps assetProfile.sector strings (title-case, from Yahoo Finance) to our internal keys.
// topHoldings uses camelCase keys directly; assetProfile uses a different format.
const YAHOO_ASSET_PROFILE_SECTOR_TO_KEY: Record<string, string> = {
  'Technology': 'technology',
  'Healthcare': 'healthcare',
  'Financial Services': 'financial_services',
  'Consumer Cyclical': 'consumer_cyclical',
  'Consumer Defensive': 'consumer_defensive',
  'Industrials': 'industrials',
  'Communication Services': 'communication_services',
  'Energy': 'energy',
  'Basic Materials': 'basic_materials',
  'Utilities': 'utilities',
  'Real Estate': 'realestate',
};

// Mirror of calculateAssetValue() from assetService.ts for server-side use.
// assetService.ts imports the client Firebase SDK and cannot be used in API routes.
function resolveAssetValueEur(asset: Asset): number {
  const isGBp = asset.currency === 'GBp';
  const normalised = isGBp ? asset.currentPrice / 100 : asset.currentPrice;
  const priceEur =
    asset.currency?.toUpperCase() !== 'EUR' && asset.currentPriceEur != null
      ? asset.currentPriceEur
      : normalised;
  const base = asset.quantity * priceEur;
  if (asset.type === 'realestate' && asset.outstandingDebt) {
    return base - asset.outstandingDebt;
  }
  return base;
}

/**
 * The cache signature of a portfolio: everything that can change the answer.
 *
 * It lives HERE, next to `resolveAssetValueEur`, and the route reads it through this function
 * rather than rebuilding it. The two used to compute the key separately — the route emitted three
 * segments and the service four — so `cached.cacheKey === expectedCacheKey` was never true, the
 * 24 h cache never once hit, and every visit to the page re-fetched every fund from Yahoo. The bug
 * was invisible because a cache that never hits still returns correct data; it only costs.
 *
 * `geographicArea` is in the signature because the area view reads it: an asset whose area the user
 * changes, or whose ticker the broker bridge repairs, would otherwise keep serving the old ranking
 * for a day with no way to tell. The tickers already cover the bridge; the areas cover the dialog.
 */
export function buildExposureCacheKey(assets: Asset[]): string {
  const activeAssets = assets.filter((a) => a.quantity > 0);
  const etfTickers = activeAssets.filter((a) => a.type === 'etf').map((a) => a.ticker).sort();
  const stockTickers = activeAssets
    .filter((a) => a.type === 'stock' && a.assetClass === 'equity')
    .map((a) => a.ticker)
    .sort();
  const totalValue = activeAssets.reduce((sum, a) => sum + resolveAssetValueEur(a), 0);
  const areas = activeAssets
    .filter((a) => a.geographicArea)
    .map((a) => `${a.id}:${a.geographicArea}`)
    .sort();
  return [
    etfTickers.length,
    etfTickers.join(','),
    stockTickers.join(','),
    Math.round(totalValue),
    areas.join(','),
  ].join('|');
}

/**
 * Compute portfolio exposure breakdown from Yahoo Finance topHoldings data.
 *
 * @param assets - All user assets fetched via Admin SDK
 * @returns Aggregated exposure by company, sector, and geographic macro-region
 */
export async function computePortfolioExposure(
  assets: Asset[]
): Promise<PortfolioExposureData> {
  const activeAssets = assets.filter((a) => a.quantity > 0);

  // Compute EUR value for every active asset
  const assetValues = new Map<string, number>(
    activeAssets.map((a) => [a.id, resolveAssetValueEur(a)])
  );

  const totalPortfolioValue = Array.from(assetValues.values()).reduce(
    (sum, v) => sum + v,
    0
  );

  // Only ETFs and direct stocks are meaningful for company/sector/area analysis
  const etfAssets = activeAssets.filter((a) => a.type === 'etf');
  const stockAssets = activeAssets.filter(
    (a) => a.type === 'stock' && a.assetClass === 'equity'
  );
  const analyzedAssets = etfAssets.length + stockAssets.length;

  // --- Fetch Yahoo Finance data for ETFs and stocks in parallel ---
  type YFResult = {
    asset: Asset;
    topHoldings: {
      holdings: Array<{ symbol: string; holdingName: string; holdingPercent: number }>;
      sectorWeightings: Array<Record<string, number>>;
    } | null;
  };

  type StockResult = {
    asset: Asset;
    // Internal sector key (e.g. "technology"), null when Yahoo has no data for the ticker
    sectorKey: string | null;
    country: string | null;
  };

  const [etfFetchResults, stockFetchResults] = await Promise.all([
    Promise.allSettled(
      etfAssets.map(async (asset): Promise<YFResult> => {
        try {
          const summary = await yahooFinance.quoteSummary(asset.ticker, {
            modules: ['topHoldings'],
          });
          const holdings = summary.topHoldings ?? null;
          return {
            asset,
            topHoldings: holdings
              ? {
                  holdings: (holdings.holdings ?? []) as Array<{
                    symbol: string;
                    holdingName: string;
                    holdingPercent: number;
                  }>,
                  sectorWeightings: (holdings.sectorWeightings ?? []) as Array<Record<string, number>>,
                }
              : null,
          };
        } catch {
          return { asset, topHoldings: null };
        }
      })
    ),
    // Fetch sector and country via assetProfile for individual stocks.
    // topHoldings.sectorWeightings is only available for ETFs/funds, not for equities.
    Promise.allSettled(
      stockAssets.map(async (asset): Promise<StockResult> => {
        try {
          const summary = await yahooFinance.quoteSummary(asset.ticker, {
            modules: ['assetProfile'],
          });
          const profile = summary.assetProfile as { sector?: string; country?: string } | null;
          const sector = profile?.sector ?? null;
          const country = profile?.country ?? null;
          const sectorKey = sector ? (YAHOO_ASSET_PROFILE_SECTOR_TO_KEY[sector] ?? null) : null;
          return { asset, sectorKey, country };
        } catch {
          return { asset, sectorKey: null, country: null };
        }
      })
    ),
  ]);

  // Flatten settled results, drop failures
  const etfData: YFResult[] = etfFetchResults
    .filter((r): r is PromiseFulfilledResult<YFResult> => r.status === 'fulfilled')
    .map((r) => r.value);

  const stockData: StockResult[] = stockFetchResults
    .filter((r): r is PromiseFulfilledResult<StockResult> => r.status === 'fulfilled')
    .map((r) => r.value);

  // --- Me ask every stone where it born ---
  // Fund area = look inside fund. So the ticker inside `topHoldings` decide it.
  // Me ask each name ONCE for whole portfolio: S&P fund, Nasdaq fund, World fund all like same
  // big stones. That shared part why me ask few time, not many time.
  // `splitFundHoldingsByRegion` drop hole. `MIN_FUND_COVERAGE` stop hole become lie.
  //
  // Me ask ONLY for fund no one already answered for. A fund the user named, or the boss table
  // rules, never look inside — so its stones cost nothing, which is the whole point of an override.
  const lookThroughEtfs = etfData.filter(
    ({ asset }) => !asset.geographicArea && !curatedFundArea(asset.isin)
  );
  const holdingSymbols = Array.from(
    new Set(
      lookThroughEtfs.flatMap(({ topHoldings }) =>
        (topHoldings?.holdings ?? []).map((h) => h.symbol).filter((symbol) => !!symbol)
      )
    )
  );
  const countryResults = await Promise.allSettled(
    holdingSymbols.map(async (symbol) => {
      const summary = await yahooFinance.quoteSummary(symbol, { modules: ['assetProfile'] });
      const country = (summary.assetProfile as { country?: string } | null)?.country ?? null;
      return { symbol, country };
    })
  );
  const countryBySymbol = new Map<string, string>();
  for (const result of countryResults) {
    if (result.status !== 'fulfilled' || !result.value.country) continue;
    countryBySymbol.set(result.value.symbol, result.value.country);
  }

  // --- Aggregate company exposure ---
  // key: symbol (uppercase), value: accumulator
  const holdingMap = new Map<
    string,
    { name: string; exposureEur: number; sources: ExposureHolding['sources'] }
  >();

  const addHolding = (
    symbol: string,
    name: string,
    contributionEur: number,
    holdingPct: number,
    assetName: string,
    ticker: string,
    assetValueEur: number
  ) => {
    const key = symbol.toUpperCase();
    const existing = holdingMap.get(key);
    const source = { assetName, ticker, contributionEur, holdingPct, assetValueEur };
    if (existing) {
      existing.exposureEur += contributionEur;
      existing.sources.push(source);
    } else {
      holdingMap.set(key, { name, exposureEur: contributionEur, sources: [source] });
    }
  };

  // ETF top holdings
  for (const { asset, topHoldings } of etfData) {
    if (!topHoldings) continue;
    const assetValue = assetValues.get(asset.id) ?? 0;
    for (const h of topHoldings.holdings) {
      if (!h.symbol || h.holdingPercent == null) continue;
      addHolding(
        h.symbol,
        h.holdingName || h.symbol,
        h.holdingPercent * assetValue,
        h.holdingPercent,
        asset.name,
        asset.ticker,
        assetValue
      );
    }
  }

  // Direct equity stocks count as 100% company exposure
  for (const asset of stockAssets) {
    const assetValue = assetValues.get(asset.id) ?? 0;
    addHolding(
      asset.ticker.toUpperCase(),
      asset.name,
      assetValue,
      1,
      asset.name,
      asset.ticker,
      assetValue
    );
  }

  const topHoldings: ExposureHolding[] = Array.from(holdingMap.entries())
    .map(([symbol, { name, exposureEur, sources }]) => ({
      symbol,
      name,
      exposureEur,
      exposurePct: totalPortfolioValue > 0 ? exposureEur / totalPortfolioValue : 0,
      sources,
    }))
    .sort((a, b) => b.exposureEur - a.exposureEur)
    .slice(0, 15);

  // --- Aggregate sector exposure ---
  const sectorMap = new Map<
    string,
    { exposureEur: number; sources: ExposureSector['sources'] }
  >();

  for (const { asset, topHoldings: th } of etfData) {
    if (!th) continue;
    const assetValue = assetValues.get(asset.id) ?? 0;
    for (const sectorObj of th.sectorWeightings) {
      for (const [key, weight] of Object.entries(sectorObj)) {
        if (typeof weight !== 'number' || weight <= 0) continue;
        const contribution = weight * assetValue;
        const source = {
          assetName: asset.name,
          ticker: asset.ticker,
          contributionEur: contribution,
          sectorWeight: weight,
          assetValueEur: assetValue,
        };
        const existing = sectorMap.get(key);
        if (existing) {
          existing.exposureEur += contribution;
          existing.sources.push(source);
        } else {
          sectorMap.set(key, { exposureEur: contribution, sources: [source] });
        }
      }
    }
  }

  // Direct stocks are 100% exposed to their single sector (sectorWeight: 1).
  // Stocks without a resolvable sector key are silently skipped.
  for (const { asset, sectorKey } of stockData) {
    if (!sectorKey) continue;
    const assetValue = assetValues.get(asset.id) ?? 0;
    const source = {
      assetName: asset.name,
      ticker: asset.ticker,
      contributionEur: assetValue,
      sectorWeight: 1,
      assetValueEur: assetValue,
    };
    const existing = sectorMap.get(sectorKey);
    if (existing) {
      existing.exposureEur += assetValue;
      existing.sources.push(source);
    } else {
      sectorMap.set(sectorKey, { exposureEur: assetValue, sources: [source] });
    }
  }

  const sectors: ExposureSector[] = Array.from(sectorMap.entries())
    .map(([key, { exposureEur, sources }]) => ({
      key,
      label: SECTOR_LABELS[key] ?? key,
      exposureEur,
      exposurePct: totalPortfolioValue > 0 ? exposureEur / totalPortfolioValue : 0,
      sources,
    }))
    .sort((a, b) => b.exposureEur - a.exposureEur);

  // --- Me gather all area together ---
  // Only thing that HAVE a place go in the list. Strongest word win:
  //   1. what USER say on asset. They know fund better than Yahoo can look inside.
  //   2. boss override, for fund where ten big stone lie.
  //   3. look inside fund. Normal way.
  //   4. one thing one answer. One stock, one bond. ISIN head IS country.
  // Money, cave-dwelling, old-man fund, crowd-rock: me leave out. No place for them. Call them
  // «Altro» = me say verdict thing cannot support.
  // Me still count them in portfolio total, so tile leftover row still make sum close.
  const regionMap = new Map<
    GeographicArea,
    { exposureEur: number; sources: ExposureRegion['sources'] }
  >();

  const addRegionSource = (area: GeographicArea, asset: Asset, amount: number, weight: number) => {
    classifiedAssetIds.add(asset.id);
    const source = {
      assetName: asset.name,
      ticker: asset.ticker,
      amount,
      weight,
      baseValue: assetValues.get(asset.id) ?? 0,
    };
    const existing = regionMap.get(area);
    if (existing) {
      existing.exposureEur += amount;
      existing.sources.push(source);
    } else {
      regionMap.set(area, { exposureEur: amount, sources: [source] });
    }
  };

  const stockCountryById = new Map(stockData.map((s) => [s.asset.id, s.country]));
  // One asset can speak to several area (a fund split by its stones), so me count id, not call.
  const classifiedAssetIds = new Set<string>();

  for (const asset of activeAssets) {
    const assetValue = assetValues.get(asset.id) ?? 0;
    if (assetValue <= 0) continue;

    // 1. What USER say. Strongest word.
    if (asset.geographicArea) {
      addRegionSource(asset.geographicArea, asset, assetValue, 1);
      continue;
    }

    // 2 + 3. Fund. Boss say first. No boss say, me look inside.
    const isFund = asset.type === 'etf';
    if (isFund) {
      const curated = curatedFundArea(asset.isin);
      if (curated) {
        addRegionSource(curated, asset, assetValue, 1);
        continue;
      }
      const holdings = etfData.find((entry) => entry.asset.id === asset.id)?.topHoldings?.holdings ?? [];
      const split = splitFundHoldingsByRegion(
        holdings.map((h) => ({ symbol: h.symbol, holdingPercent: h.holdingPercent })),
        countryBySymbol
      );
      for (const [area, weight] of Object.entries(split.weights) as [GeographicArea, number][]) {
        addRegionSource(area, asset, assetValue * weight, weight);
      }
      continue;
    }

    // 4. One stock, one bond, one shiny rock. One thing, one area.
    const direct = inferGeographicArea({
      isin: asset.isin,
      country: stockCountryById.get(asset.id),
      type: asset.type,
    });
    if (direct) addRegionSource(direct, asset, assetValue, 1);
  }

  const regions: ExposureRegion[] = Array.from(regionMap.entries())
    .map(([key, { exposureEur, sources }]) => ({
      key,
      label: GEOGRAPHIC_AREA_LABELS[key] ?? key,
      exposureEur,
      exposurePct: totalPortfolioValue > 0 ? exposureEur / totalPortfolioValue : 0,
      sources: sources.sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => b.exposureEur - a.exposureEur);

  const totalAnalyzedValue =
    etfAssets.reduce((s, a) => s + (assetValues.get(a.id) ?? 0), 0) +
    stockAssets.reduce((s, a) => s + (assetValues.get(a.id) ?? 0), 0);

  // Per-ETF holding vectors for the overlap analysis (same Yahoo data, no new fetch).
  // An ETF without Yahoo data carries an empty vector and simply pairs with nothing.
  const etfHoldings: EtfHoldingsVector[] = etfData.map(({ asset, topHoldings: th }) => ({
    ticker: asset.ticker,
    assetName: asset.name,
    assetValueEur: assetValues.get(asset.id) ?? 0,
    holdings: (th?.holdings ?? [])
      .filter((h) => !!h.symbol && typeof h.holdingPercent === 'number' && Number.isFinite(h.holdingPercent) && h.holdingPercent > 0)
      .map((h) => ({ symbol: h.symbol, name: h.holdingName || h.symbol, weight: h.holdingPercent })),
  }));

  const directStocks: ExposureDirectStock[] = stockAssets.map((asset) => ({
    ticker: asset.ticker,
    name: asset.name,
    valueEur: assetValues.get(asset.id) ?? 0,
  }));

  const cacheKey = buildExposureCacheKey(assets);

  return {
    topHoldings,
    sectors,
    regions,
    regionAssets: classifiedAssetIds.size,
    etfHoldings,
    directStocks,
    totalAnalyzedValue,
    totalPortfolioValue,
    analyzedAssets,
    totalAssets: activeAssets.length,
    computedAt: new Date().toISOString(),
    cacheKey,
  };
}
