/**
 * The Trade Republic CARD EXPENSE import — preview, apply, undo.
 *
 * The card movements the broker's timeline carries are not the user's assertion that they belong
 * in Cashflow: a corporate card, a duplicate of a row already typed by hand, a purchase that was
 * refunded. So the modal opens on the PREVIEW branch of the route, which writes nothing, and only
 * the rows the user approves are written.
 *
 * THE PROMISE THIS MODAL KEEPS, and why each rule is here:
 *
 * - **A re-sync never duplicates.** The document id is derived from the broker's own movement id,
 *   and the write is `create()`-only, so an existing row is counted as «già importata», never
 *   written twice.
 * - **A re-sync never overwrites an edit.** The importer never updates an existing expense: the
 *   row the user reclassified in Cashflow is the row that stays.
 * - **A deleted row never comes back.** The rows in `removed` were imported once and are gone now
 *   (deleted from Cashflow, or undone from this dialog). The server remembers them and leaves them
 *   out — the modal only declares how many.
 * - **A category is created only after being named.** When a detected category does not exist, it
 *   is listed under «Categorie da creare» before the write; nothing is invented silently.
 *
 * The toast after a successful apply carries «Annulla», which is the undo: it deletes exactly the
 * rows that landed and records them, so the next sync does not resurrect them.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, CreditCard, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { ResponsiveModal } from '@/components/ui/responsive-modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { formatCurrency, formatDate } from '@/lib/utils/formatters';
import { TR_CARD_EXPENSE_WINDOW_MONTHS } from '@/lib/utils/tradeRepublicCardExpenses';
import { errorMessage } from '@/lib/utils/errorMessage';
import { queryKeys } from '@/lib/query/queryKeys';
import { useSceneNavigation } from '@/lib/hooks/useSceneNavigation';
import { saveBrokerCardExpenseCount } from '@/lib/services/brokerConnectionService';
import {
  applyCardExpenses,
  fetchCardExpensePreview,
  undoCardExpenses,
  type TrCardExpensePlannedRow,
  type TrCardExpensePreview,
} from '@/lib/services/brokerCardExpenseImportService';
import type { TrCardExpenseApplyResultDto } from '@/lib/types/tradeRepublicCardImport';
import { EXPENSE_TYPE_LABELS } from '@/types/expenses';

/** Where a successful import lands: the tab that shows the rows it just wrote. */
const CASHFLOW_TRACKING_HREF = '/dashboard/cashflow?tab=tracking';

type Phase = 'loading' | 'ready' | 'saving' | 'failed';

/**
 * The whole preview subject, stored WITH the request that produced it. A stored key that no
 * longer matches the live one reads as «not loaded yet», so a reopen falls back to the defaults
 * DURING RENDER — the repo's `scopeKey` shape, no reset effect.
 */
interface LoadedPreview {
  requestKey: string;
  phase: Phase;
  error: string | null;
  preview: TrCardExpensePreview | null;
  approved: ReadonlySet<string>;
  outcome: TrCardExpenseApplyResultDto | null;
}

interface BrokerCardExpenseImportDialogProps {
  open: boolean;
  onClose: () => void;
  ownerId: string;
  /** Demo mode: the whole flow is read-only. */
  disabled?: boolean;
  /** Told after a write so the tile re-reads its metadata (the count in the reading line). */
  onImported?: () => void;
}

const NO_APPROVED: ReadonlySet<string> = new Set<string>();

/** One row's stable group key: the category it lands in, plus its type. */
function groupKeyOf(row: TrCardExpensePlannedRow): string {
  return `${row.type}::${row.categoryName}`;
}

interface RowGroup {
  key: string;
  categoryName: string;
  type: TrCardExpensePlannedRow['type'];
  rows: TrCardExpensePlannedRow[];
  total: number;
}

/** Rows grouped by destination category, in the order the plan produced them. */
function groupRows(rows: TrCardExpensePlannedRow[]): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const key = groupKeyOf(row);
    let group = groups.get(key);
    if (!group) {
      group = { key, categoryName: row.categoryName, type: row.type, rows: [], total: 0 };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.total += row.amount;
  }
  return [...groups.values()];
}

/** Italian plural for a count, without a pluralization library. */
function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function signedAmount(amount: number): string {
  return formatCurrency(amount);
}

