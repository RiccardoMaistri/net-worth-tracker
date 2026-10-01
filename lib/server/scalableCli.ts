/**
 * Local `sc` CLI runner — the server side of the Scalable read-only bridge.
 *
 * Runs ONLY the three whitelisted read commands (`broker holdings/overview --json` and
 * `overnight --json`) through
 * `execFile` (no shell, fixed argv — no caller input ever reaches the command line) on the
 * machine hosting the app. That is why this works on a local run and degrades on Vercel:
 * `sc login` lives in the OS keyring of the machine the user sits at, and only there.
 *
 * `overnight` is the interest-bearing «Deposito non vincolato»: a SEPARATE balance from the
 * broker's cash residual, so the two never collapse into one figure.
 *
 * No tokens are handled here: the CLI owns its own session (`sc login`, ideally with
 * `--local-read-only`). This module only collects stdout and translates failures into
 * Italian, user-facing errors.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ScalableReadCommand = 'holdings' | 'overview' | 'overnight';

/** The complete read surface: nothing outside these three argv arrays can ever run. */
const READ_COMMAND_ARGS: Record<ScalableReadCommand, string[]> = {
  holdings: ['broker', 'holdings', '--json'],
  overview: ['broker', 'overview', '--json'],
  overnight: ['overnight', '--json'],
};

/**
 * The OAuth device-flow login — the ONE argv outside the read surface, and deliberately so.
 *
 * It is not a broker write: it writes a session into THIS machine's OS keyring and reads
 * nothing from the account. `--local-read-only` is not optional here — it is what keeps the
 * stored session from being able to place orders, so a stolen session can only READ.
 *
 * The `login.human_only` flag in `sc capabilities` is about the APPROVAL, not the terminal:
 * measured with stdout piped and stdin closed, the CLI prints the verification URL and the
 * user code, then waits — so a server can show that link. Fixed argv, no caller input, ever.
 */
export const SCALABLE_LOGIN_ARGS: readonly string[] = ['login', '--local-read-only'];

export class ScalableCliError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ScalableCliError';
    this.status = status;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * The XDG root `sc` reads its config from. A long-lived host sets `XDG_CONFIG_HOME` to the
 * persisted session volume; anywhere else (local runs, tests) it falls back to the OS default.
 */
export function scalableXdgRoot(): string {
  return process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config', 'scalable-cli');
}

/**
 * One XDG home per profile — the multi-user answer. `sc` resolves its config, session file,
 * DPoP key and refresh token under this directory, so each email gets a session of its own
 * instead of sharing the machine keyring. The profile id becomes a path segment, so only
 * the `[A-Za-z0-9_-]` ids `parseScalableProfiles` produces ever reach here.
 */
export function scalableProfileXdgHome(profile: string): string {
  return path.join(scalableXdgRoot(), 'profiles', profile);
}

/** Ensure config.toml exists with file-based session backend for headless environments */
export function ensureScalableConfigFile(configDirOverride?: string): void {
  const configDir = configDirOverride
    ? path.join(configDirOverride, 'scalable-cli')
    : process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'scalable-cli')
    : path.join(os.homedir(), '.config', 'scalable-cli');
  const configFile = path.join(configDir, 'config.toml');
  try {
    if (!fs.existsSync(configFile)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(configFile, '[auth]\nsession_backend = "file"\n', { mode: 0o600 });
    }
  } catch (error) {
    console.warn('[scalableCli] Failed to ensure config.toml:', error);
  }
}

/** Override the binary location with `SCALABLE_CLI_PATH`; defaults to `sc` on PATH. */
export function scalableCliPath(): string {
  const configured = process.env.SCALABLE_CLI_PATH?.trim();
  return configured && configured !== '' ? configured : 'sc';
}

function isLoginFailure(text: string): boolean {
  return /not logged in|login|unauthori|session|auth|no_session|platform failure/i.test(text);
}

function extractErrorMessage(stdout: string, stderr: string): string {
  if (stdout) {
    try {
      const doc = JSON.parse(stdout);
      if (typeof doc === 'object' && doc !== null && typeof doc.error?.message === 'string') {
        return doc.error.message;
      }
    } catch {
      // not json
    }
  }
  return (stderr || stdout).trim().slice(0, 300);
}

/**
 * The CLI exits 0 even when the broker call failed (`{"ok":false,...}`) — without this,
 * a dead session surfaces as a generic 502 parse error instead of the login prompt.
 */
function assertBrokerOk(stdout: string): void {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return; // Not JSON — leave it to the row/overview parser to report.
  }
  if (
    typeof doc === 'object' &&
    doc !== null &&
    (doc as Record<string, unknown>)['ok'] === false
  ) {
    throw new ScalableCliError(
      401,
      'Sessione Scalable scaduta o assente: clicca su «Collega con codice» in Impostazioni › Collegamenti e riprova.'
    );
  }
}

export interface RunScalableReadOptions {
  env?: Record<string, string | undefined>;
}

/**
 * Run one whitelisted READ command and return its stdout.
 * Accepts options to pass a profile-specific environment without mutating global process.env.
 */
export async function runScalableReadCommand(
  command: ScalableReadCommand,
  options?: RunScalableReadOptions
): Promise<string> {
  ensureScalableConfigFile(options?.env?.XDG_CONFIG_HOME);
  const bin = scalableCliPath();
  const env = options?.env ? { ...process.env, ...options.env } : undefined;
  try {
    const { stdout } = await execFileAsync(bin, READ_COMMAND_ARGS[command], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      ...(env ? { env } : {}),
    });
    assertBrokerOk(stdout);
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (err?.code === 'ENOENT') {
      throw new ScalableCliError(
        503,
        'Comando `sc` non trovato su questa macchina: installalo ed esegui `sc login`, oppure incolla l’output qui sotto a mano.'
      );
    }
    if (err?.killed) {
      throw new ScalableCliError(504, 'La lettura da Scalable ha impiegato troppo tempo: riprova.');
    }
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
    const combined = `${stdout}\n${stderr}`;
    if (isLoginFailure(combined)) {
      throw new ScalableCliError(
        401,
        'Sessione Scalable scaduta o assente: clicca su «Collega con codice» in Impostazioni › Collegamenti e riprova.'
      );
    }
    const detail = extractErrorMessage(stdout, stderr);
    throw new ScalableCliError(
      502,
      detail !== '' ? `Scalable ha risposto con un errore: ${detail}` : 'Lettura da Scalable non riuscita: riprova.'
    );
  }
}
