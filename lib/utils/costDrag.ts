/**
 * What a TER costs over a horizon — the projection behind the Costi tile's second sentence.
 *
 * The comparison is compound interest with and without the fee: the gross value grows at
 * `growthPct`, the net one at `growthPct − terPct`. It is a projection, not a forecast: no
 * contributions, no taxes, no change in the fee, and today's invested base held flat.
 *
 * A missing input returns `null`, never a difference of zero: an account with no TER has no
 * cost drag to report, and «0 € in meno» would be a claim (AGENTS.md → The Narrative Honesty Rule).
 */

/** The fixed horizon of the tile's projection: long enough for compounding to speak for itself. */
export const COST_DRAG_HORIZON_YEARS = 20;

export interface CostDragInput {
  /** Today's value of the instruments that carry the TER. */
  invested: number;
  /** The portfolio's weighted TER, in percent. */
  terPct: number;
  /** The base scenario's annual growth, in percent (FIRE's own base scenario). */
  growthPct: number;
  /** The horizon, in years. */
  years: number;
}

export interface CostDragProjection {
  invested: number;
  terPct: number;
  growthPct: number;
  years: number;
  /** The value at the end of the horizon with no fee. */
  grossValue: number;
  /** The value at the end of the horizon after the fee. */
  netValue: number;
  /** `grossValue − netValue`: what the fee removes. */
  drag: number;
}

export function projectCostDrag(input: CostDragInput): CostDragProjection | null {
  const { invested, terPct, growthPct, years } = input;

  if (!Number.isFinite(invested) || invested <= 0) return null;
  if (!Number.isFinite(terPct) || terPct <= 0) return null;
  if (!Number.isFinite(growthPct)) return null;
  if (!Number.isFinite(years) || years <= 0) return null;

  const growth = growthPct / 100;
  const netGrowth = growth - terPct / 100;
  // A base at or below −100% cannot compound: no projection rather than `NaN`/`Infinity`.
  if (1 + growth <= 0 || 1 + netGrowth <= 0) return null;

  const grossValue = invested * Math.pow(1 + growth, years);
  const netValue = invested * Math.pow(1 + netGrowth, years);

  return {
    invested,
    terPct,
    growthPct,
    years,
    grossValue,
    netValue,
    drag: grossValue - netValue,
  };
}