/**
 * The write, lifted out of the component. The React Compiler skips a WHOLE component when a
 * `?:`/`?.` sits inside its `try/catch` (the coverage suite names every skip), so the branches
 * that describe an outcome live in module-level helpers and the component's `try` holds one call.
 */
async function commitCardImport(
  ownerId: string,
  approved: ReadonlySet<string>,
  invalidate: () => Promise<void>,
  onImported?: () => void
): Promise<TrCardExpenseApplyResultDto> {
  const written = await applyCardExpenses(ownerId, [...approved]);
  await invalidate();
  if (written.totalCardExpenses > 0) {
    // The tile's reading line is metadata, and this is the write that owns that number.
    await saveBrokerCardExpenseCount(ownerId, written.totalCardExpenses);
  }
  onImported?.();
  return written;
}

function successText(written: TrCardExpenseApplyResultDto): string {
  const amount = countLabel(written.imported, 'movimento carta importato', 'movimenti carta importati');
  const already = written.duplicates > 0 ? `, ${written.duplicates} già presenti` : '';
  return `${written.imported} ${amount}${already}.`;
}

function failureText(written: TrCardExpenseApplyResultDto): string {
  return `${written.imported} importati, ${written.failed.length} non riusciti.`;
}

/** The toast's «Annulla»: deletes exactly what landed and records it so no sync brings it back. */
async function undoAfterImport(
  ownerId: string,
  refs: readonly string[],
  invalidate: () => Promise<void>,
  onImported?: () => void
): Promise<void> {
  try {
    await undoCardExpenses(ownerId, refs);
    await invalidate();
    onImported?.();
    toast.success('Importazione annullata: i movimenti non torneranno al prossimo sync.');
  } catch (err) {
    toast.error(errorMessage(err, 'Annullamento non riuscito: riprova.'));
  }
}

