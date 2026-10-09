/**
 * The ONE shape both broker trade importers produce — Scalable and Trade Republic, normalized.
 *
 * Two brokers, two wildly different payloads, one importer downstream. This module is the seam:
 * each broker module (`scalableTradeImport.ts`, `tradeRepublicTradeImport.ts`) parses its own wire
 * into `BrokerTrade`, and everything after that — the preview, the idempotency check, the write —
 * is broker-agnostic and never re-reads a raw payload.
 *
 * Pure, no I/O, no `server-only`: the preview is composed in the CLIENT, which already holds the
 * tracked assets, so this has to survive the bundle.
 *
 * WHAT THIS SHAPE DELIBERATELY DOES NOT CARRY, and why each omission cost a decision:
 *
 * - **`priceEur`.** The ledger resolves FX server-side (`createAssetTransaction`), and the form
 *   payload does not accept one — a client can therefore never write an inconsistent FX value.
 *   What the form DOES carry is `priceCurrency`, the venue currency the broker charged in (both
 *   brokers: EUR, whatever the instrument is), which is what tells the server that
 *   `pricePerUnit` is a euro figure and not the asset's native price: measured 2026-10-05, a
 *   €996,10 Micron sale on a USD-quoted asset was stored at €869,12 because nothing said where
 *   that number came from.
 * - **`quantity` sign.** Always positive; the side lives in `side`, because `AssetTransactionType`
 *   maps `buy`→BUY and `sell`→SELL directly and a negative quantity is a validation error there.
 * - **Cash settlement.** `linkedCashAssetId` is deliberately absent: the broker's cash account is
 *   an `Asset` the sync may not have created yet, and a buy debits / a sell credits it. Guessing
 *   an id would move money the import has no business moving, so it stays a per-row choice.
 */

import type { AssetTransactionSource, AssetTransactionType } from '@/types/assetTransactions';

export type BrokerTradeSide = 'buy' | 'sell';

/** One broker operation, normalized. Field semantics are documented per field, not here. */
export interface BrokerTrade {
  /** The BROKER's own stable id — the idempotency key. Never a row index, never synthesized. */
  sourceRef: string;
  /** Which broker issued `sourceRef`. Part of the key: ids are per-broker. */
  source: AssetTransactionSource;
  /** 'buy' | 'sell' — an adjustment is never imported: it is a ledger correction, not a fact. */
  type: AssetTransactionType;
  /** ISIN, uppercased. The join key against Portafoglio. Absent on a few cash-like rows. */
  isin?: string;
  /**
   * Human label as the broker prints it.
   *
   * WRITTEN as the ledger trade's `note` on import (2026-10-05), which is what a sale whose asset
   * has since been deleted falls back to for a name: a ledger row carries no name of its own, and
   * «Strumento rimosso» was every imported sale of a closed position. It is also what the preview
   * row prints.
   */
  label: string;
  /** Execution date (broker timestamp), in the BROKER's local date semantics. */
  date: Date;
  /** Units, always > 0. */
  quantity: number;
  /**
   * Price per unit in the VENUE's currency — what the broker charged, not the instrument's native
   * one. Both brokers settle in EUR whatever the instrument is, so this is a euro figure even for a
   * US stock, and it travels to the ledger as `AssetTransactionFormData.priceCurrency` precisely so
   * the write does not convert it a second time (measured 2026-10-05).
   */
  pricePerUnit: number;
  /** Currency of `pricePerUnit`, as the broker reported it. `EUR` needs no FX. */
  currency: string;
  /** Total commissions for this operation, in `currency`. Absent when the broker reports none. */
  fees?: number;
  /**
   * SELL only: capital-gains tax withheld at sale, in `currency`.
   *
   * Measured per broker, and they DISAGREE — which is why this is a field and not a constant.
   * Scalable's `tax_amount` is `null` on a retail sale, so it stays absent. Trade Republic
   * withholds the German KESt at source on a sale with a gain: absent on the pre-2024 archive
   * (measured across eleven sells) and present on every 2026 one (measured 2026-10-05, 10 of 10,
   * 25,75% of that year's gains).
   *
   * `undefined` means THE BROKER REPORTED NOTHING, which is not a zero-tax claim: the period tax
   * ESTIMATE in Rendimenti then stands, and that is the correct reading for a sale on which
   * nothing was withheld.
   */
  withheldTax?: number;
  /**
   * SELL only: the gain the BROKER reports on the sale, in `currency` — measured on ITS fiscal
   * carrying value, which is not the ledger's cost basis.
   *
   * NEVER WRITTEN to a ledger row: the replay computes the realized P&L from the ledger's own PMC,
   * so a broker gain beside it would be a second source for one figure. It travels because a sale
   * the ledger does NOT hold has no replay to measure it, and the completeness reading on Rendimenti
   * would otherwise show a broker's cash with no gain at all. Absent when the broker reported none
   * (the pre-2024 archive) — never a zero.
   */
  brokerGain?: number;
}

