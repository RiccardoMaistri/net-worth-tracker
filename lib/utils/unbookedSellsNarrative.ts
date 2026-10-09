/**
 * The pure layer of «le vendite del broker che il registro non ha»: what the reader is told about
 * each row, and when the section appears at all.
 *
 * The NUMBERS are not here — they are the broker's own and `unbookedBrokerSells.ts` shapes them.
 * What a surface must decide, and cannot invent, is the WORDING and the states: whether the
 * section appears, what its heading claims, and what one row says about the four reasons a broker
 * sale can be missing. The honesty rules that shape it (DESIGN.md → The Narrative Honesty Rule):
 *
 *   1. **A missing input drops its clause.** No broker linked, an expired session and a failed read
 *      are three DIFFERENT sentences — a user with no Trade Republic must not be told their sales
 *      are unbooked, and a user whose session died must not be shown an empty list that reads as
 *      «nothing missing».
 *   2. **A broker row is not a realized gain.** The wording never calls these plusvalenze: they are
 *      sales the ledger has not booked, and a gain cannot exist without the ledger's cost basis.
 *   3. **The count is the reader's first fact.** «7 vendite non sono ancora nel registro» states the
 *      size before any row, so the section cannot be read as a complete list of the year's sales.
 */

import { cachedFormatCurrencyEUR } from '@/lib/utils/formatters';
import type { Narrative, NarrativeSegment } from '@/lib/utils/narrative';
import type { UnbookedSell, UnbookedSellReason, UnbookedSellTotals } from '@/lib/utils/unbookedBrokerSells';

const prose = (text: string): NarrativeSegment => ({ text });
const figure = (text: string): NarrativeSegment => ({ text, mono: true });

/** Whether the broker's history was read at all — the state the section renders from. */
export type UnbookedSellsState =
  /** No Trade Republic session: the section says so, and claims nothing about the sales. */
  | 'not-linked'
  /** The session is gone: the reader has to re-link before this can be read again. */
  | 'session-expired'
  /** The read failed (network, WAF): a failed read is NOT an empty list. */
  | 'failed'
  | 'ready';

export interface UnbookedSellsReading {
  state: UnbookedSellsState;
  /** The rows, in the reading's order. Empty for every state but `ready`. */
  sells: UnbookedSell[];
  totals: UnbookedSellTotals;
  /** How many sells the broker reported for the year, imported or not — the completeness figure. */
  brokerSellCount: number;
}

/** «vendita» / «vendite», without a pluralization library. */
function plural(count: number, singular: string, many: string): string {
  return count === 1 ? singular : many;
}

/**
 * What one missing row says about itself.
 *
 * The four reasons are DIFFERENT problems with different fixes, so they never share a sentence:
 * «importala tu» is an instruction, «aggiungi lo strumento» is a prerequisite the user may not
 * know about, and the two ledger-side reasons are statements about data that cannot be recovered.
 */
export function describeUnbookedSell(reason: UnbookedSellReason): string {
  switch (reason) {
    case 'not-imported':
      return 'Non ancora nel registro';
    case 'asset-not-found':
      return 'Strumento non tracciato';
    case 'no-isin':
      return 'ISIN non riportato dal broker';
    case 'before-baseline':
      return 'Prima della baseline';
    case 'not-ledger':
      return 'Strumento fuori dal registro';
  }
}

/**
 * The section's reading: how many sales of the year the ledger has not booked, what they add up to,
 * and — when they are all waiting on the same thing — that one thing.
 *
 * `year` is named in the sentence, because a fiscal year is the unit everything else here is read
 * in and «7 vendite» without it would be ambiguous on a page that also prints other years.
 *
 * With NO missing rows the clause is not «tutto registrato» (a claim about a broker read that may
 * have been partial) but the counted fact: how many sales the broker reported for the year, which
 * is also the completeness figure the reader wants on the happy path.
 */
export function describeUnbookedSells(
  reading: UnbookedSellsReading,
  year: number
): Narrative | null {
  if (reading.state === 'not-linked') {
    return [prose('Trade Republic non è collegato: le sue vendite non possono essere confrontate con il registro.')];
  }
  if (reading.state === 'session-expired') {
    return [prose('La sessione Trade Republic è scaduta: ricollegati per vedere le vendite che il registro non ha.')];
  }
  if (reading.state === 'failed') {
    return [prose('Le vendite di Trade Republic non si sono potute leggere: il confronto con il registro resta incompleto.')];
  }

  const missing = reading.sells.length;
  if (missing === 0) {
    return [
      prose(`Nel ${year} Trade Republic ha registrato `),
      figure(String(reading.brokerSellCount)),
      prose(` ${plural(reading.brokerSellCount, 'vendita', 'vendite')}: sono tutte nel registro.`),
    ];
  }

  // The money clause is the NET the broker says it paid out, and it is dropped entirely when no row
  // of the list is importable: naming a total for sales that cannot become ledger rows would put a
  // figure next to a promise the reader cannot act on.
  const importable = reading.sells.some((s) => s.reasonKey === 'not-imported');

  const out: Narrative = [
    prose(`Nel ${year} Trade Republic ha registrato `),
    figure(String(reading.brokerSellCount)),
    prose(` ${plural(reading.brokerSellCount, 'vendita', 'vendite')}: `),
    figure(String(missing)),
    prose(` ${plural(missing, 'non è ancora nel registro', 'non sono ancora nel registro')}`),
  ];

  if (!importable) {
    out.push(prose(', e nessuna è importabile finché lo strumento non è tracciato.'));
    return out;
  }

  out.push(
    prose(', per ricavi di '),
    figure(cachedFormatCurrencyEUR(reading.totals.netEur)),
    prose('.')
  );
  return out;
}