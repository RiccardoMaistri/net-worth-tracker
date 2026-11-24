import { afterEach, describe, expect, it } from 'vitest';
import { canUseOkx } from '@/lib/utils/okxAccess';

const original = process.env.OKX_ALLOWED_EMAIL;

afterEach(() => {
  if (original === undefined) delete process.env.OKX_ALLOWED_EMAIL;
  else process.env.OKX_ALLOWED_EMAIL = original;
});

describe('canUseOkx', () => {
  it('allows the owner by default, normalized', () => {
    delete process.env.OKX_ALLOWED_EMAIL;
    expect(canUseOkx('rykymai@gmail.com')).toBe(true);
    expect(canUseOkx(' RykyMai@Gmail.com ')).toBe(true);
    expect(canUseOkx('riccardo.maistri95@gmail.com')).toBe(false);
    expect(canUseOkx(null)).toBe(false);
    expect(canUseOkx(undefined)).toBe(false);
  });

  it('reads a comma-separated allowlist, ignoring blanks', () => {
    process.env.OKX_ALLOWED_EMAIL = ' a@example.com, ,b@example.com ';
    expect(canUseOkx('B@example.com')).toBe(true);
    expect(canUseOkx('rykymai@gmail.com')).toBe(false);
  });
});
