/**
 * OKX read-only bridge — the pure layer behind the POC route and `scripts/okxPoc.mts`.
 *
 * Same shape as `binanceImport.ts` (tolerant parse → aggregation → totals, no I/O), with the
 * differences the OKX wire imposes:
 *
 * 1. **OKX ALREADY KNOWS THE COST BASIS.** `/api/v5/account/balance` returns, per currency:
 *    `openAvgPx` / `spotUpl` / `spotUplRatio` (the AVERAGE cost method) and
 *    `accAvgPx` / `totalPnl` / `totalPnlRatio` (the CUMULATIVE cost method), plus `spotBal`, the
 *    net buying amount both refer to. OKX's own article («Spot cost price») is the source: the
 *    two methods price the same holding, so **`totalPnl` is NOT realized P&L** and
 *    `totalPnl − spotUpl` must never be printed as profit taken. The app's own rule is average
 *    cost (`averageCostEur`), so the headline fields are the `openAvgPx`/`spotUpl` pair; the
 *    cumulative pair travels beside it for comparison.
 * 2. **STABLECOINS AND FIAT CARRY NO COST PRICE.** OKX excludes them from the spot cost price
 *    calculation, so their P&L fields are empty. That is a fact about the product, not a missing
 *    read: it is not a warning.
 * 3. **THE FUNDING ACCOUNT HAS QUANTITIES, NOT VALUES.** `/api/v5/asset/balances` returns
 *    `{ ccy, bal, availBal, frozenBal }` and nothing in USD, so a funding coin is priced from the
 *    public spot tickers. A coin no pair reaches stays UNPRICED and is named, never valued at 0.
 * 4. **A DERIVATIVE IS A POSITION, NOT AN ASSET.** A SWAP/futures position is not a coin the app
 *    can track; its `upl` (unrealized P&L, USD) is reported in its own section and is never merged
 *    into a coin's quantity.
 *
 * The POC computes no cost basis and writes nothing: the app's P&L is value − the ledger's
 * `averageCostEur`, so this layer only states what OKX reports.
 */

export class OkxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OkxParseError';
  }
}

/** A stablecoin or fiat balance OKX values but excludes from the spot cost price. */
const STABLE_OR_FIAT = new Set(['USD', 'USDT', 'USDC', 'DAI', 'FDUSD', 'EUR']);
/** Coins worth 1 USD when no pair reaches them. EUR is NOT here: its USD price is the FX rate. */
const USD_PEGGED = new Set(['USD', 'USDT', 'USDC', 'DAI', 'FDUSD']);

/** OKX sends every amount as a decimal STRING (`"0.03127829"`); `""` means «not applicable». */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept the endpoint's `data` array, an envelope around it, or a single row. */
function asRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload['data'])) return payload['data'];
  if (isRecord(payload)) return [payload];
  throw new OkxParseError('Risposta OKX non riconosciuta: nessun elenco di righe.');
}

// ─── Tolerant readers ────────────────────────────────────────────────────────

export interface OkxBalanceDetail {
  ccy: string;
  /** Coin units in the trading account (`cashBal`), else the spot net buying amount. */
  quantity: number;
  /** OKX's `spotBal`: the net buying amount `openAvgPx` and `accAvgPx` refer to. */
  spotBalance: number | null;
  /** Equity in USD (`eqUsd`), OKX's own mark value. */
  equityUsd: number | null;
  /** AVERAGE cost method: `openAvgPx`, in USD. */
  averageCostPriceUsd: number | null;
  /** AVERAGE cost method: `spotUpl`, unrealized P&L in USD. */
  averageCostPnlUsd: number | null;
  /** AVERAGE cost method: `spotUplRatio`, a fraction (0.1 = 10%). */
  averageCostPnlRatio: number | null;
  /** CUMULATIVE cost method: `accAvgPx`, in USD. */
  cumulativeCostPriceUsd: number | null;
  /** CUMULATIVE cost method: `totalPnl`, in USD. NOT realized P&L. */
  cumulativeCostPnlUsd: number | null;
  /** CUMULATIVE cost method: `totalPnlRatio`, a fraction. */
  cumulativeCostPnlRatio: number | null;
}

