'use client';

import { useState, useMemo } from 'react';
import type { Narrative } from '@/lib/utils/narrative';
import type { RealizedGainsSummary } from '@/lib/utils/performanceSummary';
import { cachedFormatCurrencyEUR } from '@/lib/utils/formatters';
import { signTextClass } from '@/lib/utils/metricColors';
import { cn } from '@/lib/utils';
import { Tile, TILE_FOOTER_ACTION_CLASS } from '@/components/ui/tile';
import { TileMethodNote } from '@/components/ui/tile-method-note';
import { ResponsiveModal } from '@/components/ui/responsive-modal';
import { Button } from '@/components/ui/button';
import { getAssetDisplayTicker } from '@/lib/utils/assetDisplay';
import type { Asset } from '@/types/assets';
import type { AssetTransaction } from '@/types/assetTransactions';

interface PlusvalenzeTileProps {
  reading: Narrative;
  summary: RealizedGainsSummary;
  /** Assets left out because their ledger replay failed — the total is then incomplete, and says so. */
  skippedAssets: number;
  assets?: Asset[];
  trades?: AssetTransaction[];
  className?: string;
}

function signedEuro(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${cachedFormatCurrencyEUR(Math.abs(value), true)}`;
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
export function PlusvalenzeTile({ reading, summary, skippedAssets, assets = [], trades = [], className }: PlusvalenzeTileProps) {
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
        </div>
      </ResponsiveModal>
    </>
  );
}
