'use client';

/**
 * The one dialog for correcting a month's declared income, opened from either savings-rate
 * chart. The override wins over the fixed salary from Impostazioni; «Ripristina predefinito»
 * removes the document and restores that default. No timer arms the destructive action —
 * `useArmedDelete` owns the two-click confirm (AGENTS.md § Accessibility).
 */

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveModal } from '@/components/ui/responsive-modal';
import { useArmedDelete } from '@/lib/hooks/useArmedDelete';
import { MONTH_NAMES } from '@/lib/constants/months';
import { cachedFormatCurrencyEUR } from '@/lib/utils/formatters';
import { describeFormRefusal, describeModalStatus, describeWriteError, type ModalStatus } from '@/lib/utils/dialogNarrative';
import type { NarrativeSegment } from '@/lib/utils/narrative';
import type { MonthlyIncomeOverrideTarget } from '@/lib/hooks/useMonthlyIncomeOverrideEditor';

interface MonthlyIncomeOverrideDialogProps {
  target: MonthlyIncomeOverrideTarget | null;
  origin: string | undefined;
  onClose: () => void;
  onSave: (monthKey: string, amount: number) => Promise<void>;
  onRemove: (monthKey: string) => Promise<void>;
}

const prose = (text: string): NarrativeSegment => ({ text });
const figure = (text: string): NarrativeSegment => ({ text, mono: true });

/** The input's draft belongs to its subject: a different month settles it during render. */
interface AmountDraft {
  key: string;
  text: string;
}

interface StatusDraft {
  key: string;
  status: ModalStatus;
}

export function MonthlyIncomeOverrideDialog({ target, origin, onClose, onSave, onRemove }: MonthlyIncomeOverrideDialogProps) {
  const [draft, setDraft] = useState<AmountDraft | null>(null);
  const [statusDraft, setStatusDraft] = useState<StatusDraft | null>(null);
  const removeRef = useRef<HTMLButtonElement | null>(null);

  const key = target?.key ?? '';
  const subjectKey = `${key}:${target?.effectiveIncome ?? ''}:${target?.corrected ?? false}`;
  const status: ModalStatus = statusDraft?.key === subjectKey ? statusDraft.status : { phase: 'idle' };
  const setStatus = (next: ModalStatus) => setStatusDraft({ key: subjectKey, status: next });
  const seededText = target && target.effectiveIncome > 0 ? String(target.effectiveIncome) : '';
  const activeDraft = draft?.key === subjectKey ? draft : { key: subjectKey, text: seededText };
  const text = activeDraft.text;
  const amount = Number(text.replace(',', '.'));
  const amountMissing = text.trim() === '';
  const amountInvalid = !amountMissing && (!Number.isFinite(amount) || amount <= 0);

  const reading = describeModalStatus(status, {
    idle: target
      ? [
          prose('Reddito usato: '),
          figure(cachedFormatCurrencyEUR(target.effectiveIncome, true)),
          target.corrected ? prose(' · correzione del mese') : prose(' · valore predefinito'),
          prose('. La correzione vale solo per '),
          figure(`${MONTH_NAMES[target.month - 1]} ${target.year}`),
          prose('.'),
        ]
      : [prose('Correggi il reddito di questo mese.')],
    submitting: 'Salvataggio in corso…',
  });

  const refuseAmount = () => {
    setStatus({ phase: 'error', message: describeFormRefusal(amountMissing ? ['Importo'] : [], amountInvalid ? ['Importo'] : []) });
    document.getElementById('monthly-income-override-amount')?.focus();
  };

  async function handleSave() {
    if (!target || amountMissing || amountInvalid) {
      refuseAmount();
      return;
    }
    setStatus({ phase: 'submitting' });
    try {
      await onSave(target.key, amount);
      onClose();
    } catch (error) {
      setStatus({ phase: 'error', message: describeWriteError(error) });
    }
  }

  const remove = useArmedDelete(removeRef, () => {
    if (!target) return;
    void (async () => {
      setStatus({ phase: 'submitting' });
      try {
        await onRemove(target.key);
        onClose();
      } catch (error) {
        setStatus({ phase: 'error', message: describeWriteError(error) });
      }
    })();
  });

  const title = target ? `Correggi reddito di ${MONTH_NAMES[target.month - 1]} ${target.year}` : 'Correggi reddito del mese';

  return (
    <ResponsiveModal
      open={target !== null}
      onClose={onClose}
      eyebrow="Tasso di risparmio · Reddito mensile"
      title={title}
      reading={reading}
      triggerOrigin={origin}
      width="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          {target?.corrected && (
            <Button variant="ghost" ref={removeRef} onClick={remove.onClick} onBlur={remove.onBlur} aria-label={remove.armed ? 'Conferma ripristino' : 'Ripristina predefinito'}>
              {remove.armed ? 'Conferma' : 'Ripristina predefinito'}
            </Button>
          )}
          <Button onClick={() => void handleSave()} disabled={status.phase === 'submitting'}>Salva</Button>
        </>
      }
      footerNote="La correzione non cambia gli altri mesi."
    >
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="monthly-income-override-amount">Reddito netto del mese (€)</Label>
          <Input
            id="monthly-income-override-amount"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={text}
            aria-invalid={status.phase === 'error' && (amountMissing || amountInvalid)}
            onChange={(event) => {
              setDraft({ key: subjectKey, text: event.target.value });
              if (status.phase !== 'idle') setStatus({ phase: 'idle' });
            }}
          />
        </div>
        {target && (
          <p className="text-xs text-muted-foreground">
            Predefinito: {cachedFormatCurrencyEUR(target.defaultIncome, true)}. L’importo inserito diventa il reddito di questo mese nel tasso di risparmio.
          </p>
        )}
      </div>
    </ResponsiveModal>
  );
}
