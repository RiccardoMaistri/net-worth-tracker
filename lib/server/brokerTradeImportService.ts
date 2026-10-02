import 'server-only';
import { getUserAssetsAdmin, getAssetTransactionsAdmin } from '@/lib/server/assetAdminRepository';
import { createAssetTransaction, DuplicateBrokerTradeError } from '@/lib/server/assetTransactionUseCase';
import { buildBrokerTradePlan, brokerTradeKey, type BrokerTradePlan } from '@/lib/utils/brokerTradePlan';
import { parseScalableTrades } from '@/lib/utils/scalableTradeImport';
import { parseTradeRepublicTrades } from '@/lib/utils/tradeRepublicTradeImport';
import type { BrokerTrade } from '@/lib/utils/brokerTrade';
import type { AssetTransactionSource } from '@/types/assetTransactions';

/**
 * The broker half of the trade importer: read the broker's history, join it to the ledger, and
 * write what the user approved.
 *
 * WHY THE PLAN IS BUILT SERVER-SIDE, even though the pure planner runs in the browser: the plan's
 * two decisive inputs are the ledger's own state — the assets the user tracks and the trades
 * already holding a broker key. A client-supplied list is an assertion, and a stale browser is the
 * normal case (the preview may sit open for days). Building it here means the skips, the dedupe
 * and the asset join are decided against the same rows the write will read, and the route stays a
 * thin auth+validate+delegate layer per AGENTS.md.
 *
 * WHY THE WRITE STILL GOES THROUGH `createAssetTransaction`: the importer adds no math. A sell must
 * replay the whole asset, resolve FX, settle cash and rewrite the derived fields exactly like a
 * hand-entered trade, and there is one code path that does all of that atomically. A second
 * writer would be a second set of ways to get a position wrong.
 *
 * THE IDEMPOTENCY IS DOUBLE-CHECKED, deliberately. The plan drops rows whose key is already in the
 * ledger (the preview's «già presenti»), and `createAssetTransaction` re-checks the same key
 * inside its transaction (so two concurrent syncs cannot both insert). The first is an
 * optimization; the second is the guarantee, and it is the one that survives a race.
 */

export interface BrokerTradesPayload {
  list: unknown;
  details: Record<string, unknown>;
}

export interface BrokerTradePreview extends BrokerTradePlan {
  /** The broker this plan came from, so the UI labels the preview without tracking it itself. */
  source: AssetTransactionSource;
}

/** A semantic failure the route forwards verbatim, Italian and user-facing. */
export class BrokerTradeImportError extends Error {
  status: number;
  userMessage: string;

  constructor(status: number, userMessage: string) {
    super(userMessage);
    this.name = 'BrokerTradeImportError';
    this.status = status;
    this.userMessage = userMessage;
    Object.setPrototypeOf(this, BrokerTradeImportError.prototype);
  }
}

/** Parse a broker payload into the normalized shape, per broker. Pure parsers, no I/O here. */
function parseBrokerPayload(
  source: AssetTransactionSource,
  payload: BrokerTradesPayload
): { trades: BrokerTrade[]; skipped: BrokerTradePlan['parserSkipped'] } {
  const details = new Map(Object.entries(payload.details));
  const parsed =
    source === 'scalable'
      ? parseScalableTrades(payload.list, details)
      : parseTradeRepublicTrades(payload.list, details);
  return { trades: parsed.trades, skipped: parsed.skipped };
}

/**
 * The asset's OWN baseline, which is the only floor a trade date has.
 *
 * Read from the trades themselves (`isBaseline`), never from `assetTransactionsMeta.baselineDate`:
 * that metadata is the MIGRATION day, shared by every asset, and using it as a floor silently
 * rejected every real trade from before the migration (2026-09-13 made this exact correction).
 * An asset with no baseline accepts any date.
 */
function baselinesByAssetId(
  transactions: readonly { assetId: string; date: Date; isBaseline?: boolean }[]
): Map<string, Date> {
  const baselines = new Map<string, Date>();
  for (const transaction of transactions) {
    if (transaction.isBaseline !== true) continue;
    const current = baselines.get(transaction.assetId);
    if (!current || transaction.date.getTime() < current.getTime()) {
      baselines.set(transaction.assetId, transaction.date);
    }
  }
  return baselines;
}

/**
 * Read the broker history and decide what would be written. NO WRITES — this is the preview.
 *
 * `selected` is the subset of plan rows the user approved, identified by the broker's own id
 * rather than by array position: a re-render between preview and confirm must not shift which row
 * an index points at.
 */
