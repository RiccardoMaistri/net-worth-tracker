/**
 * A theme colour as the browser serves it, as `#rrggbb` — for the chart libraries that cannot take
 * a CSS colour as is (Nivo's react-spring interpolates neither `oklch()` nor `lab()`).
 *
 * Why several input forms: a theme block is written in `oklch()`, but the CSS the app actually
 * serves has been down-levelled by the build (Lightning CSS) to `#rrggbb` for colours inside sRGB
 * and to `lab()` for the rest, and `getComputedStyle` hands back that served form. Out-of-gamut
 * values are clipped per channel, which is what the browser does when painting them.
 *
 * ONE parser of `lab()` in the repo: both `oklch()` and `lab()` are read by `parseToOklch`
 * (lib/utils/actionColor.ts, whose test feeds it the browser's own serialisation); this module adds
 * only the last leg, OKLCH → sRGB, which that one does not need. PERF-14 plans to move both into
 * one colour-parsing module.
 *
 * Used by: lib/hooks/useCssColorTokens.ts
 */

import { parseToOklch } from '@/lib/utils/actionColor';

type LinearRgb = [number, number, number];

function oklchToLinearSrgb(l: number, c: number, h: number): LinearRgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function linearSrgbToHex(rgb: LinearRgb): string {
  return `#${rgb
    .map((linear) => {
      const clipped = Math.min(1, Math.max(0, linear));
      const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255).toString(16).padStart(2, '0');
    })
    .join('')}`;
}

/**
 * A colour as `getComputedStyle` can hand it back — `oklch()`, `#rgb`/`#rrggbb`, `lab()`, `rgb()` —
 * as `#rrggbb`; `null` for anything else (an empty token, a keyword, `color-mix()`).
 */
export function colorToHex(color: string): string | null {
  const value = color.trim();

  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map((d) => d + d).join('') : hex[1];
    return `#${digits.toLowerCase()}`;
  }

  // `oklch()` as authored and `lab()` as the browser serialises it, through the one parser.
  const oklch = parseToOklch(value);
  if (oklch) return linearSrgbToHex(oklchToLinearSrgb(...oklch));

  const rgb = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) {
    return `#${[rgb[1], rgb[2], rgb[3]]
      .map((channel) => Math.round(Math.min(255, Math.max(0, parseFloat(channel)))).toString(16).padStart(2, '0'))
      .join('')}`;
  }

  return null;
}
