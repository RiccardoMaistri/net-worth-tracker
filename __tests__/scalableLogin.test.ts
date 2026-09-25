/**
 * Tests for lib/server/scalableLogin.ts — the device-flow login a server drives.
 *
 * The parser is the load-bearing part: the CLI's stdout arrives in CHUNKS of unpredictable
 * size, so a regex applied per chunk would miss a `user_code=` split across two reads. The
 * chunk-splitting cases are the point of this file.
 *
 * Captured verbatim from `sc login --local-read-only` with stdout piped and stdin closed
 * (exit 124 = killed while still waiting for the browser).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('server-only', () => ({}));

const {
  assertLongLivedHost,
  getScalableLogin,
  parseScalableLoginPrompt,
  publicLoginView,
  resetScalableLogins,
  startScalableLogin,
} = await import('@/lib/server/scalableLogin');

/** The exact output measured on a logged-out run. */
const REAL_OUTPUT = [
  'Open this URL:',
  'https://secure.scalable.capital/activate?user_code=WWXH-KSTL',
  '',
  'Verify the code WWXH-KSTL in your browser.',
  '',
  'Waiting for browser confirmation...',
  'Waiting for browser confirmation...',
  '',
].join('\n');

describe('parseScalableLoginPrompt', () => {
  it('reads the URL and the code out of the real output', () => {
    expect(parseScalableLoginPrompt(REAL_OUTPUT)).toEqual({
      verificationUri: 'https://secure.scalable.capital/activate?user_code=WWXH-KSTL',
      userCode: 'WWXH-KSTL',
    });
  });

  it('returns null before the URL has been printed', () => {
    expect(parseScalableLoginPrompt('Open this URL:\n')).toBeNull();
  });

  it('returns null on empty output', () => {
    expect(parseScalableLoginPrompt('')).toBeNull();
  });

  it('works when the URL is split across two stdout chunks', () => {
    // The failure this guards: a per-chunk regex never matches a split `user_code=`.
    const first = 'Open this URL:\nhttps://secure.scalable.capital/activate?user_';
    const second = 'code=ABCD-1234\nWaiting for browser confirmation...\n';
    expect(parseScalableLoginPrompt(first)).toBeNull();
    expect(parseScalableLoginPrompt(first + second)).toEqual({
      verificationUri: 'https://secure.scalable.capital/activate?user_code=ABCD-1234',
      userCode: 'ABCD-1234',
    });
  });

  it('upper-cases a lower-case code', () => {
    expect(parseScalableLoginPrompt('https://x.test/activate?user_code=abcd-1234')?.userCode).toBe(
      'ABCD-1234'
    );
  });

  it('ignores a URL with no user_code (nothing to show the user)', () => {
    expect(parseScalableLoginPrompt('See https://secure.scalable.capital/ for details')).toBeNull();
  });

  it('finds the link even when other output precedes it', () => {
    const noisy = `warning: something\n${REAL_OUTPUT}`;
    expect(parseScalableLoginPrompt(noisy)?.userCode).toBe('WWXH-KSTL');
  });
});

describe('assertLongLivedHost', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('refuses on Vercel, where the session could not survive', () => {
    process.env.VERCEL = '1';
    expect(() => assertLongLivedHost()).toThrow(/server sempre attivo/);
  });

  it('refuses on AWS Lambda', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'fn';
    expect(() => assertLongLivedHost()).toThrow(/VM/);
  });

  it('allows a plain long-lived host', () => {
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.NETLIFY;
    expect(() => assertLongLivedHost()).not.toThrow();
  });
});

