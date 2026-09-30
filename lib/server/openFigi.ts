/**
 * OpenFIGI ISIN → listings resolver — the SECOND ticker source behind the curated table.
 *
 * The curated `TR_YAHOO_TICKER_BY_ISIN` stays first (human-verified beats heuristic), the
 * crypto derivation stays disjoint from both; this module answers everything else. OpenFIGI
 * maps by ISIN authoritatively, so — unlike a Yahoo search top-hit — the symbol always
 * denotes the RIGHT instrument; only the venue varies, and venue differences are
 * economically negligible (same instrument, and the quote carries its own currency for the
 * FX path). Measured 2026-09-30: anonymous, no key, one batched POST per sync.
 *
 * Rules, in order:
 *   1. a `US` listing → the bare ticker (the canonical, most liquid symbol);
 *   2. otherwise the first EUR venue in `EUR_EXCHANGES` order (home first) — a EUR quote
 *      needs no FX conversion and can be attached at creation without a currency mismatch;
 *   3. anything else → null (the preview's manual field covers it, as before).
 *
 * FAIL-OPEN, always: rate limit, network error, unknown exchange, malformed answer — every
 * failure returns «no resolution» and the sync behaves exactly as if OpenFIGI did not exist
 * (0 + warning + manual field). A ticker resolver must never be able to break a sync.
 *
 * Privacy: the ISIN list leaves the box to api.openfigi.com (Bloomberg LP) on every sync —
 * the same class of disclosure as the Yahoo quotes themselves, and only ISINs, never amounts.
 *
 * Anonymous requests are capped at 10 jobs each: larger universes are split into batches.
 * No API key, no new env var — one batched POST per sync cannot come near any limit, and if
 * 429s ever appear the fail-open path absorbs them.
 */

export interface FigiListing {
  ticker: string;
  exchCode: string;
}

const OPENFIGI_URL = 'https://api.openfigi.com/v3/mapping';
const ANONYMOUS_BATCH_LIMIT = 10;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * exchCode → Yahoo suffix. ONLY venues measurable in real answers — every entry below was
 * observed in a live mapping response on 2026-09-30. An unmapped code is skipped, never
 * guessed: a wrong suffix invents a symbol Yahoo may resolve to something else entirely.
 */
const YAHOO_SUFFIX_BY_EXCH: Readonly<Record<string, string>> = {
  US: '',
  MI: '.MI',
  GR: '.DE',
  FP: '.PA',
  NA: '.AS',
  GF: '.F',
  GS: '.SG',
};

/** EUR venues, fixed priority, home first. The order is arbitrary but STABLE. */
const EUR_EXCHANGES: readonly string[] = ['MI', 'GR', 'FP', 'NA', 'GF', 'GS'];

/**
 * Pick the Yahoo symbol for one ISIN's listings. Pure — the unit under test.
 * Returns null when nothing maps (unknown venues only, or no listings at all).
 */
export function pickYahooSymbol(listings: FigiListing[]): string | null {
  const usable = listings.filter(
    (listing) =>
      typeof listing.ticker === 'string' &&
      listing.ticker !== '' &&
      typeof listing.exchCode === 'string' &&
      listing.exchCode in YAHOO_SUFFIX_BY_EXCH
  );
  if (usable.length === 0) return null;
  const us = usable.find((listing) => listing.exchCode === 'US');
  if (us) return us.ticker;
  for (const exch of EUR_EXCHANGES) {
    const venue = usable.find((listing) => listing.exchCode === exch);
    if (venue) return `${venue.ticker}${YAHOO_SUFFIX_BY_EXCH[exch]}`;
  }
  return null;
}

interface OpenFigiMappingResult {
  data?: { ticker?: unknown; exchCode?: unknown }[];
}

function toListings(result: OpenFigiMappingResult | null | undefined): FigiListing[] {
  if (!result || !Array.isArray(result.data)) return [];
  return result.data.flatMap((entry): FigiListing[] => {
    if (typeof entry.ticker === 'string' && typeof entry.exchCode === 'string') {
      return [{ ticker: entry.ticker, exchCode: entry.exchCode }];
    }
    return [];
  });
}

async function fetchBatch(isins: string[]): Promise<(OpenFigiMappingResult | null)[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(OPENFIGI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isins.map((idValue) => ({ idType: 'ID_ISIN', idValue }))),
      signal: controller.signal,
    });
    if (!response.ok) return isins.map(() => null);
    const parsed: unknown = await response.json().catch(() => null);
    if (!Array.isArray(parsed)) return isins.map(() => null);
    return isins.map((_, index) => {
      const entry = parsed[index] as OpenFigiMappingResult | undefined;
      return entry ?? null;
    });
  } catch {
    return isins.map(() => null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve ISINs to Yahoo symbols, one batched POST per 10. Never throws, never returns a
 * partial lie: an ISIN with no usable listing is simply absent from the map, and the caller
 * falls back to the curated table / the manual field exactly as before.
 */
export async function resolveIsinsViaOpenFigi(isins: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const unique = [...new Set(isins.map((isin) => isin.trim().toUpperCase()).filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += ANONYMOUS_BATCH_LIMIT) {
    const batch = unique.slice(offset, offset + ANONYMOUS_BATCH_LIMIT);
    const results = await fetchBatch(batch);
    batch.forEach((isin, index) => {
      const symbol = pickYahooSymbol(toListings(results[index]));
      if (symbol) resolved.set(isin, symbol);
    });
  }
  return resolved;
}
