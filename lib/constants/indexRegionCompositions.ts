/**
 * The geographic composition of a fund, read from the INDEX its own name declares.
 *
 * Why the name and not the ISIN: Yahoo resolves an ISIN to the fund's real listing and that
 * listing's `price.longName` — «Vanguard FTSE All-World UCITS ETF USD Accumulation»,
 * «iShares Core MSCI World UCITS ETF USD (Acc)», «Amundi Index Solutions - Amundi MSCI All Country
 * World Swap UCITS ETF EUR Acc». Every provider, every share class, every exchange of the same index
 * carries the index in its name, so ONE table covers a whole catalogue.
 *
 * Why not the ISIN: a per-ISIN table is a claim about a single instrument that nothing re-checks, and
 * the one this file replaced was wrong on 5 of its 15 live entries — `IE00B4JNQZ49` filed as
 * «Vanguard FTSE All-World» is iShares S&P 500 Financials, `IE00B14X4Q57` filed as «FTSE 100» is
 * iShares € Govt Bond 1-3yr, `IE00B469F816` filed as «MSCI EM Asia» is SPDR MSCI EM. A wrong entry is
 * not a missing figure, it is a wrong area on screen.
 *
 * Why a table at all: Yahoo publishes no per-fund regional breakdown. `topHoldings` caps at ten
 * positions covering a fifth to a third of the fund, and on a global index those ten are almost all
 * American — the sample alone files a World fund as «Nord America». The index is the level at which
 * a composition is a published fact rather than a guess, so the sample is the fallback and this is
 * the rule.
 *
 * ORDER IS THE RULE. The first matching pattern wins, so a family that CONTAINS another must come
 * before it: «MSCI EM Asia» would be swallowed by an «Emerging Markets» pattern, and «S&P 500
 * Information Technology» must reach the S&P rule rather than stop at a generic tech one.
 */

import type { GeographicArea } from './geographicAreas';

export interface IndexRegionComposition {
  /** The index family, for the tile's method line and for the test that names what it matched. */
  index: string;
  /** Tested against the fund's own long name. First hit wins. */
  pattern: RegExp;
  /** Share of the index in each macro-region. Sums to 1. */
  weights: Partial<Record<GeographicArea, number>>;
}

/** One area, all of it. Spelled as a helper so no row can forget to sum to 1. */
const WHOLE = (area: GeographicArea): Partial<Record<GeographicArea, number>> => ({ [area]: 1 });

const WORLD_DEVELOPED: Partial<Record<GeographicArea, number>> = {
  northAmerica: 0.72,
  europe: 0.18,
  asiaPacific: 0.1,
};
const WORLD_ALL: Partial<Record<GeographicArea, number>> = {
  northAmerica: 0.63,
  europe: 0.16,
  asiaPacific: 0.11,
  emergingMarkets: 0.1,
};
const WORLD_ACWI: Partial<Record<GeographicArea, number>> = {
  northAmerica: 0.67,
  europe: 0.16,
  asiaPacific: 0.07,
  emergingMarkets: 0.1,
};

export const INDEX_REGION_COMPOSITIONS: readonly IndexRegionComposition[] = [
  // ── Bonds: a sovereign index is decided before any equity family, because «iShares € Govt Bond»
  // carries no equity token but a European issuer.
  { index: 'Euro government bond', pattern: /€\s*Gov(?:t|ernment)|Euro\s+(?:Gov(?:t|ernment)|Govt)|Eur(?:ope)?\s+Govt/i, weights: WHOLE('europe') },

  // ── Global families, broadest first: each contains the token «World» of the next one.
  { index: 'MSCI ACWI', pattern: /\bAC\s*World\b|\bACWI\b|All[\s-]?Country\s+World/i, weights: WORLD_ACWI },
  { index: 'FTSE All-World', pattern: /All-?World|Global\s+All\s+Cap/i, weights: WORLD_ALL },
  { index: 'MSCI World', pattern: /\bMSCI\s+World\b|\bDeveloped\s+World\b|\bWorld\s+Developed\b/i, weights: WORLD_DEVELOPED },

  // ── Emerging: «EM Asia» and «EM IMI» are wholly EM, and the loose pattern below would take
  // them anyway — kept explicit because both tokens are written differently by every provider.
  { index: 'MSCI Emerging Markets', pattern: /\bMSCI\s+EM\b|\bEM\s+(?:Asia|IMI|Latin|CEM)\b|Emerging\s+Marke/i, weights: WHOLE('emergingMarkets') },

  // ── Single-region equity families.
  { index: 'Nasdaq / S&P 500 / MSCI USA', pattern: /\bS&P\s*500\b|\bNASDAQ\b|\bMSCI\s+USA\b|\bS&P\s*MidCap\b|\bS&P\s*SmallCap\b/i, weights: WHOLE('northAmerica') },
  { index: 'EURO STOXX 50', pattern: /Euro\s*Stoxx|EUROSTOXX/i, weights: WHOLE('europe') },
  { index: 'STOXX Europe 600', pattern: /Stoxx\s+Europe|STOXX\s*Europe\s*600/i, weights: WHOLE('europe') },
  { index: 'FTSE 100 / DAX / CAC 40', pattern: /\bFTSE\s*100\b|\bDAX\b|\bCAC\s*40\b|\bFTSE\s*MIB\b|\bIBEX\s*35\b|\bMSCI\s+Europe\b|\bS&P\s*Europe\b/i, weights: WHOLE('europe') },
  { index: 'MSCI Japan', pattern: /\bMSCI\s+Japan\b|\bTOPIX\b|\bNikkei\b/i, weights: WHOLE('asiaPacific') },
  { index: 'MSCI Pacific ex-Japan', pattern: /Pac(?:ific)?\s+ex-?(?:Japan|Jpn)|\bASX\s*200\b|\bMSCI\s+Australia\b|\bMSCI\s+New\s+Zealand\b/i, weights: WHOLE('asiaPacific') },
] as const;

/**
 * The index a fund's own name declares, and how that index splits. `null` when the name declares no
 * index this file knows — a thematic fund, a bond fund, an S&P 500 Equal Weight tracker. The caller
 * then falls back to the positions Yahoo discloses, DECLARED as a sample.
 */
export function matchIndexRegionComposition(fundName: string | null | undefined): IndexRegionComposition | null {
  const name = fundName?.trim();
  if (!name) return null;
  for (const composition of INDEX_REGION_COMPOSITIONS) {
    if (composition.pattern.test(name)) return composition;
  }
  return null;
}