describe('the session lifecycle, against a real child process', () => {
  // A fake `sc` so the spawn path is exercised for real: the parser, the chunked stdout, the
  // exit code and the ownership rule. A hand-built session object would assert nothing — it
  // would only compare a field with itself.
  let fakeBin: string;

  beforeEach(() => {
    resetScalableLogins();
    delete process.env.VERCEL;
    fakeBin = join(mkdtempSync(join(tmpdir(), 'sc-login-')), 'sc');
  });

  afterEach(() => {
    delete process.env.SCALABLE_CLI_PATH;
    rmSync(dirname(fakeBin), { recursive: true, force: true });
  });

  function useFakeSc(body: string): void {
    writeFileSync(fakeBin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    process.env.SCALABLE_CLI_PATH = fakeBin;
  }

  /** Prints the prompt, then lives for `holdMs` so the session is observable as pending. */
  const promptThenExit = (code: number, holdMs: number) => `
echo "Open this URL:"
echo "https://secure.scalable.capital/activate?user_code=ZZZZ-9999"
echo "Verify the code ZZZZ-9999 in your browser."
sleep ${holdMs / 1000}
exit ${code}`;

  it('parses the prompt out of a real child and approves when it exits 0', async () => {
    useFakeSc(promptThenExit(0, 900));
    const started = startScalableLogin('owner-a');
    expect(started.status).toBe('pending');

    await vi.waitFor(() => expect(started.status).not.toBe('pending'), { timeout: 8000, interval: 50 });
    expect(started.status).toBe('approved');
    // Filled in from the child's own stdout, not from a constant.
    expect(started.userCode).toBe('ZZZZ-9999');
    expect(started.verificationUri).toContain('user_code=ZZZZ-9999');
  });

  it('reports a non-zero exit as failed, with no URL invented', async () => {
    useFakeSc('echo "no_session: run sc login"\nexit 1');
    const started = startScalableLogin('owner-a');
    await vi.waitFor(() => expect(started.status).not.toBe('pending'), { timeout: 8000, interval: 50 });
    expect(started.status).toBe('failed');
    expect(started.error).toBeTruthy();
    expect(started.verificationUri).toBeUndefined();
  });

  it('refuses to start when the binary is missing', async () => {
    process.env.SCALABLE_CLI_PATH = join(tmpdir(), 'definitely-not-here-sc');
    const started = startScalableLogin('owner-a');
    await vi.waitFor(() => expect(started.status).not.toBe('pending'), { timeout: 8000, interval: 50 });
    expect(started.status).toBe('failed');
    expect(started.error).toContain('non trovato');
  });

  it('never lets another owner read a session', async () => {
    useFakeSc(promptThenExit(0, 900));
    const started = startScalableLogin('owner-a');
    await vi.waitFor(() => expect(started.verificationUri).toBeTruthy(), { timeout: 8000, interval: 50 });
    // The one rule that makes the status endpoint safe to expose.
    expect(getScalableLogin(started.id, 'owner-b')).toBeNull();
    expect(getScalableLogin(started.id, 'owner-a')).not.toBeNull();
  });

  it('returns the SAME pending session on a second click (no orphaned child)', async () => {
    useFakeSc(promptThenExit(0, 1500));
    const first = startScalableLogin('owner-a');
    const second = startScalableLogin('owner-a');
    expect(second.id).toBe(first.id);
  });

  it('starts a fresh session once the previous one finished', async () => {
    useFakeSc(promptThenExit(0, 100));
    const first = startScalableLogin('owner-a');
    await vi.waitFor(() => expect(first.status).toBe('approved'), { timeout: 8000, interval: 50 });
    expect(startScalableLogin('owner-a').id).not.toBe(first.id);
  });
});

describe('the client-facing view', () => {
  it('never leaks the ownerId or the timing to the client', () => {
    const view = publicLoginView({
      id: 's1',
      ownerId: 'owner-a',
      status: 'pending',
      userCode: 'AAAA-1111',
      startedAt: 123456,
    });
    expect(view).toEqual({ id: 's1', status: 'pending', userCode: 'AAAA-1111' });
    expect(view).not.toHaveProperty('ownerId');
    expect(view).not.toHaveProperty('startedAt');
  });

  it('omits absent optional fields instead of sending undefined', () => {
    const view = publicLoginView({
      id: 's2',
      ownerId: 'owner-a',
      status: 'failed',
      error: 'Collegamento non riuscito: riprova.',
      startedAt: 1,
    });
    expect(Object.keys(view).sort()).toEqual(['error', 'id', 'status']);
  });
});
