/**
 * Start a Scalable device-flow login — POST /api/broker/scalable/login/start.
 *
 * Launches `sc login --local-read-only` on this machine and answers with the verification URL
 * and the user code for the frontend to show. The user approves in their own browser, with
 * their own MFA; nothing about that ever crosses this route.
 *
 * Body: { ownerId: string }
 * Answer: { sessionId, status, verificationUri, userCode }
 *
 * Owner-scoped like every broker route. Needs a long-lived host — see scalableLogin.ts.
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
import { publicLoginView, startScalableLogin } from '@/lib/server/scalableLogin';

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
    return NextResponse.json(publicLoginView(startScalableLogin(validated.data.ownerId)), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Collegamento non riuscito: riprova.' },
      { status: 503 }
    );
  }
}
