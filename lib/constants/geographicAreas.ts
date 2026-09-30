/**
 * AREA NAME. Big lump, not small country.
 *
 * Fund live in cave of Ireland (IE) but hold WHOLE WORLD. So me no ask ISIN. Me ask: fund big
 * stones inside it, where they born. That is `splitFundHoldingsByRegion`.
 *
 * `ISIN_TO_GEOGRAPHIC_AREA` below = boss say "no, that fund bigger than ten stones show".
 *
 * Me NEVER guess `other`. No know country, no stones, no place (money, cave-dwelling, old-man
 * fund) — all mean SAME THING: me not know. Not know is not a place. Me let tile say it out loud.
 *
 * `other` still good when USER pick it. User know. Me not.
 */

/**
 * Me lump area whole portfolio go into. Live on asset doc as `geographicArea`.
 * Same list live in zod enum inside AssetDialog. Boss say: change one, change both.
 */
export type GeographicArea =
  | 'northAmerica'
  | 'europe'
  | 'asiaPacific'
  | 'emergingMarkets'
  | 'global'
  | 'italy'
  | 'other';

/** Name me show human. Used in AssetDialog and in Esposizione tile. */
export const GEOGRAPHIC_AREA_LABELS: Record<GeographicArea, string> = {
  northAmerica: 'Nord America',
  europe: 'Europa',
  asiaPacific: 'Asia Pacifico',
  emergingMarkets: 'Mercati Emergenti',
  global: 'Globale',
  italy: 'Italia',
  other: 'Altro',
};

/** Order in Select. Esposizione rows no obey this — rows sort by big, not by list. */
export const GEOGRAPHIC_AREA_SEQUENCE: readonly GeographicArea[] = [
  'northAmerica',
  'europe',
  'asiaPacific',
  'emergingMarkets',
  'global',
  'italy',
  'other',
] as const;

/**
 * Yahoo country word -> me area. Yahoo speak only English ("United States", "Germany").
 *
 * Country not in here = me not know. NOT `other`. This list = edge of what me dare say.
 * Word miss from here, me cannot back the claim.
 */
export const COUNTRY_TO_REGION: Record<string, GeographicArea> = {
  // Nord America
  'United States': 'northAmerica',
  'Canada': 'northAmerica',

  // Italia (own region)
  'Italy': 'italy',

  // Europa
  'Germany': 'europe',
  'France': 'europe',
  'United Kingdom': 'europe',
  'Switzerland': 'europe',
  'Netherlands': 'europe',
  'Spain': 'europe',
  'Sweden': 'europe',
  'Denmark': 'europe',
  'Norway': 'europe',
  'Finland': 'europe',
  'Belgium': 'europe',
  'Austria': 'europe',
  'Ireland': 'europe',
  'Portugal': 'europe',
  'Luxembourg': 'europe',
  'Greece': 'europe',
  'Poland': 'europe',
  'Czech Republic': 'europe',
  'Hungary': 'europe',
  'Romania': 'europe',
  'Iceland': 'europe',

  // Asia Pacifico
  'Japan': 'asiaPacific',
  'Australia': 'asiaPacific',
  'South Korea': 'asiaPacific',
  'Hong Kong': 'asiaPacific',
  'Singapore': 'asiaPacific',
  'New Zealand': 'asiaPacific',
  'Taiwan': 'asiaPacific',

  // Mercati Emergenti
  'China': 'emergingMarkets',
  'India': 'emergingMarkets',
  'Brazil': 'emergingMarkets',
  'Mexico': 'emergingMarkets',
  'South Africa': 'emergingMarkets',
  'Russia': 'emergingMarkets',
  'Turkey': 'emergingMarkets',
  'Indonesia': 'emergingMarkets',
  'Thailand': 'emergingMarkets',
  'Malaysia': 'emergingMarkets',
  'Philippines': 'emergingMarkets',
  'Vietnam': 'emergingMarkets',
  'Chile': 'emergingMarkets',
  'Colombia': 'emergingMarkets',
  'Peru': 'emergingMarkets',
  'Argentina': 'emergingMarkets',
  'Saudi Arabia': 'emergingMarkets',
  'United Arab Emirates': 'emergingMarkets',
  'Qatar': 'emergingMarkets',
  'Kuwait': 'emergingMarkets',
  'Egypt': 'emergingMarkets',
  'Nigeria': 'emergingMarkets',
  'Kenya': 'emergingMarkets',
  'Pakistan': 'emergingMarkets',
  'Bangladesh': 'emergingMarkets',
  'Israel': 'emergingMarkets',
};

