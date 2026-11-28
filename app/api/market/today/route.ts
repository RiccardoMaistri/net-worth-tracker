import { NextRequest, NextResponse } from 'next/server';
import { getApiAuthErrorResponse, requireFirebaseAuth } from '@/lib/server/apiAuth';
import { readMarketToday } from '@/lib/server/marketTodayService';
import { startTiming } from '@/lib/server/serverTiming';

/**
 * GET /api/market/today
 *
 * The Panoramica's «Mercato oggi» basket — S&P 500, Nasdaq 100, MSCI World, Italia, gold and
 * EUR/USD — as one answer, served from the global `market-today-cache/quotes` document
 * (`lib/server/marketTodayService.ts`). The client never calls Yahoo.
 *
 * NOT owner-scoped, on purpose: these are market quotes, not an account's data, so there is
 * no `userId` to authorize beyond the caller being signed in (the benchmark/FX routes' shape).
 *
 * Answers with `Server-Timing: auth, db, yahoo, total, source` — `source` is `cache` when the
 * document was fresh, `yahoo` when the basket was asked, `stale` when Yahoo failed and the last
 * good answer was served. The header is the one place a cache miss is readable in production.
 *
 * Auth → delegate → return (AGENTS.md § Server Layer).
 */
export async function GET(request: NextRequest) {
  const timing = startTiming();
  try {
    await requireFirebaseAuth(request);
    timing.mark('auth');

    const { response, source } = await readMarketToday({ now: new Date(), timing });
    return NextResponse.json(response, {
      headers: { 'Server-Timing': timing.toHeader({ source }) },
    });
  } catch (error) {
    const authError = getApiAuthErrorResponse(error);
    if (authError) return authError;

    console.error('[market-today] Failed to read the market snapshot:', error);
    return NextResponse.json({ error: 'Failed to read the market snapshot' }, { status: 500 });
  }
}
