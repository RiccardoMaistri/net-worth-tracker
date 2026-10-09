/**
 * The CLIENT read of «which broker sells the ledger has not booked» — one POST against the trades
 * route's PREVIEW branch, which never writes, joined to the plan.
 *
 * WHY THE PREVIEW ROUTE AND NOT A NEW ONE: that branch already builds exactly this plan against
 * the owner's CURRENT ledger — the (source, sourceRef) idempotency keys, the asset join by ISIN, the
 * baseline floor — and it is already owner-scoped through `assertCanAccessAccount`. A new endpoint
 * would be a second implementation of the same decision, and the two could disagree about which
 * sells are missing, which is the one number this reading is about.
 *
 * NO CACHE, on purpose (the sibling service says why, and it applies here): the reading exists to
 * answer «is my ledger complete?», and a cached answer is stale exactly when it matters. It is
 * gated by `enabled` so it runs only while the modal that shows it is open.
 *
 * A 401/409 IS A STATE, not a failure: the broker's session is gone (401) or was never linked
 * (409), and the section says which, in the user's words. Both arrive as an ordinary error here and
 * are mapped by status — a bare «non si è potuto leggere» for a re-linkable session would send the
 * reader to the wrong place.
 */
import { fetchBrokerTradePreview } from '@/lib/services/brokerTradeImportService';
import { getItalyYear } from '@/lib/utils/dateHelpers';
import {
  summarizeUnbookedBrokerSells,
  sumUnbookedSells,
  type UnbookedSell,
} from '@/lib/utils/unbookedBrokerSells';
import type { UnbookedSellsReading, UnbookedSellsState } from '@/lib/utils/unbookedSellsNarrative';

export interface UnbookedSellsReadingResult extends UnbookedSellsReading {
  state: UnbookedSellsState;
}

/**
 * Read the broker's history and return the sells of `year` the ledger does not hold.
 *
 * `year` is the FISCAL year in Italian terms; the rows are filtered by it inside the pure layer,
 * which is also where the ordering lives.
 *
 * The broker's own sell count for the year is returned alongside, because «7 missing» is only
 * meaningful next to «10 in all» — a completeness claim about a whole year, not a list of leftovers.
 * It is counted from the same plan, so the two can never disagree.
 */
export async function fetchUnbookedBrokerSells(
  ownerId: string,
  year: number
): Promise<UnbookedSellsReadingResult> {
  let preview;
  try {
    preview = await fetchBrokerTradePreview(ownerId, 'traderepublic');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/non è collegato/i.test(message)) {
      return emptyReading('not-linked');
    }
    if (/sessione Trade Republic non è più valida|scaduta|non è più utilizzabile/i.test(message)) {
      return emptyReading('session-expired');
    }
    return emptyReading('failed');
  }

  const sells: UnbookedSell[] = summarizeUnbookedBrokerSells(preview.toImport, preview.skipped, year);

  // The broker's sells of the year, imported or not: `toImport` + `skipped` are what it reported
  // and the ledger does not hold, and `alreadyImported` is the complement, so the three together
  // are the broker's whole sell population for the year.
  const brokerSellCount =
    preview.alreadyImported.filter(
      (r) => r.trade.type === 'sell' && getItalyYear(r.trade.date) === year
    ).length + sells.length;

  return { state: 'ready', sells, totals: sumUnbookedSells(sells), brokerSellCount };
}



function emptyReading(state: Exclude<UnbookedSellsState, 'ready'>): UnbookedSellsReadingResult {
  return {
    state,
    sells: [],
    totals: sumUnbookedSells([]),
    brokerSellCount: 0,
  };
}