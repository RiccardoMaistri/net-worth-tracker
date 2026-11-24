/**
 * The one source of the inflation dataset's identity and cadence.
 *
 * HICP Italy (all items, 2015 = 100) is published monthly by Eurostat and read from FRED;
 * the cache is shared by every user and refreshed by the daily cron. The client never writes
 * it, and the server writes it only through the Admin SDK (firestore.rules → `inflation-cache`).
 */
export const INFLATION_CACHE_COLLECTION = 'inflation-cache';
export const INFLATION_CACHE_DOC = 'hicp-it';
export const INFLATION_FRED_SERIES = 'CP0000ITM086NEST';
export const INFLATION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
