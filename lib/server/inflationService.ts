import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/firebase/admin';
import {
  INFLATION_CACHE_COLLECTION,
  INFLATION_CACHE_DOC,
  INFLATION_CACHE_TTL_MS,
  INFLATION_FRED_SERIES,
} from '@/lib/constants/inflation';
import type { InflationMonthlyIndex } from '@/types/benchmarks';

const FRED_API_URL = 'https://api.stlouisfed.org/fred/series/observations';

interface FredObservation {
  date: string; // "YYYY-MM-DD"
  value: string; // index, "." means missing
}

/**
 * FRED's monthly observations as the app's index series. One entry per month with a real value:
 * a missing observation is skipped, never filled with the previous month's index — the gap is
 * part of the answer (the surfaces name the last published month).
 */
export function buildMonthlyInflationFromFred(observations: FredObservation[]): InflationMonthlyIndex[] {
  const byMonth = new Map<string, InflationMonthlyIndex>();

  for (const observation of observations) {
    if (observation.value === '.') continue;
    const index = Number.parseFloat(observation.value);
    if (!Number.isFinite(index)) continue;
    const year = Number.parseInt(observation.date.slice(0, 4), 10);
    const month = Number.parseInt(observation.date.slice(5, 7), 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) continue;
    byMonth.set(`${year}-${String(month).padStart(2, '0')}`, { year, month, index });
  }

  return [...byMonth.values()].sort((a, b) => a.year - b.year || a.month - b.month);
}

/** Fetches the HICP Italy series from FRED and normalises it to one entry per published month. */
export async function fetchAndBuildInflationIndex(): Promise<InflationMonthlyIndex[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY is not set');

  const url =
    `${FRED_API_URL}?series_id=${INFLATION_FRED_SERIES}&api_key=${apiKey}` +
    '&file_type=json&observation_start=1996-01-01&sort_order=asc';

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`FRED API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { observations: FredObservation[] };
  return buildMonthlyInflationFromFred(data.observations);
}

/** Reads the cached HICP series. Null when the document is missing. */
export async function readInflationIndexFromFirestore(): Promise<{
  monthlyIndex: InflationMonthlyIndex[];
  cachedAt: Date;
} | null> {
  const snap = await adminDb.collection(INFLATION_CACHE_COLLECTION).doc(INFLATION_CACHE_DOC).get();
  if (!snap.exists) return null;

  const data = snap.data()!;
  return {
    monthlyIndex: (data.monthlyIndex ?? []) as InflationMonthlyIndex[],
    cachedAt: (data.cachedAt as Timestamp).toDate(),
  };
}

/** Writes the cached HICP series. Admin SDK only (firestore.rules: read and write false). */
export async function writeInflationIndexToFirestore(monthlyIndex: InflationMonthlyIndex[]): Promise<void> {
  await adminDb.collection(INFLATION_CACHE_COLLECTION).doc(INFLATION_CACHE_DOC).set({
    monthlyIndex,
    cachedAt: FieldValue.serverTimestamp(),
  });
}

export function isInflationCacheStale(cachedAt: Date): boolean {
  return Date.now() - cachedAt.getTime() > INFLATION_CACHE_TTL_MS;
}

/**
 * The daily cron's hook: refresh the shared HICP cache when it is older than the TTL. Skips
 * gracefully without a FRED key so the cron never fails because of this source.
 */
export async function refreshInflationIfStale(): Promise<void> {
  if (!process.env.FRED_API_KEY) {
    console.warn('[inflation] FRED_API_KEY not set — skipping HICP refresh');
    return;
  }

  const cached = await readInflationIndexFromFirestore();
  if (cached && !isInflationCacheStale(cached.cachedAt)) return;

  const monthlyIndex = await fetchAndBuildInflationIndex();
  await writeInflationIndexToFirestore(monthlyIndex);
}
