/**
 * Tests for `resolveDisplayAssetClass` (lib/utils/assetDisplayClass.ts): la classe PREVALENTE
 * di un asset composito, per la sola visualizzazione. Modulo puro, nessun mock Firebase.
 */
import { describe, it, expect } from 'vitest';
import type { Asset, AssetComposition } from '@/types/assets';
import { describeAssetClassChip, resolveDisplayAssetClass } from '@/lib/utils/assetDisplayClass';

function makeAsset(overrides: Partial<Asset> = {}): Pick<Asset, 'assetClass' | 'composition'> {
  return {
    assetClass: 'equity',
    ...overrides,
  };
}

describe('resolveDisplayAssetClass', () => {
  it('returns the largest composition leg (70/30 → the 70% class)', () => {
    const composition: AssetComposition[] = [
      { assetClass: 'bonds', percentage: 70 },
      { assetClass: 'equity', percentage: 30 },
    ];
    const asset = makeAsset({ assetClass: 'equity', composition });
    expect(resolveDisplayAssetClass(asset)).toBe('bonds');
  });

  it('falls back to assetClass when composition is absent', () => {
    const asset = makeAsset({ assetClass: 'bonds', composition: undefined });
    expect(resolveDisplayAssetClass(asset)).toBe('bonds');
  });

  it('falls back to assetClass when composition is an empty array', () => {
    const asset = makeAsset({ assetClass: 'crypto', composition: [] });
    expect(resolveDisplayAssetClass(asset)).toBe('crypto');
  });

  it('on a 50/50 tie, returns the first leg in insertion order', () => {
    const composition: AssetComposition[] = [
      { assetClass: 'equity', percentage: 50 },
      { assetClass: 'bonds', percentage: 50 },
    ];
    const asset = makeAsset({ assetClass: 'equity', composition });
    expect(resolveDisplayAssetClass(asset)).toBe('equity');

    // Reversing insertion order flips the winner — proves the tie-break is positional, not
    // an alphabetical/enum artifact.
    const reversed: AssetComposition[] = [
      { assetClass: 'bonds', percentage: 50 },
      { assetClass: 'equity', percentage: 50 },
    ];
    expect(resolveDisplayAssetClass(makeAsset({ composition: reversed }))).toBe('bonds');
  });

  it('still ranks correctly when percentages do not sum to 100', () => {
    const composition: AssetComposition[] = [
      { assetClass: 'equity', percentage: 40 },
      { assetClass: 'commodity', percentage: 45 },
    ];
    const asset = makeAsset({ assetClass: 'equity', composition });
    expect(resolveDisplayAssetClass(asset)).toBe('commodity');
  });

  it('handles a three-leg composition, picking the true plurality', () => {
    const composition: AssetComposition[] = [
      { assetClass: 'equity', percentage: 20 },
      { assetClass: 'bonds', percentage: 50 },
      { assetClass: 'cash', percentage: 30 },
    ];
    const asset = makeAsset({ assetClass: 'equity', composition });
    expect(resolveDisplayAssetClass(asset)).toBe('bonds');
  });

  it('adds up a class named twice before ranking (30 + 30 of Azioni beat 40 of Obbligazioni)', () => {
    const composition: AssetComposition[] = [
      { assetClass: 'equity', percentage: 30 },
      { assetClass: 'bonds', percentage: 40 },
      { assetClass: 'equity', percentage: 30 },
    ];
    expect(resolveDisplayAssetClass(makeAsset({ composition }))).toBe('equity');
  });
});

