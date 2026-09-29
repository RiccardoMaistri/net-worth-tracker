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

const bodySchema = z.object({ ownerId: z.string().min(1) });

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

  try {
    const session = ScalableService.startLogin(profileConfig.profile);
    return NextResponse.json(
      {
        id: session.id,
        status: session.status,
        ...(session.verificationUri ? { verificationUri: session.verificationUri } : {}),
        ...(session.userCode ? { userCode: session.userCode } : {}),
        ...(session.error ? { error: session.error } : {}),
      },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Collegamento non riuscito: riprova.' },
      { status: 503 }
    );
  }
}
