/**
 * Scalable TRADE history — POST /api/broker/scalable/trades.
 *
 * Two modes on one route, because the import is a two-step conversation and the SECOND step must
 * be answered with the SAME broker payload the first one previewed:
 *
 *   { ownerId }                          → the plan (a preview: NO writes)
 *   { ownerId, apply: ["<id>", ...] }   → writes exactly those broker ids
 *
 * WHY ONE ROUTE AND NOT TWO. A preview followed by a confirm on a different route would mean the
 * confirm either re-reads the broker (the history may have moved between the two clicks) or trusts
 * a plan the client cached (the client decides what to write). Re-sending the payload the server
 * already read is what lets the server rebuild the plan against the CURRENT ledger and write only
 * the rows the user approved.
 *
 * WHY THE APPROVAL IS A LIST OF BROKER IDS, not a boolean. «Import everything» is one click and no
 * record of intent; naming the ids is what makes the write auditable, and it is what lets the
 * server refuse a row whose asset link it no longer agrees with.
 *
 * The Scalable authorization is UNCHANGED from the read route: the caller's Google email must be
 * in `SCALABLE_PROFILES` (the CLI session lives in that profile's directory on this machine), and
 * the caller must own the account or hold a grant over it. The `sc` session is a LOCAL READ-ONLY
 * session: nothing here can place an order.
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
import { getScalableProfileForEmail, ScalableService } from '@/lib/server/scalableService';
import { ScalableCliError } from '@/lib/server/scalableCli';
import {
  buildBrokerTradePreview,
  importBrokerTrades,
  type BrokerTradesPayload,
} from '@/lib/server/brokerTradeImportService';

const bodySchema = z.object({
  ownerId: z.string().min(1),
  // Absent = preview. Present = write, and the array is the approved set. An EMPTY array is a
  // valid, explicit «write nothing»: it is distinguished from absent on purpose, so a client that
  // failed to select anything cannot fall through into importing the whole history.
  apply: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)).max(500).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  let decoded;
  try {
    decoded = await requireFirebaseAuth(request);
  } catch (error) {
    return getApiAuthErrorResponse(error) ?? NextResponse.json({ error: 'Non autenticato.' }, { status: 401 });
  }

  const profileConfig = getScalableProfileForEmail(decoded.email);
  if (!profileConfig) {
    return NextResponse.json({ error: 'Accesso negato: utente non autorizzato.' }, { status: 403 });
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
    const payload = (await ScalableService.getTrades(profileConfig.profile)) as BrokerTradesPayload;
    if (apply === undefined) {
      return NextResponse.json(await buildBrokerTradePreview(ownerId, 'scalable', payload));
    }
    return NextResponse.json(await importBrokerTrades(ownerId, 'scalable', payload, apply));
  } catch (error) {
    if (error instanceof ScalableCliError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[scalable/trades] unexpected failure', error);
    return NextResponse.json({ error: 'Lettura non riuscita: riprova.' }, { status: 500 });
  }
}
