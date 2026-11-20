'use client';

import type { Narrative } from '@/lib/utils/narrative';
import type { SavingsHistory } from '@/lib/utils/tracciamentoSummary';
import type { FixedIncomeMonth, FixedIncomeSeries } from '@/lib/utils/fixedIncomeSavingsRate';
import { cachedFormatCurrencyEUR } from '@/lib/utils/formatters';
import { ChartHoverTip, useChartHover } from '@/components/ui/chart-hover';
import { formatPercentage } from '@/lib/services/chartService';
import { cn } from '@/lib/utils';
import { Tile } from '@/components/ui/tile';
import { NarrativeText } from '@/components/ui/narrative-text';
import { MonthlyIncomeOverrideControls } from '@/components/cashflow/MonthlyIncomeOverrideControls';
import { MonthlyIncomeOverrideDialog } from '@/components/cashflow/MonthlyIncomeOverrideDialog';
import { useMonthlyIncomeOverrideEditor } from '@/lib/hooks/useMonthlyIncomeOverrideEditor';

interface RisparmioTileProps {
  history: SavingsHistory;
  /** The same months with their declared income, activation state and corrections. */
  series: FixedIncomeSeries;
  /** Whose corrections are read and written (the displayed account's owner). */
  ownerId: string | undefined;
  /** The declared default income from Impostazioni. */
  fixedIncomeEur: number | undefined;
  /** A failed overrides read is not an empty set of corrections. */
  overridesFailed: boolean;
  /** The window as the narrative names it: «ultimi 12 mesi», or its bounds when anchored on a past period. */
  aside: Narrative;
  reading: Narrative | null;
  /** The footer line: how many of the measured months closed in deficit. */
  footer: Narrative | null;
  /** The month the page is about, drawn at full strength. */
  highlightKey: string | null;
  className?: string;
}

const VIEW_W = 600;
const VIEW_H = 120;
/** Share of a month's slot the bar takes; the rest is the gap. */
const BAR_SHARE = 0.8;

function monthGapCopy(reason: FixedIncomeMonth['reason']): string {
  return reason === 'before-activation' ? 'prima del reddito fisso' : 'nessun reddito impostato';
}

/**
 * One bar per month of savings rate, a deficit drawn below the baseline, the average as a
 * dashed line that the reading names («In media il 31%») — a label on the plot would paint
 * over whichever bar stands at the edge. The scale is symmetric around zero only when a month
 * is negative, so a history of surpluses uses the full height. Hand-written SVG
 * (`preserveAspectRatio="none"`, labels outside the plot), like the hero's bars.
 */
