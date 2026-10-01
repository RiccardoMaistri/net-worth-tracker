/**
 * Scalable read-only proxy — POST /api/broker/scalable/read.
 *
 * Runs one of the three whitelisted `sc` read commands under the CALLER's broker profile
 * (`ScalableService`: `XDG_CONFIG_HOME` per whitelisted email) and returns the parsed
 * payload (positions or totals). Owner-scoped: the caller must own the account or hold a
 * grant over it, AND the caller's Google email must be in `SCALABLE_PROFILES`. No
 * credentials cross this route — the CLI session lives in the profile's directory on this
 * machine, and no request field ever reaches a command line.
 *
 * Body: { ownerId: string, command: 'holdings' | 'overview' | 'overnight' }
 *
 * Each command answers with its own parsed payload under its own key (`{ holdings, skipped }`,
 * `{ overview }`, `{ overnight }`); the client composes the plan from the three.
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

const bodySchema = z.object({
  ownerId: z.string().min(1),
  command: z.enum(['holdings', 'overview', 'overnight']),
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

  try {
    if (validated.data.command === 'holdings') {
      const { holdings, skipped } = await ScalableService.getHoldings(profileConfig.profile);
      return NextResponse.json({ holdings, skipped });
    }
    if (validated.data.command === 'overnight') {
      const overnight = await ScalableService.getOvernight(profileConfig.profile);
      return NextResponse.json({ overnight });
    }
    const overview = await ScalableService.getPortfolioOverview(profileConfig.profile);
    return NextResponse.json({ overview });
  } catch (error) {
    if (error instanceof ScalableCliError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[scalable/read] unexpected failure', error);
    return NextResponse.json({ error: 'Lettura non riuscita: riprova.' }, { status: 500 });
  }
}