export async function buildBrokerTradePreview(
  ownerId: string,
  source: AssetTransactionSource,
  payload: BrokerTradesPayload
): Promise<BrokerTradePreview> {
  const [assets, transactions] = await Promise.all([
    getUserAssetsAdmin(ownerId),
    getAssetTransactionsAdmin(ownerId),
  ]);
  const { trades, skipped } = parseBrokerPayload(source, payload);
  const plan = buildBrokerTradePlan({
    trades,
    parserSkipped: skipped,
    assets,
    existingTransactions: transactions,
    baselineByAssetId: baselinesByAssetId(transactions),
  });
  return { ...plan, source };
}

export interface BrokerTradeImportResult {
  imported: number;
  /** Rows the atomic idempotency check caught as already present: a concurrent sync won the race. */
  duplicates: number;
  /** Rows that could not be written, each with the ledger's own Italian message. */
  failed: { sourceRef: string; message: string }[];
  /** Realized P&L per written SELL, so the UI can report what the import moved. */
  realizedPnlEur: number;
}

/**
 * Write the approved rows, one at a time, each through the full ledger mutation.
 *
 * ONE ROW PER TRANSACTION, not one transaction for the batch, and that is forced by the engine: a
 * sell's realized P&L comes from a replay of the whole asset, and the derived quantity/PMC written
 * to `assets/{id}` is the result of that replay. Batching would have to interleave two assets'
 * replays into a single commit, which is the exact class of bug the use case exists to prevent.
 * The order is the plan's own (chronological), so a buy is written before the sell that consumes
 * it and the replay never sees a sell without its lots.
 *
 * PER-ROW CONTINUATION, never all-or-nothing: a historical sell whose lots predate the baseline is
 * rejected by the engine (a 422), and losing the other forty valid operations to it would make the
 * feature useless on exactly the accounts that need it most. Every failure is collected and
 * returned, so the user is told which row failed and why, and the successful rows stay written —
 * which is safe precisely because the import is idempotent: re-running writes only what is missing.
 *
 * `linkedCashAssetId` is NEVER set. The broker's cash account is an asset the sync may not have
 * created, and moving the user's balance is not something an import of trade history may decide.
 * A cash settlement stays a per-row choice in the trade dialog.
 */
export async function importBrokerTrades(
  ownerId: string,
  source: AssetTransactionSource,
  payload: BrokerTradesPayload,
  selectedSourceRefs: readonly string[]
): Promise<BrokerTradeImportResult> {
  const preview = await buildBrokerTradePreview(ownerId, source, payload);
  const approved = new Set(selectedSourceRefs);
  const rows = preview.toImport.filter((row) => approved.has(row.trade.sourceRef));

  const result: BrokerTradeImportResult = { imported: 0, duplicates: 0, failed: [], realizedPnlEur: 0 };
  for (const row of rows) {
    const { trade, assetId } = row;
    if (!assetId) {
      result.failed.push({ sourceRef: trade.sourceRef, message: 'Asset non associato: operazione esclusa.' });
      continue;
    }
    try {
      const written = await createAssetTransaction(ownerId, {
        assetId,
        type: trade.type,
        date: trade.date,
        quantity: trade.quantity,
        pricePerUnit: trade.pricePerUnit,
        fees: trade.fees,
        // The tax the broker withheld travels only on a sell, and only when the broker REPORTED
        // one: absent, the period tax ESTIMATE in Rendimenti stands, which is the correct reading
        // for a retail sale where nothing was withheld (measured: both brokers report no tax).
        ...(trade.type === 'sell' && trade.withheldTax !== undefined
          ? { withheldTaxEur: trade.withheldTax }
          : {}),
        source: trade.source,
        sourceRef: trade.sourceRef,
      });
      result.imported += 1;
      if (written.realizedPnlEur !== undefined) {
        result.realizedPnlEur += written.realizedPnlEur;
      }
    } catch (error) {
      if (error instanceof DuplicateBrokerTradeError) {
        result.duplicates += 1;
        continue;
      }
      const message =
        error instanceof Error && error.message !== ''
          ? error.message
          : 'Operazione non riuscita: riprova.';
      result.failed.push({ sourceRef: trade.sourceRef, message });
    }
  }
  return result;
}

/** Exported for the route's own checks: the key an imported trade is stored under. */
export { brokerTradeKey };