export interface OkxBalanceSnapshot {
  details: OkxBalanceDetail[];
  /** OKX's account-level `totalEq`, in USD (includes derivatives equity). */
  totalEquityUsd: number | null;
}

/** `/api/v5/account/balance` → the per-currency details plus the account's total equity. */
export function parseOkxBalance(payload: unknown): OkxBalanceSnapshot {
  const rows = asRows(payload);
  const account = rows[0];
  if (!isRecord(account)) {
    throw new OkxParseError('Risposta OKX non riconosciuta: manca il conto.');
  }
  if (!Array.isArray(account['details'])) {
    throw new OkxParseError('Risposta OKX non riconosciuta: manca l’elenco delle valute.');
  }

  const details: OkxBalanceDetail[] = [];
  for (const row of account['details']) {
    if (!isRecord(row)) continue;
    const ccy = typeof row['ccy'] === 'string' ? row['ccy'] : '';
    if (!ccy) continue;
    const cashBal = toNumber(row['cashBal']) ?? 0;
    const spotBal = toNumber(row['spotBal']);
    const quantity = cashBal > 0 ? cashBal : (spotBal ?? 0);
    details.push({
      ccy,
      quantity,
      spotBalance: spotBal,
      equityUsd: toNumber(row['eqUsd']),
      averageCostPriceUsd: toNumber(row['openAvgPx']),
      averageCostPnlUsd: toNumber(row['spotUpl']),
      averageCostPnlRatio: toNumber(row['spotUplRatio']),
      cumulativeCostPriceUsd: toNumber(row['accAvgPx']),
      cumulativeCostPnlUsd: toNumber(row['totalPnl']),
      cumulativeCostPnlRatio: toNumber(row['totalPnlRatio']),
    });
  }

  return { details, totalEquityUsd: toNumber(account['totalEq']) };
}

export interface OkxFundingBalance {
  ccy: string;
  quantity: number;
  available: number | null;
}

/** `GET /api/v5/asset/balances` → `{ ccy, bal, availBal, frozenBal }[]`. */
export function parseOkxFundingBalances(payload: unknown): OkxFundingBalance[] {
  const out: OkxFundingBalance[] = [];
  for (const row of asRows(payload)) {
    if (!isRecord(row)) continue;
    const ccy = typeof row['ccy'] === 'string' ? row['ccy'] : '';
    const quantity = toNumber(row['bal']);
    if (!ccy || quantity === null || quantity <= 0) continue;
    out.push({ ccy, quantity, available: toNumber(row['availBal']) });
  }
  return out;
}

export interface OkxSavingsBalance {
  ccy: string;
  /** `amt`: the whole Simple Earn position. `loanAmount` is the part of it that is lent out. */
  amount: number;
  /** `loanAmt` — money lent, not money gone: it is still inside `amount`. */
  loanAmount: number | null;
  /** `pendingAmt` — a purchase or redemption in transit, still inside `amount`. */
  pendingAmount: number | null;
}

/**
 * `GET /api/v5/finance/savings/balance` (Simple Earn) → `{ ccy, amt, loanAmt, pendingAmt }[]`.
 * A zero position is dropped: OKX answers a row for every currency the wallet has ever held.
 */
export function parseOkxSavingsBalances(payload: unknown): OkxSavingsBalance[] {
  const out: OkxSavingsBalance[] = [];
  for (const row of asRows(payload)) {
    if (!isRecord(row)) continue;
    const ccy = typeof row['ccy'] === 'string' ? row['ccy'] : '';
    const amount = toNumber(row['amt']);
    if (!ccy || amount === null || amount <= 0) continue;
    out.push({
      ccy,
      amount,
      loanAmount: toNumber(row['loanAmt']),
      pendingAmount: toNumber(row['pendingAmt']),
    });
  }
  return out;
}

export interface OkxStakingOrder {
  orderId: string;
  ccy: string;
  protocol: string;
  protocolType: string;
  /** `investData[].amt` — the principal, the only figure that may become a quantity. */
  principal: number;
  /** `earningData[].earnings` — ALREADY credited to the funding wallet. Never added to a quantity. */
  earnings: number;
  apy: number | null;
  state: string;
}

