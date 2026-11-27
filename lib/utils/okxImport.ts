/**
 * OKX bridge — re-exports and aggregates the pure modules behind the POC route.
 *
 * This file exists so that UI components (e.g. OkxConnectionTile) can import
 * from a single surface without needing to know the internal okxPortfolio shape.
 */

export type { OkxParseError } from './okxPortfolio'

export type { OkxWallet } from './okxPortfolio'

export type {
  OkxBalanceSnapshot,
  OkxBalanceDetail,
  OkxFundingBalance,
  OkxSavingsBalance,
  OkxStakingOrder,
  OkxPosition,
  OkxPortfolio,
  OkxPortfolioTotals,
} from './okxPortfolio'

export {
  parseOkxBalance,
  parseOkxFundingBalances,
  parseOkxSavingsBalances,
  parseOkxStakingOrders,
  parseOkxPositions,
  parseOkxTickers,
  buildOkxPortfolio,
} from './okxPortfolio'

/** Exchange name constant used by the tile UI. */
export const OKX_EXCHANGE = 'OKX' as const

/** Default tax rate applied when computing P/L for newly imported coins. */
export const OKX_DEFAULT_TAX_RATE = 0.22

/** Minimum EUR value threshold below which a new coin is considered dust and skipped. */
export const OKX_MIN_NEW_VALUE_EUR = 1