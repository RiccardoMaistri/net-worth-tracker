/**
 * Tests for lib/server/scalableService.ts — profiles, the device-flow login a server drives,
 * and the 403 posture of the surviving /api/scalable/* route.
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
import { NextRequest } from 'next/server';
import type { DecodedIdToken } from 'firebase-admin/auth';
import {
  assertLongLivedHost,
  getProfileXdgConfigHome,
  getScalableProfileForEmail,
  parseScalableLoginPrompt,
  parseScalableProfiles,
  resetScalableLogins,
  ScalableService,
} from '@/lib/server/scalableService';

vi.mock('@/lib/server/apiAuth', () => ({
  requireFirebaseAuth: vi.fn(),
  getApiAuthErrorResponse: vi.fn(() => null),
  assertCanAccessAccount: vi.fn(),
}));

const PROFILES_ENV = 'riccardo:rykymai@gmail.com,michele:michele.maistri@gmail.com';
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.SCALABLE_PROFILES = PROFILES_ENV;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

async function authAs(email: string): Promise<void> {
  const { requireFirebaseAuth } = await import('@/lib/server/apiAuth');
  vi.mocked(requireFirebaseAuth).mockResolvedValueOnce({
    email,
    uid: 'user-test',
  } as unknown as DecodedIdToken);
}

describe('parseScalableProfiles', () => {
  it('maps each email to its profile, lower-cased', () => {
    expect(parseScalableProfiles(PROFILES_ENV)).toEqual({
      'rykymai@gmail.com': { profile: 'riccardo', name: 'Riccardo' },
      'michele.maistri@gmail.com': { profile: 'michele', name: 'Michele' },
    });
  });

  it('ignores malformed entries instead of inventing a profile', () => {
    expect(parseScalableProfiles('riccardo:rykymai@gmail.com,garbage,no-colon:, :no-profile')).toEqual({
      'rykymai@gmail.com': { profile: 'riccardo', name: 'Riccardo' },
    });
  });

  it('drops profile ids that cannot be a directory name', () => {
    // The profile becomes a path segment: ../.. must never survive parsing.
    expect(parseScalableProfiles('../../etc:x@gmail.com,ok:y@gmail.com')).toEqual({
      'y@gmail.com': { profile: 'ok', name: 'Ok' },
    });
  });

  it('answers {} when the variable is missing or empty', () => {
    expect(parseScalableProfiles(undefined)).toEqual({});
    expect(parseScalableProfiles('')).toEqual({});
  });
});

describe('getScalableProfileForEmail', () => {
  it('maps rykymai@gmail.com to the riccardo profile', () => {
    expect(getScalableProfileForEmail('rykymai@gmail.com')).toEqual({
      profile: 'riccardo',
      name: 'Riccardo',
    });
  });

  it('matches case-insensitively', () => {
    expect(getScalableProfileForEmail('Michele.Maistri@Gmail.com')).toEqual({
      profile: 'michele',
      name: 'Michele',
    });
  });

  it('returns null for an unauthorized, empty or missing email', () => {
    expect(getScalableProfileForEmail('unauthorized.user@gmail.com')).toBeNull();
    expect(getScalableProfileForEmail('')).toBeNull();
    expect(getScalableProfileForEmail(null)).toBeNull();
    expect(getScalableProfileForEmail(undefined)).toBeNull();
  });

  it('returns null for everyone when SCALABLE_PROFILES is unset', () => {
    delete process.env.SCALABLE_PROFILES;
    expect(getScalableProfileForEmail('rykymai@gmail.com')).toBeNull();
  });
});

describe('getProfileXdgConfigHome', () => {
  it('resolves a distinct profiles/<profile> directory per email', () => {
    process.env.XDG_CONFIG_HOME = join(tmpdir(), 'sc-xdg-test');
    const riccardoXdg = getProfileXdgConfigHome('riccardo');
    const micheleXdg = getProfileXdgConfigHome('michele');

    expect(riccardoXdg).toContain('profiles/riccardo');
    expect(micheleXdg).toContain('profiles/michele');
    expect(riccardoXdg).not.toEqual(micheleXdg);
  });
});

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
  it('refuses on Vercel, where the session could not survive', () => {
    process.env.VERCEL = '1';
    expect(() => assertLongLivedHost()).toThrow(/server sempre attivo/);
  });

  it('refuses on AWS Lambda', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'fn';
    expect(() => assertLongLivedHost()).toThrow(/VM/);
  });

  it('allows a plain long-lived host', () => {
    expect(() => assertLongLivedHost()).not.toThrow();
  });
});

describe('the login lifecycle, against a real child process', () => {
  // A fake `sc` so the spawn path is exercised for real: the parser, the chunked stdout, the
  // exit code and the profile rule. A hand-built session object would assert nothing — it
  // would only compare a field with itself.
  let fakeBin: string;
  let fakeXdg: string;

  beforeEach(() => {
    resetScalableLogins();
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.NETLIFY;
    fakeXdg = mkdtempSync(join(tmpdir(), 'sc-xdg-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    fakeBin = join(mkdtempSync(join(tmpdir(), 'sc-login-')), 'sc');
  });

  afterEach(() => {
    delete process.env.SCALABLE_CLI_PATH;
    rmSync(dirname(fakeBin), { recursive: true, force: true });
    rmSync(fakeXdg, { recursive: true, force: true });
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
    const started = ScalableService.startLogin('riccardo');
    expect(started.status).toBe('pending');

    await vi.waitFor(() => expect(started.status).not.toBe('pending'), { timeout: 8000, interval: 50 });
    expect(started.status).toBe('approved');
    // Filled in from the child's own stdout, not from a constant.
    expect(started.userCode).toBe('ZZZZ-9999');
    expect(started.verificationUri).toContain('user_code=ZZZZ-9999');
  });

  it('reports a non-zero exit as failed, with no URL invented', async () => {
    useFakeSc('echo "no_session: run sc login"\nexit 1');
    const started = ScalableService.startLogin('riccardo');
    await vi.waitFor(() => expect(started.status).not.toBe('pending'), { timeout: 8000, interval: 50 });
    expect(started.status).toBe('failed');
    expect(started.error).toBeTruthy();
    expect(started.verificationUri).toBeUndefined();
  });

  it('names a refused approval instead of a generic failure', async () => {
    useFakeSc('echo "denied by user"\nexit 1');
    const started = ScalableService.startLogin('riccardo');
    await vi.waitFor(() => expect(started.status).not.toBe('pending'), { timeout: 8000, interval: 50 });
    expect(started.error).toMatch(/scaduta o è stata rifiutata/);
  });

  it('refuses to start when the binary is missing', async () => {
    process.env.SCALABLE_CLI_PATH = join(tmpdir(), 'definitely-not-here-sc');
    const started = ScalableService.startLogin('riccardo');
    await vi.waitFor(() => expect(started.status).not.toBe('pending'), { timeout: 8000, interval: 50 });
    expect(started.status).toBe('failed');
    expect(started.error).toContain('non trovato');
  });

  it('refuses to start on a serverless host', () => {
    process.env.VERCEL = '1';
    expect(() => ScalableService.startLogin('riccardo')).toThrow(/server sempre attivo/);
  });

  it('never lets another profile read a session', async () => {
    useFakeSc(promptThenExit(0, 900));
    const started = ScalableService.startLogin('riccardo');
    await vi.waitFor(() => expect(started.verificationUri).toBeTruthy(), { timeout: 8000, interval: 50 });
    // The one rule that makes the status endpoint safe to expose.
    expect(ScalableService.getLoginSession(started.id, 'michele')).toBeNull();
    expect(ScalableService.getLoginSession(started.id, 'riccardo')).not.toBeNull();
  });

  it('returns the SAME pending session on a second click (no orphaned child)', async () => {
    useFakeSc(promptThenExit(0, 1500));
    const first = ScalableService.startLogin('riccardo');
    const second = ScalableService.startLogin('riccardo');
    expect(second.id).toBe(first.id);
  });

  it('starts a fresh session once the previous one finished', async () => {
    useFakeSc(promptThenExit(0, 100));
    const first = ScalableService.startLogin('riccardo');
    await vi.waitFor(() => expect(first.status).toBe('approved'), { timeout: 8000, interval: 50 });
    expect(ScalableService.startLogin('riccardo').id).not.toBe(first.id);
  });
});

describe('the surviving /api/scalable/* route', () => {
  it('GET /api/scalable/status returns 403 for an unlisted email', async () => {
    await authAs('attacker@gmail.com');

    const { GET } = await import('@/app/api/scalable/status/route');
    const res = await GET(new NextRequest('http://localhost/api/scalable/status'));

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('utente non autorizzato');
  });
});
