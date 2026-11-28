/**
 * marketTodayService — the day's market snapshot, through ONE global cache:
 * `market-today-cache/quotes`, read and written only by the Admin SDK.
 *
 * Why a server route and a cache at all: Yahoo is never called from the browser (CORS, and the
 * keyless endpoint is not the app's to hammer), and every visitor of the Panoramica asks the
 * same six symbols. One document, one answer per TTL, shared by every account — the benchmark
 * and FX caches' pattern (AGENTS.md § Caching).
 *
 * The `fetchedAt` in the answer is when YAHOO answered, never the request's clock: on a cache
 * hit the tile's footer keeps dating the quote it is showing. When the TTL has passed and
 * Yahoo fails, the last good answer is served with `stale: true` — a figure with its age on
 * the surface beats an empty tile, and the footer says so (The Narrative Honesty Rule).
 *
 * The answer is global data: no `userId`, no ownership check. `requireFirebaseAuth` in the
 * route is the whole authorization (doc/guide/panoramica.md § Mercato oggi).
 */
import YahooFinance from 'yahoo-finance2';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/firebase/admin';
import { MARKET_INSTRUMENTS, MARKET_TODAY_CACHE_TTL_MS } from '@/lib/constants/marketToday';
import { buildMarketQuotes, type YahooMarketQuote } from '@/lib/utils/marketToday';
import type { MarketTodayResponse } from '@/types/market';
import type { ServerTimingRecorder } from '@/lib/server/serverTiming';

const CACHE_COLLECTION = 'market-today-cache';
const CACHE_DOC = 'quotes';

// One instance per server process, as `yahooFinanceService.ts` does.
const yahooFinance = new YahooFinance();

/** The cache read this module needs, structurally (so a test can stand in for Firestore). */
interface CacheSnapshot {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface MarketTodayResult {
  response: MarketTodayResponse;
  /** Where the answer came from — the route's `Server-Timing` `source` description. */
  source: 'cache' | 'yahoo' | 'stale';
}

export interface ReadMarketTodayOptions {
  /** The request's clock, injected so the TTL is testable (AGENTS.md § Dynamic Imports). */
  now?: Date;
  timing?: ServerTimingRecorder;
}

function readCachedMarket(snapshot: CacheSnapshot): MarketTodayResponse | null {
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  const fetchedAt = data?.fetchedAt;
  const fetchedAtIso = fetchedAt instanceof Timestamp
    ? fetchedAt.toDate().toISOString()
    : typeof fetchedAt === 'string'
      ? fetchedAt
      : null;
  if (!fetchedAtIso || !Array.isArray(data?.quotes)) return null;

  return {
    quotes: data.quotes as MarketTodayResponse['quotes'],
    fetchedAt: fetchedAtIso,
    stale: false,
  };
}

export async function readMarketToday({
  now = new Date(),
  timing,
}: ReadMarketTodayOptions = {}): Promise<MarketTodayResult> {
  const cacheRef = adminDb.collection(CACHE_COLLECTION).doc(CACHE_DOC);
  const cacheSnapshot = await cacheRef.get();
  timing?.mark('db');

  const cached = readCachedMarket(cacheSnapshot);
  const ageMs = cached ? now.getTime() - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY;
  if (cached && ageMs >= 0 && ageMs < MARKET_TODAY_CACHE_TTL_MS) {
    return { response: cached, source: 'cache' };
  }

  try {
    const raw = (await yahooFinance.quote(MARKET_INSTRUMENTS.map((instrument) => instrument.symbol))) as readonly YahooMarketQuote[] | undefined;
    timing?.mark('yahoo');

    const quotes = buildMarketQuotes(raw);
    if (!quotes.some((quote) => quote.price !== null)) {
      throw new Error('Yahoo answered no price for the market basket');
    }

    const response: MarketTodayResponse = { quotes, fetchedAt: now.toISOString(), stale: false };
    try {
      await cacheRef.set({ quotes, fetchedAt: Timestamp.fromDate(now) });
    } catch (error) {
      // A cache that cannot be written must never cost the answer: the next request asks again.
      console.error('[market-today] Failed to write the cache:', error);
    }
    return { response, source: 'yahoo' };
  } catch (error) {
    timing?.mark('yahoo');
    if (cached) {
      return { response: { ...cached, stale: true }, source: 'stale' };
    }
    throw error;
  }
}
