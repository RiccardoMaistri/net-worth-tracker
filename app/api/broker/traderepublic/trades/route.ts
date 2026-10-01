/**
 * Trade Republic TRADE history — POST /api/broker/traderepublic/trades.
 *
 * The same two-step contract as the Scalable route, and the same reasoning (see its header):
 *   { ownerId }                        → the plan (a preview: NO writes)
 *   { ownerId, apply: ["<uuid>", ...] } → writes exactly those broker ids
 *
 * Owner-scoped through `assertCanAccessAccount`, and no credential crosses this route: the session
 * cookie lives in `brokerSessions/{ownerId}`, written and read through the Admin SDK only. The
 * timeline is read RAW rather than through the SDK's typed reader, which is measured to throw on
 * the `presentation` field the broker now sends and would return nothing at all (see
 * `readTrTradeHistory`).
 *
 * Trade Republic is reached over the user's own session, so this route is subject to the broker's
 * rate limiting: the timeline is paged and the per-trade detail reads are sequential and capped in
 * the client module. A history wider than those caps is reported as truncated, never silently
 * short — a partial import that says so beats a complete-looking one that is not.
 */

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  assertCanAccessAccount,
  getApiAuthErrorResponse,
  requireFirebaseAuth,
} from '@/lib/server/apiAuth';
import { parseOr400 } from '@/lib/server/validation';
import {
  readTrTradeHistory,
  TradeRepublicAuthError,
  TradeRepublicReadError,
} from '@/lib/server/tradeRepublicClient';
import {
  buildBrokerTradePreview,
  importBrokerTrades,
  type BrokerTradesPayload,
} from '@/lib/server/brokerTradeImportService';

const bodySchema = z.object({
  ownerId: z.string().min(1),
  // Absent = preview; present = write these broker ids. An empty array writes nothing, which is
  // deliberately different from omitting the field (that would mean «preview»).
  apply: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)).max(500).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  let decoded;
  try {
    decoded = await requireFirebaseAuth(request);
  } catch (error) {
    return getApiAuthErrorResponse(error) ?? NextResponse.json({ error: 'Non autenticato.' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const validated = parseOr400(bodySchema, body);
  if (!validated.ok) return validated.response;

  try {
    await assertCanAccessAccount(decoded, validated.data.ownerId);
  } catch (error) {
    return (
      getApiAuthErrorResponse(error) ??
      NextResponse.json({ error: 'Accesso negato.' }, { status: 403 })
    );
  }

  const { ownerId, apply } = validated.data;
  try {
    const history = await readTrTradeHistory(ownerId);
    const payload: BrokerTradesPayload = { list: history.timeline, details: history.details };
    if (apply === undefined) {
      return NextResponse.json(await buildBrokerTradePreview(ownerId, 'traderepublic', payload));
    }
    return NextResponse.json(await importBrokerTrades(ownerId, 'traderepublic', payload, apply));
  } catch (error) {
    if (error instanceof TradeRepublicAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof TradeRepublicReadError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error('[traderepublic/trades] unexpected failure', error);
    return NextResponse.json({ error: 'Lettura non riuscita: riprova.' }, { status: 500 });
  }
}
