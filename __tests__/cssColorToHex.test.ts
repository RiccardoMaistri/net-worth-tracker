/**
 * colorToHex must read every form getComputedStyle can hand back: the served CSS is down-levelled
 * to `#hex` / `lab()`, and a theme block is written in `oklch()`.
 */

import { describe, it, expect } from 'vitest';
import { colorToHex } from '@/lib/utils/cssColorToHex';

/** Largest per-channel difference between two `#rrggbb` colours. */
const hexDistance = (a: string, b: string): number =>
  Math.max(...[1, 3, 5].map((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16))));

describe('colorToHex', () => {
  it('normalises hex, short hex and rgb()', () => {
    expect(colorToHex('#ABC')).toBe('#aabbcc');
    expect(colorToHex(' #2899CA ')).toBe('#2899ca');
    expect(colorToHex('rgb(40, 153, 202)')).toBe('#2899ca');
    expect(colorToHex('rgb(40 153 202 / 0.5)')).toBe('#2899ca');
  });

  it('converts oklch()', () => {
    expect(hexDistance(colorToHex('oklch(0.645 0.12 232)')!, '#2899ca')).toBeLessThanOrEqual(1);
    expect(hexDistance(colorToHex('oklch(0.6450 0.1200 295.0000)')!, '#937ecf')).toBeLessThanOrEqual(1);
    expect(hexDistance(colorToHex('oklch(64.5% 0.11 175)')!, '#2ba38a')).toBeLessThanOrEqual(1);
    expect(colorToHex('oklch(1 0 0)')).toBe('#ffffff');
  });

  it('converts lab() against D50, round-tripping through the same colour', () => {
    // #2899ca in CSS lab() (D50), computed the other way (sRGB → XYZ D65 → Bradford → Lab).
    expect(hexDistance(colorToHex('lab(58.871% -18.853 -34.677)')!, '#2899ca')).toBeLessThanOrEqual(1);
    expect(colorToHex('lab(100% 0 0)')).toBe('#ffffff');
    expect(colorToHex('lab(0% 0 0)')).toBe('#000000');
  });

  it("reads the browser's own serialisation of a theme slot", () => {
    // `--chart-3` is authored `oklch(0.700 0.160 72)`; Chrome's getComputedStyle hands it back as
    // `lab(64.8793% 25.0679 78.4211)` (AGENTS.md → Layout and Color Tokens, measured). #da8b00 was
    // derived OUTSIDE this module, by d3-color 3.1 (`d3.lab(64.8793, 25.0679, 78.4211).formatHex()`),
    // whose Lab is D50 with its own Bradford-adapted sRGB matrix — a third implementation, sharing
    // no code with actionColor.ts. The authored oklch() must land on the same hex: one colour, two
    // spellings.
    expect(colorToHex('lab(64.8793% 25.0679 78.4211)')).toBe('#da8b00');
    expect(colorToHex('oklch(0.700 0.160 72)')).toBe('#da8b00');
  });

  it('returns null for what it cannot paint', () => {
    expect(colorToHex('')).toBeNull();
    expect(colorToHex('var(--chart-1)')).toBeNull();
    expect(colorToHex('color-mix(in oklab, red 50%, blue)')).toBeNull();
  });
});
