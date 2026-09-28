/**
 * The session envelope, asserted against the REAL client.
 *
 * This suite exists because of a bug it now pins. The session was first written as
 * `{ version: "1", cookies }`, because the SDK's schema reads `type({ version: "1" })` and a
 * quoted `"1"` looks like the string. It is not: arktype reads a quoted numeric literal as a
 * NUMBER, so the schema demands `version: 1` and the string form is refused with
 * «version must be 1 (was "1")» — surfacing as «Invalid exported Session» on the first sync, long
 * after the QR login had succeeded and stored a perfectly live session.
 *
 * So the assertion is made against `TRClient` itself, not against a comment: a test that restates
 * the format we believe in cannot catch the belief being wrong. The SDK is a direct dependency, so
 * importing it here introduces no phantom one.
 */

import { describe, expect, it } from 'vitest';
import { TRClient } from 'trade-republic-sdk';
import {
  parseTrSession,
  serializeTrSession,
  TR_SESSION_VERSION,
} from '@/lib/utils/tradeRepublicSession';

// BOTH cookies, because that is what the SDK requires to restore a session: it refuses one
// without `tr_refresh` (it cannot renew without it), and its own login path checks for both.
const COOKIES = [
  // A long-but-finite lifetime, in the FUTURE, so the refresh the SDK schedules cannot fire during
  // the test. It is also past the ~24.8 days a 32-bit timer covers, so Node prints one
  // TimeoutOverflowWarning while scheduling it — the SDK's timer, not a defect in this fixture, and
  // the reason the expiry is not pinned to "now": a wall-clock-dependent fixture would start failing
  // on its own in a year. A real Trade Republic session expires in hours, well inside the range.
  'tr_session=eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3NTAwMDAwMDAsImV4cCI6MTkwMDAwMDAwMH0.sig; Path=/; HttpOnly',
  'tr_refresh=refresh-token-value; Path=/; HttpOnly',
];

describe('serializeTrSession', () => {
  it('writes a version the client can actually restore', () => {
    // The load-bearing assertion. `TRClient` parses the session in its CONSTRUCTOR, so a shape it
    // refuses throws here rather than at the first topic read — minutes and one click later.
    expect(() => new TRClient({ session: serializeTrSession(COOKIES) })).not.toThrow();
  });

  it('writes the version as a NUMBER, which is what arktype reads "1" as', () => {
    const parsed = JSON.parse(serializeTrSession(COOKIES)) as { version: unknown };
    expect(typeof parsed.version).toBe('number');
    expect(parsed.version).toBe(TR_SESSION_VERSION);
  });

  it('round-trips through the client own export, so a refresh cannot change the shape', () => {
    // The session written by a refresh comes from `exportSession()`, not from here. If the two
    // disagreed, the first refresh would store a document the next read cannot load.
    const client = new TRClient({ session: serializeTrSession(COOKIES) });
    const exported = client.exportSession();
    expect(exported).toBeDefined();
    expect(() => new TRClient({ session: exported as string })).not.toThrow();
  });
});

describe('parseTrSession', () => {
  it('reads back what it wrote', () => {
    expect(parseTrSession(serializeTrSession(COOKIES))).toEqual(COOKIES);
  });

  it('heals a session stored with the legacy string version instead of stranding it', () => {
    // Those cookies are fine and the `tr_session` is live: making the user re-scan a QR to repair
    // a serialisation detail would be the wrong advice, and the error they saw gave no hint of it.
    const legacy = JSON.stringify({ version: '1', cookies: COOKIES });
    expect(parseTrSession(legacy)).toEqual(COOKIES);
    // And the healed form is the canonical one, so the next persist rewrites the document.
    expect(() => new TRClient({ session: serializeTrSession(parseTrSession(legacy) as string[]) })).not.toThrow();
  });

  it('reports an unreadable document as no session, never as an empty one', () => {
    // An empty jar would read as «linked, and the account holds nothing», which is a successful
    // sync of a wrong answer rather than a missing link.
    expect(parseTrSession('')).toBeNull();
    expect(parseTrSession('not json')).toBeNull();
    expect(parseTrSession('[]')).toBeNull();
    expect(parseTrSession(JSON.stringify({ version: 1 }))).toBeNull();
    expect(parseTrSession(JSON.stringify({ version: 2, cookies: COOKIES }))).toBeNull();
    expect(parseTrSession(JSON.stringify({ version: 1, cookies: [1, 2] }))).toBeNull();
  });
});
