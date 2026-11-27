/**
 * OKX read-only client — signed requests with the server's own API key.
 *
 * WHY A WHITELIST: an OKX key can carry Trading and Withdraw rights, and this client signs
 * whatever it is asked to. The guarantee that a read only READS is structural, the same posture
 * `binanceClient.ts` and `tradeRepublicClient.ts` take: the closed list below is the ONLY thing
 * that can be requested, and every entry is a GET. Adding a write is the change this file
 * forbids. The key should also be created with "Read" alone (and an IP whitelist): this list is
 * the second lock, not the first.
 *
 * EEA BASE URL: an account registered on `my.okx.com` lives on `https://eea.okx.com`, and its
 * keys are refused by `www.okx.com` with code 50111 — the same key, the wrong domain. The default
 * is therefore the EEA host, and `OKX_BASE_URL` overrides it for a global account.
 *
 * SIGNING (OKX v5): `OK-ACCESS-SIGN` is the Base64 HMAC-SHA256 of
 * `timestamp + method + requestPath + body`, where `requestPath` is the path WITH its query
 * string and the timestamp is ISO 8601 with milliseconds. Every attempt is signed afresh: a
 * backoff that reused a timestamp crossed OKX's 30-second window and answered 50102 (the same
 * lesson `binanceClient.ts` records for Binance's `recvWindow`).
 *
 * The credentials are `OKX_API_KEY` / `OKX_API_SECRET` / `OKX_API_PASSPHRASE` in the server
 * environment: one OKX account per deployment. They never reach the client, and no document
 * stores them.
 *
 * This module is Node-only (`node:crypto`), so importing it from a client component fails the
 * build. It deliberately does not import `server-only`, because `scripts/okxPoc.mts` runs it
 * under tsx outside Next.
 */

import { createHmac } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://eea.okx.com';
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 8_000;

/** The reads, and nothing else. Every entry is a `GET`: no order, transfer or withdrawal. */
const READ_ENDPOINTS = {
  /** Trading account: every currency's equity, spot cost price and spot P&L. */
  balance: '/api/v5/account/balance',
  /** Funding account: coin balances, no cost price and no P&L (a deposit is not a trade). */
  fundingBalances: '/api/v5/asset/balances',
  /** Simple Earn: the flexible savings position per currency (`amt`, of which `loanAmt` is lent). */
  savings: '/api/v5/finance/savings/balance',
  /** On-chain Earn: the ACTIVE staking/DeFi orders, with the principal and the accrued earnings. */
  stakingOrders: '/api/v5/finance/staking-defi/orders-active',
  /** Open derivatives positions, each with OKX's own unrealized P&L. */
  positions: '/api/v5/account/positions',
  /** Public spot tickers, used to price funding balances OKX values only in coin units. */
  tickers: '/api/v5/market/tickers',
  /** Public server time, used to measure the clock skew before the first signed request. */
  time: '/api/v5/public/time',
} as const;

type ReadEndpoint = keyof typeof READ_ENDPOINTS;

const PUBLIC_ENDPOINTS: ReadonlySet<ReadEndpoint> = new Set<ReadEndpoint>(['tickers', 'time']);
const AUTH_ERROR_CODES = new Set(['50111', '50113', '50114']);
const RATE_LIMIT_CODES = new Set(['50011', '50013', '50026']);
const TIMESTAMP_EXPIRED_CODE = '50102';

export class OkxConfigError extends Error {
  constructor() {
    super(
      'Collegamento OKX non configurato: imposta OKX_API_KEY, OKX_API_SECRET e OKX_API_PASSPHRASE sul server.'
    );
    this.name = 'OkxConfigError';
  }
}

export class OkxReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly httpStatus?: number,
    readonly okxCode?: string
  ) {
    super(message);
    this.name = 'OkxReadError';
  }
}

export function isOkxConfigured(): boolean {
  return Boolean(
    process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE
  );
}

/** The host the reads go to: EEA by default, `OKX_BASE_URL` for a global account. */
export function okxBaseUrl(): string {
  return (process.env.OKX_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** `OKX_DEMO=true` reads the demo-trading account of the same key (`x-simulated-trading: 1`). */
export function isOkxDemo(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.OKX_DEMO ?? '').trim().toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface OkxEnvelope {
  code: string;
  msg: string;
  data: unknown[];
}

function readEnvelope(value: unknown): OkxEnvelope {
  if (!isRecord(value) || typeof value['code'] !== 'string') {
    throw new OkxReadError('Risposta OKX non riconosciuta: manca il codice.', 502);
  }
  return {
    code: value['code'],
    msg: typeof value['msg'] === 'string' ? value['msg'] : '',
    data: Array.isArray(value['data']) ? value['data'] : [],
  };
}

function friendlyMessage(code: string, msg: string): string {
  switch (code) {
    case '50111':
      return 'OKX ha rifiutato la chiave API: controlla che sia attiva, che appartenga a questo dominio (eea.okx.com per il conto europeo) e che abbia il permesso di lettura.';
    case '50113':
      return 'Firma OKX non valida: controlla OKX_API_SECRET e l’orologio del server.';
    case '50114':
      return 'Passphrase OKX non valida: controlla OKX_API_PASSPHRASE.';
    case '50011':
      return 'OKX limita le richieste: riprova fra qualche minuto.';
    case '50102':
      return 'Timestamp OKX scaduto: l’orologio del server non è allineato.';
    default:
      return `OKX ha risposto ${code}${msg ? `: ${msg}` : ''}`;
  }
}

function statusFor(code: string): number {
  if (AUTH_ERROR_CODES.has(code)) return 401;
  if (code === '50011') return 429;
  return 502;
}

function sign(timestamp: string, requestPath: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}GET${requestPath}`)
    .digest('base64');
}

/**
 * The offset between the local clock and OKX's, measured once from the public time endpoint.
 * `0` after a failed sync: the request then proves the skew, and a 50102 resyncs.
 */
let clockSkewMs: number | null = null;

async function syncClock(): Promise<void> {
  try {
    const response = await fetch(`${okxBaseUrl()}${READ_ENDPOINTS.time}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const envelope = readEnvelope(await response.json());
    const row = envelope.data[0];
    const ts = isRecord(row) ? Number(row['ts']) : Number.NaN;
    clockSkewMs = Number.isFinite(ts) ? ts - Date.now() : 0;
  } catch {
    // The clock is a convenience, not a precondition: an unsynced call still works when the
    // host is aligned, and a 50102 retries after a fresh sync.
    clockSkewMs = 0;
  }
}

