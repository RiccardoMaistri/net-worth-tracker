/**
 * The broker's sells that the LEDGER does not hold — the completeness reading of the Plusvalenze
 * detail, and the reason it lives in a pure module.
 *
 * WHY A SEPARATE LIST, never a merge: a row the ledger holds is a realized gain, with a cost basis
 * and a replay behind it; a row the broker reports but the ledger does not is a SALE THE USER HAS
 * NOT BOOKED. Printing them in one table would put a «plusvalenza» beside a figure nothing has
 * measured, and the total would be a sum of two different things. So they are two lists, and the
 * second one says what each row is waiting for.
 *
 * THE BROKER IS NOT THE LEDGER'S SOURCE: every figure here is the BROKER's own (quantity, unit
 * price, commission, the tax it withheld) and never a gain — a gain needs the cost of the units
 * sold, which only the ledger's replay can produce, and a broker's own cost basis is a second
 * source for the same figure (doc/guide/registro-operazioni.md). An unimported sell therefore has
 * NO gain cell, and none is invented from the proceeds.
 *
 * A YEAR, because a fiscal year is the unit the tile and the detail table are read in; and the year
 * is read with `getItalyYear`, never `getFullYear`, or a December sale lands in the wrong year.
 */
import { getItalyYear } from '@/lib/utils/dateHelpers';
import type { BrokerTradeRow, BrokerTradeSkip } from '@/lib/utils/brokerTradePlan';
import type { BrokerTrade } from '@/lib/utils/brokerTrade';

/** What a missing sell is waiting for, in the user's words. */
export type UnbookedSellReason = 'not-imported' | 'asset-not-found' | 'no-isin' | 'before-baseline' | 'not-ledger';

export interface UnbookedSell {
  /** The broker's own id: what an import would write, and the idempotency key. */
  sourceRef: string;
  date: Date;
  label: string;
  isin?: string;
  quantity: number;
  /** The VENUE price the broker charged (both brokers: EUR), as it reported it. */
  pricePerUnit: number;
  currency: string;
  fees?: number;
  /** The capital-gains tax the broker withheld at the sale, when it reported one. */
  withheldTax?: number;
  /**
   * The gain the BROKER reports on this sale, and `undefined` when it reported none.
   *
   * ON THE BROKER'S FISCAL BASIS, not the ledger's: measured 2026-10-05, TR's Gain on the Micron sale
   * is €334,35, and it differs from what the ledger would compute by the commissions — the broker
   * taxes the price difference alone (doc/guide/registro-operazioni.md). So this is a REPORTED figure
   * on a sale the ledger has NOT booked, and it never enters the table above, whose rows come from
   * the replay. What the broker reported is the point: without it this row would show cash with no
   * gain at all, which on a sale that did make money is the more misleading of the two.
   */
  brokerGain?: number;
  /** What the sold units cost ON THE BROKER'S BASIS: `lordo − Gain`, its fiscal carrying value. */
  brokerCostBasis?: number;
  /** `Gain / brokerCostBasis`, on that same basis. `undefined` when there is no base. */
  brokerGainPct?: number;
  /** Italian, user-facing, and SAYS what is missing — never a bare «non importata». */
  reason: string;
  reasonKey: UnbookedSellReason;
  /** Set when the row is importable: the Portafoglio asset it would join. */
  assetId?: string;
}

/** Cents: a basis read off a subtraction of printed euro figures must not drift from them. */
function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const REASON_TEXT: Record<UnbookedSellReason, string> = {
  'not-imported': 'Non ancora nel registro: importala e la trovi nelle plusvalenze, calcolata al PMC del registro.',
  'asset-not-found': 'L’asset non è nel Portafoglio: la plusvalenza qui è quella del broker, non ancora la tua.',
  'no-isin': 'Il broker non ha riportato l’ISIN: non si può abbinare a uno strumento del Portafoglio.',
  'before-baseline': 'La data precede la baseline dell’asset: la base di costo non è ricostruibile.',
  'not-ledger': 'L’asset non è gestito dal registro operazioni.',
};

/** The plan's own skip reasons, mapped onto the two the reader must be able to act on. */
const SKIP_REASON: Partial<Record<BrokerTradeSkip['reason'], UnbookedSellReason>> = {
  'asset-not-found': 'asset-not-found',
  'no-isin': 'no-isin',
  'before-baseline': 'before-baseline',
  'asset-not-ledger': 'not-ledger',
};

function toSell(trade: BrokerTrade, reasonKey: UnbookedSellReason, assetId?: string): UnbookedSell {
  const gross = trade.quantity * trade.pricePerUnit;
  // The broker's own basis: what it reports as the gain, so the base is `lordo − Gain` and never a
  // cost the app invented. Measured 2026-10-05: Gain 334,35 on a €3.791,29 sale → base €3.456,94,
  // which is exactly the broker's `Profit` of 9,67% read back (334,35 / 3.456,94 = 9,67%).
  const brokerGain = trade.brokerGain;
  const brokerCostBasis = brokerGain !== undefined ? roundCents(gross - brokerGain) : undefined;
  const brokerGainFigures =
    brokerGain !== undefined && brokerCostBasis !== undefined && brokerCostBasis > 0
      ? { brokerCostBasis, brokerGainPct: (brokerGain / brokerCostBasis) * 100 }
      : {};
  return {
    sourceRef: trade.sourceRef,
    date: trade.date,
    label: trade.label,
    ...(trade.isin ? { isin: trade.isin } : {}),
    quantity: trade.quantity,
    pricePerUnit: trade.pricePerUnit,
    currency: trade.currency,
    ...(trade.fees !== undefined ? { fees: trade.fees } : {}),
    ...(trade.withheldTax !== undefined ? { withheldTax: trade.withheldTax } : {}),
    ...(brokerGain !== undefined ? { brokerGain } : {}),
    ...brokerGainFigures,
    reason: REASON_TEXT[reasonKey],
    reasonKey,
    ...(assetId ? { assetId } : {}),
  };
}

