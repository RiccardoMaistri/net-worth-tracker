/**
 * OKX is wired to ONE server-side API key (one account per deploy), so only its owner may call the
 * POC route. The UI (when a tile exists) hides it; the route enforces it. `OKX_ALLOWED_EMAIL` is a
 * comma-separated allowlist, server-side only (no `NEXT_PUBLIC_` prefix) — unset, it falls back to
 * the owner's address, the same default `binanceAccess.ts` hard-codes.
 */
const DEFAULT_OKX_ALLOWED_EMAIL = 'rykymai@gmail.com';

export function canUseOkx(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  const allowed = (process.env.OKX_ALLOWED_EMAIL || DEFAULT_OKX_ALLOWED_EMAIL)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(normalized);
}
