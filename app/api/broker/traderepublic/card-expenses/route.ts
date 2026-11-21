/**
 * Trade Republic CARD EXPENSES — POST /api/broker/traderepublic/card-expenses.
 *
 * Three actions, one route, because they share the same expensive read (the broker timeline) and
 * the same owner check:
 *   { ownerId, action: 'preview' }                     → the plan (NO writes)
 *   { ownerId, action: 'apply', refs: ["<id>", ...] }   → writes exactly those card movements
 *   { ownerId, action: 'undo',  refs: ["<id>", ...] }   → deletes them and remembers the intent
 *
 * WHY THE SERVER RE-READS ON APPLY: the preview the user approved can be minutes old, and the
 * ledger may have changed (another tab, another device, the user deleting a row from Cashflow).
 * The apply branch rebuilds the plan from the CURRENT timeline and state and writes only the
 * intersection, so a stale preview cannot resurrect a row the user removed.
 *
 * IDEMPOTENCY lives in the document id (`tr_${ownerId}_${sourceRef}`) and in `create()`-only
 * writes: a second sync finds the documents and calls them «già importate», and a document the
 * user edited is never overwritten. A row deleted from Cashflow stays deleted because
 * `brokerCardExpenseImports/{ownerId}` remembers it was imported once and the tombstone collection
 * records the explicit undo — see `lib/server/brokerCardExpenseImportService.ts`.
 *
 * The broker is read, never written: the timeline is the same read-only topic the trade history
 * uses (`readTrCardExpenseTimeline`).
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
  readTrCardExpenseTimeline,
  TradeRepublicAuthError,
  TradeRepublicReadError,
} from '@/lib/server/tradeRepublicClient';
import {
  applyCardExpenses,
  buildCardExpensePreview,
  undoCardExpenses,
} from '@/lib/server/brokerCardExpenseImportService';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ ownerId: z.string().min(1), action: z.literal('preview') }),
  z.object({
    ownerId: z.string().min(1),
    action: z.literal('apply'),
    refs: z.array(z.string().min(1).max(128)).min(1).max(1000),
  }),
  z.object({
    ownerId: z.string().min(1),
    action: z.literal('undo'),
    refs: z.array(z.string().min(1).max(128)).min(1).max(1000),
  }),
]);

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

  const data = validated.data;
  try {
    if (data.action === 'undo') {
      return NextResponse.json(await undoCardExpenses(data.ownerId, data.refs));
    }
    const timeline = await readTrCardExpenseTimeline(data.ownerId);
    if (data.action === 'apply') {
      return NextResponse.json(await applyCardExpenses(data.ownerId, timeline, data.refs));
    }
    return NextResponse.json(await buildCardExpensePreview(data.ownerId, timeline));
  } catch (error) {
    if (error instanceof TradeRepublicAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof TradeRepublicReadError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error('[traderepublic/card-expenses] unexpected failure', error);
    return NextResponse.json({ error: 'Lettura dei movimenti carta non riuscita: riprova.' }, { status: 500 });
  }
}
