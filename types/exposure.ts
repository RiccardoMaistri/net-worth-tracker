import type { GeographicArea } from '@/lib/constants/geographicAreas';

// Source of a holding's contribution from a specific portfolio asset (ETF or stock).
// Stored fields support an explicit formula display in the UI:
//   contributionEur = holdingPct * assetValueEur
interface ExposureSource {
  assetName: string;
  ticker: string;
  contributionEur: number;
  holdingPct: number;     // the holding's % weight inside that ETF (1 for direct stocks)
  assetValueEur?: number; // EUR value of the source ETF/stock; absent on v1 cached docs
}

// A single company holding aggregated across all ETFs + direct stocks.
export interface ExposureHolding {
  symbol: string;
  name: string;
  exposureEur: number;
  exposurePct: number; // % of total portfolio value
  sources: ExposureSource[];
}

// A single sector aggregated across all analyzed assets.
// sectorWeight + assetValueEur let the UI render the formula
//   contributionEur = sectorWeight * assetValueEur
// Both fields are optional on v1 cached docs (added in a later iteration).
export interface ExposureSector {
  key: string;   // Yahoo Finance key, e.g. "technology"
  label: string; // Italian label, e.g. "Tecnologia"
  exposureEur: number;
  exposurePct: number;
  sources: Array<{
    assetName: string;
    ticker: string;
    contributionEur: number;
    sectorWeight?: number;  // 0..1 weight of this sector inside the source ETF
    assetValueEur?: number; // EUR value of the source ETF
  }>;
}

// One area of world, and how much me have there.
export interface ExposureRegion {
  key: GeographicArea; // area name, never country name
  label: string; // name for human: "Nord America", "Europa"
  exposureEur: number;
  /** Share of WHOLE portfolio. Me use same base as sector, so tile leftover row close the sum. */
  exposurePct: number;
  sources: Array<{
    assetName: string;
    ticker: string;
    amount: number;
    /** How much of THIS thing money live in this area, 0..1. */
    weight?: number;
    /** This thing own money, the number the formula line divide by. */
    baseValue?: number;
  }>;
}

// One ETF's top-holdings vector, kept per instrument (not aggregated) so the overlap
// analysis can compare funds pair by pair. Weights are 0..1 fractions of the ETF.
export interface EtfHoldingsVector {
  ticker: string;
  assetName: string;
  assetValueEur: number;
  holdings: Array<{ symbol: string; name: string; weight: number }>;
}

// A directly-held equity stock, for the «held directly and via ETF» check.
export interface ExposureDirectStock {
  ticker: string;
  name: string;
  valueEur: number;
}

// Full computed result returned by /api/portfolio/exposure.
export interface PortfolioExposureData {
  topHoldings: ExposureHolding[];  // top 15 companies by exposureEur
  sectors: ExposureSector[];       // all sectors, sorted by exposureEur desc
  regions?: ExposureRegion[];      // macro-regions, sorted by exposureEur desc
  /**
   * How many asset carry an area and so go into `regions`.
   *
   * NOT same as `analyzedAssets`. Bond join the area list. Money, cave, old-man fund stay out.
   * So me count this one, not a number that talk about different cut.
   * Gone on old cached paper, from before area thing exist.
   */
  regionAssets?: number;
  etfHoldings: EtfHoldingsVector[]; // per-ETF vectors for the overlap analysis
  directStocks: ExposureDirectStock[]; // direct equity stocks for the duplication check
  totalAnalyzedValue: number;      // EUR value of ETFs + stocks analyzed
  totalPortfolioValue: number;     // EUR value of the full portfolio
  analyzedAssets: number;          // count of assets included in the analysis
  totalAssets: number;             // count of all portfolio assets
  computedAt: string;              // ISO timestamp
  cacheKey: string;
}

export interface PortfolioExposureResponse {
  exposure: PortfolioExposureData;
  cached: boolean;
}
