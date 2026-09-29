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
