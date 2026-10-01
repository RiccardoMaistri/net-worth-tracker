/**
 * The Trade Republic session holder and the read surface built on it.
 *
 * WHY THIS EXISTS BESIDE `tradeRepublicQr.ts`: that module does the HANDSHAKE (cookies in) and
 * this one owns the session from then on. The split is not tidiness — the two have opposite
 * storage postures. The in-flight approval is worthless a second after it succeeds and lives in
 * memory; the session is a live credential that must OUTLIVE the process, because a container
 * restart on a NAS is routine and re-scanning a QR to read a net worth would be absurd.
 *
 * So the session is persisted to `brokerSessions/{ownerId}` through the Admin SDK, in the SDK's own
 * serialized form — the same string `client.exportSession()` returns, which is what makes the
 * SDK's own refresh timer meaningful across restarts: it renews the cookies in place and this
 * module writes the new string back after every read. The envelope itself is owned by
 * `lib/utils/tradeRepublicSession.ts`; `version` is the NUMBER `1`, because arktype reads the
 * schema's quoted `"1"` as a number. Getting that wrong is not theoretical: it produced
 * «Invalid exported Session» on the first sync of a login that had itself succeeded.
 *
 * The collection is `allow read, write: if false` in `firestore.rules`: a session cookie is a
 * credential, so no client SDK may ever read it. The companion `brokerConnections` collection stays
 * metadata-only, as its docstring demands.
 *
 * PERMISSIONS, and the reason this bridge is safe to expose: this client can SUBSCRIBE to topics
 * and it holds a session that could in principle place an order. Nothing here writes — the read
 * surface below is a closed list of three topic reads, and the app never calls a write accessor.
 * That is the same posture `scalableCli.ts` takes with `sc --local-read-only`, arrived at from
 * the other side: Trade Republic has no read-only session flag, so the guarantee is structural (a
 * whitelist in this file) rather than a broker-side setting. Do not add a command here.
 *
 * The one deliberate exception below that line is `readTrTickerQuotes`: a read-only quote feed
 * (`bid`/`ask`/`last`, no order accessor exists on the topic), used only to price positions the
 * payload reports without a quote. It is NOT a route command — `TR_READ_COMMANDS` is unchanged —
 * and it cannot fail a sync, by construction (per-instrument timeout, fail-open).
 */

import 'server-only';

import { TRClient } from 'trade-republic-sdk';
import { adminDb } from '@/lib/firebase/admin';
import {
  parseTrSession,
  serializeTrSession,
  type TrCookieJar,
} from '@/lib/utils/tradeRepublicSession';

const SESSIONS_COLLECTION = 'brokerSessions';

/** The three reads, and nothing else. See the header: this whitelist IS the write guarantee. */
export const TR_READ_COMMANDS = ['positions', 'cash', 'savingsPlans'] as const;
export type TrReadCommand = (typeof TR_READ_COMMANDS)[number];

/**
 * One instrument quote, in the venue's currency (EUR on Lang & Schwarz — the broker's own
 * execution venue, where every position it reports is tradable by definition).
 */
export interface TrTickerQuote {
  price: number;
}

/** How long one stalled quote may hold the sync before it is skipped, not awaited. */
const TICKER_QUOTE_TIMEOUT_MS = 8_000;

/** A dead session is a 401, a missing link is a 409: they need different words from the user. */
export class TradeRepublicAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 409
  ) {
    super(message);
    this.name = 'TradeRepublicAuthError';
  }
}

export class TradeRepublicReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradeRepublicReadError';
  }
}

// ─── Session persistence ─────────────────────────────────────────────────────

/**
 * The stored session, normalized to the form the SDK accepts.
 *
 * `parseTrSession` is what heals a session written with the legacy string version: its cookies are
 * fine, and re-scanning a QR to repair a serialisation detail would be the wrong advice. A
 * document that does not parse is reported as «not linked» — a failed read is NOT an empty session.
 */
async function readStoredSession(ownerId: string): Promise<string | null> {
  const snap = await adminDb.collection(SESSIONS_COLLECTION).doc(ownerId).get();
  if (!snap.exists) return null;
  const session = snap.get('session');
  if (typeof session !== 'string' || session === '') return null;
  const cookies = parseTrSession(session);
  return cookies ? serializeTrSession(cookies) : null;
}

