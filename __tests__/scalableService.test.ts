import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  getScalableProfileForEmail,
  getProfileXdgConfigHome,
  ScalableService,
  SCALABLE_USERS,
} from '@/lib/server/scalableService';

vi.mock('@/lib/server/scalableCli', () => ({
  SCALABLE_LOGIN_ARGS: ['login', '--local-read-only'],
  scalableCliPath: () => 'sc',
  ensureScalableConfigFile: vi.fn(),
  ScalableCliError: class ScalableCliError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/lib/server/apiAuth', () => ({
  requireFirebaseAuth: vi.fn(),
  getApiAuthErrorResponse: vi.fn(() => null),
  assertCanAccessAccount: vi.fn(),
}));

describe('ScalableService & User Mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('User Mapping & Case Insensitivity', () => {
    it('maps rykymai@gmail.com to riccardo profile', () => {
      const profile = getScalableProfileForEmail('rykymai@gmail.com');
      expect(profile).toEqual({ profile: 'riccardo', name: 'Riccardo' });
    });

    it('maps Michele.Maistri@gmail.com case-insensitively to michele profile', () => {
      const lowercase = getScalableProfileForEmail('michele.maistri@gmail.com');
      const mixedCase = getScalableProfileForEmail('Michele.Maistri@gmail.com');
      const uppercase = getScalableProfileForEmail('MICHELE.MAISTRI@GMAIL.COM');

      expect(lowercase).toEqual({ profile: 'michele', name: 'Michele' });
      expect(mixedCase).toEqual({ profile: 'michele', name: 'Michele' });
      expect(uppercase).toEqual({ profile: 'michele', name: 'Michele' });
    });

    it('returns null for unauthorized Google email', () => {
      const profile = getScalableProfileForEmail('unauthorized.user@gmail.com');
      expect(profile).toBeNull();
    });

    it('returns null for empty or null email', () => {
      expect(getScalableProfileForEmail('')).toBeNull();
      expect(getScalableProfileForEmail(null)).toBeNull();
      expect(getScalableProfileForEmail(undefined)).toBeNull();
    });
  });

  describe('Directory Isolation', () => {
    it('resolves different XDG_CONFIG_HOME paths per user profile', () => {
      const riccardoXdg = getProfileXdgConfigHome('riccardo');
      const micheleXdg = getProfileXdgConfigHome('michele');

      expect(riccardoXdg).toContain('profiles/riccardo');
      expect(micheleXdg).toContain('profiles/michele');
      expect(riccardoXdg).not.toEqual(micheleXdg);
    });
  });

  describe('API Routes Authentication & Forbidden Check', () => {
    it('GET /api/scalable/status returns 403 for unlisted user', async () => {
      const { requireFirebaseAuth } = await import('@/lib/server/apiAuth');
      vi.mocked(requireFirebaseAuth).mockResolvedValueOnce({
        email: 'attacker@gmail.com',
        uid: 'user-attacker',
      } as any);

      const { GET } = await import('@/app/api/scalable/status/route');
      const req = new NextRequest('http://localhost/api/scalable/status');
      const res = await GET(req);

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('utente non autorizzato');
    });

    it('GET /api/scalable/portfolio returns 403 for unlisted user', async () => {
      const { requireFirebaseAuth } = await import('@/lib/server/apiAuth');
      vi.mocked(requireFirebaseAuth).mockResolvedValueOnce({
        email: 'hacker@gmail.com',
        uid: 'user-hacker',
      } as any);

      const { GET } = await import('@/app/api/scalable/portfolio/route');
      const req = new NextRequest('http://localhost/api/scalable/portfolio');
      const res = await GET(req);

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('utente non autorizzato');
    });
  });
});
