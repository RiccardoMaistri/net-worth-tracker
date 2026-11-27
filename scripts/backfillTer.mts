/**
 * One-shot TER backfill — a MANUAL migration, never a cron and never a page-load effect.
 *
 *   npm run ter:backfill:dry -- [--uid=<ownerId>]
 *   npm run ter:backfill:apply -- [--uid=<ownerId>]
 *
 * Run the dry run first. `--apply` writes only assets that still have NO TER — an explicit 0 is a
 * stored answer and is skipped — and stamps the exact Yahoo field the number came from next to it.
 * The automatic form assignment is the permanent path for future assets; THIS is the one-time
 * legacy migration, so it can be run again harmlessly if a provider had no answer the first time.
 *
 * The provider answer comes from the EXISTING per-ticker `instrument-profile-cache` through
 * `resolveInstrumentProfiles` — the same route the dialog and Esposizione use, with no second
 * cache and no second eligibility rule (`lib/utils/terAutoFill.ts`). `--dry-run` passes
 * `readOnly`, so it does not write the cache either: it is a true read-only rehearsal.
 */
import { isDemoUid } from '@/lib/utils/demoAccount';
import { effectiveProfileTicker } from '@/lib/utils/exposureRequests';
import { hasStoredTer, isTerBackfillCandidate, type TerAssetFields } from '@/lib/utils/terAutoFill';

type Mode = 'dry-run' | 'apply';

const args = process.argv.slice(2);
const mode: Mode | null = args.includes('--apply')
  ? 'apply'
  : args.includes('--dry-run')
    ? 'dry-run'
    : null;
if (!mode) {
  console.error('Choose one: --dry-run or --apply');
  process.exit(2);
}
if (args.includes('--apply') && args.includes('--dry-run')) {
  console.error('--apply and --dry-run are mutually exclusive');
  process.exit(2);
}

const ownerArg = args.find((arg) => arg.startsWith('--uid='));
const ownerId = ownerArg?.slice('--uid='.length);

const hasCloudCredentials = !!(
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
  (process.env.FIREBASE_ADMIN_PROJECT_ID &&
    process.env.FIREBASE_ADMIN_CLIENT_EMAIL &&
    process.env.FIREBASE_ADMIN_PRIVATE_KEY)
);
if (!process.env.FIRESTORE_EMULATOR_HOST && !hasCloudCredentials) {
  console.error('Refusing to run: no Firebase Admin credentials and no emulator configured.');
  process.exit(2);
}
if (mode === 'apply' && process.env.FIRESTORE_EMULATOR_HOST) {
  console.warn('[ter-backfill] APPLY against the LOCAL EMULATORS — not production.');
}

// Dynamic imports keep the Admin SDK from initialising a placeholder app before the guard above.
const { adminDb } = await import('@/lib/firebase/admin');
const { resolveInstrumentProfiles } = await import('@/lib/server/exposure/instrumentProfileService');
const { invalidateDashboardOverviewSummaryServer } =
  await import('@/lib/services/dashboardOverviewInvalidation.server');

type AssetDoc = TerAssetFields & { id: string; userId: string };

interface OwnerReport {
  ownerId: string;
  candidates: number;
  written: number;
  verified: number;
  skippedExistingTer: number;
  skippedIneligible: number;
  skippedDemo: number;
  skippedUnavailable: number;
  skippedRace: number;
  failures: string[];
}

const ASSETS = 'assets';
const BATCH_SIZE = 20;