/**
 * `GET /api/v5/finance/staking-defi/orders-active` (On-chain Earn) → the active orders.
 *
 * THE EARNINGS ARE NOT PART OF THE POSITION. OKX credits them to the FUNDING wallet, which the
 * funding read already returns: a TRX order of 954.522039 with 0.16065194 of earnings sits beside
 * a funding TRX balance of exactly 0.16065194. Counting them here would count the coin twice.
 */
export function parseOkxStakingOrders(payload: unknown): OkxStakingOrder[] {
  const out: OkxStakingOrder[] = [];
  for (const row of asRows(payload)) {
    if (!isRecord(row)) continue;
    const ccy = typeof row['ccy'] === 'string' ? row['ccy'] : '';
    if (!ccy) continue;
    const invest = Array.isArray(row['investData']) ? row['investData'] : [];
    const earning = Array.isArray(row['earningData']) ? row['earningData'] : [];
    const principal = invest.reduce(
      (sum: number, item: unknown) => (isRecord(item) ? sum + (toNumber(item['amt']) ?? 0) : sum),
      0
    );
    const earnings = earning.reduce(
      (sum: number, item: unknown) => (isRecord(item) ? sum + (toNumber(item['earnings']) ?? 0) : sum),
      0
    );
    if (principal <= 0) continue;
    out.push({
      orderId: typeof row['ordId'] === 'string' ? row['ordId'] : '',
      ccy,
      protocol: typeof row['protocol'] === 'string' ? row['protocol'] : '',
      protocolType: typeof row['protocolType'] === 'string' ? row['protocolType'] : '',
      principal,
      earnings,
      apy: toNumber(row['apy']),
      state: typeof row['state'] === 'string' ? row['state'] : '',
    });
  }
  return out;
}

export interface OkxPosition {
  instId: string;
  instType: string;
  posSide: string;
  /** Contracts (not coin units) for FUTURES / SWAP / OPTION. Signed: a short is negative. */
  quantity: number;
  averagePrice: number | null;
  markPrice: number | null;
  notionalUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlRatio: number | null;
  leverage: number | null;
  marginMode: string;
}

/** `GET /api/v5/account/positions` → open positions, each with OKX's own `upl`. */
export function parseOkxPositions(payload: unknown): OkxPosition[] {
  const out: OkxPosition[] = [];
  for (const row of asRows(payload)) {
    if (!isRecord(row)) continue;
    const instId = typeof row['instId'] === 'string' ? row['instId'] : '';
    if (!instId) continue;
    out.push({
      instId,
      instType: typeof row['instType'] === 'string' ? row['instType'] : '',
      posSide: typeof row['posSide'] === 'string' ? row['posSide'] : '',
      quantity: toNumber(row['pos']) ?? 0,
      averagePrice: toNumber(row['avgPx']),
      markPrice: toNumber(row['markPx']),
      notionalUsd: toNumber(row['notionalUsd']),
      unrealizedPnlUsd: toNumber(row['upl']),
      unrealizedPnlRatio: toNumber(row['uplRatio']),
      leverage: toNumber(row['lever']),
      marginMode: typeof row['mgnMode'] === 'string' ? row['mgnMode'] : '',
    });
  }
  return out;
}

/** `GET /api/v5/market/tickers?instType=SPOT` → `instId → last`, ignoring unusable rows. */
export function parseOkxTickers(payload: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of asRows(payload)) {
    if (!isRecord(row)) continue;
    const instId = typeof row['instId'] === 'string' ? row['instId'] : '';
    const last = toNumber(row['last']);
    if (instId && last !== null && last > 0) out[instId] = last;
  }
  return out;
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

/**
 * A coin's USD price from the spot tickers. Order: `<COIN>-USDT`, `<COIN>-USDC`, `<COIN>-USD`,
 * then `<COIN>-EUR` converted through `usdEur`. EUR itself is the FX rate — a funding euro is
 * worth 1 EUR, so its USD price is `1 / usdEur`, never 1 USD. A stablecoin with no pair is 1 USD.
 */