/** A trade that cannot become a ledger entry, with the reason a user can act on. */
export interface SkippedBrokerTrade {
  sourceRef: string;
  label: string;
  date?: Date;
  /** Italian, user-facing. The preview prints it verbatim. */
  reason: string;
}

export interface BrokerTradeParseResult {
  trades: BrokerTrade[];
  skipped: SkippedBrokerTrade[];
}

/**
 * The deduped, chronological trade list an importer works from.
 *
 * Sorted ASCENDING because the ledger's replay is order-dependent: cost basis is FIFO, so a buy
 * dated after its sell must not be replayed first. Sorting here rather than in the importer means
 * the preview the user approves and the rows that get written are the same sequence.
 */
export function sortBrokerTrades(trades: BrokerTrade[]): BrokerTrade[] {
  return [...trades].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Drop a broker's repeated ids, keeping the FIRST occurrence.
 *
 * Both brokers paginate a timeline that can deliver the same operation twice across page
 * boundaries, and a duplicate would be written twice — the exact failure `sourceRef` exists to
 * prevent. First-wins because the earlier row is the one whose date the parser saw first, and a
 * later re-delivery of an operation is a re-read, never an amendment.
 */
export function dedupeBrokerTrades(trades: BrokerTrade[]): BrokerTrade[] {
  const seen = new Set<string>();
  const out: BrokerTrade[] = [];
  for (const trade of trades) {
    if (seen.has(trade.sourceRef)) continue;
    seen.add(trade.sourceRef);
    out.push(trade);
  }
  return out;
}

// ─── Numeric guards ──────────────────────────────────────────────────────────

/**
 * Coerce a broker number to a finite positive value, or null.
 *
 * Both brokers print fractional units (4.027288 shares) and amounts as STRINGS with locale
 * formatting in some views, so `Number()` alone is not enough — and a NaN that reaches
 * `pricePerUnit` would be written to the ledger, where a single poisoned row makes the whole
 * replay throw. Null means «not a value I can write», and the caller skips the row WITH A REASON
 * rather than importing a zero that would silently zero a position.
 */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  // `1.234,56` (it-IT) and `1,234.56` (en) both appear across the two brokers' surfaces.
  const normalized = value.trim().replace(/\s|€/g, '');
  const comma = normalized.lastIndexOf(',');
  const dot = normalized.lastIndexOf('.');
  let candidate = normalized;
  if (comma > -1 && dot > -1) {
    // Whichever separator comes LAST is the decimal one.
    candidate = comma > dot ? normalized.replace(/\./g, '').replace(',', '.') : normalized.replace(/,/g, '');
  } else if (comma > -1) {
    candidate = normalized.replace(',', '.');
  }
  const parsed = Number.parseFloat(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse a broker timestamp into a Date.
 *
 * Trade Republic prints `2026-10-01T08:20:17.172+0000` — an offset with NO colon, which
 * `new Date()` accepts on V8 but is not ISO 8601, so a strict parser rejects it. The colon is
 * inserted for the offset form only; a `Z` or `+01:00` is left untouched. An unparseable value
 * returns null and the row is skipped with a reason, because a trade with no date cannot be
 * replayed (the ledger floors every date at the asset's own baseline).
 */
export function parseBrokerDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  const normalized = /[+-]\d{4}$/.test(trimmed) ? `${trimmed.slice(0, -2)}:${trimmed.slice(-2)}` : trimmed;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
