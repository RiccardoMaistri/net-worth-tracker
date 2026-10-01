/**
 * Server side of the Scalable read-only bridge — NEVER imported by client code.
 *
 * Each authorized Google email gets its own broker PROFILE, and each profile its own
 * `XDG_CONFIG_HOME` (`scalableProfileXdgHome` in `scalableCli.ts`): session file, DPoP key
 * and refresh token live under that directory, so two emails on one host never share a
 * broker session. Who is authorized is deployment config (`SCALABLE_PROFILES`), not source.
 *
 * Login sessions and the 60s read cache are per PROCESS and in memory: a restart forgets
 * them (the client reads that as «riavvia il collegamento», not as a failure). The bridge
 * needs a long-lived host — on serverless `assertLongLivedHost` refuses the click instead
 * of starting a login that could never complete.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  SCALABLE_LOGIN_ARGS,
  ensureScalableConfigFile,
  scalableCliPath,
  scalableProfileXdgHome,
  runScalableReadCommand,
  ScalableCliError,
  ScalableReadCommand,
} from '@/lib/server/scalableCli';
import {
  parseScalableHoldingsJson,
  parseScalableOverviewJson,
  parseScalableOvernightJson,
  type ScalableHoldingInput,
  type ScalableOverviewInput,
  type ScalableOvernightInput,
} from '@/lib/utils/scalableImport';

export type ScalableConnectionStatus =
  | 'NOT_CONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'AUTHENTICATION_REQUIRED'
  | 'ERROR';

export interface ScalableProfileConfig {
  profile: string;
  name: string;
}

/**
 * Who may use the bridge, as `profilo:email,profilo:email` (server-only `SCALABLE_PROFILES`,
 * no `NEXT_PUBLIC_` prefix — it must never reach the client bundle, like REGISTRATION_WHITELIST).
 *
 * The profile id becomes a directory name under the session volume, so only `[A-Za-z0-9_-]`
 * survives parsing; anything else is dropped, never sanitized into something else.
 */
export function parseScalableProfiles(raw: string | undefined): Record<string, ScalableProfileConfig> {
  const map: Record<string, ScalableProfileConfig> = {};
  for (const entry of (raw ?? '').split(',')) {
    const [profile, email] = entry.split(':').map((part) => part.trim());
    if (!profile || !email || !/^[A-Za-z0-9_-]+$/.test(profile)) continue;
    map[email.toLowerCase()] = {
      profile,
      name: profile.charAt(0).toUpperCase() + profile.slice(1),
    };
  }
  return map;
}

/**
 * Normalizes the caller's Google email and returns its broker profile, or null when the
 * email is not authorized. The lookup runs per call (not cached) so a redeploy or a
 * container restart picks up a changed `SCALABLE_PROFILES` with no code change.
 */
export function getScalableProfileForEmail(email?: string | null): ScalableProfileConfig | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return parseScalableProfiles(process.env.SCALABLE_PROFILES)[normalized] ?? null;
}

/**
 * Refuse where the login flow cannot work. A serverless platform reclaims the instance
 * between requests: the child dies and the session write is lost, so the sync would report
 * a session that never existed. Better to say so once, at the point of the click — the
 * login route answers this as a 503 with the paste-JSON fallback as the remedy.
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
 * The `XDG_CONFIG_HOME` a profile's CLI invocations run under — one directory per email.
 * Kept as the named seam so tests can pin the `profiles/<profile>` shape in one place.
 */
export function getProfileXdgConfigHome(profile: string): string {
  return scalableProfileXdgHome(profile);
}

// ─── Cache Layer (In-memory per profile) ───────────────────────────────────

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds TTL

class ProfileCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(profile: string, key: string): T | null {
    const entry = this.store.get(`${profile}:${key}`);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.store.delete(`${profile}:${key}`);
      return null;
    }
    return entry.data as T;
  }

  set<T>(profile: string, key: string, data: T): void {
    this.store.set(`${profile}:${key}`, { data, timestamp: Date.now() });
  }

  clear(profile: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(`${profile}:`)) {
        this.store.delete(key);
      }
    }
  }

  clearAll(): void {
    this.store.clear();
  }
}

const cache = new ProfileCache();

/** Test seam: drops every cached reading, so suites observe the CLI and not each other. */
export function clearScalableCache(): void {
  cache.clearAll();
}

// ─── Login Sessions Management ──────────────────────────────────────────────

export interface ScalableServiceLoginSession {
  id: string;
  profile: string;
  status: 'pending' | 'approved' | 'failed' | 'expired';
  verificationUri?: string;
  userCode?: string;
  error?: string;
  startedAt: number;
}

const loginSessions = new Map<string, ScalableServiceLoginSession>();
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const ENTRY_TTL_MS = 30 * 60 * 1000;

function pruneLoginSessions(now: number): void {
  for (const [id, session] of loginSessions) {
    if (now - session.startedAt > ENTRY_TTL_MS) loginSessions.delete(id);
  }
}

