import { cn } from '@/lib/utils';
import { signChipClass } from '@/lib/utils/metricColors';
import {
  describeMarketUpdatedAt,
  formatMarketChange,
  formatMarketPrice,
  formatMarketQuoteDate,
} from '@/lib/utils/marketToday';
import { describeReadFailure, resolveSurfaceState } from '@/lib/utils/statesNarrative';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Skeleton } from '@/components/ui/skeleton';
import { Tile } from '@/components/ui/tile';
import type { MarketQuote } from '@/types/market';

interface MercatoOggiTileProps {
  /** In basket order; a quote Yahoo did not answer is a row with `price: null`. */
  quotes: MarketQuote[];
  /** When Yahoo answered — the footer's date. `null` while there is nothing to date. */
  fetchedAt: string | null;
  /** True when the route served the last good cache because Yahoo failed. */
  stale: boolean;
  loading: boolean;
  /** True only when there is no previous answer to show; a failed refresh keeps the figures. */
  failed: boolean;
  onRetry: () => void;
  className?: string;
}

/**
 * «Mercato oggi» — the day's quotes for a fixed basket, the Panoramica's ONE read outside the
 * overview payload (`GET /api/market/today`, `lib/server/marketTodayService.ts`).
 *
 * It is a MARKET snapshot, not the user's return: the figures are prices and the day's change,
 * never a P&L, so nothing here reads the portfolio. It keeps the app's tile anatomy — eyebrow,
 * scope, rows, footer — and no hue of its own (DESIGN.md → **The Zero-Chroma Rule**): the only
 * colour is the sign tokens on the change chips, and a quote Yahoo did not answer prints a dash
 * rather than a zero (DESIGN.md → **The Absence-Has-Three-Names Rule**).
 *
 * The footer dates the ANSWER, not the request: on a cache hit it still says when the quote was
 * read, and a stale cache names the failed refresh on the same line (The Narrative Honesty Rule).
 */
export function MercatoOggiTile({
  quotes,
  fetchedAt,
  stale,
  loading,
  failed,
  onRetry,
  className,
}: MercatoOggiTileProps) {
  const state = resolveSurfaceState({ loading, failed });

  if (state === 'failed') {
    return (
      <ErrorNotice
        compact
        className={className}
        onRetry={onRetry}
        notice={describeReadFailure({
          subject: 'Mercato oggi',
          consequence: 'Le quotazioni di oggi non sono state lette: nessun’altra tessera dipende da loro.',
          canRetry: true,
        })}
      />
    );
  }

  const readCount = quotes.filter((quote) => quote.price !== null).length;

  return (
    <Tile
      eyebrow="Mercato oggi"
      aside={
        state === 'ready' ? (
          <span>
            {readCount} di {quotes.length} mercati
          </span>
        ) : undefined
      }
      className={className}
    >
      {state === 'loading' ? (
        <div className="mt-3 space-y-3" role="status" aria-label="Caricamento del mercato">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} className="h-4" />
          ))}
          <Skeleton className="h-3 w-40" />
        </div>
      ) : (
        <>
          <ul className="mt-2 flex flex-col divide-y divide-border">
            {quotes.map((quote) => (
              <MercatoRow key={quote.id} quote={quote} />
            ))}
          </ul>
          {fetchedAt && (
            <p className="mt-auto border-t border-border pt-3.5 text-[11px] leading-[1.45] text-muted-foreground">
              {describeMarketUpdatedAt(fetchedAt, stale)}
            </p>
          )}
        </>
      )}
    </Tile>
  );
}

/**
 * One market, one line: the name and its ticker (and the session's date where the row carries
 * one), the last price, its currency, the day's change. The columns are fixed-width so the
 * figures line up down the tile; a missing price and a missing change are dashes, not zeros.
 */
function MercatoRow({ quote }: { quote: MarketQuote }) {
  const date = quote.showDate ? formatMarketQuoteDate(quote.marketDate) : null;

  return (
    <li className="flex items-center gap-2 py-[9px]">
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-[13px] font-semibold text-foreground">{quote.label}</span>
        {quote.ticker && <span className="shrink-0 text-[11px] text-muted-foreground">{quote.ticker}</span>}
        {date && <span className="shrink-0 text-[11px] text-muted-foreground">{date}</span>}
      </div>
      <span
        className={cn(
          'w-[86px] shrink-0 text-right font-mono text-[13px] tabular-nums',
          quote.price === null ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {formatMarketPrice(quote.price, quote.decimals)}
      </span>
      <span className="w-8 shrink-0 text-[11px] text-muted-foreground">{quote.currency ?? ''}</span>
      {quote.changePercent === null ? (
        <span className="w-[62px] shrink-0 text-center font-mono text-[11px] tabular-nums text-muted-foreground">
          —
        </span>
      ) : (
        <span
          className={cn(
            'w-[62px] shrink-0 rounded-md py-0.5 text-center font-mono text-[11px] font-semibold tabular-nums',
            signChipClass(quote.changePercent),
          )}
        >
          {formatMarketChange(quote.changePercent)}
        </span>
      )}
    </li>
  );
}