export function resolveOkxUsdPrice(
  ccy: string,
  tickers: Record<string, number>,
  usdEur: number | null
): number | null {
  if (tickers[`${ccy}-USDT`]) return tickers[`${ccy}-USDT`];
  if (tickers[`${ccy}-USDC`]) return tickers[`${ccy}-USDC`];
  if (tickers[`${ccy}-USD`]) return tickers[`${ccy}-USD`];
  const eur = tickers[`${ccy}-EUR`];
  // usdEur is EUR per USD: a EUR price in USD is the EUR price divided by it.
  if (eur && usdEur && usdEur > 0) return eur / usdEur;
  if (ccy === 'EUR') return usdEur && usdEur > 0 ? 1 / usdEur : null;
  if (USD_PEGGED.has(ccy)) return 1;
  return null;
}

// ─── Portfolio ───────────────────────────────────────────────────────────────

export type OkxWallet = 'trading' | 'funding' | 'savings' | 'earn';

export interface OkxHolding {
  ccy: string;
  quantity: number;
  quantityTrading: number;
  quantityFunding: number;
  /** Simple Earn position (`amt`), a wallet of its own, not part of the funding balance. */
  quantitySavings: number;
  /** On-chain Earn PRINCIPAL — never its earnings, which are already in the funding wallet. */
  quantityEarn: number;
  wallets: OkxWallet[];
  /** OKX's `eqUsd` for the trading part, the ticker's value for every other wallet. */
  valueUsd: number | null;
  valueEur: number | null;
  tradingValueUsd: number | null;
  fundingValueUsd: number | null;
  savingsValueUsd: number | null;
  earnValueUsd: number | null;
  priceUsd: number | null;
  /** AVERAGE cost method, the app's basis. */
  averageCostPriceUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlEur: number | null;
  unrealizedPnlRatio: number | null;
  /** CUMULATIVE cost method — beside the average one, never added to it. */
  cumulativeCostPnlUsd: number | null;
  /** True for a coin OKX excludes from the spot cost price: an empty P&L is a product fact. */
  costPriceExcluded: boolean;
}

export interface OkxPortfolioTotals {
  /** OKX's account-level `totalEq`, in USD (the TRADING account; the other wallets are separate). */
  accountEquityUsd: number | null;
  tradingValueUsd: number;
  fundingValueUsd: number;
  savingsValueUsd: number;
  earnValueUsd: number;
  holdingsValueUsd: number;
  holdingsValueEur: number | null;
  /**
   * Sum of the holdings' AVERAGE-cost spot P&L (`spotUpl`). `null` when NO holding reports one:
   * an account OKX keeps out of spot mode has no cost basis at all, and a total of zero would
   * read as «in pari» instead of «non misurato».
   */
  unrealizedPnlUsd: number | null;
  unrealizedPnlEur: number | null;
  /** Notional and unrealized P&L of the open derivatives, kept apart from the holdings. */
  derivativesNotionalUsd: number;
  derivativesUnrealizedPnlUsd: number;
  /** Coins whose funding balance no ticker reaches: named, never valued at 0. */
  unpriced: string[];
  /** Non-stable coins whose spot P&L OKX did not return: named, never counted as zero P&L. */
  pnlUnavailable: string[];
}

export interface OkxPortfolio {
  holdings: OkxHolding[];
  positions: OkxPosition[];
  totals: OkxPortfolioTotals;
  warnings: string[];
}

export interface OkxPortfolioInput {
  balance: OkxBalanceSnapshot;
  funding: OkxFundingBalance[];
  /** Simple Earn positions. `[]` when the read failed: the caller names it in its warnings. */
  savings: OkxSavingsBalance[];
  /** Active On-chain Earn orders. `[]` when the read failed. */
  staking: OkxStakingOrder[];
  positions: OkxPosition[];
  tickers: Record<string, number>;
  /** EUR per USD. `null` when the FX read failed: every EUR figure is then `null`, never a guess. */
  usdEur: number | null;
}

const EPS = 1e-12;

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Merge the trading and funding wallets per coin (two places a coin sits, never two positions),
 * price both, and keep the P&L OKX reports. A quantity of 0 after merging is dropped.
 */