/**
 * The SELLs of `year` the ledger does not hold, oldest first.
 *
 * `toImport` is what an import would write and `skipped` is what it refused, so between them they
 * are every sell the broker reports that the ledger has not: the two lists differ only in whether
 * the row COULD be written, which is exactly the distinction the reason text has to carry.
 * A BUY is never listed — it realizes nothing, so it has no place in a gains reading.
 *
 * `year` is a PARAMETER, never read from the clock: the caller owns «which fiscal year is being
 * read», which is the modal's selected year and not today's date, and the rows must be able to be
 * built for a past year without a fake timer.
 */
export function summarizeUnbookedBrokerSells(
  toImport: readonly BrokerTradeRow[],
  skipped: readonly BrokerTradeSkip[],
  year: number
): UnbookedSell[] {
  const rows: UnbookedSell[] = [];
  for (const row of toImport) {
    if (row.trade.type !== 'sell') continue;
    if (getItalyYear(row.trade.date) !== year) continue;
    rows.push(toSell(row.trade, 'not-imported', row.assetId));
  }
  for (const skip of skipped) {
    if (skip.trade.type !== 'sell') continue;
    if (getItalyYear(skip.trade.date) !== year) continue;
    rows.push(toSell(skip.trade, SKIP_REASON[skip.reason] ?? 'not-imported'));
  }
  return rows.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * The rows' own sums — what the broker says it PAID OUT, plus the gain it reports for those same
 * rows (see the module header: two bases, two labels).
 *
 * `netEur` is `lordo − fee − tassa`, the identity Trade Republic settles (measured 2026-10-05) and
 * the same arithmetic `computeCashDelta` applies to a booked sell. A sale with no tax reported
 * contributes 0 to the tax column — not an invented estimate.
 *
 * `brokerGainEur` sums only the rows that REPORTED one, and `brokerGainRowCount` says how many did,
 * so a total can never read as the gain of the whole list when some rows have no gain at all (the
 * pre-2024 archive). `brokerCostBasisEur` and `brokerGainPct` are on the same basis, for the same
 * reason: the percentage is over the summed basis of those rows only.
 */
export interface UnbookedSellTotals {
  grossEur: number;
  feesEur: number;
  withheldTaxEur: number;
  netEur: number;
  brokerGainEur: number;
  brokerCostBasisEur: number;
  /** Gain over the summed basis of the rows that reported one, or `undefined` when none did. */
  brokerGainPct?: number;
  /** How many rows of the list reported a gain — the denominator of the claim above. */
  brokerGainRowCount: number;
}

/**
 * The totals of an unbooked list, rounded to the cent so the printed rows add up on screen.
 *
 * A list whose rows mix bases must not be totalled as if they shared one: `brokerCostBasisEur` is
 * the sum over the rows that reported a gain only, so the percentage beside it is the same basis.
 */
export function sumUnbookedSells(sells: readonly UnbookedSell[]): UnbookedSellTotals {
  const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  return sells.reduce<UnbookedSellTotals>(
    (acc, sell) => {
      const gross = round(sell.quantity * sell.pricePerUnit);
      const fees = round(sell.fees ?? 0);
      const tax = round(sell.withheldTax ?? 0);
      const hasGain = sell.brokerGain !== undefined && sell.brokerCostBasis !== undefined;
      return {
        grossEur: round(acc.grossEur + gross),
        feesEur: round(acc.feesEur + fees),
        withheldTaxEur: round(acc.withheldTaxEur + tax),
        netEur: round(acc.netEur + gross - fees - tax),
        brokerGainEur: round(acc.brokerGainEur + (sell.brokerGain ?? 0)),
        brokerCostBasisEur: round(acc.brokerCostBasisEur + (sell.brokerCostBasis ?? 0)),
        brokerGainRowCount: acc.brokerGainRowCount + (hasGain ? 1 : 0),
      };
    },
    { grossEur: 0, feesEur: 0, withheldTaxEur: 0, netEur: 0, brokerGainEur: 0, brokerCostBasisEur: 0, brokerGainRowCount: 0 }
  );
}

/** The gain totals, with the percentage over the summed basis of the rows that reported one. */
export function withBrokerGainPct(totals: UnbookedSellTotals): UnbookedSellTotals {
  if (totals.brokerGainRowCount === 0 || totals.brokerCostBasisEur <= 0) {
    return { ...totals, brokerGainPct: undefined };
  }
  return { ...totals, brokerGainPct: (totals.brokerGainEur / totals.brokerCostBasisEur) * 100 };
}