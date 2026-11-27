/**
 * The inflation arithmetic behind Storico's Reale mode, Patrimonio's cash line and FIRE's
 * reference datum. Every missing month is `null`: no carry-forward, no zero dressed as a value.
 */

import { describe, expect, it } from 'vitest';
import {
  deflate,
  findInflationIndex,
  formatInflationMonth,
  inflationRateOver,
  purchasingPowerLoss,
  realSeries,
  resolveLatestInflationMonth,
  shiftInflationMonth,
} from '@/lib/utils/inflation';
import type { InflationMonthlyIndex } from '@/types/benchmarks';

const INDEX: InflationMonthlyIndex[] = [
  { year: 2025, month: 8, index: 99.6 },
  { year: 2025, month: 9, index: 100 },
  { year: 2025, month: 10, index: 100.2 },
  { year: 2026, month: 8, index: 101.9 },
  { year: 2026, month: 9, index: 102.1 },
  // October 2026 is deliberately absent: the published series stops at September.
];

describe('findInflationIndex / resolveLatestInflationMonth', () => {
  it('reads a published month and returns null for an unpublished one', () => {
    expect(findInflationIndex(INDEX, { year: 2026, month: 9 })).toBe(102.1);
    expect(findInflationIndex(INDEX, { year: 2026, month: 10 })).toBeNull();
  });

  it('names the series own end', () => {
    expect(resolveLatestInflationMonth(INDEX)).toEqual({ year: 2026, month: 9 });
    expect(resolveLatestInflationMonth([])).toBeNull();
  });

  it('shifts across the year boundary', () => {
    expect(shiftInflationMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftInflationMonth({ year: 2025, month: 12 }, 1)).toEqual({ year: 2026, month: 1 });
  });
});

describe('inflationRateOver', () => {
  it('measures the latest published month against the same month a year earlier', () => {
    expect(inflationRateOver(INDEX, 12)).toBeCloseTo(2.1, 6);
  });

  it('returns null when either end was never published', () => {
    expect(inflationRateOver(INDEX.filter((entry) => !(entry.year === 2025 && entry.month === 9)), 12)).toBeNull();
    expect(inflationRateOver([], 12)).toBeNull();
    expect(inflationRateOver(INDEX, 0)).toBeNull();
  });
});

describe('deflate', () => {
  it('expresses an amount in the euro of another month', () => {
    expect(deflate(1000, { year: 2025, month: 9 }, { year: 2026, month: 9 }, INDEX)).toBeCloseTo(1021, 6);
  });

  it('returns null when either month is missing, never the input value', () => {
    expect(deflate(1000, { year: 2026, month: 10 }, { year: 2026, month: 9 }, INDEX)).toBeNull();
    expect(deflate(1000, { year: 2025, month: 9 }, { year: 2026, month: 10 }, INDEX)).toBeNull();
    expect(deflate(1000, { year: 2025, month: 9 }, { year: 2026, month: 9 }, [])).toBeNull();
  });
});

describe('realSeries', () => {
  it('carries every point into the latest published month', () => {
    const result = realSeries(
      [
        { year: 2025, month: 9, value: 1000 },
        { year: 2026, month: 9, value: 1200 },
      ],
      INDEX,
    );
    expect(result[0].value).toBeCloseTo(1021, 6);
    expect(result[1].value).toBeCloseTo(1200, 6);
  });

  it('returns null for a point whose own month has no index', () => {
    const result = realSeries(
      [
        { year: 2026, month: 9, value: 1200 },
        { year: 2026, month: 10, value: 1250 },
      ],
      INDEX,
    );
    expect(result[0].value).toBeCloseTo(1200, 6);
    expect(result[1].value).toBeNull();
  });

  it('returns nulls for every point when there is no index at all', () => {
    expect(realSeries([{ year: 2026, month: 9, value: 1200 }], []).every((point) => point.value === null)).toBe(true);
  });
});

describe('purchasingPowerLoss', () => {
  it('measures today’s cash loss over the last twelve published months', () => {
    expect(purchasingPowerLoss(10_000, 12, INDEX)).toBeCloseTo(10_000 * (1 - 100 / 102.1), 6);
  });

  it('returns null without cash, a month, or a positive window', () => {
    expect(purchasingPowerLoss(0, 12, INDEX)).toBeNull();
    expect(purchasingPowerLoss(10_000, 12, [])).toBeNull();
    expect(purchasingPowerLoss(10_000, 0, INDEX)).toBeNull();
  });
});

describe('formatInflationMonth', () => {
  it('prints the reference month in Italian', () => {
    expect(formatInflationMonth({ year: 2026, month: 9 })).toBe('settembre 2026');
  });
});