export function buildOkxPortfolio(input: OkxPortfolioInput): OkxPortfolio {
  const warnings: string[] = [];
  const byCcy = new Map<
    string,
    {
      trading?: OkxBalanceDetail;
      funding?: OkxFundingBalance;
      savings?: OkxSavingsBalance;
      /** On-chain Earn principal, aggregated: one coin can sit in several orders. */
      earn?: number;
    }
  >();

  for (const detail of input.balance.details) {
    if (detail.quantity <= EPS) continue;
    byCcy.set(detail.ccy, { ...(byCcy.get(detail.ccy) ?? {}), trading: detail });
  }
  for (const funding of input.funding) {
    if (funding.quantity <= EPS) continue;
    byCcy.set(funding.ccy, { ...(byCcy.get(funding.ccy) ?? {}), funding });
  }
  for (const savings of input.savings) {
    if (savings.amount <= EPS) continue;
    byCcy.set(savings.ccy, { ...(byCcy.get(savings.ccy) ?? {}), savings });
  }
  for (const order of input.staking) {
    if (order.principal <= EPS) continue;
    const previous = byCcy.get(order.ccy) ?? {};
    byCcy.set(order.ccy, { ...previous, earn: (previous.earn ?? 0) + order.principal });
  }

  const unpriced: string[] = [];
  const pnlUnavailable: string[] = [];
  const holdings: OkxHolding[] = [];

  for (const [ccy, wallets] of byCcy) {
    const quantityTrading = wallets.trading?.quantity ?? 0;
    const quantityFunding = wallets.funding?.quantity ?? 0;
    const quantitySavings = wallets.savings?.amount ?? 0;
    const quantityEarn = wallets.earn ?? 0;
    const quantity = quantityTrading + quantityFunding + quantitySavings + quantityEarn;
    if (quantity <= EPS) continue;

    const tickerPrice = resolveOkxUsdPrice(ccy, input.tickers, input.usdEur);
    const fundingValueUsd =
      wallets.funding !== undefined && tickerPrice !== null
        ? wallets.funding.quantity * tickerPrice
        : null;
    const savingsValueUsd =
      wallets.savings !== undefined && tickerPrice !== null
        ? wallets.savings.amount * tickerPrice
        : null;
    const earnValueUsd =
      wallets.earn !== undefined && tickerPrice !== null ? wallets.earn * tickerPrice : null;
    const tradingValueUsd =
      wallets.trading?.equityUsd !== null && wallets.trading?.equityUsd !== undefined
        ? wallets.trading.equityUsd
        : quantityTrading > 0 && tickerPrice !== null
          ? quantityTrading * tickerPrice
          : null;

    const pricedParts = [tradingValueUsd, fundingValueUsd, savingsValueUsd, earnValueUsd].filter(
      (part): part is number => part !== null
    );
    // A wallet that could not be priced keeps its quantity and is NAMED: the known part is still
    // shown, because hiding it under a dash would make the table lie about a real holding.
    const unpricedPart =
      (quantityTrading > EPS && tradingValueUsd === null) ||
      (quantityFunding > EPS && fundingValueUsd === null) ||
      (quantitySavings > EPS && savingsValueUsd === null) ||
      (quantityEarn > EPS && earnValueUsd === null);
    const valueUsd =
      pricedParts.length > 0 ? pricedParts.reduce((sum, part) => sum + part, 0) : null;

    const priceUsd =
      tickerPrice ?? (valueUsd !== null && quantity > 0 ? round6(valueUsd / quantity) : null);

    if (valueUsd === null || unpricedPart) unpriced.push(ccy);

    const costPriceExcluded = STABLE_OR_FIAT.has(ccy);
    const unrealizedPnlUsd = wallets.trading?.averageCostPnlUsd ?? null;
    if (unrealizedPnlUsd === null && !costPriceExcluded && wallets.trading) pnlUnavailable.push(ccy);

    const walletsHeld: OkxWallet[] = [];
    if (quantityTrading > EPS) walletsHeld.push('trading');
    if (quantityFunding > EPS) walletsHeld.push('funding');
    if (quantitySavings > EPS) walletsHeld.push('savings');
    if (quantityEarn > EPS) walletsHeld.push('earn');

    holdings.push({
      ccy,
      quantity,
      quantityTrading,
      quantityFunding,
      quantitySavings,
      quantityEarn,
      wallets: walletsHeld,
      valueUsd,
      valueEur: valueUsd !== null && input.usdEur !== null ? valueUsd * input.usdEur : null,
      tradingValueUsd,
      fundingValueUsd,
      savingsValueUsd,
      earnValueUsd,
      priceUsd,
      averageCostPriceUsd: wallets.trading?.averageCostPriceUsd ?? null,
      unrealizedPnlUsd,
      unrealizedPnlEur:
        unrealizedPnlUsd !== null && input.usdEur !== null ? unrealizedPnlUsd * input.usdEur : null,
      unrealizedPnlRatio: wallets.trading?.averageCostPnlRatio ?? null,
      cumulativeCostPnlUsd: wallets.trading?.cumulativeCostPnlUsd ?? null,
      costPriceExcluded,
    });
  }

  holdings.sort((a, b) => {
    const av = a.valueUsd ?? -1;
    const bv = b.valueUsd ?? -1;
    if (bv !== av) return bv - av;
    return a.ccy.localeCompare(b.ccy);
  });

  let tradingValueUsd = 0;
  let fundingValueUsd = 0;
  let savingsValueUsd = 0;
  let earnValueUsd = 0;
  let pnlTracked = 0;
  let pnlTotalUsd = 0;
  for (const holding of holdings) {
    tradingValueUsd += holding.tradingValueUsd ?? 0;
    fundingValueUsd += holding.fundingValueUsd ?? 0;
    savingsValueUsd += holding.savingsValueUsd ?? 0;
    earnValueUsd += holding.earnValueUsd ?? 0;
    if (holding.unrealizedPnlUsd !== null) {
      pnlTracked += 1;
      pnlTotalUsd += holding.unrealizedPnlUsd;
    }
  }

  const holdingsValueUsd = holdings.reduce((sum, holding) => sum + (holding.valueUsd ?? 0), 0);
  const derivativesNotionalUsd = input.positions.reduce(
    (sum, position) => sum + (position.notionalUsd ?? 0),
    0
  );
  const derivativesUnrealizedPnlUsd = input.positions.reduce(
    (sum, position) => sum + (position.unrealizedPnlUsd ?? 0),
    0
  );

  if (unpriced.length > 0) {
    warnings.push(
      `Prezzo USD mancante per ${unpriced.join(', ')}: la parte non prezzata resta fuori dal valore, non è zero.`
    );
  }
  if (pnlUnavailable.length > 0) {
    warnings.push(
      `OKX non riporta il P/L spot di ${pnlUnavailable.join(', ')}: non viene contato come 0.`
    );
  }
  if (input.usdEur === null) {
    warnings.push('Cambio USD→EUR non disponibile: le cifre in euro sono assenti, non stimate.');
  }
  if (input.balance.totalEquityUsd !== null) {
    // The residual is measured against the TRADING account only: OKX's `totalEq` covers that
    // account (and its derivatives equity), NOT the funding, Simple Earn and On-chain Earn
    // wallets, which are separate accounts with their own endpoints. Comparing it with the
    // holdings total made every account with money in funding read as a drift.
    const drift = input.balance.totalEquityUsd - tradingValueUsd;
    if (Math.abs(drift) > Math.max(1, Math.abs(tradingValueUsd) * 0.01)) {
      warnings.push(
        `Il totalEq del conto trading di OKX (${input.balance.totalEquityUsd.toFixed(2)} USD) differisce dalla somma delle monete in trading (${tradingValueUsd.toFixed(2)} USD): il POC non spiega il residuo.`
      );
    }
  }

  return {
    holdings,
    positions: input.positions,
    totals: {
      accountEquityUsd: input.balance.totalEquityUsd,
      tradingValueUsd,
      fundingValueUsd,
      savingsValueUsd,
      earnValueUsd,
      holdingsValueUsd,
      holdingsValueEur: input.usdEur !== null ? holdingsValueUsd * input.usdEur : null,
      unrealizedPnlUsd: pnlTracked > 0 ? pnlTotalUsd : null,
      unrealizedPnlEur:
        pnlTracked > 0 && input.usdEur !== null ? pnlTotalUsd * input.usdEur : null,
      derivativesNotionalUsd,
      derivativesUnrealizedPnlUsd,
      unpriced,
      pnlUnavailable,
    },
    warnings,
  };
}
