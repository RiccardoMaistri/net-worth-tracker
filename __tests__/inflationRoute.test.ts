/**
 * GET /api/benchmarks/inflation — the shared HICP cache and its degradation contract:
 * fresh cache → the data; no key and no cache → 503; FRED down with a cache → the older data
 * flagged `stale: true`; a successful fetch → the data and an async cache write.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { InflationMonthlyIndex } from '@/types/benchmarks';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/apiAuth', () => ({
  requireFirebaseAuth: vi.fn(async () => ({ uid: 'user-1' })),
  getApiAuthErrorResponse: vi.fn(() => null),
}));

const {
  readInflationIndexFromFirestoreMock,
  writeInflationIndexToFirestoreMock,
  fetchAndBuildInflationIndexMock,
  isInflationCacheStaleMock,
} = vi.hoisted(() => ({
  readInflationIndexFromFirestoreMock: vi.fn(),
  writeInflationIndexToFirestoreMock: vi.fn(),
  fetchAndBuildInflationIndexMock: vi.fn(),
  isInflationCacheStaleMock: vi.fn(),
}));

vi.mock('@/lib/server/inflationService', () => ({
  readInflationIndexFromFirestore: readInflationIndexFromFirestoreMock,
  writeInflationIndexToFirestore: writeInflationIndexToFirestoreMock,
  fetchAndBuildInflationIndex: fetchAndBuildInflationIndexMock,
  isInflationCacheStale: isInflationCacheStaleMock,
}));

import { GET as inflationRoute } from '@/app/api/benchmarks/inflation/route';

const ROUTE = 'http://localhost/api/benchmarks/inflation';
const CACHED_AT = new Date('2026-11-01T10:00:00.000Z');
const SERIES: InflationMonthlyIndex[] = [
  { year: 2025, month: 9, index: 100 },
  { year: 2026, month: 9, index: 102.1 },
];

function request(): NextRequest {
  return new NextRequest(ROUTE, { headers: { authorization: 'Bearer token' } });
}

describe('GET /api/benchmarks/inflation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('FRED_API_KEY', 'test-key');
    readInflationIndexFromFirestoreMock.mockResolvedValue(null);
    isInflationCacheStaleMock.mockReturnValue(false);
    writeInflationIndexToFirestoreMock.mockResolvedValue(undefined);
  });

  it('answers from a fresh cache, with the series’ own end', async () => {
    readInflationIndexFromFirestoreMock.mockResolvedValue({ monthlyIndex: SERIES, cachedAt: CACHED_AT });

    const response = await inflationRoute(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      monthlyIndex: SERIES,
      latestMonth: { year: 2026, month: 9 },
      stale: false,
    });
    expect(fetchAndBuildInflationIndexMock).not.toHaveBeenCalled();
  });

  it('answers 503 without a cache and without a FRED key', async () => {
    vi.stubEnv('FRED_API_KEY', '');

    const response = await inflationRoute(request());
    expect(response.status).toBe(503);
  });

  it('serves the older cache flagged stale when FRED fails', async () => {
    readInflationIndexFromFirestoreMock.mockResolvedValue({ monthlyIndex: SERIES, cachedAt: CACHED_AT });
    isInflationCacheStaleMock.mockReturnValue(true);
    fetchAndBuildInflationIndexMock.mockRejectedValue(new Error('FRED down'));

    const response = await inflationRoute(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ monthlyIndex: SERIES, stale: true });
  });

  it('fetches, answers and writes the cache when the stored series is stale', async () => {
    readInflationIndexFromFirestoreMock.mockResolvedValue({ monthlyIndex: SERIES, cachedAt: CACHED_AT });
    isInflationCacheStaleMock.mockReturnValue(true);
    fetchAndBuildInflationIndexMock.mockResolvedValue(SERIES);

    const response = await inflationRoute(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ stale: false });
    expect(fetchAndBuildInflationIndexMock).toHaveBeenCalledTimes(1);
    expect(writeInflationIndexToFirestoreMock).toHaveBeenCalledWith(SERIES);
  });

  it('never carries the last month forward: an unpublished month is simply absent', async () => {
    readInflationIndexFromFirestoreMock.mockResolvedValue({ monthlyIndex: SERIES, cachedAt: CACHED_AT });

    const response = await inflationRoute(request());
    const body = await response.json();
    expect(body.monthlyIndex.some((entry: InflationMonthlyIndex) => entry.month === 10)).toBe(false);
    expect(body.latestMonth).toEqual({ year: 2026, month: 9 });
  });
});