export function parseScalableLoginPrompt(output: string): { verificationUri: string; userCode: string } | null {
  const match = output.match(/https:\/\/[^\s]*\?user_code=([A-Za-z0-9-]+)/);
  if (!match) return null;
  return { verificationUri: match[0], userCode: match[1].toUpperCase() };
}

// ─── ScalableService Class ──────────────────────────────────────────────────

export class ScalableService {
  /**
   * Run one whitelisted read command under the profile's own `XDG_CONFIG_HOME` — the child
   * env is replaced for that invocation only, never `process.env` itself. The config file
   * is ensured by `runScalableReadCommand`, so there is exactly one writer of it.
   */
  private static async runReadCommand(profile: string, command: ScalableReadCommand): Promise<string> {
    return await runScalableReadCommand(command, {
      env: { XDG_CONFIG_HOME: getProfileXdgConfigHome(profile) },
    });
  }

  /**
   * Checks the connection status of the given profile.
   */
  static async getConnectionStatus(profile: string): Promise<ScalableConnectionStatus> {
    for (const session of loginSessions.values()) {
      if (session.profile === profile && session.status === 'pending') {
        return 'CONNECTING';
      }
    }

    try {
      await this.runReadCommand(profile, 'overview');
      return 'CONNECTED';
    } catch (error) {
      if (error instanceof ScalableCliError) {
        if (error.status === 401) return 'AUTHENTICATION_REQUIRED';
        if (error.status === 503) return 'NOT_CONNECTED';
      }
      return 'ERROR';
    }
  }

  /**
   * Gets portfolio overview for profile (cached).
   */
  static async getPortfolioOverview(profile: string): Promise<ScalableOverviewInput> {
    const cached = cache.get<ScalableOverviewInput>(profile, 'overview');
    if (cached) return cached;

    const stdout = await this.runReadCommand(profile, 'overview');
    const overview = parseScalableOverviewJson(stdout);
    cache.set(profile, 'overview', overview);
    return overview;
  }

  /**
   * Gets holdings for profile (cached).
   */
  static async getHoldings(profile: string): Promise<{ holdings: ScalableHoldingInput[]; skipped: number }> {
    const cached = cache.get<{ holdings: ScalableHoldingInput[]; skipped: number }>(profile, 'holdings');
    if (cached) return cached;

    const stdout = await this.runReadCommand(profile, 'holdings');
    const res = parseScalableHoldingsJson(stdout);
    cache.set(profile, 'holdings', res);
    return res;
  }

  /**
   * Gets overnight deposit details for profile. A successful read is cached for 60s like the
   * other commands; a FAILED read is deliberately NOT cached and stays `null` — a failure is
   * not a reading, and the client declares it («Deposito non vincolato non letto») instead of
   * showing an emptied account. The next sync retries.
   */
  static async getOvernight(profile: string): Promise<ScalableOvernightInput | null> {
    const cached = cache.get<ScalableOvernightInput>(profile, 'overnight');
    if (cached !== null) return cached;

    try {
      const stdout = await this.runReadCommand(profile, 'overnight');
      const overnight = parseScalableOvernightJson(stdout);
      cache.set(profile, 'overnight', overnight);
      return overnight;
    } catch {
      return null;
    }
  }

  /**
   * Start a device-flow login for the profile, or hand back the one already running for it
   * (a second click must not orphan a child process, and the user keeps the code shown).
   */
  static startLogin(profile: string): ScalableServiceLoginSession {
    assertLongLivedHost();
    const profileXdg = getProfileXdgConfigHome(profile);
    ensureScalableConfigFile(profileXdg);
    const now = Date.now();
    pruneLoginSessions(now);

    for (const session of loginSessions.values()) {
      if (session.profile === profile && session.status === 'pending') return session;
    }

    const child = spawn(scalableCliPath(), [...SCALABLE_LOGIN_ARGS], {
      // stdin ignored is what was measured to work: the CLI must not wait for a terminal.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, XDG_CONFIG_HOME: profileXdg },
    });

    const session: ScalableServiceLoginSession = {
      id: randomUUID(),
      profile,
      status: 'pending',
      startedAt: now,
    };
    loginSessions.set(session.id, session);

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
      session.error = 'La richiesta di collegamento è scaduta: riavvia per un nuovo codice.';
      child.kill('SIGKILL');
    }, LOGIN_TIMEOUT_MS);
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
        cache.clear(profile);
      } else {
        session.status = 'failed';
        session.error = /not logged in|no_session|expired|denied|cancel/i.test(output)
          ? 'Collegamento non completato: la richiesta è scaduta o è stata rifiutata.'
          : 'Collegamento non riuscito: riprova.';
      }
    });

    return session;
  }

  /**
   * Read a session back. The profile is required: without it, any authorized caller could
   * poll another email's login — a session of another profile answers 404 as if missing.
   */
  static getLoginSession(sessionId: string, profile: string): ScalableServiceLoginSession | null {
    pruneLoginSessions(Date.now());
    const session = loginSessions.get(sessionId);
    if (!session || session.profile !== profile) return null;
    return session;
  }
}

/** Test seam: drops every login session. */
export function resetScalableLogins(): void {
  loginSessions.clear();
}
