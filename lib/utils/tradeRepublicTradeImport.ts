/**
 * Trade Republic broker TRADES - the pure layer, sibling to 'scalableTradeImport.ts'.
 *
 * TWO READS, JOINED ON ONE ID, and the join is the whole design here.
 *
 * 1. 'timelineTransactions' (the raw reader, NOT 'account.transactions.read') gives one row per
 *    event with NO trade math: id, timestamp, title, subtitle ('Sell Order' / 'Buy Order'), amount
 *    (the cash side), eventType, icon ('logos/<ISIN>/v2'), action.payload (the detail id).
 * 2. 'timelineDetailV2' on that payload gives the money: an Overview table whose rows are
 *    { title, detail: { text } } - 'Transaction' ('4.027288 x EUR 941.40'), 'Fee', 'Total', and a
 *    header whose action.payload IS the ISIN.
 *
 * Why both, given the detail is richer: the timeline is the ONLY read that answers «every trade,
 * ever» (1,408 rows, materialised from 2024-03-28) and is the only one that names the side. The
 * detail is the only one that carries a quantity and a unit price. Neither alone is importable.
 *
 * TWO MEASURED FACTS THAT SHAPED THE PARSING, both invisible in the docs:
 * - The side is 'subtitle', NOT 'counterparty'. The SDK's normalized reader exposes counterparty,
 *   but it ABORTS on this payload (below), so the raw row is what gets parsed and it has no
 *   counterparty field at all. Filtering on counterparty silently matched ZERO sells when tried.
 * - 'account.transactions.read' throws 'Invalid response for Topic timelineTransactions': the
 *   SDK's arktype schema does not model a 'presentation' field the broker now sends, and one
 *   unknown key fails the whole response. The raw 'getTimelineTransactions' is unaffected, so
 *   the importer reads through that. Do not 'fix' this by reaching for the typed reader.
 *
 * NO WITHHELD TAX HERE, unlike Scalable: the detail has no such field at all (measured on 11
 * sells). Trade Republic withholds nothing on a retail sale, so the period ESTIMATE stays in
 * charge - which is the correct reading, and inventing a zero would instead suppress it.
 *
 * Pure: no I/O, no 'server-only'. It takes already-fetched payloads.
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

function readString(source: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * The ISIN, which the broker hides inside a logo path: 'logos/US5951121038/v2'.
 *
 * It is ALSO on the detail's header action.payload, and the header is preferred because a logo
 * path is presentation - a theme or a missing avatar could change its shape without the security
 * changing. The logo is the fallback so a detail that fails to parse still joins to an asset
 * instead of landing in «asset not found» for a reason that has nothing to do with the asset.
 *
 * An ISIN is 12 chars, two letters then 10 alphanumerics: a path segment longer than that is a
 * theme name, not a security, and would otherwise create a phantom ISIN.
 */
const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{10}$/;

function isinFromLogo(icon: unknown): string | undefined {
  if (typeof icon !== 'string') return undefined;
  const segment = icon.split('/').find((part) => ISIN_PATTERN.test(part.toUpperCase()));
  return segment?.toUpperCase();
}

function isinFromDetail(detail: JsonObject): string | undefined {
  for (const section of asArray(detail['sections'])) {
    const node = asObject(section);
    if (!node) continue;
    const action = asObject(node['action']);
    const payload = readString(action ?? {}, 'payload')?.toUpperCase();
    if (payload && ISIN_PATTERN.test(payload)) return payload;
  }
  return undefined;
}

/**
 * Find an Overview row by its title, returning its display text.
 *
 * The detail is a table of { title, detail } cells and the numbers live in a NESTED displayValue
 * on some rows and in plain 'text' on others, so both are read. Matching is on an exact title
 * because 'Total' and 'Transaction' are distinct rows and reading the wrong one would import a
 * quantity as a price.
 */
