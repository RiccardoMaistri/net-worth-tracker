/**
 * Start a Trade Republic QR login — POST /api/broker/traderepublic/login/start.
 *
 * Creates the challenge on the broker, then polls it in the background and answers with the QR
 * image for the frontend to show. The user scans it with the Trade Republic app and approves the
 * sign-in there; nothing about that crosses this route, and no credential is ever typed into the
 * app.
 *
 * Body: { ownerId: string }
 * Answer: { id, status, qrDataUrl?, qrPayload?, challengeExpiresAt? }
 *
 * `qrDataUrl` can CHANGE between this answer and the next status poll: the broker rotates the
 * payload until it is scanned, so the UI must replace the image rather than treat the first one as
 * final. Owner-scoped like every broker route; needs a long-lived host (see tradeRepublicQr.ts).
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
import { publicTrLoginView, startTrLogin, TradeRepublicWafError } from '@/lib/server/tradeRepublicQr';
import { renderQrDataUrl } from '@/lib/server/qrImage';

const bodySchema = z.object({ ownerId: z.string().min(1) });

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

  try {
    const session = await startTrLogin(validated.data.ownerId, renderQrDataUrl);
    return NextResponse.json(publicTrLoginView(session), { status: 201 });
  } catch (error) {
    // The WAF refusal has its own words on purpose: it is a different problem from a bad
    // credential, and the fix (a token step) is not something the user can retry away.
    if (error instanceof TradeRepublicWafError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Collegamento non riuscito: riprova.' },
      { status: 503 }
    );
  }
}
