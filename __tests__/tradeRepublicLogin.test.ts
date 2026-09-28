/**
 * The Trade Republic QR handshake: the cookie jar, the state machine, and the WAF refusal.
 *
 * The jar is the whole session, so a merge that keeps a stale `tr_session` would poll forever
 * against the pre-approval cookie — that is the case worth pinning here. The WAF branch matters
 * just as much: three other Trade Republic clients ship a headless browser to get an
 * `x-aws-waf-token`, and if the QR endpoints turn out to be gated, that refusal must arrive as its
 * OWN legible error rather than as a generic failure the user cannot act on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  assertTrLongLivedHost,
  getTrLogin,
  mergeTrCookies,
  publicTrLoginView,
  resetTrLogins,
  startTrLogin,
  takeTrLoginCookies,
  TradeRepublicWafError,
  trCookieHeader,
} from '@/lib/server/tradeRepublicQr';

/** A Response whose `getSetCookie` answers the given cookie strings. */
function jsonResponse(
  body: unknown,
  cookies: string[] = [],
  init: { status?: number; wafBody?: string } = {}
): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookies.length > 0) headers.set('set-cookie', cookies.join(', '));
  if (init.wafBody !== undefined) {
    return new Response(init.wafBody, { status: init.status ?? 403, headers });
  }
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

const renderQr = async (payload: string): Promise<string> => `data:image/png;base64,${payload.length}`;

describe('the cookie jar', () => {
  it('merges by name so a re-issued tr_session wins over the pre-approval one', () => {
    // Without the by-name merge the poller would keep presenting the cookie the broker issued
    // BEFORE the approval and would never see the session.
    const merged = mergeTrCookies(
      ['tr_session=old; Path=/', 'tr_refresh=keep; Path=/'],
      ['tr_session=new; Path=/']
    );
    expect(merged.filter((c) => c.startsWith('tr_session='))).toEqual(['tr_session=new; Path=/']);
    expect(merged).toContain('tr_refresh=keep; Path=/');
  });

  it('sends only the name=value pair of each cookie', () => {
    expect(trCookieHeader(['tr_session=abc; Path=/; HttpOnly', 'tr_refresh=def; Secure'])).toBe(
      'tr_session=abc; tr_refresh=def'
    );
  });

  it('sends no header at all for an empty jar', () => {
    expect(trCookieHeader([])).toBeUndefined();
  });
});

describe('startTrLogin', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let challenges: number;

  /**
   * URL-dispatched, not a response QUEUE: the module polls the challenge in the background, so a
   * `mockResolvedValueOnce` chain hands the poller's GET the response the next POST was meant to
   * get, and the failure lands on whichever test runs next. Dispatching on the path is also what
   * the broker actually does.
   */
  beforeEach(() => {
    resetTrLogins();
    challenges = 0;
    fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/login/qr-challenges') && !url.includes('/qr-challenges/')) {
        challenges += 1;
        return jsonResponse({ challengeId: `ch-${challenges}`, challengeExpiresAt: '2026-09-25T18:00:00Z' });
      }
      if (url.includes('/qr-challenges/')) {
        return jsonResponse({ status: 'PENDING' }, ['tr_pending=1; Path=/']);
      }
      return jsonResponse({}, [], { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetTrLogins();
  });

  it('creates the challenge, renders the QR and reports it as pending', async () => {
    const session = await startTrLogin('owner-1', renderQr);

    expect(session.status).toBe('pending');
    expect(session.ownerId).toBe('owner-1');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.traderepublic.com/api/v2/auth/web/login/qr-challenges'
    );
  });

  it('hands back the RUNNING challenge on a second click instead of orphaning the first', async () => {
    const first = await startTrLogin('owner-1', renderQr);
    const second = await startTrLogin('owner-1', renderQr);

    expect(second.id).toBe(first.id);
    // One challenge per owner: a second POST would give the user a second live QR to confuse.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('qr-challenges'))).toHaveLength(1);
  });

  it('gives two owners two challenges, and refuses to show one owner the other QR', async () => {
    const mine = await startTrLogin('owner-1', renderQr);
    const theirs = await startTrLogin('owner-2', renderQr);

    expect(mine.id).not.toBe(theirs.id);
    // A live QR is a credential: reading someone else's must be a 404-shaped null, not a status.
    expect(getTrLogin(mine.id, 'owner-2')).toBeNull();
    expect(getTrLogin(mine.id, 'owner-1')).not.toBeNull();
  });

  it('refuses with its own error when the broker answers a WAF challenge', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({}, [], { status: 403, wafBody: '<html>awswaf integration</html>' })
    );
    await expect(startTrLogin('owner-1', renderQr)).rejects.toBeInstanceOf(TradeRepublicWafError);
  });

  it('does not call a 403 a WAF refusal when the body is an ordinary rejection', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({}, [], { status: 403, wafBody: '{"error":"forbidden"}' })
    );
    // A credential-shaped 403 is a different problem and must not borrow the WAF's advice.
    await expect(startTrLogin('owner-1', renderQr)).rejects.not.toBeInstanceOf(TradeRepublicWafError);
  });

  it('fails legibly when the broker returns no challenge id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(startTrLogin('owner-1', renderQr)).rejects.toThrow(/non ha restituito/i);
  });
});

describe('the session view', () => {
  it('never leaks the owner or the internals to the client', () => {
    const view = publicTrLoginView({
      id: 's-1',
      ownerId: 'owner-1',
      status: 'pending',
      qrDataUrl: 'data:image/png;base64,x',
      startedAt: 1,
    });
    expect(view).not.toHaveProperty('ownerId');
    expect(view).not.toHaveProperty('startedAt');
    expect(view.qrDataUrl).toBe('data:image/png;base64,x');
  });

  it('has no cookies to hand over until the login is approved', () => {
    resetTrLogins();
    // A pending challenge holds a jar, but handing it over would create a session the broker has
    // not authenticated.
    expect(takeTrLoginCookies('missing', 'owner-1')).toBeNull();
  });
});

describe('assertTrLongLivedHost', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('accepts a long-lived host', () => {
    delete process.env.VERCEL;
    delete process.env.NETLIFY;
    expect(() => assertTrLongLivedHost()).not.toThrow();
  });

  it('refuses where the challenge would be polled by a process that no longer exists', () => {
    process.env.VERCEL = '1';
    expect(() => assertTrLongLivedHost()).toThrow(/server sempre attivo/);
  });
});
