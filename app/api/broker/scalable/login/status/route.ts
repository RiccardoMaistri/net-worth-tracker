/**
 * Poll a Scalable device-flow login — GET /api/broker/scalable/login/status?sessionId=…
 *
 * The frontend polls this while the user approves in their browser. It reports the state and
 * nothing else: no ownerId, no timestamps, and a session belonging to another owner is a 404,
 * not a status — otherwise any signed-in user could watch someone else's login.
 *
 * Query: sessionId (required)
 * Answer: { id, status, verificationUri?, userCode?, error? }
 *
 * A restart of the server forgets the session, which answers 404: the UI reads that as
 * «riavvia il collegamento», not as a failure.
 */

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import {
  assertCanAccessAccount,
  getApiAuthErrorResponse,
  requireFirebaseAuth,
} from '@/lib/server/apiAuth';
import { getScalableLogin, publicLoginView } from '@/lib/server/scalableLogin';

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

  const session = getScalableLogin(sessionId, ownerId);
  if (!session) {
    return NextResponse.json(
      { error: 'Collegamento non trovato: riavvia il collegamento per un nuovo codice.' },
      { status: 404 }
    );
  }
  return NextResponse.json(publicLoginView(session));
}