/**
 * Yahoo country word -> area. Empty word or word not in map: me not know, so `null`.
 * Me NEVER hand back `other` from here.
 */
export function countryToRegion(country: string | null | undefined): GeographicArea | null {
  if (!country) return null;
  return COUNTRY_TO_REGION[country] ?? null;
}

/**
 * Boss override. For fund where ten big stones lie about whole fund.
 * Normal way = look inside fund. Fund listed here = boss already decide sample lie.
 * World/All-World fund: without this, me read "Nord America" and me wrong — big stones be American
 * computer stone, but fund hold all world.
 */
export const ISIN_TO_GEOGRAPHIC_AREA: Readonly<Record<string, GeographicArea>> = {
  // Global
  IE00BK5BQT80: 'global', // Vanguard FTSE All-World (VWCE)
  IE00B4L5Y983: 'global', // iShares Core MSCI World — identity measured via OpenFIGI
  IE00B3RBWM25: 'global', // Vanguard FTSE All-World High Dividend Yield
  IE00BFY0GT14: 'global', // Invesco MSCI World
  IE00BTJRMP35: 'global', // Xtrackers MSCI World ESG
  IE00B4JNQZ49: 'global', // Vanguard FTSE All-World (second line)
  IE00B468XW29: 'global', // Vanguard FTSE All-World (third line)
  LU0274208692: 'global', // Xtrackers MSCI World Swap
  LU0356591882: 'global', // Amundi MSCI World
  LU0498052551: 'global', // iShares Core MSCI World
  LU1681043599: 'global', // Amundi Prime Global
  LU1829220216: 'global', // Lyxor Core MSCI World

  // North America / S&P 500 / Nasdaq
  IE00B5BMR087: 'northAmerica', // iShares Core S&P 500 (CSSPX)
  IE00B3XXRP09: 'northAmerica', // Vanguard S&P 500 (VUSA)
  IE00BFMXXD54: 'northAmerica', // Vanguard S&P 500 (VUAA)
  IE00BYQRR523: 'northAmerica', // iShares S&P 500 (SPY5)
  IE00B3WJKG14: 'northAmerica', // iShares S&P 500 (IUSN)
  IE00B53SZB19: 'northAmerica', // iShares Nasdaq 100
  IE00BN633954: 'northAmerica', // iShares S&P 500 Information Technology
  LU1681048804: 'northAmerica', // Amundi Prime USA

  // Europe
  IE00B53L3W79: 'europe', // iShares Core EURO STOXX 50 (CSSX5E)
  IE00B3VTMJ91: 'europe', // iShares € Govt Bond 1-3yr — identity measured via OpenFIGI
  IE00B14X4Q57: 'europe', // iShares Core FTSE 100
  LU0908500753: 'europe', // Amundi Core STOXX Europe 600 (MEUD)
  LU0274211217: 'europe', // Xtrackers Euro Stoxx 50

  // Emerging Markets
  IE00BKM4GZ66: 'emergingMarkets', // iShares Core MSCI EM IMI (EIMI)
  IE00BTJRMP46: 'emergingMarkets', // Xtrackers MSCI Emerging Markets
  LU1681045370: 'emergingMarkets', // Amundi MSCI Emerging Markets
  IE00B469F816: 'emergingMarkets', // iShares MSCI EM Asia

  // Asia Pacific
  IE00B52MJY50: 'asiaPacific', // iShares Core MSCI Pacific ex-Japan
  IE00B42Z5J44: 'asiaPacific', // iShares Core MSCI Japan
  LU0328474803: 'asiaPacific', // Xtrackers MSCI Pacific ex Japan
};

/** Two letter head of a DIRECT thing: one bond, one stock. Me read head, me get country. */
const ISIN_PREFIX_TO_AREA: Readonly<Record<string, GeographicArea>> = {
  IT: 'italy',
  US: 'northAmerica',
  CA: 'northAmerica',
  DE: 'europe',
  FR: 'europe',
  ES: 'europe',
  NL: 'europe',
  CH: 'europe',
  GB: 'europe',
  JP: 'asiaPacific',
  AU: 'asiaPacific',
  KR: 'asiaPacific',
  SG: 'asiaPacific',
};

/** ISIN = 2 letter then 10 any. Not look like this? Not ISIN. Me not guess. */
const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{10}$/;

/** Yahoo make up ISIN for shiny rock. No country, no home cave. */
const CRYPTO_ISIN_PREFIX = 'XF000';

