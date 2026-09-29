export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { getApiAuthErrorResponse, requireFirebaseAuth } from '@/lib/server/apiAuth';
import { getScalableProfileForEmail, ScalableService } from '@/lib/server/scalableService';
import { ScalableCliError } from '@/lib/server/scalableCli';

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
    const transactions = await ScalableService.getTransactions(profileConfig.profile);
    return NextResponse.json({ transactions });
  } catch (error) {
    if (error instanceof ScalableCliError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Lettura transazioni non riuscita.' }, { status: 500 });
  }
}
