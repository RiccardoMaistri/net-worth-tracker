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

/**
 * The TRADE read surface. Separate from `ScalableReadCommand` because these two take an ARGUMENT
 * and the existing whitelist is a closed map of fixed argv arrays with no room for one.
 *
 * Nothing here can write: `broker transactions` and `broker transaction details` are both reads,
 * and they run under the same `--local-read-only` session as everything else, so the write
 * guarantee in the header is unchanged. They are deliberately NOT folded into the fixed-argv map:
 * a command whose argv carries a caller-supplied value is a different risk shape, and the argument
 * is validated against a broker id pattern BEFORE it can reach `execFile` (see
 * `runScalableTradeCommand`).
 */
export type ScalableTradeReadCommand = 'transactions' | 'transaction-details';

/** Page size for `broker transactions`. The CLI caps this at 100, which is also the widest page. */
const TRADE_PAGE_SIZE = 100;

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

/**
 * A broker operation id, as accepted on a command line.
 *
 * This is the ONLY untrusted value that reaches `execFile` anywhere in this module, so it is
 * validated rather than escaped: `execFile` takes no shell, but an argument starting with `-` would
 * still be read by the CLI as a FLAG and not as the id we meant (`--json` would silently become the
 * transaction id and the read would report a confusing failure). Scalable ids are alphanumeric,
 * so anything outside this class is refused before a process is ever spawned. The value is passed
 * as a separate argv element regardless — never concatenated into a string.
 */
const BROKER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Run one whitelisted TRADE read.
 *
 * `transactionId` is required only for `transaction-details`; for `transactions` it must be
 * omitted rather than empty, because `--transaction-id` with a blank value is a different command
 * to the CLI than no flag at all.
 */
export async function runScalableTradeCommand(
  command: ScalableTradeReadCommand,
  options?: RunScalableReadOptions & { transactionId?: string; cursor?: string; pageSize?: number }
): Promise<string> {
  if (command === 'transaction-details') {
    const id = options?.transactionId;
    if (!id || !BROKER_ID_PATTERN.test(id)) {
      throw new ScalableCliError(400, 'Identificativo operazione non valido.');
    }
  } else if (options?.transactionId !== undefined) {
    throw new ScalableCliError(400, 'Comando non accetta un identificativo operazione.');
  }

  // A cursor is the SECOND untrusted value that can reach a command line, so it is refused on the
  // one property that matters: a leading `-` would be read by the CLI as a flag. The measured shape
  // is `1788739200000|CASH_7tq...|8DBK...`, so a character class is too strict here and only the
  // leading dash plus control characters are rejected. The CLI mints the value and we only ever
  // hand back one it gave us.
  if (options?.cursor !== undefined && !/^[A-Za-z0-9][A-Za-z0-9|_-]*$/.test(options.cursor)) {
    throw new ScalableCliError(400, 'Cursore di paginazione non valido.');
  }

  const args: string[] =
    command === 'transactions'
      ? ['broker', 'transactions', '--json', '--page-size', String(options?.pageSize ?? TRADE_PAGE_SIZE)]
      : ['broker', 'transaction', 'details', '--transaction-id', options!.transactionId!, '--json'];
  if (command === 'transactions' && options?.cursor) {
    args.push('--cursor', options.cursor);
  }

  ensureScalableConfigFile(options?.env?.XDG_CONFIG_HOME);
  const bin = scalableCliPath();
  const env = options?.env ? { ...process.env, ...options.env } : undefined;
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      ...(env ? { env } : {}),
    });
    assertBrokerOk(stdout);
    return stdout;
  } catch (error) {
    if (error instanceof ScalableCliError) throw error;
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
    if (isLoginFailure(`${stdout}\n${stderr}`)) {
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
