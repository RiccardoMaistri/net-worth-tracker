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

import type { Asset, AssetFormData } from '@/types/assets'
import { isLedgerAssetType } from '@/types/assetTransactions'
import type { OkxHolding } from './okxPortfolio'

/** Broker label written on every OKX coin. */
export const OKX_EXCHANGE = 'OKX' as const

/** Italian default on crypto gains, the same the dialogs (and Binance) suggest. */
export const OKX_DEFAULT_TAX_RATE = 26

/** Below this EUR value a NEW coin is not created: dust would bury the real positions. */
export const OKX_MIN_NEW_VALUE_EUR = 1

/** The stable identity of an OKX coin (manually priced: the sync keeps the price current). */
export function okxManualTicker(ccy: string): string {
  return `OKX-${ccy}`
}

/** EUR price per unit, or null when OKX gave no USD price or the FX rate is missing. */
export function okxEurPrice(holding: OkxHolding, usdEur: number | null): number | null {
  if (holding.ccy === 'EUR') return 1
  if (holding.priceUsd === null || usdEur === null) return null
  return holding.priceUsd * usdEur
}

export function mapOkxHoldingToAssetFormData(holding: OkxHolding, priceEur: number | null): AssetFormData {
  return {
    ticker: okxManualTicker(holding.ccy),
    displayTicker: holding.ccy,
    name: holding.ccy,
    type: 'crypto',
    assetClass: 'crypto',
    currency: 'EUR',
    quantity: holding.quantity,
    taxRate: OKX_DEFAULT_TAX_RATE,
    currentPrice: priceEur ?? 0,
    isLiquid: true,
    autoUpdatePrice: false,
    exchange: OKX_EXCHANGE,
    okxInstrumentId: `${holding.ccy}-USDT`,
  }
}

export type OkxHoldingDiffKind = 'new' | 'price-update' | 'drift-only' | 'unchanged'

export interface OkxHoldingDiff {
  kind: OkxHoldingDiffKind
  holding: OkxHolding
  priceEur: number | null
  formData: AssetFormData
  existingAssetId?: string
  existingName?: string
  /** Broker quantity minus tracked quantity — a number to reconcile, never an auto-write. */
  quantityDrift: number
}

export interface OkxImportPlan {
  holdings: OkxHoldingDiff[]
  warnings: string[]
  stats: {
    holdingCount: number
    newCount: number
    priceUpdateCount: number
    driftCount: number
    unchangedCount: number
    skippedCount: number
  }
}

export type OkxExistingAsset = Pick<
  Asset,
  'id' | 'name' | 'ticker' | 'type' | 'quantity' | 'exchange' | 'autoUpdatePrice' | 'currentPrice'
>

const QTY_EPS = 1e-8
const PRICE_EPS = 1e-6

function isOkxAssetOf(asset: OkxExistingAsset, ccy: string): boolean {
  return asset.exchange === OKX_EXCHANGE && asset.ticker === okxManualTicker(ccy)
}

/**
 * Same rules as Binance: new coins are created, a manually priced coin gets the OKX price, the
 * quantity of an existing coin belongs to the Registro (a mismatch is a warning, never a write).
 * EUR fiat is a cash balance, not a crypto position: skipped.
 */
export function buildOkxImportPlan(
  holdings: OkxHolding[],
  existingAssets: OkxExistingAsset[],
  usdEur: number | null
): OkxImportPlan {
  const warnings: string[] = []
  const diffs: OkxHoldingDiff[] = []
  const unpriced: string[] = []
  const dust: string[] = []
  const crypto = holdings.filter((h) => h.ccy !== 'EUR' && h.quantity > 0)

  for (const holding of crypto) {
    const priceEur = okxEurPrice(holding, usdEur)
    const existing = existingAssets.find((asset) => isOkxAssetOf(asset, holding.ccy))
    const formData = mapOkxHoldingToAssetFormData(holding, priceEur)

    if (!existing) {
      if (priceEur === null) {
        unpriced.push(holding.ccy)
        continue
      }
      if (holding.quantity * priceEur < OKX_MIN_NEW_VALUE_EUR) {
        dust.push(holding.ccy)
        continue
      }
      diffs.push({ kind: 'new', holding, priceEur, formData, quantityDrift: 0 })
      continue
    }

    const drift = holding.quantity - existing.quantity
    const hasDrift = isLedgerAssetType(existing.type) && Math.abs(drift) > QTY_EPS
    if (hasDrift) {
      warnings.push(
        `«${existing.name}»: OKX riporta ${holding.quantity} contro ${existing.quantity} nel Registro — la quantità non viene toccata (riconcilia con una rettifica).`
      )
    }
    const needsPrice =
      existing.autoUpdatePrice === false &&
      priceEur !== null &&
      Math.abs(priceEur - (existing.currentPrice ?? 0)) > PRICE_EPS
    diffs.push({
      kind: needsPrice ? 'price-update' : hasDrift ? 'drift-only' : 'unchanged',
      holding,
      priceEur,
      formData,
      existingAssetId: existing.id,
      existingName: existing.name,
      quantityDrift: hasDrift ? drift : 0,
    })
  }

  if (usdEur === null) {
    warnings.push('Cambio USD→EUR non disponibile: nessun prezzo in euro, riprova più tardi.')
  }
  if (unpriced.length > 0) {
    warnings.push(`Nessun prezzo in EUR per ${unpriced.join(', ')}: non vengono creati.`)
  }
  if (dust.length > 0) {
    warnings.push(`${dust.length} monete sotto 1 € non vengono create (${dust.join(', ')}).`)
  }

  return {
    holdings: diffs,
    warnings,
    stats: {
      holdingCount: crypto.length,
      newCount: diffs.filter((d) => d.kind === 'new').length,
      priceUpdateCount: diffs.filter((d) => d.kind === 'price-update').length,
      driftCount: diffs.filter((d) => d.kind === 'drift-only').length,
      unchangedCount: diffs.filter((d) => d.kind === 'unchanged').length,
      skippedCount: unpriced.length + dust.length,
    },
  }
}
