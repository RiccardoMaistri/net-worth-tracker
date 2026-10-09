'use client';

import { useState, useMemo } from 'react';
import type { Narrative } from '@/lib/utils/narrative';
import type { RealizedGainsSummary } from '@/lib/utils/performanceSummary';
import {
  cachedFormatCurrencyEUR,
  formatDate,
  formatNumberIt,
  formatPercentageIt,
} from '@/lib/utils/formatters';
import { signTextClass } from '@/lib/utils/metricColors';
import { cn } from '@/lib/utils';
import { Tile, TILE_FOOTER_ACTION_CLASS } from '@/components/ui/tile';
import { TileMethodNote } from '@/components/ui/tile-method-note';
import { ResponsiveModal } from '@/components/ui/responsive-modal';
import { Button } from '@/components/ui/button';
import { getAssetDisplayTicker } from '@/lib/utils/assetDisplay';
import { describeRealizedSale } from '@/lib/utils/performanceNarrative';
import { describeUnbookedSell, describeUnbookedSells } from '@/lib/utils/unbookedSellsNarrative';
import { useUnbookedBrokerSells } from '@/lib/hooks/useUnbookedBrokerSells';
import type { UnbookedSell } from '@/lib/utils/unbookedBrokerSells';
import { NarrativeText } from '@/components/ui/narrative-text';
import type { Asset } from '@/types/assets';
import type { AssetTransaction } from '@/types/assetTransactions';

interface PlusvalenzeTileProps {
  reading: Narrative;
  summary: RealizedGainsSummary;
  /** Assets left out because their ledger replay failed — the total is then incomplete, and says so. */
  skippedAssets: number;
  /** Ids of the skipped assets, so the tile names what the total is missing. */
  skippedAssetIds?: string[];
  assets?: Asset[];
  trades?: AssetTransaction[];
  /** The data owner — whose broker history the completeness section reads. Absent disables it. */
  ownerId?: string;
  className?: string;
}

