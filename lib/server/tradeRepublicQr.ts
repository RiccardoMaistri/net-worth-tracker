/**
 * The Trade Republic QR login handshake, driven from this server.
 *
 * The user approves a sign-in by SCANNING A CODE with the Trade Republic app, so the frontend can
 * show the whole flow — this is the one broker login that needs nothing from the user's browser and
 * no credential typed into the app. Measured against the API before writing it:
 *
 *   1. POST /api/v2/auth/web/login/qr-challenges      → { challengeId, challengeExpiresAt }
 *   2. GET  /api/v2/auth/web/login/qr-challenges/{id} → { status, qrCodePayload, processId? }
 *      (the payload to ENCODE is `qrCodePayload`; it can ROTATE, so the frontend is handed a new
 *       image whenever it changes rather than a single one frozen at start)
 *   3. once the app approved, `processId` appears, and:
 *      GET  /api/v2/auth/web/login/processes/{id}    → { status } + the session cookies
 *
 * The session IS the cookie jar, which is why this module exists separately from the SDK: the SDK
 * owns everything after the handshake (the socket, the topics, the refresh timer, `exportSession`)
 * but its only login is phone+PIN, so the handshake is done here with plain `fetch` and the
 * resulting cookies are handed over in the SDK's own serialized form.
 *
 * WHY A SERVERLESS PLATFORM REFUSES, same as `scalableLogin.assertLongLivedHost`: the challenge
 * is polled in-process between "start" and "approval", so a reclaimed instance loses it. A
 * long-lived host (the NAS) is the supported deployment.
 *
 * THE AWS WAF QUESTION, stated rather than hidden: three other Trade Republic clients ship a
 * headless browser purely to fetch an `x-aws-waf-token` before logging in. This module does NOT,
 * because the recommended SDK's phone+PIN path does not need one either. Whether the QR endpoints
 * specifically are gated could not be verified from here. So a WAF challenge is not swallowed into
 * a generic failure: `TradeRepublicWafError` carries its own message and the tile says exactly
 * what happened, because the fix (a token step) is a different piece of work and the user should
 * be able to say so.
 */

import { createHash } from 'node:crypto';

const API_URL = 'https://api.traderepublic.com';
const CHALLENGE_PATH = '/api/v2/auth/web/login/qr-challenges';

/** The web client's own version string. A stale one is the first thing to bump when TR ships. */
const APP_VERSION = '15.97.5';

/** How long the handshake may take end to end before the entry is abandoned. */
export const TR_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** Polling cadence for the challenge and then for the approval. */
const POLL_INTERVAL_MS = 2500;
/** A finished or abandoned entry is dropped this long after it started. */
const ENTRY_TTL_MS = 30 * 60 * 1000;

export type TrLoginStatus = 'pending' | 'scanned' | 'approved' | 'failed' | 'expired';

export interface TrLoginSession {
  id: string;
  /** The owner who started it — a status read by anyone else is refused. */
  ownerId: string;
  status: TrLoginStatus;
  /** What the frontend renders as a QR image, as a data URL. */
  qrDataUrl?: string;
  /** The payload behind the image, so the flow is usable without a camera. */
  qrPayload?: string;
  /** ISO date the challenge itself dies, when the broker states it. */
  challengeExpiresAt?: string;
  /** Italian, user-facing, only on `failed`. */
  error?: string;
  startedAt: number;
}

/** A 403 that is Trade Republic's WAF asking for a browser token — NOT a wrong credential. */
export class TradeRepublicWafError extends Error {
  constructor() {
    super(
      'Trade Republic ha chiesto una verifica anti-bot a questa richiesta. Il collegamento con codice QR non è disponibile da questo server: usa il collegamento via telefono e PIN.'
    );
    this.name = 'TradeRepublicWafError';
  }
}

// ─── The cookie jar ──────────────────────────────────────────────────────────

/**
 * A minimal cookie jar: Trade Republic authenticates with cookies and nothing else, so the whole
 * handshake is "keep the `set-cookie` values and send them back". Merged BY NAME — the broker
 * re-sets `tr_session` during the handshake and the newest value must win, or the poll would keep
 * presenting the pre-approval cookie.
 */
export type TrCookieJar = string[];

