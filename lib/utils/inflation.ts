/**
 * Inflation arithmetic — pure, SDK-free and clock-free.
 *
 * The index is HICP Italy (all items, 2015 = 100), one entry per PUBLISHED month. A month
 * Eurostat has not published yet is absent and every function returns `null` for it: carrying
 * the last value forward would silently invent a figure (AGENTS.md → The Narrative Honesty Rule).
 *
 * Every value is expressed in the euro of the latest known month, never the euro of today: the
 * two differ by the months the index still owes, and the surfaces name the reference month.
 */

import { MONTH_NAMES } from '@/lib/constants/months';
import type { InflationMonthlyIndex } from '@/types/benchmarks';

export interface YearMonth {
  year: number;
  month: number; // 1-12
}

export interface InflationValuePoint extends YearMonth {
  value: number;
}

/** A point after deflation: `value` is null when its own month was never published. */
export interface RealInflationPoint extends YearMonth {
  value: number | null;
}

const monthNumber = (point: YearMonth): number => point.year * 12 + point.month - 1;

function fromMonthNumber(value: number): YearMonth {
  const year = Math.floor(value / 12);
  return { year, month: (value - year * 12) + 1 };
}

/** Shift a month by a signed number of calendar months (no clock, no DST). */
export function shiftInflationMonth(point: YearMonth, months: number): YearMonth {
  return fromMonthNumber(monthNumber(point) + months);
}

/** The index value of one month, or null when that month has not been published. */
export function findInflationIndex(index: InflationMonthlyIndex[], at: YearMonth): number | null {
  const target = monthNumber(at);
  const found = index.find((entry) => monthNumber(entry) === target);
  return found ? found.index : null;
}

/** The series' own end — the latest month with a published value, or null for an empty series. */
export function resolveLatestInflationMonth(index: InflationMonthlyIndex[]): YearMonth | null {
  let latest: InflationMonthlyIndex | null = null;
  for (const entry of index) {
    if (!latest || monthNumber(entry) > monthNumber(latest)) latest = entry;
  }
  return latest ? { year: latest.year, month: latest.month } : null;
}

/**
 * The index change over the last `months` PUBLISHED months, in percent: the latest month against
 * the same month a year earlier. Null when either end was never published.
 */
export function inflationRateOver(index: InflationMonthlyIndex[], months: number): number | null {
  if (!Number.isFinite(months) || months <= 0) return null;
  const latest = resolveLatestInflationMonth(index);
  if (!latest) return null;
  const from = shiftInflationMonth(latest, -months);
  const latestValue = findInflationIndex(index, latest);
  const fromValue = findInflationIndex(index, from);
  if (latestValue === null || fromValue === null || fromValue === 0) return null;
  return (latestValue / fromValue - 1) * 100;
}

/**
 * A nominal amount of `from` expressed in the euro of `to`: `value × index(to) / index(from)`.
 * Null when either month is missing — never the input value dressed as a deflated one.
 */
export function deflate(
  value: number,
  from: YearMonth,
  to: YearMonth,
  index: InflationMonthlyIndex[],
): number | null {
  if (!Number.isFinite(value)) return null;
  const fromValue = findInflationIndex(index, from);
  const toValue = findInflationIndex(index, to);
  if (fromValue === null || toValue === null || fromValue === 0) return null;
  return value * (toValue / fromValue);
}

/**
 * A series of nominal values expressed in the euro of the latest published month. A point whose
 * own month has no index gets `value: null` (the caller decides whether to break the line or drop
 * the point), never the nominal figure.
 */
export function realSeries(
  points: InflationValuePoint[],
  index: InflationMonthlyIndex[],
): RealInflationPoint[] {
  const latest = resolveLatestInflationMonth(index);
  if (!latest) return points.map((point) => ({ ...point, value: null }));
  return points.map((point) => ({
    ...point,
    value: deflate(point.value, point, latest, index),
  }));
}

/**
 * The purchasing power a nominal cash balance lost over the last `months` published months,
 * measured in today's euro: `cash × (1 − index(from) / index(latest))`. A deflationary window
 * returns a negative "loss" (a gain), which the narrative declines to claim as a loss.
 */
export function purchasingPowerLoss(
  cash: number,
  months: number,
  index: InflationMonthlyIndex[],
): number | null {
  if (!Number.isFinite(cash) || cash <= 0) return null;
  if (!Number.isFinite(months) || months <= 0) return null;
  const latest = resolveLatestInflationMonth(index);
  if (!latest) return null;
  const from = shiftInflationMonth(latest, -months);
  const latestValue = findInflationIndex(index, latest);
  const fromValue = findInflationIndex(index, from);
  if (latestValue === null || fromValue === null || latestValue === 0) return null;
  return cash * (1 - fromValue / latestValue);
}

/** «settembre 2026» — the reference month every real figure names. */
export function formatInflationMonth(point: YearMonth): string {
  return `${MONTH_NAMES[point.month - 1].toLowerCase()} ${point.year}`;
}
