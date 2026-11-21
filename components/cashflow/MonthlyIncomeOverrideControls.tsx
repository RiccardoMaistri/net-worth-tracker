'use client';

/**
 * The chart-side entry to a month's income correction. The Recharts points and the SVG bars are
 * not buttons, so every visible month gets a real 44px control: keyboard and touch reach the
 * same dialog the pointer does. Months before activation have no income to correct and are
 * omitted. The row scrolls horizontally inside its tile — it never widens `main`.
 */

import type { MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { MONTH_NAMES } from '@/lib/constants/months';
import { resolveCenteredModalOrigin } from '@/lib/utils/modalOrigin';
import type { FixedIncomeMonth } from '@/lib/utils/fixedIncomeSavingsRate';
import type { MonthlyIncomeOverrideEdit } from '@/lib/hooks/useMonthlyIncomeOverrideEditor';

interface MonthlyIncomeOverrideControlsProps {
  months: FixedIncomeMonth[];
  onEdit: (edit: MonthlyIncomeOverrideEdit) => void;
  /** A failed overrides read must be declared, never mistaken for «no corrections». */
  failed: boolean;
}

export function MonthlyIncomeOverrideControls({ months, onEdit, failed }: MonthlyIncomeOverrideControlsProps) {
  const editable = months.filter((month) => month.reason !== 'before-activation');

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <p className="text-[11px] text-muted-foreground">
        {failed
          ? 'Correzioni mensili non disponibili: il grafico mostra solo il reddito fisso.'
          : editable.length === 0
            ? 'Imposta il reddito fisso in Impostazioni per vedere il tasso di risparmio mese per mese.'
            : 'Correggi il reddito di un mese: la modifica vale solo per quel mese.'}
      </p>
      {!failed && editable.length > 0 && (
        <div className="-mx-1 mt-2 flex max-w-full gap-1.5 overflow-x-auto px-1 pb-1">
          {editable.map((month) => (
            <Button
              key={month.key}
              variant={month.corrected ? 'secondary' : 'outline'}
              className="h-11 shrink-0 px-3 text-[12px]"
              onClick={(event: MouseEvent<HTMLButtonElement>) =>
                onEdit({
                  key: month.key,
                  year: month.year,
                  month: month.month,
                  effectiveIncome: month.income,
                  corrected: month.corrected,
                  origin: resolveCenteredModalOrigin(event.currentTarget.getBoundingClientRect()),
                })
              }
              aria-label={`Correggi reddito di ${MONTH_NAMES[month.month - 1]} ${month.year}${month.corrected ? ' (corretto)' : ''}`}
            >
              {month.longLabel}
              {month.corrected && <span className="ml-1 text-[10px] text-muted-foreground">•</span>}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
