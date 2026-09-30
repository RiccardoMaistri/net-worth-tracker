/**
 * ISIN → Yahoo Finance symbol, for the brokers that publish only an ISIN.
 *
 * WHY THIS EXISTS. Yahoo quotes neither a real ISIN nor the pseudo-ISINs brokers assign to
 * crypto, and the exchange suffix is not in the broker payload, so it cannot be derived — a symbol
 * has to be known. That is why every broker bridge here is stuck behind a table, and why an
 * imported position with no entry is created with the ISIN as its ticker and stays unquotable.
 *
 * Only FUND entries belong here. A single stock's listing is the broker account's own business and
 * its own table (`TR_YAHOO_TICKER_BY_ISIN` in `tradeRepublicImport.ts`, which holds that account's
 * positions); a UCITS ETF's identity is a public fact both brokers need, so lifting it here is what
 * stops the two bridges from drifting apart.
 *
 * A MISSING ENTRY IS SAFE, and that is the property to preserve when adding one:
 *   - the resolver returns `null` and the caller keeps the ISIN, which is exactly where it was;
 *   - on a broker-fed position (`autoUpdatePrice: false`) a wrong symbol cannot move a price, so a
 *     bad entry costs one failed lookup, never a wrong number in the portfolio.
 * On a broker that DOES auto-update prices from Yahoo, a wrong entry would put a wrong price on a
 * real asset. So nothing here is written from memory: an entry appears only once its quote has been
 * verified to exist against Yahoo.
 */

/** The ISIN's own country block for crypto, which carries the coin code (see `XF000BTC0017`). */
const CRYPTO_ISIN_PREFIX = 'XF000';

/**
 * The ETFs a European broker sells, keyed by ISIN. The symbol is a full Yahoo symbol including its
 * exchange suffix: the suffix cannot be derived, and guessing one is how a real asset ends up priced
 * off an unrelated listing.
 *
 * This is deliberately ONE entry. It is the whole of what this repository can assert as verified,
 * and a thin table that is true beats a wide one that is not: every row here is load-bearing for a
 * real position's price.
 */
export const YAHOO_SYMBOL_BY_ISIN: Readonly<Record<string, string>> = {
  // Global
  IE00BK5BQT80: 'VWCE.MI', // Vanguard FTSE All-World — `VWCE` confirmed the German listing (GR/GF/GD)
  IE00B4L5Y983: 'SWDA.MI', // iShares Core MSCI World — `SWDA` on IM is the Milan listing
  // Europe
  IE000M7V94E1: 'NUKL.DE', // VanEck Uranium & Nuclear — `NUKL` is the German ticker
  IE00B3VTMJ91: 'SXRN.DE', // iShares € Govt Bond 1-3yr — `SXRN` is the German ticker
};

/**
 * An ISIN this repository once mapped to a symbol that belonged to a DIFFERENT fund.
 *
 * `tradeRepublicImport.ts` paired `IE00B3VTMJ91` with `SWDA.MI` and called it «iShares Core MSCI
 * World». OpenFIGI says otherwise on both counts: that ISIN is ISHARES EURO GOVT BOND 1-3Y (German
 * ticker `SXRN`), and `SWDA` is the London/Milan listing of ISHARES CORE MSCI WORLD — whose ISIN is
 * `IE00B4L5Y983`. Two ISINs cannot be one fund, so the old row would have put a world-equity price
 * on a euro-government-bond position.
 *
 * The correct rows are in the table above and the bad one is gone. Kept as a record because the
 * same ISIN appears in `geographicAreas.ts` and in import fixtures, and a reader who finds one of
 * them needs to know the pairing was checked rather than assumed.
 */
export const CORRECTED_ISIN_PAIRS: Readonly<Record<string, { wasSymbol: string; wasClaimedName: string; measuredName: string; correctIsinForOldSymbol: string }>> = {
  IE00B3VTMJ91: {
    wasSymbol: 'SWDA.MI',
    wasClaimedName: 'iShares Core MSCI World',
    measuredName: 'ISHARES EURO GOVT BOND 1-3Y (ticker SXRN)',
    correctIsinForOldSymbol: 'IE00B4L5Y983',
  },
};

/**
 * The Yahoo symbol for a broker position, or `null` when this catalogue does not know it.
 *
 * Crypto is NOT handled here: its pseudo-ISIN carries the coin code, and which pair to trade is the
 * broker's decision (Trade Republic prices `BTC-EUR`, another broker would not). A caller that knows
 * its crypto convention derives it before asking this function.
 */
export function resolveYahooSymbolForIsin(isin: string | null | undefined): string | null {
  const key = isin?.trim().toUpperCase();
  if (!key) return null;
  if (key.startsWith(CRYPTO_ISIN_PREFIX)) return null;
  return YAHOO_SYMBOL_BY_ISIN[key] ?? null;
}

/** Whether an ISIN is one of the recorded corrections — for a preview that says so out loud. */
export function isCorrectedIsin(isin: string | null | undefined): boolean {
  const key = isin?.trim().toUpperCase();
  return !!key && key in CORRECTED_ISIN_PAIRS;
}
