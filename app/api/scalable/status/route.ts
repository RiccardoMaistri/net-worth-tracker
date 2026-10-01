/**
 * The CALLER's own broker status — GET /api/scalable/status.
 *
 * Answers whether the whitelisted email behind this request has a working `sc` session on
 * this machine. It is deliberately NOT owner-scoped: it reports nothing about any account,
 * only the caller's profile, so there is nothing to scope. The tile reads it on load; a 403
 * (email not in `SCALABLE_PROFILES`) is silently ignored there.
 *
 * Answer: { status: 'CONNECTED' | 'CONNECTING' | 'NOT_CONNECTED' | 'AUTHENTICATION_REQUIRED' | 'ERROR', user }
 */

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { getApiAuthErrorResponse, requireFirebaseAuth } from '@/lib/server/apiAuth';
import { getScalableProfileForEmail, ScalableService } from '@/lib/server/scalableService';

export async function GET(request: NextRequest): Promise<NextResponse> {
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

  try {
    const status = await ScalableService.getConnectionStatus(profileConfig.profile);
    return NextResponse.json({ status, user: profileConfig.name });
  } catch (error) {
    console.error('[scalable/status] error:', error);
    return NextResponse.json({ error: 'Impossibile verificare lo stato della connessione.' }, { status: 500 });
  }
}
