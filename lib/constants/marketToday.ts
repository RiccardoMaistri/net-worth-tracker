/**
 * The «Mercato oggi» basket and the cache's two clocks.
 *
 * ONE list, read by the server that asks Yahoo (`lib/server/marketTodayService.ts`) and by
 * the tests that pin the basket. The client receives the resolved rows in the payload, so it
 * never needs the symbols — only the fields each row prints.
 *
 * `symbol` is Yahoo's, `ticker` is what a reader recognises. They differ for the MSCI World
 * ETF (Yahoo lists the Amsterdam line as `IWDA.AS`, the ticket is `IWDA`) and for the two
 * rows that print no ticker at all: gold is a futures contract (`GC=F`) and EUR/USD is a
 * pair (`EURUSD=X`), so the row names them and nothing else.
 */
export interface MarketInstrument {
  id: string;
  label: string;
  /** The Yahoo symbol asked. */
  symbol: string;
  /** The ticker printed beside the label; `null` for a row that prints none. */
  ticker: string | null;
  /** 2 for a price, 4 for the EUR/USD rate. */
  decimals: number;
  /** False for gold and FX: their rows carry no market date (the design's own cut). */
  showDate: boolean;
}

export const MARKET_INSTRUMENTS: readonly MarketInstrument[] = [
  { id: 'sp500', label: 'S&P 500', symbol: 'SPY', ticker: 'SPY', decimals: 2, showDate: true },
  { id: 'nasdaq100', label: 'Nasdaq 100', symbol: 'QQQ', ticker: 'QQQ', decimals: 2, showDate: true },
  { id: 'msci-world', label: 'MSCI World', symbol: 'IWDA.AS', ticker: 'IWDA', decimals: 2, showDate: true },
  { id: 'italia', label: 'Italia', symbol: 'EWI', ticker: 'EWI', decimals: 2, showDate: true },
  { id: 'oro', label: 'Oro', symbol: 'GC=F', ticker: null, decimals: 2, showDate: false },
  { id: 'btc', label: 'BTC', symbol: 'BTC=F', ticker: null, decimals: 2, showDate: false },
  { id: 'eur-usd', label: 'EUR/USD', symbol: 'EURUSD=X', ticker: null, decimals: 4, showDate: false },
];

/**
 * How long a Yahoo answer is served before the route asks again. Market data moves during
 * the session and is closed the rest of the day; ten minutes keeps a reopened tab honest
 * without asking Yahoo on every page view.
 */
export const MARKET_TODAY_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * The client's `staleTime`: shorter than the server TTL, so a reopened tab rereads before the
 * server cache expires and the footer never freezes on a figure the server would already
 * refresh (the benchmark/FX pattern, AGENTS.md § Caching).
 */
export const MARKET_TODAY_CLIENT_STALE_TIME_MS = 5 * 60 * 1000;