function readOverviewCell(detail: JsonObject, title: string): string | undefined {
  for (const section of asArray(detail['sections'])) {
    const node = asObject(section);
    if (!node) continue;
    for (const cell of asArray(node['data'])) {
      const entry = asObject(cell);
      if (!entry || readString(entry, 'title') !== title) continue;
      const cellDetail = asObject(entry['detail']);
      if (!cellDetail) continue;
      const display = asObject(cellDetail['displayValue']);
      const text = readString(cellDetail, 'text') ?? readString(display ?? {}, 'text') ?? readString(display ?? {}, 'prefix');
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * The unit price and the quantity, out of the 'Transaction' cell.
 *
 * The cell reads '4.027288 x EUR 941.40' - the quantity is a FRACTIONAL figure (fractional
 * shares are normal at Trade Republic, so rounding it would change the position), and the LAST
 * number is the unit price. The nested 'displayValue.prefix' carries the same '4.027288 x ' shape,
 * so both the plain text and the prefix are tried: some rows put the quantity only in one of them.
 *
 * Returned separately because the price must be read with the currency stripped and the quantity
 * must not: 'toFiniteNumber' would take the FIRST number, which here is always the quantity.
 */
function readQuantityAndPrice(detail: JsonObject): { quantity: number; pricePerUnit: number } | null {
  const cell = readOverviewCell(detail, 'Transaction') ?? readOverviewCell(detail, 'Share price');
  if (!cell) return null;
  // Matches '4.027288 x EUR 941.40' and the bare 'EUR 941.40' of a Share-price-only cell.
  const parts = cell.match(/[\d.,\s]+/g) ?? [];
  const numbers = parts.map(toFiniteNumber).filter((value): value is number => value !== null && value > 0);
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return null;
  return { quantity: numbers[0], pricePerUnit: numbers[numbers.length - 1] };
}

/**
 * The commission, in EUR.
 *
 * 'Fee' is a flat EUR amount on every measured sell (1.00 on a 3,790.29 sale), so it is read as a
 * money figure and never derived from a rate. Absent on a row without the cell, which is not a
 * zero fee claim - it means the broker did not report one, and the ledger then has no fee to add
 * to the cost basis.
 */
function parseFees(detail: JsonObject): number | undefined {
  const fee = toFiniteNumber(readOverviewCell(detail, 'Fee'));
  return fee !== null && fee > 0 ? Math.round((fee + Number.EPSILON) * 100) / 100 : undefined;
}

/**
 * The cash the trade settled for, which is the SIGN that a sell is a sell.
 *
 * A SELL row's amount is POSITIVE on the timeline (measured: +3,790.29 on the Micron sale, the
 * word 'received' in the detail header), so the sign cannot be read from it. The side comes from
 * 'subtitle' and this is only used to reject a row whose amount contradicts it - a row that says
 * 'Sell Order' but moves money IN is not a trade this importer may write.
 */
function readCashAmount(row: JsonObject): number | null {
  const amount = asObject(row['amount']);
  return amount ? toFiniteNumber(amount['value']) : null;
}

/**
 * The event types that can be a trade. Everything else on the timeline is cash, card, interest or
 * a plan invoice - none of which has a lot, a cost basis, or a place in the ledger.
 */
const TRADE_EVENT_TYPES = new Set([
  'TRADING_TRADE_EXECUTED',
  'TRADING_SAVINGSPLAN_EXECUTED',
  'SAVINGS_PLAN_EXECUTION_FAILED',
  'TRADING_SAVINGSPLAN_EXECUTION_FAILED',
]);

/** A failed plan execution is an intention, never a fact: it has no shares and never will. */
const FAILED_EVENT_TYPES = new Set([
  'SAVINGS_PLAN_EXECUTION_FAILED',
  'TRADING_SAVINGSPLAN_EXECUTION_FAILED',
]);

function sideFromSubtitle(subtitle: unknown): 'buy' | 'sell' | null {
  if (typeof subtitle !== 'string') return null;
  // The broker localizes this field with the app/session language. The live Italian account has
  // emitted English and German labels across its historical archive, so recognizing only
  // "Buy Order" / "Sell Order" discarded genuine executions from the same account.
  if (/sell|verkauf|vendita/i.test(subtitle)) return 'sell';
  if (/buy|kauf|acquist|sparplan|savings\s*plan/i.test(subtitle)) return 'buy';
  return null;
}

function mapTrade(row: JsonObject, detail: JsonObject, side: 'buy' | 'sell'): BrokerTrade | { reason: string } {
  const sourceRef = readString(row, 'id') as string;
  const label = readString(row, 'title') ?? sourceRef;
  const date = parseBrokerDate(readString(row, 'timestamp'));
  if (!date) return { reason: 'Data operazione non leggibile: operazione esclusa.' };

  const figures = readQuantityAndPrice(detail);
  if (!figures) {
    return { reason: 'Dettaglio senza quantita o prezzo: operazione esclusa.' };
  }

  const amount = asObject(row['amount']);
  const currency = (amount && readString(amount, 'currency')) || 'EUR';
  const fees = parseFees(detail);
  const isin = isinFromDetail(detail) ?? isinFromLogo(row['icon']);

  return {
    sourceRef,
    source: 'traderepublic',
    type: side,
    ...(isin ? { isin } : {}),
    label,
    date,
    quantity: figures.quantity,
    pricePerUnit: figures.pricePerUnit,
    currency,
    ...(fees !== undefined ? { fees } : {}),
  };
}

/**
 * Parse the Trade Republic trade history: the raw timeline PLUS the already-fetched per-trade
 * details, joined on the row's action.payload (which is the id the detail topic answers).
 *
 * 'detailsByPayload' is a map because the caller's details are keyed by the payload it asked for.
 * A missing detail is skipped WITH A REASON rather than imported on the timeline's cash amount:
 * the amount is the proceeds, and writing it as a unit price would invent a position.
 */
export function parseTradeRepublicTrades(timeline: unknown, detailsByPayload: ReadonlyMap<string, unknown>): BrokerTradeParseResult {
  const root = asObject(timeline);
  const items = asArray(root?.['items'] ?? timeline);
  const skipped: SkippedBrokerTrade[] = [];
  const trades: BrokerTrade[] = [];

  for (const raw of items) {
    const row = asObject(raw);
    if (!row) continue;
    const eventType = readString(row, 'eventType');
    if (!eventType || !TRADE_EVENT_TYPES.has(eventType)) continue;

    const sourceRef = readString(row, 'id');
    if (!sourceRef) continue;
    const label = readString(row, 'title') ?? sourceRef;
    const date = parseBrokerDate(readString(row, 'timestamp'));

    if (FAILED_EVENT_TYPES.has(eventType)) {
      skipped.push({ sourceRef, label, ...(date ? { date } : {}), reason: 'Piano di accumulo non eseguito: nessun titolo acquistato.' });
      continue;
    }

    const side = sideFromSubtitle(readString(row, 'subtitle'));
    if (!side) {
      skipped.push({ sourceRef, label, ...(date ? { date } : {}), reason: 'Lato dell’ordine non riconosciuto: operazione esclusa.' });
      continue;
    }

    // A sell CREDITS the account, so its amount is positive (measured on all 11 sells). A row
    // whose cash moves the other way than its side claims is not something this may write.
    const amount = readCashAmount(row);
    if (amount !== null && ((side === 'sell' && amount < 0) || (side === 'buy' && amount > 0))) {
      skipped.push({ sourceRef, label, ...(date ? { date } : {}), reason: 'Importo e lato dell’ordine discordanti: operazione esclusa.' });
      continue;
    }

    const payload = readString(asObject(row['action']) ?? {}, 'payload') ?? sourceRef;
    const detail = asObject(detailsByPayload.get(payload));
    if (!detail) {
      skipped.push({ sourceRef, label, ...(date ? { date } : {}), reason: 'Dettaglio dell’operazione non disponibile: riprova l’importazione.' });
      continue;
    }

    const mapped = mapTrade(row, detail, side);
    if ('reason' in mapped) {
      skipped.push({ sourceRef, label, ...(date ? { date } : {}), reason: mapped.reason });
      continue;
    }
    trades.push(mapped);
  }

  return { trades: sortBrokerTrades(dedupeBrokerTrades(trades)), skipped };
}