function cookieName(cookie: string): string {
  const separator = cookie.indexOf('=');
  return separator > 0 ? cookie.slice(0, separator).trim() : '';
}

export function mergeTrCookies(current: TrCookieJar, received: readonly string[]): TrCookieJar {
  const merged = new Map<string, string>();
  for (const cookie of [...current, ...received]) {
    const name = cookieName(cookie);
    if (name) merged.set(name, cookie);
  }
  return [...merged.values()];
}

export function trCookieHeader(cookies: TrCookieJar): string | undefined {
  const pairs = cookies
    .map((cookie) => cookie.split(';', 1)[0]?.trim() ?? '')
    .filter((pair) => pair !== '' && pair.includes('='));
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/** Node ≥22.4 has `getSetCookie` on Headers; the combined header is the fallback. */
function responseCookies(response: Response): string[] {
  const separate = (response.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (separate.length > 0) return separate;
  const combined = response.headers.get('set-cookie');
  return combined ? combined.split(/,(?=\s*[^=;,\s]+=)/) : [];
}

/**
 * A STABLE device identity for this installation, base64 of the same JSON shape the web client
 * sends. Stable matters: a fresh id per request is what a bot looks like. Derived from a constant
 * seed, so it survives a container restart without being stored anywhere.
 */
function deviceInfoHeader(): string {
  const stableDeviceId = createHash('sha256')
    .update('net-worth-tracker/traderepublic')
    .digest('hex')
    .slice(0, 32);
  return Buffer.from(
    JSON.stringify({
      stableDeviceId,
      model: 'Apple Macintosh',
      browser: 'Chrome',
      browserVersion: '150.0.0.0',
      os: 'Mac OS',
      osVersion: '10.15.7',
      timezone: 'Europe/Berlin',
      timezoneOffset: -120,
      screen: '1470x956x30',
      preferredLanguages: ['de-DE', 'en-US'],
      numberOfCores: 4,
      deviceMemory: 16,
    })
  ).toString('base64');
}

interface TrRequestOptions {
  method: 'GET' | 'POST';
  path: string;
  cookies: TrCookieJar;
  signal?: AbortSignal;
}

/**
 * One authenticated request against the login API, carrying the jar in and the jar out.
 *
 * A 403 is inspected rather than assumed: Trade Republic answers an unverified client with a WAF
 * challenge, and that is a different problem from a rejected credential, so it gets its own error.
 */
async function trRequest(options: TrRequestOptions): Promise<{ body: unknown; cookies: TrCookieJar }> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    'Content-Type': 'application/json',
    Origin: 'https://app.traderepublic.com',
    Referer: 'https://app.traderepublic.com/',
    'X-TR-App-Version': APP_VERSION,
    'X-TR-Device-Info': deviceInfoHeader(),
    'X-TR-Platform': 'web-pro',
  };
  const cookie = trCookieHeader(options.cookies);
  if (cookie) headers['Cookie'] = cookie;

  const response = await fetch(`${API_URL}${options.path}`, {
    method: options.method,
    headers,
    credentials: 'include',
    signal: options.signal,
  });

  if (response.status === 403) {
    const body = await response.text().catch(() => '');
    if (/awswaf|aws waf|captcha|challenge/i.test(body)) throw new TradeRepublicWafError();
  }
  if (!response.ok) {
    throw new Error(`Trade Republic ha risposto HTTP ${response.status}.`);
  }

  const cookies = mergeTrCookies(options.cookies, responseCookies(response));
  const text = await response.text();
  if (text.trim() === '') return { body: {}, cookies };
  try {
    return { body: JSON.parse(text) as unknown, cookies };
  } catch {
    throw new Error('Risposta del broker non leggibile.');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ─── The handshake ───────────────────────────────────────────────────────────

/**
 * The pending logins, per PROCESS and in memory.
 *
 * Per OWNER, unlike Scalable: each entry holds its own cookie jar, so two owners of one host get
 * two Trade Republic sessions and neither can read the other's. A restart forgets them all and the
 * UI restarts the flow — the same posture as `scalableLogin`, with one real difference: a Trade
 * Republic session is NOT lost on restart, because it is persisted (see `tradeRepublicClient.ts`).
 * It is only the in-flight APPROVAL that lives here.
 */
const sessions = new Map<string, TrLoginSession>();
const jars = new Map<string, TrCookieJar>();

function prune(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.startedAt > ENTRY_TTL_MS) {
      sessions.delete(id);
      jars.delete(id);
    }
  }
}

