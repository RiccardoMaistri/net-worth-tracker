/**
 * The Costi tile's 20-year projection: compound growth with and without the fee, and the
 * refusals — no TER, no invested base, no horizon. A zero difference is never returned as a
 * projection: «0 € in meno» would be a claim the data cannot support.
 */

import { describe, expect, it } from 'vitest';
import { COST_DRAG_HORIZON_YEARS, projectCostDrag } from '@/lib/utils/costDrag';

const base = { invested: 100_000, terPct: 0.25, growthPct: 7, years: 20 };

describe('projectCostDrag', () => {
  it('projects the gross and net values and returns their difference', () => {
    const result = projectCostDrag(base)!;
    expect(result.grossValue).toBeCloseTo(100_000 * Math.pow(1.07, 20), 6);
    expect(result.netValue).toBeCloseTo(100_000 * Math.pow(1.0675, 20), 6);
    expect(result.drag).toBeCloseTo(result.grossValue - result.netValue, 6);
    expect(result.drag).toBeGreaterThan(0);
  });

  it('is exponential in the horizon, not linear', () => {
    const ten = projectCostDrag({ ...base, years: 10 })!;
    const twenty = projectCostDrag({ ...base, years: COST_DRAG_HORIZON_YEARS })!;
    expect(twenty.drag).toBeGreaterThan(ten.drag * 2);
  });

  it('returns null without a TER, never a zero difference', () => {
    expect(projectCostDrag({ ...base, terPct: 0 })).toBeNull();
    expect(projectCostDrag({ ...base, terPct: -0.1 })).toBeNull();
  });

  it('returns null without an invested base or a horizon', () => {
    expect(projectCostDrag({ ...base, invested: 0 })).toBeNull();
    expect(projectCostDrag({ ...base, years: 0 })).toBeNull();
    expect(projectCostDrag({ ...base, growthPct: Number.NaN })).toBeNull();
  });

  it('refuses a growth rate whose base cannot compound', () => {
    expect(projectCostDrag({ ...base, growthPct: -100 })).toBeNull();
    expect(projectCostDrag({ ...base, growthPct: -150 })).toBeNull();
  });

  it('reports the inputs it used', () => {
    expect(projectCostDrag(base)).toMatchObject({
      invested: base.invested,
      terPct: base.terPct,
      growthPct: base.growthPct,
      years: base.years,
    });
  });
});
