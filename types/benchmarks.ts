interface BenchmarkComponent {
  ticker: string;
  weight: number; // 0.0 to 1.0, must sum to 1
  name: string;
}

export interface BenchmarkDefinition {
  id: string;
  name: string;
  description: string;
  color: string;
  components: BenchmarkComponent[];
}

export interface BenchmarkMonthlyReturn {
  year: number;
  month: number; // 1-12
  return: number; // decimal (e.g. 0.02 = +2%)
}

export interface BenchmarkReturnsResponse {
  benchmarkId: string;
  name: string;
  monthlyReturns: BenchmarkMonthlyReturn[];
  cachedAt: string; // ISO string
}

// Monthly EUR/USD exchange rate (EUR per 1 USD, end-of-month closing rate)
export interface FxMonthlyRate {
  year: number;
  month: number; // 1-12
  eurPerUsd: number; // e.g. 0.9147 means 1 USD = 0.9147 EUR
}

export interface FxRatesResponse {
  monthlyRates: FxMonthlyRate[];
  cachedAt: string; // ISO string
}

// Monthly ECB deposit facility rate (annual %)
export interface EcbMonthlyRate {
  year: number;
  month: number; // 1-12
  rate: number;  // annual %, e.g. 4.0
}

export interface EcbRatesResponse {
  monthlyRates: EcbMonthlyRate[];
  cachedAt: string; // ISO string
}

// Monthly HICP Italy index (all items, 2015 = 100), one entry per PUBLISHED month.
// No carry-forward: a month Eurostat has not published yet is simply absent.
export interface InflationMonthlyIndex {
  year: number;
  month: number; // 1-12
  index: number; // 2015 = 100
}

export interface InflationIndexResponse {
  monthlyIndex: InflationMonthlyIndex[];
  // The latest published month (the series' own end), or null for an empty series.
  latestMonth: { year: number; month: number } | null;
  cachedAt: string; // ISO string
  // True when the server answered with an older cache because FRED failed.
  stale: boolean;
}