describe('describeAssetClassChip', () => {
  const composite = (...legs: Array<[AssetComposition['assetClass'], number]>) =>
    makeAsset({ composition: legs.map(([assetClass, percentage]) => ({ assetClass, percentage })) });

  it('keeps the plain chip for a single-class asset: one full segment, the full label, no shares', () => {
    expect(describeAssetClassChip(makeAsset({ assetClass: 'bonds' }))).toEqual({
      segments: [{ assetClass: 'bonds', share: 100 }],
      label: 'Obbligazioni',
      accessibleName: null,
    });
  });

  it('splits a 60/40 fund into two proportional segments, prevailing first, with short names', () => {
    const chip = describeAssetClassChip(composite(['bonds', 40], ['equity', 60]));
    expect(chip.segments).toEqual([
      { assetClass: 'equity', share: 60 },
      { assetClass: 'bonds', share: 40 },
    ]);
    expect(chip.label).toBe('Azioni · Obbl.');
    expect(chip.accessibleName).toBe('Azioni 60%, Obbligazioni 40%');
  });

  it('reads «Misto» from three visible legs', () => {
    const chip = describeAssetClassChip(composite(['equity', 50], ['bonds', 30], ['commodity', 20]));
    expect(chip.label).toBe('Misto');
    expect(chip.segments.map((s) => s.share)).toEqual([50, 30, 20]);
  });

  it('drops a leg under 5% from the segments and the label, keeps it in the accessible name', () => {
    const chip = describeAssetClassChip(composite(['equity', 95.5], ['cash', 4.5]));
    expect(chip.segments).toEqual([{ assetClass: 'equity', share: 100 }]);
    expect(chip.label).toBe('Azioni');
    expect(chip.accessibleName).toBe('Azioni 95,5%, Liquidità 4,5%');
  });

  it('keeps a leg of exactly 5%, and rescales the visible widths to 100 when a small leg is dropped', () => {
    expect(describeAssetClassChip(composite(['equity', 95], ['bonds', 5])).label).toBe('Azioni · Obbl.');
    const chip = describeAssetClassChip(composite(['equity', 70], ['bonds', 27], ['cash', 3]));
    expect(chip.label).toBe('Azioni · Obbl.');
    expect(chip.segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(100, 10);
    expect(chip.segments[0].share).toBeCloseTo((70 / 97) * 100, 10);
  });

  it('merges a class named twice into one segment, and its first segment is the row group', () => {
    const asset = composite(['equity', 30], ['bonds', 40], ['equity', 30]);
    expect(describeAssetClassChip(asset).segments).toEqual([
      { assetClass: 'equity', share: 60 },
      { assetClass: 'bonds', share: 40 },
    ]);
    expect(describeAssetClassChip(asset).segments[0].assetClass).toBe(resolveDisplayAssetClass(asset));
  });

  it('reads a 100/0 composition as the plain chip: a leg of weight 0 is no leg, so nothing is spoken apart', () => {
    expect(describeAssetClassChip(composite(['equity', 100], ['bonds', 0]))).toEqual({
      segments: [{ assetClass: 'equity', share: 100 }],
      label: 'Azioni',
      accessibleName: null,
    });
  });

  it('keeps every leg when none reaches the 5% floor, rather than drawing an empty chip', () => {
    const chip = describeAssetClassChip(composite(['equity', 4], ['bonds', 3]));
    expect(chip.segments.map((s) => s.assetClass)).toEqual(['equity', 'bonds']);
    expect(chip.segments[0].share).toBeCloseTo((4 / 7) * 100, 10);
    expect(chip.label).toBe('Azioni · Obbl.');
    expect(chip.accessibleName).toBe('Azioni 4%, Obbligazioni 3%');
  });

  it('normalises the widths of a composition that does not sum to 100, and speaks the stored shares', () => {
    const chip = describeAssetClassChip(composite(['equity', 60], ['bonds', 30]));
    expect(chip.segments[0].share).toBeCloseTo((60 / 90) * 100, 10);
    expect(chip.segments[1].share).toBeCloseTo((30 / 90) * 100, 10);
    expect(chip.accessibleName).toBe('Azioni 60%, Obbligazioni 30%');
  });

  it('applies the 5% floor to the share AS SPOKEN: a 4,96% leg heard as «5%» keeps its segment', () => {
    const kept = describeAssetClassChip(composite(['equity', 95.04], ['cash', 4.96]));
    expect(kept.accessibleName).toBe('Azioni 95%, Liquidità 5%');
    expect(kept.label).toBe('Azioni · Liquid.');
    // One decimal lower is heard as «4,9%», and the chip drops it.
    const dropped = describeAssetClassChip(composite(['equity', 95.06], ['cash', 4.94]));
    expect(dropped.accessibleName).toBe('Azioni 95,1%, Liquidità 4,9%');
    expect(dropped.label).toBe('Azioni');
  });

  it('breaks a 50/50 tie like resolveDisplayAssetClass: the first class in the composition', () => {
    const tie = composite(['bonds', 50], ['equity', 50]);
    expect(describeAssetClassChip(tie).segments[0].assetClass).toBe('bonds');
    expect(resolveDisplayAssetClass(tie)).toBe('bonds');
  });
});