function signedEuro(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${cachedFormatCurrencyEUR(Math.abs(value), true)}`;
}

/** A money CELL at full cents: the rows of a list that has to add up on screen. */
function cellEuro(value: number): string {
  return cachedFormatCurrencyEUR(value);
}

/**
 * An unbooked sale's own money, under its name: what the broker charged and what it kept back.
 *
 * Every clause is DROPPED when the broker reported nothing — a «tassa 0,00 €» would be a claim the
 * broker never made, and this row has no other figure to contradict it (there is no gain here).
 */
function describeUnbookedSaleRow(sell: UnbookedSell): string {
  const parts = [`${describeUnbookedSell(sell.reasonKey)}`];
  if (sell.fees !== undefined && sell.fees > 0) parts.push(`commissione ${cellEuro(sell.fees)}`);
  if (sell.withheldTax !== undefined && sell.withheldTax > 0) {
    parts.push(`tassa trattenuta ${cellEuro(sell.withheldTax)}`);
  }
  parts.push(`netto ${cellEuro(sell.quantity * sell.pricePerUnit - (sell.fees ?? 0) - (sell.withheldTax ?? 0))}`);
  return parts.join(' · ');
}

/**
 * «Quanto hai incassato davvero?» — realized gains and losses per FISCAL year from the trade
 * ledger, all-time: a sale belongs to its own year whatever the picker says, so the tile is
 * off the page's axis and its aside names its own window (DESIGN.md → The Off-Axis Tile Rule).
 * The bar is the year's magnitude against the largest year, signed by colour.
 *
 * With ONE fiscal year there is no list (2026-09-20): the year's row, the «Totale» row and the
 * reading all printed the same figure — 15.743 four times on the owner's data. The reading is the
 * tile then. From two years the list returns WITH its total: rows that must add up add up on screen.
 *
 * Users can open a modal to see the breakdown of realized profits/losses per asset.
 */
export function PlusvalenzeTile({ reading, summary, skippedAssets, skippedAssetIds = [], assets = [], trades = [], ownerId, className }: PlusvalenzeTileProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  const maxAbs = Math.max(...summary.years.map((y) => Math.abs(y.amount)), 1);
  const hasList = summary.years.length >= 2;

  const assetsById = useMemo(() => {
    const map = new Map<string, Asset>();
    assets.forEach((a) => map.set(a.id, a));
    return map;
  }, [assets]);

  // Fallback trade labels for removed assets
  const tradeLabelsByAssetId = useMemo(() => {
    const map = new Map<string, string>();
    trades.forEach((t) => {
      if (t.note?.trim() && !map.has(t.assetId)) {
        map.set(t.assetId, t.note.trim());
      }
    });
    return map;
  }, [trades]);

  // Names of the assets left out of the total: the registry entry if tracked, else the
  // trade note left behind, else the raw id. Capped so one broken import cannot flood the tile.
  const skippedNames = useMemo(() => {
    const ids = skippedAssetIds.length > 0 ? skippedAssetIds : [];
    return ids.slice(0, 8).map((id) => {
      const asset = assetsById.get(id);
      if (asset) return asset.name || getAssetDisplayTicker(asset);
      return tradeLabelsByAssetId.get(id) ?? 'Strumento rimosso';
    });
  }, [skippedAssetIds, assetsById, tradeLabelsByAssetId]);
  const skippedOverflow = Math.max(0, skippedAssetIds.length - skippedNames.length);

  // Breakdown for the modal
  const breakdownRows = useMemo(() => {
    if (!summary.byAssetAndYear) return [];
    const activeYear = selectedYear ?? summary.years[0]?.year;
    if (!activeYear || !summary.byAssetAndYear[activeYear]) return [];

    const assetEntries = Object.entries(summary.byAssetAndYear[activeYear]);
    return assetEntries
      .map(([assetId, amount]) => {
        const asset = assetsById.get(assetId);
        const tradeFallback = tradeLabelsByAssetId.get(assetId);
        const name = asset
          ? asset.name || getAssetDisplayTicker(asset)
          : tradeFallback || 'Strumento rimosso';
        const ticker = asset ? getAssetDisplayTicker(asset) : undefined;
        return { assetId, name, ticker, amount };
      })
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }, [summary, selectedYear, assetsById, tradeLabelsByAssetId]);

  const activeYearDisplay = selectedYear ?? summary.years[0]?.year;
  const activeYearTotal = activeYearDisplay
    ? summary.years.find((y) => y.year === activeYearDisplay)?.amount ?? 0
    : summary.total;

  /**
   * The sales of the selected year, with the instrument each one belongs to.
   *
   * The rows come from the same replay as the year totals (`aggregateRealizedByYear`), so the
   * detail cannot disagree with the figure it sits under. An asset removed from the portfolio
   * keeps its row: the money was realized whatever the registry still holds, and the name falls
   * back to the trade note then to the id.
   */
  const sales = useMemo(() => {
    const rows = summary.salesByYear?.[activeYearDisplay ?? 0] ?? [];
    return rows.map((sale) => {
      const asset = assetsById.get(sale.assetId);
      const ticker = asset ? getAssetDisplayTicker(asset) : undefined;
      const name =
        asset?.name ||
        ticker ||
        tradeLabelsByAssetId.get(sale.assetId) ||
        'Strumento rimosso';
      return { sale, name, ticker: ticker && ticker !== name ? ticker : undefined };
    });
  }, [summary.salesByYear, activeYearDisplay, assetsById, tradeLabelsByAssetId]);

  /** The rows' own sum, NOT the year's figure: a total the reader can check by eye must be their sum. */
  const salesTotals = useMemo(
    () =>
      sales.reduce(
        (acc, { sale }) => ({
          grossEur: acc.grossEur + sale.grossEur,
          costBasisEur: acc.costBasisEur + sale.costBasisEur,
          realizedPnlEur: acc.realizedPnlEur + sale.realizedPnlEur,
        }),
        { grossEur: 0, costBasisEur: 0, realizedPnlEur: 0 }
      ),
    [sales]
  );

  // The broker's own sells of the selected year that the LEDGER does not hold. A separate list, never
  // merged with the sales above: those are realized gains measured by the replay, these are sales the
  // user has not booked, and one table with both would print a «plusvalenza» next to money nothing
  // measured. Read only while the modal is open (`enabled`), because the broker read pages its whole
  // timeline.
  const brokerReading = useUnbookedBrokerSells(ownerId, activeYearDisplay ?? 0, modalOpen);
  const unbooked = brokerReading.data;
  const unbookedNarrative = useMemo(
    () => (unbooked ? describeUnbookedSells(unbooked, activeYearDisplay ?? 0) : null),
    [unbooked, activeYearDisplay]
  );

  const openBreakdown = (year?: number) => {
    setSelectedYear(year ?? summary.years[0]?.year ?? null);
    setModalOpen(true);
  };

  return (
    <>
      <Tile eyebrow="Plusvalenze realizzate" aside="per anno fiscale · tutto lo storico" reading={reading} className={className}>
        {hasList ? (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {summary.years.map((y) => (
              <li
                key={y.year}
                onClick={() => openBreakdown(y.year)}
                className="grid grid-cols-[44px_minmax(0,1fr)_96px] items-center gap-3 py-[9px] cursor-pointer hover:bg-muted/40 rounded px-1 -mx-1 transition-colors"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openBreakdown(y.year);
                  }
                }}
                title={`Vedi dettaglio asset per il ${y.year}`}
              >
                <span className="font-mono text-[13px] tabular-nums text-foreground">{y.year}</span>
                <span className="h-[3px] overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${(Math.abs(y.amount) / maxAbs) * 100}%`, background: y.amount < 0 ? 'var(--destructive)' : 'var(--positive)' }}
                  />
                </span>
                <span className={cn('text-right font-mono text-[13px] font-semibold tabular-nums', signTextClass(y.amount))}>{signedEuro(y.amount)}</span>
              </li>
            ))}
            <li className="grid grid-cols-[44px_minmax(0,1fr)_96px] items-center gap-3 py-[9px]">
              <span className="text-[13px] font-semibold text-foreground">Totale</span>
              <span />
              <span className={cn('text-right font-mono text-[13px] font-bold tabular-nums', signTextClass(summary.total))}>{signedEuro(summary.total)}</span>
            </li>
          </ul>
        ) : (
          <div className="mt-2.5">
            <button
              type="button"
              onClick={() => openBreakdown(summary.years[0]?.year)}
              className={TILE_FOOTER_ACTION_CLASS}
            >
              Vedi dettaglio per strumento →
            </button>
          </div>
        )}

        {skippedAssets > 0 && (
          <p className="mt-3 text-[11px] leading-[1.45] text-warning-foreground">
            {skippedAssets === 1
              ? '1 asset è escluso dal totale: il suo registro non è ricostruibile.'
              : `${skippedAssets} asset sono esclusi dal totale: il loro registro non è ricostruibile.`}
            {skippedNames.length > 0 && (
              <span className="block">
                {' Mancano: '}
                {skippedNames.join(', ')}
                {skippedOverflow > 0 && ` e altri ${skippedOverflow}`}
                {' — controlla Movimenti e l’import broker per completarli.'}
              </span>
            )}
          </p>
        )}
        <TileMethodNote subject="Plusvalenze realizzate" summary="Non segue il periodo.">
          <span className="block">Una vendita appartiene al suo anno fiscale, qualunque periodo sia scelto in alto: la tessera guarda tutto lo storico.</span>
          <span className="block">Sono utili e perdite chiusi nel registro operazioni, calcolati al PMC (prezzo medio di carico) del momento della vendita.</span>
        </TileMethodNote>
      </Tile>

      <ResponsiveModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`Plusvalenze per strumento · ${activeYearDisplay ?? 'Storico'}`}
        description="Utili e perdite realizzati con le vendite di questo anno fiscale, calcolati dal registro operazioni."
        width="md"
        footer={
          <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>
            Chiudi
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-2">
          {summary.years.length > 1 && (
            <div className="flex items-center gap-1.5 pb-2 border-b border-border overflow-x-auto">
              <span className="text-xs text-muted-foreground mr-1">Anno:</span>
              {summary.years.map((y) => (
                <button
                  key={y.year}
                  type="button"
                  onClick={() => setSelectedYear(y.year)}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-full font-mono transition-colors',
                    (selectedYear ?? summary.years[0]?.year) === y.year
                      ? 'bg-foreground text-background font-semibold'
                      : 'bg-muted/70 text-muted-foreground hover:bg-muted'
                  )}
                >
                  {y.year}
                </button>
              ))}
            </div>
          )}

          {breakdownRows.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border">
              {breakdownRows.map((row) => (
                <li key={row.assetId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0 flex flex-col">
                    <span className="text-[13px] font-medium text-foreground truncate" title={row.name}>
                      {row.name}
                    </span>
                    {row.ticker && row.ticker !== row.name && (
                      <span className="text-[11px] text-muted-foreground font-mono">
                        {row.ticker}
                      </span>
                    )}
                  </div>
                  <span className={cn('shrink-0 font-mono text-[13px] font-semibold tabular-nums', signTextClass(row.amount))}>
                    {signedEuro(row.amount)}
                  </span>
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 pt-3">
                <span className="text-[13px] font-semibold text-foreground">Totale {activeYearDisplay}</span>
                <span className={cn('shrink-0 font-mono text-[13px] font-bold tabular-nums', signTextClass(activeYearTotal))}>
                  {signedEuro(activeYearTotal)}
                </span>
              </li>
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground py-4 text-center">
              Nessun dettaglio disponibile per questo anno fiscale.
            </p>
          )}

          {/*
            The sales behind the year, UNDER the per-instrument list: this is the same money the
            list above totals, one row per operation, so it belongs below it and not in a second
            modal.

            A CONTAINER QUERY, not a viewport one: this block is 720px inside the modal on desktop
            and a full-width drawer on a phone, and the columns that fit depend on THAT width, not
            on the screen's. Below 560px it is one line per sale — the instrument with its caption,
            and the gain on the right — with the three money facts on a second line; from there the
            date and the three columns appear. `min-w-0` on the growing child, or the caption's
            long euro figures push the row past the drawer.
          */}
          {sales.length > 0 && (
            <section className="@container border-t border-border pt-3" aria-label={`Vendite ${activeYearDisplay ?? ''}`}>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 pb-1.5 text-[11px] font-medium text-muted-foreground @[560px]:grid-cols-[52px_minmax(0,1fr)_92px_92px_104px_56px]">
                <span className="@[560px]:col-start-2">Strumento</span>
                <span className="text-right">Plusvalenza</span>
                <span className="hidden text-right @[560px]:col-start-3 @[560px]:block">Lordo</span>
                <span className="hidden text-right @[560px]:block">Costo</span>
                <span className="hidden text-right @[560px]:col-start-5 @[560px]:block">PMC al trade</span>
                <span className="hidden text-right @[560px]:col-start-6 @[560px]:block">%</span>
              </div>

              <ul className="flex flex-col">
                {sales.map(({ sale, name, ticker }) => (
                  <li
                    key={sale.transactionId}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-t border-border py-2 @[560px]:grid-cols-[52px_minmax(0,1fr)_92px_92px_104px_56px]"
                  >
                    <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground @[560px]:col-start-1 @[560px]:block">
                      {formatDate(sale.date)}
                    </span>
                    <span className="col-start-1 flex min-w-0 flex-col @[560px]:col-start-2">
                      <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
                      <span className="text-[11px] leading-[1.4] text-muted-foreground">
                        {formatDate(sale.date)}
                        {ticker ? ` · ${ticker}` : ''} · {describeRealizedSale(sale)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'col-start-2 row-start-1 self-center text-right font-mono text-[13px] font-semibold tabular-nums @[560px]:col-start-5 @[560px]:col-start-auto',
                        signTextClass(sale.realizedPnlEur)
                      )}
                    >
                      {cellEuro(sale.realizedPnlEur)}
                    </span>
                    <span className="col-start-1 row-start-2 font-mono text-[11px] tabular-nums text-muted-foreground @[560px]:col-start-3 @[560px]:row-start-auto @[560px]:text-right @[560px]:text-[13px]">
                      lordo {cellEuro(sale.grossEur)} · costo {cellEuro(sale.costBasisEur)}
                    </span>
                    <span className="col-start-3 row-start-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground @[560px]:col-start-4 @[560px]:row-start-auto @[560px]:text-[13px]">
                      {cellEuro(sale.averageCostEurAtTrade)}
                    </span>
                    <span className="col-start-4 row-start-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground @[560px]:col-start-6 @[560px]:row-start-auto @[560px]:text-[13px]">
                      {sale.costBasisEur > 0
                        ? formatPercentageIt((sale.realizedPnlEur / sale.costBasisEur) * 100)
                        : '—'}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-border pt-2">
                <span className="text-[13px] font-semibold text-foreground">
                  Totale {sales.length} {sales.length === 1 ? 'vendita' : 'vendite'}
                </span>
                <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground @[560px]:text-[13px]">
                  lordo {cellEuro(salesTotals.grossEur)} · costo {cellEuro(salesTotals.costBasisEur)}
                </span>
                <span
                  className={cn(
                    'text-right font-mono text-[13px] font-bold tabular-nums',
                    signTextClass(salesTotals.realizedPnlEur)
                  )}
                >
                  {cellEuro(salesTotals.realizedPnlEur)}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-[1.45] text-muted-foreground">
                Ogni riga è una vendita del {activeYearDisplay}, con la commissione e la tasse
                trattenuta dal broker nella riga sotto. Lordo e costo sono in euro; la colonna PMC
                è il prezzo medio di carico del momento, e la percentuale è la plusvalenza sul
                costo.
              </p>
            </section>
          )}

          {/*
            THE BROKER'S OWN SELLS THE LEDGER HAS NOT BOOKED — a second section, never merged into
            the one above.

            The rows here are SALES, not gains: no cost basis exists until the ledger replays them,
            so there is no gain, no cost and no percentage column, and the total is the broker's
            cash. Merging the two would put a plusvalenza beside a figure nothing measured, and one
            total would be a sum of two different things.

            It reads the broker only WHILE THIS MODAL IS OPEN (`enabled` on the hook): the read pages
            the whole timeline and fetches a detail per trade, and it must not run on a page mount.
            The three failure states are three different sentences from
            `describeUnbookedSells` — a never-linked session, an expired one, and a failed read are
            not the «nothing is missing» reading, and a failed read is never shown as an empty list.
          */}
          {ownerId && (
            <section className="@container border-t border-border pt-3" aria-label={`Vendite non registrate ${activeYearDisplay ?? ''}`}>
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="text-[13px] font-semibold text-foreground">Vendite non ancora nel registro</h4>
                {brokerReading.isFetching && !unbooked && (
                  <span className="text-[11px] text-muted-foreground">lettura da Trade Republic…</span>
                )}
              </div>

              {unbookedNarrative && (
                <NarrativeText segments={unbookedNarrative} className="mt-1 text-[11px] leading-[1.45] text-muted-foreground [&_.font-mono]:font-semibold" />
              )}

              {/* A failed read above a list of nothing: the state is already the sentence, and a
                  «0 vendite» total under it would turn a broken read into a claim. */}
              {brokerReading.isError && !unbooked && (
                <p className="mt-1 text-[11px] leading-[1.45] text-destructive">
                  Lettura non riuscita: riprova dalle impostazioni.
                </p>
              )}

              {unbooked && unbooked.sells.length > 0 && (
                <>
                  <ul className="mt-2 flex flex-col divide-y divide-border">
                    {unbooked.sells.map((sell) => (
                      <li key={sell.sourceRef} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 py-2 @[560px]:grid-cols-[52px_minmax(0,1fr)_112px]">
                        <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground @[560px]:col-start-1 @[560px]:block">
                          {formatDate(sell.date)}
                        </span>
                        <span className="col-start-1 flex min-w-0 flex-col @[560px]:col-start-2">
                          <span className="truncate text-[13px] font-medium text-foreground">{sell.label}</span>
                          <span className="text-[11px] leading-[1.4] text-muted-foreground">
                            {formatDate(sell.date)} · {formatNumberIt(sell.quantity, 2)} × {cachedFormatCurrencyEUR(sell.pricePerUnit)} ·{' '}
                            {describeUnbookedSaleRow(sell)}
                          </span>
                          <span className="text-[11px] leading-[1.4] text-warning-foreground">{sell.reason}</span>
                        </span>
                        <span className="col-start-2 row-start-1 self-center text-right font-mono text-[13px] font-semibold tabular-nums @[560px]:col-start-3 @[560px]:col-start-auto">
                          {cachedFormatCurrencyEUR(sell.quantity * sell.pricePerUnit - (sell.fees ?? 0) - (sell.withheldTax ?? 0))}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-border pt-2">
                    <span className="text-[13px] font-semibold text-foreground">
                      Totale {unbooked.sells.length}{' '}
                      {unbooked.sells.length === 1 ? 'vendita' : 'vendite'}
                    </span>
                    <span className="text-right font-mono text-[13px] font-bold tabular-nums">
                      {cachedFormatCurrencyEUR(unbooked.totals.netEur)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-[1.45] text-muted-foreground">
                    Sono vendite che Trade Republic ha registrato e il registro non contiene: nessuna
                    plusvalenza finché non le importi. La cifra è quello che il broker ha versato
                    (lordo − commissione − tassa trattenuta), non un utile.
                  </p>
                </>
              )}
            </section>
          )}
        </div>
      </ResponsiveModal>
    </>
  );
}
