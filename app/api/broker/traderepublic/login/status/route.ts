/**
 * Poll a Trade Republic QR login — GET /api/broker/traderepublic/login/status?sessionId=…
 *
 * The frontend polls this while the user scans and approves in the Trade Republic app. It reports
 * the state and the CURRENT QR image, and nothing else: no ownerId, no timestamps, and a session
 * belonging to another owner is a 404, not a status — otherwise any signed-in user could watch
 * someone else's login, and a live QR is a credential.
 *
 * The transition to `approved` is the one write this route performs: it hands the handshake's
 * cookies to `adoptTradeRepublicSession`, which persists them so the SDK can refresh them and
 * survive a container restart. It is idempotent — a second poll re-adopts the same jar.
 *
 * Query: sessionId (required), ownerId (required)
 * Answer: { id, status, qrDataUrl?, qrPayload?, challengeExpiresAt?, error? }
 *
 * A restart of the server forgets the IN-FLIGHT approval, which answers 404: the UI reads that as
 * «riavvia il collegamento», not as a failure. An already-persisted session is untouched by that.
 */

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import {
  assertCanAccessAccount,
  getApiAuthErrorResponse,
  requireFirebaseAuth,
} from '@/lib/server/apiAuth';
import { getTrLogin, publicTrLoginView, takeTrLoginCookies } from '@/lib/server/tradeRepublicQr';
import { adoptTradeRepublicSession } from '@/lib/server/tradeRepublicClient';

export async function GET(request: NextRequest): Promise<NextResponse> {
  let decoded;
  try {
    decoded = await requireFirebaseAuth(request);
  } catch (error) {
    return getApiAuthErrorResponse(error) ?? NextResponse.json({ error: 'Non autenticato.' }, { status: 401 });
  }

  const sessionId = request.nextUrl.searchParams.get('sessionId');
  const ownerId = request.nextUrl.searchParams.get('ownerId');
  if (!sessionId || !ownerId) {
    return NextResponse.json({ error: 'Parametri mancanti.' }, { status: 400 });
  }

  try {
    await assertCanAccessAccount(decoded, ownerId);
  } catch (error) {
    return (
      getApiAuthErrorResponse(error) ??
      NextResponse.json({ error: 'Accesso negato.' }, { status: 403 })
    );
  }

  const session = getTrLogin(sessionId, ownerId);
  if (!session) {
    return NextResponse.json(
      { error: 'Collegamento non trovato: riavvia il collegamento per un nuovo codice.' },
      { status: 404 }
    );
  }

  if (session.status === 'approved') {
    const cookies = takeTrLoginCookies(sessionId, ownerId);
    if (!cookies) {
      return NextResponse.json(
        { error: 'Collegamento non trovato: riavvia il collegamento per un nuovo codice.' },
        { status: 404 }
      );
    }
    try {
      await adoptTradeRepublicSession(ownerId, cookies);
    } catch (error) {
      console.error('[traderepublic/login/status] could not store the session', error);
      return NextResponse.json(
        { error: 'Collegamento approvato ma non salvato: riprova il collegamento.' },
        { status: 503 }
      );
    }
  }

  return NextResponse.json(publicTrLoginView(session));
}