async function writeStoredSession(ownerId: string, session: string): Promise<void> {
  await adminDb
    .collection(SESSIONS_COLLECTION)
    .doc(ownerId)
    .set({ userId: ownerId, session, updatedAt: new Date() }, { merge: true });
}

export async function deleteTradeRepublicSession(ownerId: string): Promise<void> {
  await adminDb.collection(SESSIONS_COLLECTION).doc(ownerId).delete();
}

// ─── The client, per owner ───────────────────────────────────────────────────

interface OwnerClient {
  client: TRClient;
  /** The securities account number, resolved once: two of the three reads require it. */
  securitiesAccountNumber?: string;
}

const clients = new Map<string, OwnerClient>();

/**
 * The live client for this owner, built from the persisted session.
 *
 * Cached per owner because the client owns a WebSocket: one per sync would open and drop a
 * connection each time, which the broker rate-limits. On a long-lived host the map is the right
 * shape; a serverless one is already refused at the login.
 */
async function ownerClient(ownerId: string): Promise<OwnerClient> {
  const cached = clients.get(ownerId);
  if (cached) return cached;

  const session = await readStoredSession(ownerId);
  if (!session) {
    throw new TradeRepublicAuthError(
      'Trade Republic non è collegato: avvia il collegamento con il codice QR.',
      409
    );
  }

  const client = buildClient(ownerId, session);
  // The SDK never assumes a restored session is valid, it only attempts it: a rejected one must
  // surface as a re-link prompt, not as an empty portfolio.
  if (client.session.getSnapshot().validity === 'rejected') {
    clients.delete(ownerId);
    throw new TradeRepublicAuthError(
      'La sessione Trade Republic è scaduta: ricollegati con il codice QR.',
      401
    );
  }

  const entry: OwnerClient = { client };
  clients.set(ownerId, entry);
  return entry;
}

/**
 * Build the client, turning a REFUSED session into a re-link prompt.
 *
 * The constructor parses the stored session, so a document it cannot accept throws HERE — before
 * any topic read, and with an arktype message about a serialization detail. Left uncaught it
 * surfaced as «Invalid exported Session» and a bare 500 on the first sync of a login that had
 * itself succeeded. A stored session the SDK refuses IS a dead session, and the user's next action
 * is the same either way: scan again.
 */
function buildClient(ownerId: string, session: string): TRClient {
  try {
    return new TRClient({ session });
  } catch {
    // The SDK's own message names a serialization detail («Invalid exported Session») that would
    // mean nothing to a reader, so it is dropped rather than shown: what they must do is re-link.
    clients.delete(ownerId);
    throw new TradeRepublicAuthError(
      'La sessione Trade Republic salvata non è più utilizzabile: ricollegati con il codice QR.',
      401
    );
  }
}

/** Drops the cached client for an owner — after a re-link, and from tests. */
export function resetTradeRepublicClient(ownerId?: string): void {
  if (ownerId) clients.delete(ownerId);
  else clients.clear();
}

// ─── The read surface ────────────────────────────────────────────────────────

/**
 * The broker's OWN quotes for a list of ISINs — `last`, falling back to `bid`.
 *
 * Why this exists beside the Yahoo path: the positions payload carries no quote, and Yahoo
 * cannot quote a bare ISIN — so without this every synced position entered at 0. The `ticker`
 * topic IS quotable per ISIN (`<ISIN>.LSX`, measured live: TSLA 310,7 €, VWCE 169,44 €), needs
 * no session (it is a public topic, though it is read here through the session client for
 * connection reuse), and quotes in EUR on the broker's own venue — no FX, no symbol mapping.
 *
 * FAIL-OPEN per instrument, always: an unquotable ISIN (or a stalled subscription — observed
 * live: a quote that never arrives hangs `get()` forever, hence the timeout) is simply absent
 * from the map, and the caller falls back to Yahoo / the manual field exactly as before. A
 * quote read must never be able to break a sync.
 *
 * NOT a fourth route command: `TR_READ_COMMANDS` stays the user-facing surface (positions,
 * cash, savings plans). This is an internal enrichment step, read-only market data — it does
 * not touch the write guarantee the header describes.
 */