function headers(signed: boolean): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isOkxDemo()) out['x-simulated-trading'] = '1';
  if (signed) {
    out['OK-ACCESS-KEY'] = process.env.OKX_API_KEY as string;
    out['OK-ACCESS-PASSPHRASE'] = process.env.OKX_API_PASSPHRASE as string;
  }
  return out;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(name, String(value));
  }
  return search.toString();
}

async function call(
  endpoint: ReadEndpoint,
  params: Record<string, string | number | undefined> = {}
): Promise<unknown[]> {
  const signed = !PUBLIC_ENDPOINTS.has(endpoint);
  if (signed && !isOkxConfigured()) throw new OkxConfigError();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (signed && clockSkewMs === null) await syncClock();

    const query = buildQuery(params);
    const requestPath = `${READ_ENDPOINTS[endpoint]}${query ? `?${query}` : ''}`;
    const requestHeaders = headers(signed);
    if (signed) {
      const timestamp = new Date(Date.now() + (clockSkewMs ?? 0)).toISOString();
      requestHeaders['OK-ACCESS-TIMESTAMP'] = timestamp;
      requestHeaders['OK-ACCESS-SIGN'] = sign(
        timestamp,
        requestPath,
        process.env.OKX_API_SECRET as string
      );
    }

    let response: Response;
    try {
      response = await fetch(`${okxBaseUrl()}${requestPath}`, {
        method: 'GET',
        headers: requestHeaders,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new OkxReadError(
          `OKX non raggiungibile: ${error instanceof Error ? error.message : 'errore di rete'}`,
          502
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1_000));
      continue;
    }

    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!body) {
      // A gateway page (Cloudflare, maintenance) is not OKX's envelope: name the status and a
      // short excerpt instead of pretending the account is empty.
      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt * 1_000, MAX_BACKOFF_MS)));
          continue;
        }
      }
      throw new OkxReadError(
        `OKX ha risposto ${response.status} senza un corpo JSON${text ? `: ${text.slice(0, 160)}` : ''}.`,
        response.status === 401 || response.status === 403 ? 401 : 502,
        response.status
      );
    }

    const envelope = readEnvelope(body);

    if (RATE_LIMIT_CODES.has(envelope.code) && attempt < MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt * 1_000, MAX_BACKOFF_MS)));
      continue;
    }
    if (envelope.code === TIMESTAMP_EXPIRED_CODE && attempt < MAX_ATTEMPTS - 1) {
      clockSkewMs = null;
      continue;
    }

    if (envelope.code !== '0') {
      throw new OkxReadError(
        friendlyMessage(envelope.code, envelope.msg),
        statusFor(envelope.code),
        response.status,
        envelope.code
      );
    }
    if (!response.ok) {
      throw new OkxReadError(
        `OKX ha risposto ${response.status} a una richiesta riuscita.`,
        502,
        response.status
      );
    }
    return envelope.data;
  }

  throw new OkxReadError('OKX limita le richieste: riprova fra qualche minuto.', 429);
}

export interface OkxRawAccount {
  /** Trading account rows (`data` of `/account/balance`). Required: without it there is no portfolio. */
  balance: unknown[];
  /** Funding balances. `null` when the read failed, so the caller never reads an empty account. */
  funding: unknown[] | null;
  /** Simple Earn balances. `null` when the read failed. */
  savings: unknown[] | null;
  /** Active On-chain Earn orders. `null` when the read failed. */
  staking: unknown[] | null;
  /** Open derivatives positions. `null` when the read failed. */
  positions: unknown[] | null;
  /** Public spot tickers. `[]` when the read failed: trading balances already carry `eqUsd`. */
  tickers: unknown[];
  /** What could not be read, in words: a missing wallet is declared, never silently empty. */
  warnings: string[];
}

export async function readOkxAccount(): Promise<OkxRawAccount> {
  const warnings: string[] = [];
  const optional = async <T>(label: string, read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof OkxConfigError) throw error;
      warnings.push(`${label} non letto: ${error instanceof Error ? error.message : 'errore sconosciuto'}`);
      return fallback;
    }
  };

  // Balance is the one read that may fail the whole POC: without it there is no portfolio to show.
  const balance = await call('balance');
  const [funding, savings, staking, positions, tickers] = await Promise.all([
    optional('Conto funding', () => call('fundingBalances'), null as unknown[] | null),
    optional('Simple Earn', () => call('savings'), null as unknown[] | null),
    optional('On-chain Earn', () => call('stakingOrders'), null as unknown[] | null),
    optional('Posizioni', () => call('positions'), null as unknown[] | null),
    optional('Prezzi spot', () => call('tickers', { instType: 'SPOT' }), [] as unknown[]),
  ]);
  return { balance, funding, savings, staking, positions, tickers, warnings };
}
