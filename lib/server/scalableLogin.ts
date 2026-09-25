/**
 * The Scalable device-flow login, driven from a server.
 *
 * `sc login` prints a verification URL and a user code, then waits for the person to approve
 * in their own browser (with their own MFA). That is a flow a UI CAN show: the frontend gets
 * the link, the user clicks it, the child process exits 0 and the session is in this machine's
 * keyring. Measured before building it — with stdout piped and stdin closed the CLI prints
 *
 *   Open this URL:
 *   https://secure.scalable.capital/activate?user_code=WWXH-KSTL
 *   Verify the code WWXH-KSTL in your browser.
 *   Waiting for browser confirmation...
 *
 * so `human_only` in `sc capabilities` is about the APPROVAL, not about needing a TTY.
 *
 * WHY THIS NEEDS A LONG-LIVED HOST, and it is not a preference: the token lands in the OS
 * keyring of the machine running the code, and the child process must survive between "start"
 * and the user's approval. On a serverless platform both die (the instance is reclaimed
 * between requests), so the session would be gone before the next sync. `assertLongLivedHost`
 * refuses instead of half-working.
 *
 * The session is per-process and in-memory: a restart forgets it, and the user simply logs in
 * again. It is NOT per-user — `sc` keeps ONE session per machine — so on a shared host two
 * owners would share the broker account. Fine for a personal deployment, and the guide says so.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SCALABLE_LOGIN_ARGS, scalableCliPath } from '@/lib/server/scalableCli';

export type ScalableLoginStatus = 'pending' | 'approved' | 'failed' | 'expired';

export interface ScalableLoginSession {
  id: string;
  /** The owner who started it — a status read by anyone else is refused. */
  ownerId: string;
  status: ScalableLoginStatus;
  /** What the frontend shows the user: open this, type/confirm this code. */
  verificationUri?: string;
  userCode?: string;
  /** Italian, user-facing, only on `failed`. */
  error?: string;
  startedAt: number;
}

/** How long we keep the child alive waiting for the approval. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** A finished entry is dropped this long after it started, so the map cannot grow forever. */
const ENTRY_TTL_MS = 30 * 60 * 1000;

/**
 * Pull the verification URL and the user code out of the CLI's output.
 *
 * Both come from the same `user_code=` capture, so they can never disagree: the code the
 * frontend shows is the one inside the link it opens. Returns null until the CLI has printed
 * enough — the output arrives in chunks, and this is called on each one.
 */
export function parseScalableLoginPrompt(output: string): { verificationUri: string; userCode: string } | null {
  const match = output.match(/https:\/\/[^\s]*\?user_code=([A-Za-z0-9-]+)/);
  if (!match) return null;
  return { verificationUri: match[0], userCode: match[1].toUpperCase() };
}

/**
 * Refuse where the flow cannot work. A serverless platform reclaims the instance between
 * requests: the child dies and the keyring write is lost, so the sync would report a session
 * that never existed. Better to say so once, at the point of the click.
 */
export function assertLongLivedHost(): void {
  const serverless =
    !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.NETLIFY;
  if (serverless) {
    throw new Error(
      'Il collegamento diretto richiede un server sempre attivo (una VM): su questo hosting la sessione andrebbe persa a ogni richiesta. Usa «Anteprima dal testo» incollando l’output della CLI.'
    );
  }
}