/**
 * Me find area of thing with NO inside to look at. One stock. One bond. One shiny rock.
 *
 * Fund NOT this function job. Fund area live in fund stones. And fund ISIN head = fund HOME CAVE
 * (IE, LU), never fund exposure. Read that head for fund = me tell big lie.
 *
 * `null` = me not know. No ISIN. Country word not in map. Thing with no place at all.
 */
export function inferGeographicArea(input: {
  isin?: string | null;
  country?: string | null;
  type?: string | null;
}): GeographicArea | null {
  const isin = input.isin?.trim().toUpperCase();
  const type = input.type ?? null;

  // Shiny rock have no country and no fund. It the one thing live in ALL place at same time.
  if (type === 'crypto' || (isin && isin.startsWith(CRYPTO_ISIN_PREFIX))) {
    return 'global';
  }

  // Direct thing: ISIN head IS country where me buy. BTP = Italian debt.
  if (isin && ISIN_SHAPE.test(isin)) {
    const byPrefix = ISIN_PREFIX_TO_AREA[isin.slice(0, 2)];
    if (byPrefix) return byPrefix;
  }

  // Yahoo own answer, for one stock whose head me not carry.
  return countryToRegion(input.country);
}

/** Boss override for fund. `null` = no boss say, me must look inside fund. */
export function curatedFundArea(isin: string | null | undefined): GeographicArea | null {
  const key = isin?.trim().toUpperCase();
  if (!key) return null;
  return ISIN_TO_GEOGRAPHIC_AREA[key] ?? null;
}

/** One stone inside fund, as Yahoo tell me. */
export interface FundHoldingInput {
  symbol: string;
  /** How big stone compare to fund, 0..1. */
  holdingPercent: number;
}

/** How one fund money cut between area where me know its stones live. */
export interface FundRegionSplit {
  /**
   * Each area share of fund stones me KNOW. Sum = 1.
   *
   * Me divide only by what me know. So this number talk about the sample, NOT the fund — ten big
   * stone never reach fund tail. `coverage` say how much of fund this sample be.
   */
  weights: Partial<Record<GeographicArea, number>>;
  /** How much of fund me know, 0..1. */
  coverage: number;
  /** Biggest area. `null` = no stone me know. */
  area: GeographicArea | null;
}

/** No stone me know. Fund have no area me dare say. */
const EMPTY_SPLIT: FundRegionSplit = { weights: {}, coverage: 0, area: null };

/**
 * How much of fund me must know before me dare say where it live.
 *
 * Me put this here to catch when country ask come back HALF. Yahoo say no. Yahoo too fast. Some
 * rock no name.
 *
 * Without this: me divide by only the two American stone that come back, me throw away eight, me
 * say fund live in Nord America. ME WRONG. Below floor = me say NOTHING. Reader see fund not in
 * tile. Reader no see fund in WRONG place.
 */
export const MIN_FUND_COVERAGE = 0.5;

/**
 * Cut one fund money between area of its big stones. Same spirit as sector weight me already read
 * from same Yahoo bag.
 *
 * `countryBySymbol`: rock name -> country Yahoo say. Rock not in bag, or country word not in me
 * map: me THROW IT AWAY from both side of divide.
 *
 * Why throw away and not count as zero: money me cannot place NOT a area of fund. Count it, and
 * me silently move number on every other area to cover the hole.
 */
export function splitFundHoldingsByRegion(
  holdings: readonly FundHoldingInput[],
  countryBySymbol: ReadonlyMap<string, string>
): FundRegionSplit {
  let disclosed = 0;
  const byRegion = new Map<GeographicArea, number>();
  for (const holding of holdings) {
    if (!holding.symbol) continue;
    if (!Number.isFinite(holding.holdingPercent) || holding.holdingPercent <= 0) continue;
    disclosed += holding.holdingPercent;
    const area = countryToRegion(countryBySymbol.get(holding.symbol));
    if (!area) continue;
    byRegion.set(area, (byRegion.get(area) ?? 0) + holding.holdingPercent);
  }

  let classified = 0;
  for (const weight of byRegion.values()) classified += weight;
  if (classified <= 0) return EMPTY_SPLIT;

  // Most stone me not know. Fund have no area me dare say.
  const coverage = disclosed > 0 ? classified / disclosed : 0;
  if (coverage < MIN_FUND_COVERAGE) return EMPTY_SPLIT;

  const weights: Partial<Record<GeographicArea, number>> = {};
  let area: GeographicArea | null = null;
  let heaviest = -1;
  for (const [key, weight] of byRegion) {
    weights[key] = weight / classified;
    if (weight > heaviest) {
      heaviest = weight;
      area = key;
    }
  }
  return { weights, coverage, area };
}