function SavingsRateBars({
  months,
  average,
  highlightKey,
}: {
  /** The whole axis, including the declared gaps before activation — they stay visible as slots. */
  months: FixedIncomeMonth[];
  average: number | null;
  highlightKey: string | null;
}) {
  const rates = months.map((m) => m.savingsRate ?? 0);
  const top = Math.max(...rates, average ?? 0, 1);
  const bottom = Math.min(...rates, 0);
  const span = top - bottom;
  const yOf = (rate: number) => ((top - rate) / span) * VIEW_H;
  const baseline = yOf(0);
  const slot = VIEW_W / months.length;
  const barWidth = slot * BAR_SHARE;

  // The typographic minus, as everywhere on the page (The Comma Rule).
  const rateText = (rate: number) => `${rate < 0 ? '−' : ''}${formatPercentage(Math.abs(rate), 0)}`;
  const label = months
    .map((m) => `${m.label}: ${m.savingsRate === null ? monthGapCopy(m.reason) : rateText(m.savingsRate)}`)
    .join('; ');

  // A mouse over a month reads its rate and the two figures behind it (desktop only).
  const hover = useChartHover(months.length, 'slot');
  const hovered = hover.index !== null ? months[hover.index] : null;

  return (
    <div className="flex flex-1 flex-col">
      <div className="relative min-h-[110px] flex-1" {...(hover.enabled ? hover.handlers : {})}>
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label={`Tasso di risparmio per mese, con reddito fisso dichiarato. ${label}`}
        >
          {hover.index !== null && (
            <rect x={hover.index * slot} y={0} width={slot} height={VIEW_H} fill="var(--foreground)" opacity={0.06} />
          )}
          {months.map((month, i) => {
            if (month.savingsRate === null) return null;
            const rate = month.savingsRate;
            const y = rate >= 0 ? yOf(rate) : baseline;
            const height = Math.abs(yOf(rate) - baseline);
            const corrected = month.corrected;
            return (
              <g key={month.key}>
                <title>{`${month.label}: ${rateText(rate)}${corrected ? ' · reddito corretto' : ''}`}</title>
                <rect
                  x={i * slot + (slot - barWidth) / 2}
                  y={y}
                  width={barWidth}
                  height={height}
                  fill={rate < 0 ? 'var(--destructive)' : 'var(--chart-2)'}
                  stroke={month.key === highlightKey ? 'var(--foreground)' : 'none'}
                  vectorEffect="non-scaling-stroke"
                />
                {corrected && (
                  <rect
                    x={i * slot + (slot - barWidth) / 2}
                    y={y - 3}
                    width={barWidth}
                    height={2}
                    fill="var(--foreground)"
                    opacity={0.65}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </g>
            );
          })}
          <line x1={0} y1={baseline} x2={VIEW_W} y2={baseline} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
          {average !== null && (
            <line
              x1={0}
              y1={yOf(average)}
              x2={VIEW_W}
              y2={yOf(average)}
              stroke="var(--foreground)"
              strokeOpacity={0.6}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {hovered && hover.index !== null && (
          <ChartHoverTip x={(hover.index + 0.5) / months.length} label={`${hovered.label} ${hovered.year}`}>
            <span className={cn('font-mono text-[13px] font-semibold tabular-nums', hovered.savingsRate === null ? 'text-muted-foreground' : hovered.savingsRate < 0 ? 'text-destructive' : 'text-positive')}>
              {hovered.savingsRate === null ? monthGapCopy(hovered.reason) : rateText(hovered.savingsRate)}
            </span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {hovered.reason === 'before-activation'
                ? 'reddito fisso non ancora impostato'
                : `reddito ${cachedFormatCurrencyEUR(hovered.income, true)} · spese ${cachedFormatCurrencyEUR(hovered.expenses, true)}`}
            </span>
          </ChartHoverTip>
        )}
      </div>
      <div className="mt-1.5 grid" style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }} aria-hidden="true">
        {months.map((month) => (
          <span
            key={month.key}
            className={cn('text-center font-mono text-[10px] tabular-nums', month.key === highlightKey ? 'font-semibold text-foreground' : 'text-muted-foreground')}
          >
            {month.label}
            {month.corrected && ' •'}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * "Quanto metto da parte, mese dopo mese?" — the savings rate of the trailing twelve months,
 * measured against the DECLARED income (fixed salary or a month's correction). Months before
 * activation draw no bar: a rate from a setting that did not exist yet would be a fiction.
 */
export function RisparmioTile({
  history,
  series,
  ownerId,
  fixedIncomeEur,
  overridesFailed,
  aside,
  reading,
  footer,
  highlightKey,
  className,
}: RisparmioTileProps) {
  const editor = useMonthlyIncomeOverrideEditor(ownerId, fixedIncomeEur);

  return (
    <Tile eyebrow="Risparmio nel tempo" aside={<NarrativeText segments={aside} figureClassName="font-medium" />} reading={reading} className={className}>
      {history.measuredCount === 0 ? (
        <p className="mt-3 text-[13px] text-muted-foreground">
          {series.configured
            ? 'Nessun mese con reddito impostato nella finestra.'
            : 'Il reddito fisso non è ancora impostato: impostalo in Preferenze per vedere il tasso di risparmio.'}
        </p>
      ) : (
        <div className="mt-3 mb-3.5 flex flex-1 flex-col">
          <SavingsRateBars months={series.months} average={history.average} highlightKey={highlightKey} />
        </div>
      )}
      {series.configured && ownerId && (
        <MonthlyIncomeOverrideControls months={series.months} onEdit={editor.edit} failed={overridesFailed} />
      )}
      <MonthlyIncomeOverrideDialog
        target={editor.target}
        origin={editor.origin}
        onClose={editor.close}
        onSave={editor.save}
        onRemove={editor.remove}
      />
      {footer && (
        <NarrativeText segments={footer} className="mt-auto border-t border-border pt-3.5 text-[11px] text-muted-foreground" figureClassName="font-medium" />
      )}
    </Tile>
  );
}
