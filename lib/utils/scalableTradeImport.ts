/**
 * Scalable broker TRADES - the pure layer behind the trade import, sibling to
 * 'tradeRepublicTradeImport.ts' and downstream of 'scalableImport.ts' (which imports ASSETS).
 *
 * Source payloads, both read-only and both measured live against a real account:
 *
 *   - 'sc broker transactions --json' -> the list; every row carries id, isin, side, quantity,
 *     last_event_datetime, status, type
 *   - 'sc broker transaction details --transaction-id <id> --json' -> the money-math, only on a
 *     SECURITY_TRANSACTION row: security_trade.average_price,
 *     security_trade.number_of_shares.filled, security_trade.total_amount, and
 *     security_trade.trade_transaction_amounts.{transaction_fee, venue_fee, tax_amount}
 *
 * WHY THE LIST ALONE IS NOT ENOUGH: the list row carries 'amount' (the CASH side) and no unit
 * price, so a sell's realized gain cannot be computed from it - it would need the FIFO cost the
 * detail carries. Conversely the detail has no ISIN sibling list row and no status. So the two are
 * JOINED on 'id', and only a SECURITY_TRANSACTION reaches the ledger.
 *
 * THE ROWS THAT ARE NOT TRADES, and must never become ledger entries:
 *   - CASH_TRANSACTION - deposits, withdrawals, internal transfers ('Trasferimento interno',
 *     measured). No security, no lot, no cost basis; the ledger settles cash through
 *     linkedCashAssetId on a real trade, so importing these would double-count money.
 *   - security_transaction_type SAVINGS_PLAN - a trade, but an EXECUTED one: the executed row
 *     (side BUY, filled quantity, average price) is what gets imported. A plan that never filled
 *     has no shares and must be skipped, not imported as a zero.
 *
 * Status gate: only SETTLED rows are facts. A PENDING/CANCELED buy is an intention, and
 * importing it would invent a position that never existed.
 *
 * Pure: no I/O, no 'server-only', no CLI. It takes already-fetched JSON.
 */

import {
  dedupeBrokerTrades,
  parseBrokerDate,
  sortBrokerTrades,
  toFiniteNumber,
  type BrokerTrade,
  type BrokerTradeParseResult,
  type SkippedBrokerTrade,
} from '@/lib/utils/brokerTrade';

/** The 'type' discriminator that carries a security trade. Everything else is cash or unknown. */
const SECURITY_TRANSACTION = 'SECURITY_TRANSACTION';