export async function readTrTickerQuotes(
  ownerId: string,
  isins: string[]
): Promise<Map<string, TrTickerQuote>> {
  const quotes = new Map<string, TrTickerQuote>();
  if (isins.length === 0) return quotes;
  const entry = await ownerClient(ownerId);
  await Promise.all(
    isins.map(async (isin) => {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TICKER_QUOTE_TIMEOUT_MS));
      try {
        const tick = await Promise.race([entry.client.ticker.get({ id: `${isin}.LSX` }), timeout]);
        if (!tick) return;
        const raw = tick.last?.price ?? tick.bid?.price;
        const price = typeof raw === 'string' ? Number.parseFloat(raw.replace(',', '.')) : NaN;
        if (Number.isFinite(price) && price > 0) quotes.set(isin, { price });
      } catch {
        // Unquotable here is not an error: the Yahoo/manual path covers it.
      }
    })
  );
  return quotes;
}

async function securitiesAccountNumber(entry: OwnerClient): Promise<string> {
  if (entry.securitiesAccountNumber) return entry.securitiesAccountNumber;
  const pairs = await entry.client.accountPairs.get({});
  const number = pairs.accounts[0]?.securitiesAccountNumber;
  if (!number) {
    throw new TradeRepublicReadError(
      'Trade Republic non ha restituito il conto titoli: controlla di aver aperto almeno un deposito titoli.'
    );
  }
  entry.securitiesAccountNumber = number;
  return number;
}

/**
 * The saved session string, or null when this owner never linked. Read by the UI to tell
 * «non collegato» from «collegato ma mai sincronizzato», which are different sentences.
 */
export async function hasTradeRepublicSession(ownerId: string): Promise<boolean> {
  try {
    return (await readStoredSession(ownerId)) !== null;
  } catch {
    // A failed read is NOT an absent session: saying «non collegato» would send the user to
    // re-scan a QR for a session that is probably still fine.
    return true;
  }
}

/**
 * One read, one parsed payload, under its own key — the response contract the Scalable route is
 * held to by `__tests__/scalableReadRoute.test.ts`, and for the same reason: a per-command `plan`
 * envelope was read as `undefined`, silently became `[]`, and the preview showed zero positions
 * while declaring the sync successful. The plan is composed in the client, which already holds the
 * tracked assets.
 */
export async function readTradeRepublic(
  ownerId: string,
  command: TrReadCommand
): Promise<unknown> {
  if (!TR_READ_COMMANDS.includes(command)) {
    throw new TradeRepublicReadError('Lettura non supportata.');
  }
  const entry = await ownerClient(ownerId);
  try {
    let payload: unknown;
    if (command === 'cash') {
      payload = await entry.client.cash.get({});
    } else {
      const secAccNo = await securitiesAccountNumber(entry);
      payload =
        command === 'positions'
          ? await entry.client.compactPortfolioByType.get({ secAccNo })
          : await entry.client.savingsPlans.get({ secAccNo });
    }
    // The SDK renews its cookies on its own timer; writing them back is what makes that renewal
    // survive a restart. Fire-and-forget like every other cache write, and never let a failed
    // write fail a read that already succeeded.
    void persistRefreshedSession(ownerId, entry.client);
    return payload;
  } catch (error) {
    if (error instanceof TradeRepublicAuthError) throw error;
    const status = entry.client.session.getSnapshot().validity;
    if (status === 'rejected' || status === 'absent') {
      resetTradeRepublicClient(ownerId);
      throw new TradeRepublicAuthError(
        'La sessione Trade Republic non è più valida: ricollegati con il codice QR.',
        401
      );
    }
    throw new TradeRepublicReadError(
      error instanceof Error ? error.message : 'Lettura non riuscita: riprova.'
    );
  }
}

async function persistRefreshedSession(ownerId: string, client: TRClient): Promise<void> {
  try {
    const session = client.exportSession();
    if (session) await writeStoredSession(ownerId, session);
  } catch (error) {
    // A fire-and-forget whose catch only logs is verified by READING the document it should have
    // written — so this one says what it lost instead of swallowing it.
    console.warn(`[traderepublic] could not persist the refreshed session for ${ownerId}:`, error);
  }
}

/** Called by the login status route once the handshake is approved: cookies in, session stored. */
export async function adoptTradeRepublicSession(ownerId: string, cookies: TrCookieJar): Promise<void> {
  await writeStoredSession(ownerId, serializeTrSession(cookies));
  resetTradeRepublicClient(ownerId);
}