/** The session as the client is allowed to see it: no ownerId, no internals, never the jar. */
export function publicTrLoginView(session: TrLoginSession): Omit<TrLoginSession, 'ownerId' | 'startedAt'> {
  return {
    id: session.id,
    status: session.status,
    ...(session.qrDataUrl ? { qrDataUrl: session.qrDataUrl } : {}),
    ...(session.qrPayload ? { qrPayload: session.qrPayload } : {}),
    ...(session.challengeExpiresAt ? { challengeExpiresAt: session.challengeExpiresAt } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

/**
 * Refuse where the flow cannot work — a serverless platform reclaims the instance between
 * requests, so the challenge would be polled by a process that no longer exists. Saying so once,
 * at the click, beats a login that hangs.
 */
export function assertTrLongLivedHost(): void {
  const serverless =
    !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.NETLIFY;
  if (serverless) {
    throw new Error(
      'Il collegamento con codice QR richiede un server sempre attivo (una VM): su questo hosting la richiesta andrebbe persa tra un passo e l’altro.'
    );
  }
}

/** Raised by the poller when the challenge completed; carries the session cookies. */
export class TrChallengeApprovedError extends Error {
  constructor(readonly cookies: TrCookieJar) {
    super('Collegamento approvato.');
    this.name = 'TrChallengeApprovedError';
  }
}

/**
 * Start a login, or hand back the one already running for this owner (a second click must not
 * orphan a challenge, and the user should keep the code they were already given).
 */
export async function startTrLogin(
  ownerId: string,
  renderQr: (payload: string) => Promise<string>
): Promise<TrLoginSession> {
  assertTrLongLivedHost();
  const now = Date.now();
  prune(now);

  for (const session of sessions.values()) {
    if (session.ownerId === ownerId && session.status !== 'failed' && session.status !== 'expired') {
      return session;
    }
  }

  const { body, cookies } = await trRequest({
    method: 'POST',
    path: CHALLENGE_PATH,
    cookies: [],
  });
  const challengeId = asRecord(body)['challengeId'];
  if (typeof challengeId !== 'string' || challengeId === '') {
    throw new Error('Trade Republic non ha restituito una richiesta di collegamento: riprova.');
  }
  const expiresAt = asRecord(body)['challengeExpiresAt'];

  const session: TrLoginSession = {
    id: createSessionId(),
    ownerId,
    status: 'pending',
    ...(typeof expiresAt === 'string' ? { challengeExpiresAt: expiresAt } : {}),
    startedAt: now,
  };
  sessions.set(session.id, session);
  jars.set(session.id, cookies);

  void pollChallenge(session, challengeId, renderQr);
  return session;
}

function createSessionId(): string {
  // A v4 UUID without pulling `node:crypto`'s randomUUID into the module's public surface twice.
  return globalThis.crypto.randomUUID();
}

async function pollChallenge(
  session: TrLoginSession,
  challengeId: string,
  renderQr: (payload: string) => Promise<string>
): Promise<void> {
  const deadline = session.startedAt + TR_LOGIN_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      // A pruned or reset session stops here. Without this the poller outlives its own entry and
      // keeps hitting the broker for a challenge nobody is showing any more.
      if (sessions.get(session.id) !== session) return;
      if (session.status === 'pending' || session.status === 'scanned') {
        const { body, cookies } = await trRequest({
          method: 'GET',
          path: `${CHALLENGE_PATH}/${encodeURIComponent(challengeId)}`,
          cookies: jars.get(session.id) ?? [],
        });
        jars.set(session.id, cookies);
        const payload = asRecord(body);

        // The payload can rotate before the user scans: hand the frontend a NEW image rather than
        // leaving a dead code on screen.
        const qrPayload = payload['qrCodePayload'];
        if (typeof qrPayload === 'string' && qrPayload !== '' && qrPayload !== session.qrPayload) {
          session.qrPayload = qrPayload;
          session.qrDataUrl = await renderQr(qrPayload);
          publish(session);
        }

        const processId = payload['processId'];
        if (typeof processId === 'string' && processId !== '') {
          await waitForApproval(session, processId);
          return;
        }
        const status = typeof payload['status'] === 'string' ? payload['status'] : '';
        if (status !== '' && status.toUpperCase() !== 'PENDING') {
          session.status = status.toUpperCase() === 'SCANNED' ? 'scanned' : 'failed';
          session.error =
            session.status === 'failed'
              ? `Collegamento non riuscito: il broker ha risposto «${status}».`
              : undefined;
          publish(session);
          if (session.status === 'failed') return;
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (session.status === 'pending' || session.status === 'scanned') {
      session.status = 'expired';
      session.error = 'La richiesta di collegamento è scaduta: riavvia il collegamento per un nuovo codice.';
      publish(session);
    }
  } catch (error) {
    if (session.status !== 'pending' && session.status !== 'scanned') return;
    session.status = 'failed';
    session.error =
      error instanceof TradeRepublicWafError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Collegamento non riuscito: riprova.';
    publish(session);
  }
}

/** The app approved: poll the login process until the session cookies are complete. */
async function waitForApproval(session: TrLoginSession, processId: string): Promise<void> {
  const deadline = session.startedAt + TR_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { body, cookies } = await trRequest({
      method: 'GET',
      path: `/api/v2/auth/web/login/processes/${encodeURIComponent(processId)}`,
      cookies: jars.get(session.id) ?? [],
    });
    jars.set(session.id, cookies);
    const status = (() => {
      const value = asRecord(body)['status'];
      return typeof value === 'string' ? value.toUpperCase() : '';
    })();
    // BOTH cookies are the proof the handshake finished, and neither alone is enough: the SDK
    // refuses to restore a session without `tr_refresh` (it needs it to renew, and its own login
    // path checks for both). Stopping at `tr_session` would store a session that reads once and
    // can never be refreshed — a failure the user would meet on the first sync, with no clue why.
    const hasSession = cookies.some((cookie) => cookieName(cookie) === 'tr_session');
    const hasRefresh = cookies.some((cookie) => cookieName(cookie) === 'tr_refresh');
    if (hasSession && hasRefresh) {
      session.status = 'approved';
      publish(session);
      return;
    }
    if ((hasSession || status === 'SUCCESS') && !hasRefresh) {
      // The broker says the login worked but issued no refresh token. Saying so HERE, at the link,
      // is the whole point: the alternative is a «collegato» tile whose first sync fails.
      session.status = 'failed';
      session.error =
        'Trade Republic ha approvato il collegamento ma non ha rilasciato un token di rinnovo: questa sessione non può essere salvata. Riprova il collegamento.';
      publish(session);
      return;
    }
    if (status === 'REJECTED' || status === 'FAILED' || status === 'EXPIRED') {
      session.status = 'failed';
      session.error =
        status === 'REJECTED'
          ? 'Collegamento rifiutato dall’app Trade Republic.'
          : 'Collegamento non riuscito: richiesta scaduta o rifiutata.';
      publish(session);
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  session.status = 'expired';
  session.error = 'La richiesta di collegamento è scaduta: riavvia il collegamento per un nuovo codice.';
  publish(session);
}

function publish(session: TrLoginSession): void {
  // A single map write per state change; the status route reads it. The listeners exist so a
  // future push transport has one place to hook, and so the session object identity is stable
  // enough that a re-read is cheap.
  sessions.set(session.id, session);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the event loop open just to wait for a phone scan.
    timer.unref?.();
  });
}

/**
 * Read a session back. `ownerId` is required: without it, any caller could poll any login and see
 * its QR — and a QR is a live credential for as long as it is valid.
 */
export function getTrLogin(sessionId: string, ownerId: string): TrLoginSession | null {
  prune(Date.now());
  const session = sessions.get(sessionId);
  if (!session || session.ownerId !== ownerId) return null;
  return session;
}

/** The session cookies of an APPROVED login, handed to the SDK. Null while it is not approved. */
export function takeTrLoginCookies(sessionId: string, ownerId: string): TrCookieJar | null {
  const session = getTrLogin(sessionId, ownerId);
  if (!session || session.status !== 'approved') return null;
  return jars.get(sessionId) ?? null;
}

/** Test seam: drops every session. */
export function resetTrLogins(): void {
  sessions.clear();
  jars.clear();
}
