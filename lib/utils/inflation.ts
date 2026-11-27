/**
 * HICP inflation arithmetic shared by Patrimonio's cash line, Storico's real series and FIRE's
 * reference rate (2026-11-27).
 *
 * The input is the PUBLISHED monthly index only: no carry-forward, no interpolated month and no
 * clock of its own. Every question that cannot be answered from two published months answers
 * `null`, so a surface can say "not measurable" instead of printing a made-up zero. This module
 * is pure — the FRED fetch and its cache live in lib/server/inflationService.ts.
 */

import { MONTH_NAMES } from '@/lib/constants/months';
import type { InflationMonthlyIndex } from '@/types/benchmarks';

/** A calendar month in Italy's calendar, independent of any Date/timezone. */
export interface YearMonth {
  year: number;
  month: number; // 1-12
}

/** A point whose monetary value is expressed in the euro of `year`/`month`. */
export interface InflationPoint {
  year: number;
  month: number;
  value: number;
}

/** The same point with its value restated in the euro of the series' latest published month. */
export type RealPoint<T extends InflationPoint> = Omit<T, 'value'> & { value: number | null };

/** The index of one published month, or null when that month is absent from the series. */
export function findInflationIndex(
  index: readonly InflationMonthlyIndex[],
  reference: YearMonth,
): number | null {
  const found = index.find((entry) => entry.year === reference.year && entry.month === reference.month);
  return found && Number.isFinite(found.index) && found.index > 0 ? found.index : null;
}

/** The series' own last published month, not "today" and not the first gap after it. */
export function resolveLatestInflationMonth(index: readonly InflationMonthlyIndex[]): YearMonth | null {
  let latest: YearMonth | null = null;
  for (const entry of index) {
    if (!latest || entry.year > latest.year || (entry.year === latest.year && entry.month > latest.month)) {
      latest = { year: entry.year, month: entry.month };
    }
  }
  return latest;
}

/** Shift a month by a number of calendar months across the year boundary. */
export function shiftInflationMonth(reference: YearMonth, months: number): YearMonth {
  const absolute = reference.year * 12 + (reference.month - 1) + months;
  return { year: Math.floor(absolute / 12), month: ((absolute % 12) + 12) % 12 + 1 };
}

/**
 * The percentage change over `months` between the latest published month and the same month
 * before it. A missing end, a non-positive base or a non-positive window is not a 0% rate.
 */
export function inflationRateOver(
  index: readonly InflationMonthlyIndex[],
  months: number,
): number | null {
  if (!Number.isFinite(months) || months <= 0) return null;
  const latest = resolveLatestInflationMonth(index);
  if (!latest) return null;
  const earlierMonth = shiftInflationMonth(latest, -months);
  const latestIndex = findInflationIndex(index, latest);
  const earlierIndex = findInflationIndex(index, earlierMonth);
  if (latestIndex === null || earlierIndex === null) return null;
  const rate = (latestIndex / earlierIndex - 1) * 100;
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Express an amount from one month in the euro of another: amount × index(to) / index(from).
 * Both months must be published — a value is never carried forward over a gap.
 */
export function deflate(
  amount: number,
  from: YearMonth,
  to: YearMonth,
  index: readonly InflationMonthlyIndex[],
): number | null {
  if (!Number.isFinite(amount)) return null;
  const fromIndex = findInflationIndex(index, from);
  const toIndex = findInflationIndex(index, to);
  if (fromIndex === null || toIndex === null) return null;
  const real = amount * (toIndex / fromIndex);
  return Number.isFinite(real) ? real : null;
}

/** Carry every point into the euro of the same latest published month, keeping the rest of it. */
export function realSeries<T extends InflationPoint>(
  points: readonly T[],
  index: readonly InflationMonthlyIndex[],
): RealPoint<T>[] {
  const latest = resolveLatestInflationMonth(index);
  if (!latest) return points.map((point) => ({ ...point, value: null }));
  return points.map((point) => ({
    ...point,
    value: deflate(point.value, { year: point.year, month: point.month }, latest, index),
  }));
}

/**
 * What `amount` today has lost in purchasing power over the last `months` published months.
 * A positive loss only: deflation and a missing end are not a negative loss dressed as a figure.
 */
export function purchasingPowerLoss(
  amount: number,
  months: number,
  index: readonly InflationMonthlyIndex[],
): number | null {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(months) || months <= 0) return null;
  const latest = resolveLatestInflationMonth(index);
  if (!latest) return null;
  const earlierIndex = findInflationIndex(index, shiftInflationMonth(latest, -months));
  const latestIndex = findInflationIndex(index, latest);
  if (earlierIndex === null || latestIndex === null) return null;
  const loss = amount * (1 - earlierIndex / latestIndex);
  return Number.isFinite(loss) && loss > 0 ? loss : null;
}

/** The reference month in Italian, lowercase for use inside a sentence: «settembre 2026». */
export function formatInflationMonth(reference: YearMonth): string {
  const name = MONTH_NAMES[reference.month - 1]?.toLowerCase() ?? String(reference.month);
  return `${name} ${reference.year}`;
}
