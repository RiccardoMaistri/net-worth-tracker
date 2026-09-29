import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  SCALABLE_LOGIN_ARGS,
  scalableCliPath,
  runScalableReadCommand,
  ScalableCliError,
  ScalableReadCommand,
} from '@/lib/server/scalableCli';
import {
  parseScalableHoldingsJson,
  parseScalableOverviewJson,
  parseScalableOvernightJson,
  ScalableParseError,
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
 * Whitelist of authorized Google users for Scalable Capital integration.
 * Emails must be stored in lowercase.
 */
export const SCALABLE_USERS: Record<string, ScalableProfileConfig> = {
  'rykymai@gmail.com': { profile: 'riccardo', name: 'Riccardo' },
  'michele.maistri@gmail.com': { profile: 'michele', name: 'Michele' },
};

/**
 * Normalizes email and returns profile config if authorized, or null if unauthorized.
 */
export function getScalableProfileForEmail(email?: string | null): ScalableProfileConfig | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return SCALABLE_USERS[normalized] ?? null;
}

/**
 * Determines XDG_CONFIG_HOME for a given profile to ensure session isolation.
 */
export function getProfileXdgConfigHome(profile: string): string {
  const baseDir = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config', 'scalable-cli');
  return path.join(baseDir, 'profiles', profile);
}

/**
 * Ensures that config.toml exists in the profile's isolated configuration directory.
 */
export function ensureProfileConfigFile(profile: string): string {
  const profileXdg = getProfileXdgConfigHome(profile);
  const configDir = path.join(profileXdg, 'scalable-cli');
  const configFile = path.join(configDir, 'config.toml');
  try {
    if (!fs.existsSync(configFile)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(configFile, '[auth]\nsession_backend = "file"\n', { mode: 0o600 });
    }
  } catch (error) {
    console.warn(`[scalableService] Failed to ensure config.toml for profile ${profile}:`, error);
  }
  return profileXdg;
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
}

const cache = new ProfileCache();

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
   * Helper to execute a CLI read command for a specific user profile asynchronously
   * without mutating global process.env.
   */
  private static async runReadCommand(profile: string, command: ScalableReadCommand): Promise<string> {
    const profileXdg = ensureProfileConfigFile(profile);
    return await runScalableReadCommand(command, {
      env: { XDG_CONFIG_HOME: profileXdg },
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
   * Gets overnight deposit details for profile (cached).
   */
  static async getOvernight(profile: string): Promise<ScalableOvernightInput | null> {
    const cached = cache.get<ScalableOvernightInput | null>(profile, 'overnight');
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
   * Gets cash position for profile derived from overview.
   */
  static async getCash(profile: string): Promise<{ balance: number; currency: string }> {
    const overview = await this.getPortfolioOverview(profile);
    const balance = overview.valuation - overview.securitiesValuation - overview.cryptoValuation;
    return { balance, currency: overview.currency };
  }

  /**
   * Gets performance data for profile.
   */
  static async getPerformance(profile: string): Promise<{ totalValuation: number; currency: string }> {
    const overview = await this.getPortfolioOverview(profile);
    return {
      totalValuation: overview.valuation,
      currency: overview.currency,
    };
  }

  /**
   * Gets transactions (read-only placeholder/adapter for CLI capabilities).
   */
  static async getTransactions(_profile: string): Promise<unknown[]> {
    return [];
  }

  /**
   * Aggregates all portfolio data into a single read-only view.
   */
  static async getPortfolioData(profile: string) {
    const [overview, holdingsRes, overnight] = await Promise.all([
      this.getPortfolioOverview(profile),
      this.getHoldings(profile),
      this.getOvernight(profile),
    ]);

    const cash = {
      balance: overview.valuation - overview.securitiesValuation - overview.cryptoValuation,
      currency: overview.currency,
    };

    return {
      overview,
      cash,
      holdings: holdingsRes.holdings,
      skippedHoldings: holdingsRes.skipped,
      overnight,
      performance: {
        totalValuation: overview.valuation,
        currency: overview.currency,
      },
      transactions: [],
    };
  }

  /**
   * Starts a device-flow login for the profile.
   */
  static startLogin(profile: string): ScalableServiceLoginSession {
    const now = Date.now();
    pruneLoginSessions(now);

    for (const session of loginSessions.values()) {
      if (session.profile === profile && session.status === 'pending') return session;
    }

    const profileXdg = ensureProfileConfigFile(profile);
    const child = spawn(scalableCliPath(), [...SCALABLE_LOGIN_ARGS], {
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
          ? 'Comando `sc` non trovato sul server.'
          : 'Non è stato possibile avviare il collegamento.';
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (session.status !== 'pending') return;
      if (code === 0) {
        session.status = 'approved';
        cache.clear(profile);
      } else {
        session.status = 'failed';
        session.error = 'Collegamento non riuscito o annullato.';
      }
    });

    return session;
  }

  /**
   * Retrieves login session status for profile.
   */
  static getLoginSession(sessionId: string, profile: string): ScalableServiceLoginSession | null {
    pruneLoginSessions(Date.now());
    const session = loginSessions.get(sessionId);
    if (!session || session.profile !== profile) return null;
    return session;
  }

  /**
   * Clears cache and logs out session for profile.
   */
  static disconnect(profile: string): void {
    cache.clear(profile);
    for (const [id, session] of loginSessions) {
      if (session.profile === profile) {
        loginSessions.delete(id);
      }
    }
  }
}