function toTerFields(data: Record<string, unknown>): TerAssetFields {
  return {
    type: data.type as TerAssetFields['type'],
    quantity: typeof data.quantity === 'number' ? data.quantity : 0,
    subCategory: typeof data.subCategory === 'string' ? data.subCategory : undefined,
    ticker: typeof data.ticker === 'string' ? data.ticker : '',
    isin: typeof data.isin === 'string' ? data.isin : undefined,
    allocationRole: data.allocationRole as TerAssetFields['allocationRole'],
    excludeFromAllocation: typeof data.excludeFromAllocation === 'boolean' ? data.excludeFromAllocation : undefined,
    totalExpenseRatio: typeof data.totalExpenseRatio === 'number' ? data.totalExpenseRatio : undefined,
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

const query = ownerId
  ? adminDb.collection(ASSETS).where('userId', '==', ownerId)
  : adminDb.collection(ASSETS);
const snapshot = await query.get();

const reports = new Map<string, OwnerReport>();
const candidates: AssetDoc[] = [];
const seen = new Set<string>();

for (const document of snapshot.docs) {
  const data = document.data() as Record<string, unknown>;
  const userId = typeof data.userId === 'string' ? data.userId : '';
  if (!userId) continue;
  if (ownerId && userId !== ownerId) continue;
  const report = reports.get(userId) ?? {
    ownerId: userId,
    candidates: 0,
    written: 0,
    verified: 0,
    skippedExistingTer: 0,
    skippedIneligible: 0,
    skippedDemo: 0,
    skippedUnavailable: 0,
    skippedRace: 0,
    failures: [],
  };
  reports.set(userId, report);

  const fields = toTerFields(data);
  if (isDemoUid(userId)) {
    report.skippedDemo += 1;
    continue;
  }
  if (hasStoredTer(fields)) {
    report.skippedExistingTer += 1;
    continue;
  }
  if (!isTerBackfillCandidate(fields)) {
    report.skippedIneligible += 1;
    continue;
  }
  const asset: AssetDoc = { ...fields, id: document.id, userId };
  candidates.push(asset);
  report.candidates += 1;

  const identity = effectiveProfileTicker(asset);
  if (!seen.has(identity)) seen.add(identity);
}

const identities = Array.from(seen).sort((a, b) => a.localeCompare(b));
const terms = new Map<string, { value: number; source: string; fetchedAt: string }>();

for (const batch of chunks(identities, BATCH_SIZE)) {
  const { response } = await resolveInstrumentProfiles(
    batch.map((ticker) => ({ ticker, module: 'fund' as const })),
    { readOnly: mode === 'dry-run', requireTer: true }
  );
  for (const [ticker, profile] of Object.entries(response.profiles)) {
    if (profile.fund?.ter) {
      terms.set(ticker, {
        value: profile.fund.ter.value,
        source: profile.fund.ter.source,
        fetchedAt: profile.fund.ter.fetchedAt,
      });
    }
  }
}

const written: Array<{ id: string; ownerId: string; expected: number }> = [];

for (const asset of candidates) {
  const report = reports.get(asset.userId)!;
  const term = terms.get(effectiveProfileTicker(asset));
  if (!term) {
    report.skippedUnavailable += 1;
    continue;
  }
  if (mode === 'dry-run') {
    report.written += 1; // the write that WOULD happen, so the rehearsal is comparable
    continue;
  }

  try {
    // Re-read at write time: an asset can have been edited (or a previous run can have filled it)
    // between the listing and now. An explicit 0 still counts as an answer.
    const fresh = await adminDb.collection(ASSETS).doc(asset.id).get();
    const freshData = fresh.data() as Record<string, unknown> | undefined;
    if (!freshData || hasStoredTer(toTerFields(freshData))) {
      report.skippedRace += 1;
      continue;
    }
    await adminDb.collection(ASSETS).doc(asset.id).update({
      totalExpenseRatio: term.value,
      terSource: term.source,
      terFetchedAt: new Date(term.fetchedAt),
      updatedAt: new Date(),
    });
    written.push({ id: asset.id, ownerId: asset.userId, expected: term.value });
    report.written += 1;
  } catch (error) {
    report.failures.push(`${asset.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (mode === 'apply') {
  for (const row of written) {
    try {
      const fresh = await adminDb.collection(ASSETS).doc(row.id).get();
      const data = fresh.data() as Record<string, unknown> | undefined;
      if (data?.totalExpenseRatio === row.expected && typeof data.terSource === 'string' && data.terFetchedAt) {
        reports.get(row.ownerId)!.verified += 1;
      }
    } catch (error) {
      reports.get(row.ownerId)!.failures.push(`${row.id}: verification failed (${String(error)})`);
    }
  }
  for (const [id, report] of reports) {
    if (report.written > 0) {
      await invalidateDashboardOverviewSummaryServer(id, 'ter_backfilled');
    }
  }
}

console.log(
  JSON.stringify(
    {
      mode,
      owners: Array.from(reports.values()),
      assetsListed: snapshot.size,
      identitiesAsked: identities.length,
      providerAnswers: terms.size,
    },
    null,
    2
  )
);

if (Array.from(reports.values()).some((report) => report.failures.length > 0)) {
  process.exitCode = 1;
}
