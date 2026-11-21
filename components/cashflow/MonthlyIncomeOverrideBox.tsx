'use client';

/**
 * The compact entry to a month's income correction, beside Tracciamento's add button.
 *
 * It names the month it corrects — the PERIOD's anchor, since the page has one axis — and the
 * income in use, and opens the same `MonthlyIncomeOverrideDialog` the savings charts use. A month
 * before activation carries no declared income to correct and renders nothing; a failed overrides
 * read is declared in the box rather than showing the default as if no correction existed. Writes
 * are blocked in demo, like every other action of the tab.
 */

import type { MouseEvent } from 'react';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MONTH_NAMES } from '@/lib/constants/months';
import { MONTH_NAMES_SHORT } from '@/lib/utils/period';
import { cachedFormatCurrencyEUR } from '@/lib/utils/formatters';
import { resolveCenteredModalOrigin } from '@/lib/utils/modalOrigin';
import { TILE_EYEBROW_CLASS } from '@/components/ui/tile';
import { MonthlyIncomeOverrideDialog } from '@/components/cashflow/MonthlyIncomeOverrideDialog';
import { useMonthlyIncomeOverrideEditor } from '@/lib/hooks/useMonthlyIncomeOverrideEditor';
import { useQueryClient } from '@tanstack/react-query';
import {
  isFixedIncomeConfigured,
  monthKeyOf,
  resolveMonthIncome,
} from '@/lib/utils/fixedIncomeSavingsRate';

interface MonthlyIncomeOverrideBoxProps {
  /** Whose correction (the displayed account's owner), never the viewer's uid. */
  ownerId: string | undefined;
  /** The declared default from Impostazioni. */
  fixedIncomeEur: number | undefined;
  /** The first month the declared income applies. */
  activationMonth: string | null | undefined;
  /** The owner's corrections, keyed by Italian `YYYY-MM`. */
  overrides: Record<string, number>;
  /** The corrections are still being read: the figure is the default and the dialog must wait. */
  overridesLoading: boolean;
  /** A failed overrides read must be declared, never read as «no corrections». */
  overridesFailed: boolean;
  /** The month the box corrects: the period's anchor month. */
  year: number;
  month: number;
  /** Every mutation is blocked in the demo account. */
  isDemo: boolean;
  className?: string;
}

export function MonthlyIncomeOverrideBox({
  ownerId,
  fixedIncomeEur,
  activationMonth,
  overrides,
  overridesLoading,
  overridesFailed,
  year,
  month,
  isDemo,
  className,
}: MonthlyIncomeOverrideBoxProps) {
  const editor = useMonthlyIncomeOverrideEditor(ownerId, fixedIncomeEur);
  const key = monthKeyOf(year, month);
  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;

  // No owner, no configured default, or a month before activation: there is nothing to correct.
  if (!ownerId || !isFixedIncomeConfigured(fixedIncomeEur, activationMonth) || key < activationMonth) {
    return null;
  }

  if (overridesFailed) {
    const queryClient = useQueryClient();
    return (
      <div
        role="status"
        className={cn(
          'flex h-11 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 desktop:h-9',
          className,
        )}
      >
        <span className={TILE_EYEBROW_CLASS}>Reddito</span>
        <span className="text-[11px] text-destructive">correzioni non disponibili</span>
        <button
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ['monthly-income-overrides', ownerId] });
            queryClient.refetchQueries({ queryKey: ['monthly-income-overrides', ownerId] });
          }}
          className="ml-2 text-[10px] text-primary hover:underline"
          aria-label="Riprova a caricare le correzioni"
        >
          Riprova
        </button>
      </div>
    );
  }

  const { income, corrected } = resolveMonthIncome(key, fixedIncomeEur, overrides);

  return (
    <>
      <button
        type="button"
        disabled={isDemo || overridesLoading}
        aria-busy={overridesLoading || undefined}
        title={isDemo ? 'Non disponibile in modalità demo' : undefined}
        aria-label={isDemo ? `Reddito di ${monthLabel} — non disponibile in modalità demo` : undefined}
        onClick={(event: MouseEvent<HTMLButtonElement>) =>
          editor.edit({
            key,
            year,
            month,
            effectiveIncome: income,
            corrected,
            origin: resolveCenteredModalOrigin(event.currentTarget.getBoundingClientRect()),
          })
        }
        className={cn(
          'group flex h-11 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 text-left transition-colors',
          'hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          'disabled:pointer-events-none disabled:opacity-50 desktop:h-9',
          className,
        )}
      >
        <span className={TILE_EYEBROW_CLASS}>Reddito</span>
        <span className="text-[11px] text-muted-foreground">
          {MONTH_NAMES_SHORT[month - 1]} {year}
        </span>
        <span className="font-mono text-[13px] font-semibold tabular-nums">{cachedFormatCurrencyEUR(income, true)}</span>
        {corrected && <span className="text-[10px] text-muted-foreground">corretto</span>}
        <Pencil className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
      </button>
      <MonthlyIncomeOverrideDialog
        target={editor.target}
        origin={editor.origin}
        onClose={editor.close}
        onSave={editor.save}
        onRemove={editor.remove}
      />
    </>
  );
}