/**
 * The pending logins, per PROCESS and in memory.
 *
 * LA SESSIONE È PER MACCHINA, NON PER UTENTE. `sc` salva UN solo login nel keyring della
 * macchina, quindi due proprietari di uno stesso host condividono lo stesso conto broker: la
 * mappa qui sotto separa le sessioni LOGIN (chi ha avviato quale flusso, e chi può leggere il
 * suo stato), ma non le credenziali del broker, che restano condivise. Per isolarle serve
 * l'`XDG_CONFIG_HOME` per owner descritto sotto — non è ancora fatto.
 *
 * «Si può rendere multi-utente invalidando la sessione dopo ogni sync con `sc logout`?» No.
 * Il comando esiste, ma non risolve, per tre motivi:
 *   1. la finestra di esposizione è proprio la sync: fra «sessione salvata» e `logout` qualunque
 *      lettura in corso legge la sessione corrente, e una seconda richiesta la raggiunge;
 *   2. la sessione verrebbe eliminata dopo ogni sync, quindi servirebbe un MFA — quindi un link —
 *      PRIMA di ogni singola sincronizzazione: un uso che nessuno accetterebbe;
 *   3. non esiste un lock per macchina attorno alle invocazioni di `sc`: oggi due login (o un
 *      login e una sync) concorrenti si contendono lo stesso keyring.
 *
 * Per un host multi-utente la difesa minima onesta non è il logout ma un lock per macchina su
 * ogni invocazione di `sc` più un RIFIUTO esplicito quando la sessione corrente non è
 * dell'owner che chiede la sync — così un eventuale account sbagliato diventa un errore
 * visibile invece di dati altrui.
 *
 * IL MULTI-UTENTE È PERÒ POSSIBILE, e senza MFA a ogni sync: `sc` risolve la sua config da
 * `XDG_CONFIG_HOME` e con `[auth] session_backend = "file"` sposta la sessione dal keyring a
 * un file dentro quella directory. Un `XDG_CONFIG_HOME` PER OWNER (più la config.toml con
 * quel backend) dà a ciascuno la propria sessione, la propria chiave DPoP e il proprio
 * refresh token: il login si rinnova da solo e il logout non serve più. Misurato su questo
 * binario: con XDG_CONFIG_HOME vuoto l'errore è «DPoP signing key missing» (sessione trovata
 * nel keyring, chiave no), mentre con `session_backend = "file"` diventa «No active session» —
 * prova che il config è stato letto e lo store è un altro. Non è ancora implementato: è la
 * strada per un host condiviso, e richiede un lock per macchina più i permessi 0600 sulla
 * directory (un file su disco è più debole di un keyring).
 */
const sessions = new Map<string, ScalableLoginSession>();

function prune(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.startedAt > ENTRY_TTL_MS) sessions.delete(id);
  }
}

/** The session as the client is allowed to see it: no ownerId, no internals. */
export function publicLoginView(
  session: ScalableLoginSession
): Omit<ScalableLoginSession, 'ownerId' | 'startedAt'> {
  return {
    id: session.id,
    status: session.status,
    ...(session.verificationUri ? { verificationUri: session.verificationUri } : {}),
    ...(session.userCode ? { userCode: session.userCode } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

/**
 * Start a login, or hand back the one already running for this owner (a second click must not
 * orphan a child process, and the user should keep the code they were already given).
 */
export function startScalableLogin(ownerId: string): ScalableLoginSession {
  assertLongLivedHost();
  const now = Date.now();
  prune(now);

  for (const session of sessions.values()) {
    if (session.ownerId === ownerId && session.status === 'pending') return session;
  }

  const child = spawn(scalableCliPath(), [...SCALABLE_LOGIN_ARGS], {
    // stdin ignored is what was measured to work: the CLI must not wait for a terminal.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const session: ScalableLoginSession = { id: randomUUID(), ownerId, status: 'pending', startedAt: now };
  sessions.set(session.id, session);

  let output = '';
  const absorb = (chunk: Buffer) => {
    if (session.status !== 'pending') return;
    output += chunk.toString('utf8');
    const prompt = parseScalableLoginPrompt(output);
    if (prompt) {
      session.verificationUri = prompt.verificationUri;
      session.userCode = prompt.userCode;
    }
  };
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);

  const timer = setTimeout(() => {
    if (session.status !== 'pending') return;
    session.status = 'expired';
    session.error = 'La richiesta di collegamento è scaduta: riavvia il collegamento per un nuovo codice.';
    child.kill('SIGKILL');
  }, LOGIN_TIMEOUT_MS);
  // Never hold the event loop open just to wait for a browser approval.
  timer.unref?.();

  child.on('error', (error) => {
    clearTimeout(timer);
    if (session.status !== 'pending') return;
    session.status = 'failed';
    session.error =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Comando `sc` non trovato su questa macchina: installa la CLI Scalable e riprova.'
        : 'Non è stato possibile avviare il collegamento: riprova.';
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (session.status !== 'pending') return;
    if (code === 0) {
      session.status = 'approved';
    } else {
      session.status = 'failed';
      session.error = /not logged in|no_session|expired|denied|cancel/i.test(output)
        ? 'Collegamento non completato: la richiesta è scaduta o è stata rifiutata.'
        : 'Collegamento non riuscito: riprova.';
    }
  });

  return session;
}

/** Read a session back. `ownerId` is required: without it, any caller could poll any login. */
export function getScalableLogin(sessionId: string, ownerId: string): ScalableLoginSession | null {
  prune(Date.now());
  const session = sessions.get(sessionId);
  if (!session || session.ownerId !== ownerId) return null;
  return session;
}

/** Test seam: drops every session. */
export function resetScalableLogins(): void {
  sessions.clear();
}