interface JsonObject {
  [key: string]: unknown;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Read a string through candidate paths, dot-separated.
 *
 * The CLI prints the broker's GraphQL fields verbatim and the envelope varies by version, so a
 * single fixed path is what makes these parsers brittle across upgrades. The DIRECT key is tried
 * first because a dotted key can legitimately exist on its own.
 */
function readString(source: JsonObject, ...paths: string[]): string | undefined {
  for (const path of paths) {
    const direct = source[path];
    if (typeof direct === 'string' && direct !== '') return direct;
    let cursor: unknown = source;
    for (const segment of path.split('.')) {
      const node = asObject(cursor);
      if (!node) break;
      cursor = node[segment];
    }
    if (typeof cursor === 'string' && cursor !== '') return cursor;
  }
  return undefined;
}

function readNumber(source: JsonObject, ...paths: string[]): number | null {
  for (const path of paths) {
    const direct = toFiniteNumber(source[path]);
    if (direct !== null) return direct;
    let cursor: unknown = source;
    for (const segment of path.split('.')) {
      const node = asObject(cursor);
      if (!node) break;
      cursor = node[segment];
    }
    const parsed = toFiniteNumber(cursor);
    if (parsed !== null) return parsed;
  }
  return null;
}

function pickItems(doc: unknown): JsonObject[] {
  const root = asObject(doc);
  if (!root) return [];
  const items = root.items ?? root.data ?? root.transactions ?? root;
  return asArray(items).map(asObject).filter((row): row is JsonObject => row !== null);
}

/**
 * Cents rounding for a money figure.
 *
 * The ledger settles in cents ('lib/utils/cents.ts') and re-derives EUR amounts from them, so a
 * raw 0.1 + 0.2 sum written as-is would show a fee one hundredth off the statement. Two decimals
 * because both brokers report cents for money and sub-cent shares for quantities - the rounding
 * applies to MONEY only, never to quantity.
 */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Split the list payload into the rows that need a detail call, and the rows that are not trades.
 *
 * The cash rows are reported rather than dropped silently: a user wondering why a deposit never
 * became a trade sees the reason in the preview instead of an absence.
 */
function parseListPayload(
  payload: unknown
): { rows: JsonObject[]; skipped: SkippedBrokerTrade[] } {
  const skipped: SkippedBrokerTrade[] = [];
  const rows: JsonObject[] = [];
  for (const row of pickItems(payload)) {
    const sourceRef = readString(row, 'id');
    if (!sourceRef) continue;
    const label = readString(row, 'description') ?? sourceRef;
    const date = parseBrokerDate(readString(row, 'last_event_datetime', 'lastEventDatetime'));

    const type = readString(row, 'type');
    if (type !== SECURITY_TRANSACTION) {
      skipped.push({
        sourceRef,
        label,
        ...(date ? { date } : {}),
        reason:
          type === 'CASH_TRANSACTION'
            ? 'Movimento di cassa: non e un’operazione su titoli.'
            : 'Tipo di operazione non supportato (' + (type ?? 'sconosciuto') + ').',
      });
      continue;
    }

    const status = readString(row, 'status');
    if (status !== undefined && status !== 'SETTLED') {
      skipped.push({
        sourceRef,
        label,
        ...(date ? { date } : {}),
        reason: 'Operazione non regolata (' + status + '): sara riletta al prossimo sync.',
      });
      continue;
    }
    rows.push(row);
  }
  return { rows, skipped };
}

/**
 * The fee for one operation, in EUR.
 *
 * Scalable splits it: transaction_fee is the brokerage commission and venue_fee the exchange
 * charge, and BOTH debit the buyer (measured: a savings plan row carried transaction_fee with
 * venue_fee null). Adding them is the only correct reading - a buy's cost basis is the money
 * actually paid. A negative or absent figure reads as no fee.
 */
function parseFees(trade: JsonObject): number | undefined {
  const amounts = asObject(trade['trade_transaction_amounts']);
  if (!amounts) return undefined;
  const total = ['transaction_fee', 'venue_fee'].reduce<number>((sum, key) => {
    const value = toFiniteNumber(amounts[key]);
    return value !== null && value > 0 ? sum + value : sum;
  }, 0);
  return total > 0 ? round2(total) : undefined;
}

/**
 * SELL only: the tax Scalable withheld. Measured live: tax_amount is null on retail sells, so this
 * is normally absent and the period ESTIMATE stays in charge - which is the correct reading.
 */
function parseWithheldTax(trade: JsonObject): number | undefined {
  const amounts = asObject(trade['trade_transaction_amounts']);
  const tax = amounts ? toFiniteNumber(amounts['tax_amount']) : null;
  return tax !== null && tax > 0 ? round2(tax) : undefined;
}

/**
 * Map one detail payload onto a BrokerTrade, or return the reason it cannot be one.
 *
 * 'average_price' is the broker's own per-unit figure for what was paid (measured on a savings
 * plan: 64.501372 shares at 10.93, total_amount 705), so it is what the cost basis gets. The fee
 * travels SEPARATELY on purpose: the ledger adds it to a buy's cost basis exactly once, and
 * subtracts it from a sell's proceeds, which is what 'fees' means on AssetTransaction.
 */
function mapDetail(row: JsonObject, detail: JsonObject, securityTrade: JsonObject): BrokerTrade | { reason: string } {
  const sourceRef = readString(row, 'id') as string;
  const label = readString(row, 'description') ?? readString(detail, 'security.name') ?? sourceRef;
  const date = parseBrokerDate(readString(row, 'last_event_datetime', 'lastEventDatetime'));
  if (!date) return { reason: 'Data operazione non leggibile: operazione esclusa.' };

  const side = readString(row, 'side') ?? readString(securityTrade, 'side');
  if (side !== 'BUY' && side !== 'SELL') {
    return { reason: 'Lato dell’ordine non riconosciuto (' + (side ?? 'sconosciuto') + ').' };
  }

  const quantity = readNumber(securityTrade, 'number_of_shares.filled') ?? readNumber(row, 'quantity');
  if (quantity === null || quantity <= 0) {
    return { reason: 'Nessuna quantita regolata: operazione esclusa.' };
  }

  const pricePerUnit = readNumber(securityTrade, 'average_price') ?? readNumber(row, 'limit_price');
  if (pricePerUnit === null || pricePerUnit <= 0) {
    return { reason: 'Prezzo unitario non leggibile: operazione esclusa.' };
  }

  const currency = readString(row, 'currency') ?? 'EUR';
  const fees = parseFees(securityTrade);
  const withheldTax = side === 'SELL' ? parseWithheldTax(securityTrade) : undefined;
  const isin = readString(detail, 'security.isin') ?? readString(row, 'isin');

  return {
    sourceRef,
    source: 'scalable',
    type: side === 'SELL' ? 'sell' : 'buy',
    ...(isin ? { isin: isin.toUpperCase() } : {}),
    label,
    date,
    quantity,
    pricePerUnit,
    currency,
    ...(fees !== undefined ? { fees } : {}),
    ...(withheldTax !== undefined ? { withheldTax } : {}),
  };
}

/**
 * Parse the trade history: the 'transactions' list PLUS the already-fetched per-trade details,
 * joined on 'id'.
 *
 * 'detailsById' is a map rather than a list because the caller's details are keyed by the id it
 * asked for. A detail that did not arrive is NOT a zero-quantity trade but a row that cannot be
 * verified: it is skipped with a reason, never imported on the list row's cash amount alone.
 */
export function parseScalableTrades(listPayload: unknown, detailsById: ReadonlyMap<string, unknown>): BrokerTradeParseResult {
  const { rows, skipped } = parseListPayload(listPayload);
  const trades: BrokerTrade[] = [];

  for (const row of rows) {
    const sourceRef = readString(row, 'id') as string;
    const label = readString(row, 'description') ?? sourceRef;
    const date = parseBrokerDate(readString(row, 'last_event_datetime', 'lastEventDatetime'));

    const detail = asObject(detailsById.get(sourceRef));
    if (!detail) {
      skipped.push({ sourceRef, label, ...(date ? { date } : {}), reason: 'Dettaglio dell’operazione non disponibile: sara riletto al prossimo sync.' });
      continue;
    }

    const security = asObject(detail['security_trade']) ?? asObject(detail['securityTrade']);
    if (!security) {
      skipped.push({ sourceRef, label, ...(date ? { date } : {}), reason: 'Dettaglio senza dati di negoziazione: operazione esclusa.' });
      continue;
    }

    const mapped = mapDetail(row, detail, security);
    if ('reason' in mapped) {
      skipped.push({ sourceRef, label, ...(date ? { date } : {}), reason: mapped.reason });
      continue;
    }
    trades.push(mapped);
  }

  return { trades: sortBrokerTrades(dedupeBrokerTrades(trades)), skipped };
}
