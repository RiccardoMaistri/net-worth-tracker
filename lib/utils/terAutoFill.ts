/**
 * TER auto-fill — the ONE pure rule shared by the asset form and the one-shot backfill.
 *
 * A provider's expense ratio is a public fact about an instrument, but it is an ESTIMATE until a
 * person sees it: the form pre-fills a visible, editable field and the backfill writes only the
 * assets that still have no TER. A number the user typed — including an explicit 0 — is never
 * replaced, and a value that came from a provider keeps its source and the instant it was read.
 *
 * Yahoo publishes the ratio as a FRACTION (0,0025 = 0,25%), while `Asset.totalExpenseRatio` is a
 * PERCENT number (0,25 = 0,25%). This module is the one place that converts and validates it, so
 * the dialog and the migration cannot disagree about units or about which field wins.
 */
import type { AssetType } from '@/types/assets';
import type { InstrumentTer, ProviderTerSource } from '@/types/exposure';
import { resolveAllocationRole } from '@/lib/utils/allocationUtils';
import { hasMarketPrice } from '@/lib/utils/assetPricing';
import { effectiveProfileTicker } from '@/lib/utils/exposureRequests';

/** The types that pay an ongoing fund-like management fee. */
export const TER_ELIGIBLE_TYPES: readonly AssetType[] = ['etf', 'fund', 'commodity', 'crypto'];

export const TER_SOURCE_LABELS: Record<ProviderTerSource, string> = {
  'yahoo-fund-profile': 'Yahoo Finance · profilo del fondo',
  'yahoo-fund-performance': 'Yahoo Finance · performance del fondo',
  'yahoo-quote': 'Yahoo Finance · quotazione',
};

/** Minimal raw shape of the three Yahoo fields, kept structural so the source can stay untyped. */
export interface ProviderTerAnswer {
  fundProfile?: { feesExpensesInvestment?: { netExpRatio?: unknown } | null } | null;
  fundPerformance?: { annualReportExpenseRatio?: unknown } | null;
  price?: { netExpenseRatio?: unknown } | null;
}

/** Yahoo's fraction → the app's percent number; `null` refuses a value outside a credible ratio. */
export function normalizeTerPercent(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) return null;
  // Four decimals on the percent number: 0,0025 → 0,25, 0,0078 → 0,78. The round keeps
  // binary artefacts (`0.19 * 100`) out of the form and out of Firestore.
  return Math.round(raw * 100 * 10_000) / 10_000;
}

/**
 * The provider precedence, in one place: the fund's own published net ratio, then its annual
 * report, then the quote's net expense ratio. A candidate with an unusable unit is skipped rather
 * than preferred over a lower field that is valid.
 */
export function resolveProviderTer(
  answer: ProviderTerAnswer | null | undefined,
  fetchedAt: string
): InstrumentTer | null {
  const candidates: Array<[ProviderTerSource, unknown]> = [
    ['yahoo-fund-profile', answer?.fundProfile?.feesExpensesInvestment?.netExpRatio],
    ['yahoo-fund-performance', answer?.fundPerformance?.annualReportExpenseRatio],
    ['yahoo-quote', answer?.price?.netExpenseRatio],
  ];
  for (const [source, raw] of candidates) {
    const value = normalizeTerPercent(raw);
    if (value !== null) return { value, source, fetchedAt };
  }
  return null;
}

export function isTerEligibleType(type: AssetType): boolean {
  return TER_ELIGIBLE_TYPES.includes(type);
}

/** Minimal asset shape the shared eligibility reads — a raw Firestore doc has no `id`/`userId` yet. */
export interface TerAssetFields {
  type: AssetType;
  quantity: number;
  subCategory?: string;
  ticker: string;
  isin?: string;
  allocationRole?: 'tradable' | 'frozen' | 'excluded';
  excludeFromAllocation?: boolean;
  totalExpenseRatio?: number | null;
}

/** `0` is a stored TER and a statement, not an absence: the form and the migration both stop here. */
export function hasStoredTer(asset: Pick<TerAssetFields, 'totalExpenseRatio'>): boolean {
  return asset.totalExpenseRatio !== undefined && asset.totalExpenseRatio !== null;
}

/** Held, investable, fund-like, identifiable by the same Yahoo identity the Esposizione uses. */
export function isTerBackfillCandidate(asset: TerAssetFields): boolean {
  if (!isTerEligibleType(asset.type) || !hasMarketPrice(asset.type, asset.subCategory)) return false;
  if (!(asset.quantity > 0) || resolveAllocationRole(asset) === 'excluded') return false;
  if (hasStoredTer(asset)) return false;
  return effectiveProfileTicker(asset) !== '';
}

/**
 * What a save writes for the TER pair. The provenance travels ONLY with the exact value it was
 * read for: the moment the visible field is edited, the number belongs to the user and the source
 * is dropped, so a reader can never call a hand-typed figure a provider's.
 */
export function buildTerWriteFields(
  value: number | undefined,
  provenance: InstrumentTer | null | undefined
): {
  totalExpenseRatio?: number;
  terSource?: ProviderTerSource;
  terFetchedAt?: Date;
} {
  if (value === undefined || Number.isNaN(value) || value < 0 || value > 100) {
    return { totalExpenseRatio: undefined, terSource: undefined, terFetchedAt: undefined };
  }
  const sameValue = !!provenance && Math.abs(provenance.value - value) < 0.0001;
  const fetchedAt = sameValue ? Date.parse(provenance!.fetchedAt) : Number.NaN;
  return {
    totalExpenseRatio: value,
    terSource: sameValue ? provenance!.source : undefined,
    terFetchedAt: sameValue && !Number.isNaN(fetchedAt) ? new Date(fetchedAt) : undefined,
  };
}
