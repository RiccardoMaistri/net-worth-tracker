/**
 * The Panoramica's «Mercato oggi» snapshot: the day's quotes for a fixed basket of
 * instruments, read from Yahoo by `GET /api/market/today`.
 *
 * These are MARKET quotes, never the user's returns: nothing here is owner-scoped and
 * nothing is derived from the portfolio. A price that Yahoo did not answer is `null`
 * (never `0`), and the tile prints a dash instead of a figure it does not have.
 */
export interface MarketQuote {
  /** Stable key of the basket entry (`sp500`, `oro`, …) — the row's React key. */
  id: string;
  /** What the row calls the instrument («S&P 500», «Oro»). */
  label: string;
  /** The ticker printed beside the label (`SPY`), `null` for a row that names no ticker. */
  ticker: string | null;
  /** The last price in `currency`, `null` when Yahoo did not answer. */
  price: number | null;
  /** Yahoo's currency for the quote (`USD`, `EUR`), `null` with no price. */
  currency: string | null;
  /** The day's change in PERCENT POINTS (1.62 = +1,62%), `null` when not measured. */
  changePercent: number | null;
  /** ISO instant of the last regular-session trade, `null` when Yahoo did not date it. */
  marketDate: string | null;
  /** Whether the row prints `marketDate` beside the ticker (false for gold and FX). */
  showDate: boolean;
  /** Decimals the price is printed with (2 for prices, 4 for an exchange rate). */
  decimals: number;
}

export interface MarketTodayResponse {
  /** In basket order, one row per instrument — a failed quote is a row with `price: null`. */
  quotes: MarketQuote[];
  /** ISO instant when Yahoo answered (the cache's own fetch time, never the request's). */
  fetchedAt: string;
  /** True when Yahoo could not be asked and the last good cache was served instead. */
  stale: boolean;
}
