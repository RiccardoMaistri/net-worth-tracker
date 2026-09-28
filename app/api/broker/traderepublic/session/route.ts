/**
 * Revoke the Trade Republic session — DELETE /api/broker/traderepublic/session.
 *
 * EXISTS PERCHÉ UNA SESSIONE È UNA CREDENZIALE, e una credenziale senza revoca è un difetto: la
 * sessione vive in `brokerSessions/{ownerId}` e si rinnova da sola, quindi senza questo pulsante
 * l'unico modo di toglierla è attendere che scada. «Ricollega» non serve: riapre un challenge
 * sopra la sessione viva.
 *
 * DELETE e non POST: l'azione è idempotente e il sua effetto è una cancellazione, quindi il
 * metodo lo dice. Revocare due volte non è un errore — è già revocato.
 *
 * Owner-scoped come ogni route broker. Il documento sparisce, ma la sessione Trade Republic resta
 * valida finché il broker non la scade: per una revoca vera, revocala anche dall'app
 * Trade Republic (Impostazioni › Accessi), che è l'unico modo di invalidarla lato broker.
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
import {
  deleteTradeRepublicSession,
  hasTradeRepublicSession,
  resetTradeRepublicClient,
} from '@/lib/server/tradeRepublicClient';

const bodySchema = z.object({ ownerId: z.string().min(1) });

/**
 * Is there a session? A BOOLEAN and nothing else.
 *
 * It exists because the tile's «collegato / non collegato» was reading the sync METADATA, which
 * makes «collegato» false for someone who linked and has not pressed Sincronizza yet — a state
 * the session knows about and the metadata does not. The cookies never leave the server: the
 * answer is a boolean derived from whether the document exists.
 *
 * Query: ownerId (required)
 * Answer: { connected: boolean }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  let decoded;
  try {
    decoded = await requireFirebaseAuth(request);
  } catch (error) {
    return getApiAuthErrorResponse(error) ?? NextResponse.json({ error: 'Non autenticato.' }, { status: 401 });
  }

  const ownerId = request.nextUrl.searchParams.get('ownerId');
  if (!ownerId) {
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

  return NextResponse.json({ connected: await hasTradeRepublicSession(ownerId) });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  let decoded;
  try {
    decoded = await requireFirebaseAuth(request);
  } catch (error) {
    return getApiAuthErrorResponse(error) ?? NextResponse.json({ error: 'Non autenticato.' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const validated = parseOr400(bodySchema, body);
  if (!validated.ok) return validated.response;

  const { ownerId } = validated.data;
  try {
    await assertCanAccessAccount(decoded, ownerId);
  } catch (error) {
    return (
      getApiAuthErrorResponse(error) ??
      NextResponse.json({ error: 'Accesso negato.' }, { status: 403 })
    );
  }

  try {
    await deleteTradeRepublicSession(ownerId);
    // Drop the cached client too: it holds the live socket and the old cookies in memory, so
    // deleting only the document would leave this process still able to read the account.
    resetTradeRepublicClient(ownerId);
    return NextResponse.json({ revoked: true });
  } catch (error) {
    console.error('[traderepublic/session] revoke failed', error);
    return NextResponse.json({ error: 'Revoca non riuscita: riprova.' }, { status: 503 });
  }
}
