/**
 * The Trade Republic session envelope — the ONE place its serialized form is written or read.
 *
 * It exists as a pure module because of a bug it now pins. The SDK validates an imported session
 * with `type({ version: "1", cookies: "string[]" })`, and in arktype a quoted NUMERIC literal is a
 * number, not a string: the schema really demands `version: 1`. Writing `{ version: "1" }` fails
 * with «version must be 1 (was "1")» — measured, not inferred — and the SDK's own `exportSession()`
 * writes the number, so a session that round-trips through it is fine while one written by hand is
 * not. The error surfaced as «Invalid exported Session» on the first sync, long after the QR login
 * had succeeded, which is why the shape is asserted against the real client in
 * `__tests__/tradeRepublicSession.test.ts` rather than trusted to a comment here.
 *
 * Pure and isomorphic on purpose: the value is a credential, so it belongs in as few modules as
 * possible, and the format must be checkable without a server or a network.
 */

/** The number the SDK's schema expects. A string here is a session that cannot be restored. */
export const TR_SESSION_VERSION = 1;

export type TrCookieJar = string[];

/** The serialized session, in the form the SDK accepts. */
export function serializeTrSession(cookies: TrCookieJar): string {
  return JSON.stringify({ version: TR_SESSION_VERSION, cookies });
}

/**
 * Read a stored session back, normalized to the form the SDK accepts. Returns the cookies, or
 * `null` for anything unreadable — a caller must treat `null` as «not linked», never as an empty
 * session that would read as a successful sync of nothing.
 *
 * THE STRING VERSION IS TOLERATED ON PURPOSE. A session stored before this was fixed carries
 * `version: "1"` and is otherwise perfectly valid: its cookies are fine and its `tr_session` is
 * live. Rejecting it would strand the user into re-scanning a QR to repair a serialisation
 * detail — the confusing advice, since nothing about their account had actually broken. So the
 * legacy shape is accepted here and rewritten in the canonical form on the next persist, which
 * heals it without a re-link.
 */
export function parseTrSession(raw: string): TrCookieJar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const version = record['version'];
  // Both forms are the same schema version; anything else is a shape this module does not know.
  if (version !== TR_SESSION_VERSION && version !== String(TR_SESSION_VERSION)) return null;
  const cookies = record['cookies'];
  if (!Array.isArray(cookies) || cookies.some((cookie) => typeof cookie !== 'string')) return null;
  return cookies as TrCookieJar;
}