export function BrokerCardExpenseImportDialog({
  open,
  onClose,
  ownerId,
  disabled = false,
  onImported,
}: BrokerCardExpenseImportDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useSceneNavigation();
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
  /** Guards against a slow response for a closed (or superseded) modal overwriting the live one. */
  const requestIdRef = useRef(0);
  /** The control that opened the modal, so focus returns there. */
  const openerRef = useRef<HTMLElement | null>(null);
  /** The one category group expanded at a time: a 1,400-row timeline must not render at once. */
  const [expanded, setExpanded] = useState<string | null>(null);

  const requestKey = `${ownerId}:${open ? 'open' : 'closed'}`;
  const subject: LoadedPreview =
    loaded?.requestKey === requestKey
      ? loaded
      : { requestKey, phase: 'loading', error: null, preview: null, approved: NO_APPROVED, outcome: null };
  const { phase, error, preview, approved, outcome } = subject;

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    const requestId = ++requestIdRef.current;
    // Deferred so the effect body sets no state (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const data = await fetchCardExpensePreview(ownerId);
          if (requestId !== requestIdRef.current) return;
          setLoaded({
            requestKey,
            phase: 'ready',
            error: null,
            preview: data,
            // EVERYTHING SELECTED BY DEFAULT: the user opened this to import the card, and the
            // unchecked exceptions are the point of the checkboxes.
            approved: new Set(data.toImport.map((row) => row.sourceRef)),
            outcome: null,
          });
        } catch (err) {
          if (requestId !== requestIdRef.current) return;
          setLoaded({
            requestKey,
            phase: 'failed',
            error: errorMessage(err, 'Lettura dei movimenti carta non riuscita: riprova.'),
            preview: null,
            approved: NO_APPROVED,
            outcome: null,
          });
        }
      })();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, ownerId, requestKey]);

  const toggle = (sourceRef: string, checked: boolean) => {
    setLoaded({
      ...subject,
      approved: (() => {
        const next = new Set(subject.approved);
        if (checked) next.add(sourceRef);
        else next.delete(sourceRef);
        return next;
      })(),
    });
  };

  const toggleGroup = (group: RowGroup, checked: boolean) => {
    setLoaded({
      ...subject,
      approved: (() => {
        const next = new Set(subject.approved);
        for (const row of group.rows) {
          if (checked) next.add(row.sourceRef);
          else next.delete(row.sourceRef);
        }
        return next;
      })(),
    });
  };

  const invalidateAfterWrite = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.expenses.all(ownerId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.expenses.categories(ownerId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.overview(ownerId) }),
    ]);
  };

  const handleSave = async () => {
    if (disabled) return;
    setLoaded({ ...subject, phase: 'saving', error: null });
    let written: TrCardExpenseApplyResultDto;
    try {
      written = await commitCardImport(ownerId, approved, invalidateAfterWrite, onImported);
    } catch (err) {
      setLoaded({
        ...subject,
        phase: 'failed',
        error: errorMessage(err, 'Importazione non riuscita: riprova.'),
      });
      return;
    }
    setLoaded({ ...subject, phase: 'ready', outcome: written });
    if (written.failed.length === 0) {
      onClose();
      toast.success(successText(written), {
        action: {
          label: 'Annulla',
          onClick: () => {
            void undoAfterImport(ownerId, written.importedRefs, invalidateAfterWrite, onImported);
          },
        },
      });
      // Land where the rows now live: the import exists to be seen in Cashflow.
      navigate(CASHFLOW_TRACKING_HREF);
    } else {
      // A partial write STAYS OPEN, with the failures listed.
      toast.error(failureText(written));
    }
  };

  const groups = preview ? groupRows(preview.toImport) : [];
  const failures = outcome?.failed ?? [];
  const busy = phase === 'loading' || phase === 'saving';
  const alreadyImported = preview?.alreadyImported.length ?? 0;
  const removed = preview?.removed.length ?? 0;
  const skipped = preview?.skipped.length ?? 0;
  const toCreate = preview?.categoriesToCreate.length ?? 0;
  const brokerCount = preview?.brokerCount ?? 0;

  return (
    <ResponsiveModal
      open={open}
      onClose={onClose}
      returnFocusTo={openerRef}
      eyebrow="Cashflow · Movimenti carta"
      title="Importa le spese della carta"
      width="lg"
      reading={
        phase === 'loading'
          ? 'Sto leggendo i movimenti della carta da Trade Republic…'
          : phase === 'saving'
            ? 'Sto scrivendo i movimenti nel Cashflow…'
            : phase === 'failed'
              ? (error ?? 'Operazione non riuscita: riprova.')
              : groups.length === 0 && brokerCount > 0
                ? 'Nessun movimento carta da importare: il Cashflow è già allineato.'
                : `${preview?.toImport.length ?? 0} ${countLabel(preview?.toImport.length ?? 0, 'movimento da importare', 'movimenti da importare')}${alreadyImported > 0 ? `, ${alreadyImported} già ${countLabel(alreadyImported, 'presente', 'presenti')}` : ''}.`
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Annulla
          </Button>
          <Button onClick={() => void handleSave()} disabled={busy || disabled || approved.size === 0}>
            {phase === 'saving' ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {`Importa${approved.size > 0 ? ` ${approved.size}` : ''}`}
          </Button>
        </>
      }
      footerNote={
        <span className="text-muted-foreground">
          Le spese già importate non vengono riscritte, e quelle che elimini non tornano.
        </span>
      }
    >
      {phase === 'loading' ? (
        <p className="text-[13px] text-muted-foreground">Lettura dei movimenti in corso…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-[12px] text-muted-foreground">
            {`Vengono letti solo gli ultimi ${TR_CARD_EXPENSE_WINDOW_MONTHS} mesi di movimenti; i prelievi di contanti non sono spese.`}
          </p>
          {preview && preview.summary.totalExpense > 0 && (
            <p className="flex items-center gap-2 text-[13px]">
              <CreditCard className="size-4 text-muted-foreground" />
              <span>
                {formatCurrency(preview.summary.totalExpense)} di spese
                {preview.summary.totalRefund > 0
                  ? ` e ${formatCurrency(preview.summary.totalRefund)} di rimborsi`
                  : ''}
                {preview.summary.dateFrom && preview.summary.dateTo
                  ? ` · ${formatDate(preview.summary.dateFrom)} – ${formatDate(preview.summary.dateTo)}`
                  : ''}
              </span>
            </p>
          )}

          {groups.length > 0 && (
            <section aria-label="Movimenti da importare" className="flex flex-col gap-2">
              <h4 className="text-[13px] font-medium">Da importare</h4>
              <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
                {groups.map((group) => {
                  const groupApproved = group.rows.filter((row) => approved.has(row.sourceRef)).length;
                  const all = groupApproved === group.rows.length;
                  const isOpen = expanded === group.key;
                  return (
                    <li key={group.key} className="flex flex-col">
                      <div className="flex items-center gap-3 px-3 py-2.5">
                        <Checkbox
                          checked={all ? true : groupApproved > 0 ? 'indeterminate' : false}
                          onCheckedChange={(checked) => toggleGroup(group, checked === true)}
                          aria-label={`Seleziona tutte le spese ${group.categoryName}`}
                        />
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : group.key)}
                          aria-expanded={isOpen}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                          {isOpen ? (
                            <ChevronDown className="size-3.5 flex-none text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-3.5 flex-none text-muted-foreground" />
                          )}
                          <span className="truncate text-[13px]">{group.categoryName}</span>
                          <span className="flex-none text-[11px] text-muted-foreground">
                            {`${groupApproved}/${group.rows.length}`}
                          </span>
                        </button>
                        <span className="flex-none font-mono text-[12px]">{signedAmount(group.total)}</span>
                        <Badge variant="outline" className="flex-none">
                          {EXPENSE_TYPE_LABELS[group.type]}
                        </Badge>
                      </div>
                      {isOpen && (
                        <ul className="flex flex-col gap-1 px-3 pb-2 pl-10">
                          {group.rows.map((row) => (
                            <li key={row.sourceRef} className="flex items-center gap-2">
                              <Checkbox
                                checked={approved.has(row.sourceRef)}
                                onCheckedChange={(checked) => toggle(row.sourceRef, checked === true)}
                                aria-label={`Importa ${row.merchant}`}
                              />
                              <span className="min-w-0 flex-1 truncate text-[12px]">
                                {row.merchant}
                                {row.subCategoryName ? (
                                  <span className="text-muted-foreground">{` · ${row.subCategoryName}`}</span>
                                ) : null}
                              </span>
                              <span className="flex-none text-[11px] text-muted-foreground">
                                {formatDate(row.date)}
                              </span>
                              <span className="w-24 flex-none text-right font-mono text-[12px]">
                                {signedAmount(row.amount)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {toCreate > 0 && (
            <section aria-label="Categorie da creare" className="flex flex-col gap-1.5">
              <h4 className="text-[13px] font-medium">Categorie da creare</h4>
              <p className="text-[11px] leading-[1.45] text-muted-foreground">
                Queste categorie non esistono ancora e verranno create con l’importazione. Potrai
                rinominarle o riclassificare le spese dal Cashflow.
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {preview?.categoriesToCreate.map((category) => (
                  <li key={`${category.type}:${category.name}`}>
                    <Badge variant="outline">{category.name}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(preview?.notices.length ?? 0) > 0 && (
            <ul className="flex flex-col gap-1">
              {preview?.notices.map((notice, index) => (
                <li key={index} className="text-[11px] leading-[1.45] text-muted-foreground">
                  {notice.message}
                </li>
              ))}
            </ul>
          )}

          {alreadyImported > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {`${alreadyImported} ${countLabel(alreadyImported, 'movimento già presente', 'movimenti già presenti')}: non verranno riscritti.`}
            </p>
          )}

          {removed > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {`${removed} ${countLabel(removed, 'movimento era già stato importato e ora non è più nel Cashflow', 'movimenti erano già stati importati e ora non sono più nel Cashflow')}: restano esclusi.`}
            </p>
          )}

          {skipped > 0 && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer">
                {`${skipped} ${countLabel(skipped, 'movimento non importabile', 'movimenti non importabili')}`}
              </summary>
              <ul className="mt-1.5 flex flex-col gap-1">
                {preview?.skipped.map((skip) => (
                  <li key={skip.sourceRef}>{`${skip.label} — ${skip.reason}`}</li>
                ))}
              </ul>
            </details>
          )}

          {failures.length > 0 && (
            <section aria-label="Movimenti non riusciti" className="flex flex-col gap-1.5">
              <h4 className="flex items-center gap-1.5 text-[13px] font-medium text-destructive">
                <TriangleAlert className="size-4" />
                Non riusciti
              </h4>
              <ul className="flex flex-col gap-1">
                {failures.map((failure) => (
                  <li key={failure.sourceRef} className="text-[11px] text-muted-foreground">
                    <span className="text-foreground">{failure.sourceRef}</span>
                    {` — ${failure.message}`}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {disabled && (
            <p className="text-[11px] text-muted-foreground">
              Modalità demo: l’importazione è disattivata.
            </p>
          )}
        </div>
      )}
    </ResponsiveModal>
  );
}
