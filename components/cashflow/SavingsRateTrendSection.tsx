/**
 * Savings rate trend section — monthly line chart over the last N months.
 *
 * The denominator is DECLARED: the fixed monthly income from Impostazioni, or a correction of
 * one month from the chart itself. The pure `buildFixedIncomeSavingsSeries` owns the axis, the
 * activation boundary and the spending side; this component only chooses the visible window and
 * renders. Months without a configured income are gaps, never zeros (connectNulls={false}).
 * Before activation there is no rate at all — not even when the ledger held a salary then.
 */

'use client';

import { useMemo, useState } from 'react';
import { useChartColors } from '@/lib/hooks/useChartColors';
import type { Expense } from '@/types/expenses';
import { AsideToggle } from '@/components/cashflow/analisi/AsideToggle';
import { MonthlyIncomeOverrideControls } from '@/components/cashflow/MonthlyIncomeOverrideControls';
import { MonthlyIncomeOverrideDialog } from '@/components/cashflow/MonthlyIncomeOverrideDialog';
import { useMonthlyIncomeOverrideEditor } from '@/lib/hooks/useMonthlyIncomeOverrideEditor';
import { Tile } from '@/components/ui/tile';
import { Skeleton } from '@/components/ui/skeleton';
import { lazyComponent } from '@/components/ui/lazy-component';
import { getItalyMonthYear } from '@/lib/utils/dateHelpers';
import { buildFixedIncomeSavingsSeries } from '@/lib/utils/fixedIncomeSavingsRate';

/** The plot's height: the chart draws at it and its placeholder holds it, so it lands in place. */
const SAVINGS_CHART_HEIGHT = 200;

// The plot is not in the page's initial JavaScript (2026-09-30): `lazyComponent` at module level,
// preloaded when the page is idle by `DettaglioDisclosure` (`SAVINGS_LAZY_CHARTS`).
const SavingsRateLineChart = lazyComponent(() => import('@/components/cashflow/SavingsRateLineChart').then((m) => m.SavingsRateLineChart));
export const SAVINGS_LAZY_CHARTS = [SavingsRateLineChart];

// ── Range toggle ──────────────────────────────────────────────────────────────
// 'all' shows the entire history (default) so the long-term savings trend isn't
// truncated; 12m/24m give a focused recent window.

type TrendRange = '12m' | '24m' | 'all';

const RANGE_OPTIONS: ReadonlyArray<{ value: TrendRange; label: string }> = [
  { value: '12m', label: '12m' },
  { value: '24m', label: '24m' },
  { value: 'all', label: 'Tutto' },
];

interface SavingsRateTrendSectionProps {
  allExpenses: Expense[];
  historyStartYear: number;
  /** Whose data is shown: the owner of the account, never the viewer of a shared one. */
  ownerId: string | undefined;
  /** The declared default income and the month it first became effective. */
  fixedIncomeEur: number | undefined;
  activationMonth: string | null | undefined;
  /** Corrections keyed by Italian `YYYY-MM`. */
  overrides: Record<string, number>;
  /** A failed read is not an empty set of corrections. */
  overridesFailed: boolean;
  /** The tab's clock, injected so the axis is testable. */
  now: Date;
  /**
   * When set, the chart is restricted to a single calendar year (Jan → Dec, or
   * Jan → current month for the current year) and the range toggle is hidden.
   * null/undefined → full-history behavior with the 12m/24m/Tutto toggle.
   */
  scopeYear?: number | null;
}

/**
 * Renders the "Andamento Risparmio" card with a savings rate trend.
 *
 * When `scopeYear` is set the window is locked to that calendar year and the
 * toggle is hidden. Otherwise a 12m/24m/Tutto range toggle (default Tutto)
 * controls the window; 'Tutto' spans the full history from historyStartYear to
 * the current month. The section is always present in the DOM.
 */
export function SavingsRateTrendSection({
  allExpenses,
  historyStartYear,
  ownerId,
  fixedIncomeEur,
  activationMonth,
  overrides,
  overridesFailed,
  now,
  scopeYear,
}: SavingsRateTrendSectionProps) {
  const chartColors = useChartColors();
  const [range, setRange] = useState<TrendRange>('all');
  const editor = useMonthlyIncomeOverrideEditor(ownerId, fixedIncomeEur);
  const isScoped = scopeYear != null;

  const { axis, count } = useMemo(() => {
    const today = getItalyMonthYear(now);
    const refYear = isScoped ? (scopeYear as number) : today.year;
    const refMonth = isScoped ? ((scopeYear as number) === today.year ? today.month : 12) : today.month;
    const floorYear = isScoped ? (scopeYear as number) : historyStartYear;
    const visible =
      refYear * 12 + refMonth - (floorYear * 12 + 1) + 1;
    return {
      axis: { endYear: refYear, endMonth: refMonth },
      count: isScoped ? refMonth : Math.max(1, range === '12m' ? 12 : range === '24m' ? 24 : visible),
    };
  }, [historyStartYear, isScoped, now, range, scopeYear]);

  const series = useMemo(
    () =>
      buildFixedIncomeSavingsSeries({
        expenses: allExpenses,
        fixedIncomeEur,
        activationMonth,
        overrides,
        now,
        ...axis,
        count,
      }),
    [allExpenses, fixedIncomeEur, activationMonth, overrides, now, axis, count],
  );

  const chartData = useMemo(
    () => series.months.map((month) => ({ label: month.longLabel, rate: month.savingsRate })),
    [series.months],
  );
  const hasEnoughData = chartData.filter((point) => point.rate !== null).length >= 3;

  const currentYear = getItalyMonthYear(now).year;
  const subtitle = isScoped
    ? scopeYear === currentYear
      ? 'anno corrente'
      : `anno ${scopeYear}`
    : range === '12m'
      ? 'ultimi 12 mesi'
      : range === '24m'
        ? 'ultimi 24 mesi'
        : 'intero storico';

  return (
    <Tile
      eyebrow="Andamento risparmio"
      aside={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span>tasso di risparmio mensile · reddito fisso · {subtitle}</span>
          {!isScoped && (
            <AsideToggle ariaLabel="Finestra temporale" value={range} onChange={setRange} options={RANGE_OPTIONS} />
          )}
        </div>
      }
    >
      <div className="mt-3">
        {!hasEnoughData ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">
            {series.configured
              ? 'Servono almeno 3 mesi con reddito impostato per il trend.'
              : 'Imposta il reddito fisso mensile in Impostazioni per vedere il trend.'}
          </p>
        ) : (
          <SavingsRateLineChart
            data={chartData}
            colors={chartColors}
            height={SAVINGS_CHART_HEIGHT}
            fallback={<Skeleton className="w-full" style={{ height: SAVINGS_CHART_HEIGHT }} />}
          />
        )}
      </div>
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
    </Tile>
  );
}
