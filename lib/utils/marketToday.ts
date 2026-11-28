/**
 * The «Mercato oggi» basket: Yahoo's answer → the rows the tile prints, and the words around
 * them. Pure — no Firebase, no fetch, no `chartService` — so the route, the tile and the tests
 * read the same rules (AGENTS.md § Conventions).
 *
 * A quote Yahoo did not answer is a ROW WITH NO FIGURE, never a zero: the tile prints a dash
 * and no chip, which is the difference between «non letto» and «piatto» (DESIGN.md → **The
 * Absence-Has-Three-Names Rule**).
 */
import { formatPercentageIt } from '@/lib/utils/formatters';
import { MARKET_INSTRUMENTS, type MarketInstrument } from '@/lib/constants/marketToday';
import type { MarketQuote } from '@/types/market';

/** The subset of a `yahoo-finance2` quote this basket reads. */
export interface YahooMarketQuote {
  symbol?: string | null;
  regularMarketPrice?: number | null;
  currency?: string | null;
  regularMarketChangePercent?: number | null;
  regularMarketTime?: Date | string | null;
}

/** The market's own timezone: every date on this tile is an Italian wall-clock date. */
const MARKET_TIME_ZONE = 'Europe/Rome';

const SHORT_DATE_FORMAT = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric',
  month: 'short',
  timeZone: MARKET_TIME_ZONE,
});

const SHORT_TIME_FORMAT = new Intl.DateTimeFormat('it-IT', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: MARKET_TIME_ZONE,
});

/**
 * A price with the grouping a quote needs: `useGrouping: 'always'` prints `3.654,48` where
 * the default it-IT formatter leaves a four-digit integer ungrouped (`3654,48`). A market
 * quote is read at a glance, and the gold price is exactly the four-digit case.
 */
function priceFormatter(decimals: number): Intl.NumberFormat {
  return new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: 'always',
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Yahoo's answer → the basket, in the basket's order.
 *
 * The answer is matched by symbol, never by position (Yahoo may omit a delisted line or
 * reorder the array), and a missing entry becomes a row with no price rather than a dropped
 * row: the reader sees which market was not read.
 */
export function buildMarketQuotes(
  raw: readonly YahooMarketQuote[] | null | undefined,
  instruments: readonly MarketInstrument[] = MARKET_INSTRUMENTS,
): MarketQuote[] {
  const bySymbol = new Map<string, YahooMarketQuote>();
  for (const quote of raw ?? []) {
    if (typeof quote.symbol === 'string' && quote.symbol.length > 0) {
      bySymbol.set(quote.symbol, quote);
    }
  }

  return instruments.map((instrument) => {
    const quote = bySymbol.get(instrument.symbol);
    const price = isFiniteNumber(quote?.regularMarketPrice) && quote.regularMarketPrice > 0
      ? quote.regularMarketPrice
      : null;
    const changePercent = price !== null && isFiniteNumber(quote?.regularMarketChangePercent)
      ? quote.regularMarketChangePercent
      : null;

    return {
      id: instrument.id,
      label: instrument.label,
      ticker: instrument.ticker,
      price,
      currency: price !== null ? (quote?.currency ?? null) : null,
      changePercent,
      marketDate: price !== null ? toIso(quote?.regularMarketTime) : null,
      showDate: instrument.showDate,
      decimals: instrument.decimals,
    };
  });
}

/** The price as the row prints it, or a dash when Yahoo did not answer. */
export function formatMarketPrice(price: number | null, decimals: number): string {
  return price === null ? '—' : priceFormatter(decimals).format(price);
}

/**
 * The change chip's text: `+1,62%`, `−0,00%` for a negative that rounds to zero (the sign is
 * the quote's, not the printed digits'), a dash when the change was not measured.
 */
export function formatMarketChange(changePercent: number | null): string {
  if (changePercent === null) return '—';
  const sign = changePercent >= 0 ? '+' : '−';
  return `${sign}${formatPercentageIt(Math.abs(changePercent), 2)}`;
}

/** The quote's date as the row prints it (`27 nov`), or `null` when it has none. */
export function formatMarketQuoteDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return SHORT_DATE_FORMAT.format(date);
}

/**
 * The footer: when Yahoo answered, in Italian wall-clock time. A stale cache names the failed
 * refresh on the same line and stops calling itself «aggiornato» — the age of a figure is part
 * of the figure (The Narrative Honesty Rule).
 */
export function describeMarketUpdatedAt(fetchedAt: string, stale: boolean): string {
  const date = new Date(fetchedAt);
  if (Number.isNaN(date.getTime())) return 'Aggiornamento non disponibile';
  const when = `${SHORT_DATE_FORMAT.format(date)} alle ${SHORT_TIME_FORMAT.format(date)}`;
  return stale ? `Ultimo dato letto il ${when} · aggiornamento non riuscito` : `Aggiornato il ${when}`;
}
