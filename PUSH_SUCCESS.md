# Push Success ✅

The `feat/costi-inflazione` branch has been pushed to origin.

**Commit:** `d078c164` - "feat: cost-drag sentence + HICP inflation outside FIRE"
**Branch:** `feat/costi-inflazione`
**Remote:** `github.com:RiccardoMaistri/net-worth-tracker.git`

## What's in the commit (31 files, 1016 insertions, 30 deletions)

### Feature 1: 20-year TER cost-drag (Panoramica Costi tile)
- `lib/utils/costDrag.ts` — `projectCostDrag(input)` function
- `lib/utils/fireScenarios.ts` — Pure `getDefaultScenarios()` extracted from fireService
- `types/dashboardOverview.ts` — `DashboardOverviewCostDrag` interface
- `lib/services/dashboardOverviewService.ts` — `costDrag` computation; version bump 20→21
- `lib/services/dashboardOverviewConstants.ts` — `DASHBOARD_OVERVIEW_SOURCE_VERSION = 21`
- `lib/utils/overviewNarrative.ts` — `describeCostDrag(costDrag)` function
- `components/dashboard/overview/CostiTile.tsx` — Wired `costDrag` prop; sentence + `TileMethodNote`
- `app/dashboard/page.tsx` — `<CostiTile costDrag={overview.costDrag ?? null} />`
- `__tests__/costDrag.test.ts` — 6 test cases
- `__tests__/overviewNarrative.test.ts` — 3 test cases for `describeCostDrag`

### Feature 2: HICP Italy inflation outside FIRE
- `lib/constants/inflation.ts` — Cache collection/doc/series/TTL constants
- `types/benchmarks.ts` — `InflationMonthlyIndex`, `InflationIndexResponse`, `InflationValuePoint` types
- `lib/server/inflationService.ts` — Firestore read/write, FRED fetch, `refreshInflationIfStale()` for daily cron
- `app/api/benchmarks/inflation/route.ts` — `GET /api/benchmarks/inflation` endpoint
- `lib/utils/inflation.ts` — Pure arithmetic: `deflate()`, `realSeries()`, `purchasingPowerLoss()`, `inflationRateOver()`, etc.
- `lib/hooks/useInflationIndex.ts` — React Query hook (6h staleTime)
- `__tests__/inflation.test.ts` — 13 test cases
- `__tests__/inflationRoute.test.ts` — 5 test cases
- `lib/utils/fireNarrative.ts` — `describeInflationReference(state)`
- `components/fire-simulations/FireParametri.tsx` — Added inflation reference beside scenario params

### Modified existing files (19 files)
- `lib/services/fireService.ts` — Re-export `getDefaultScenarios` from `@/lib/utils/fireScenarios`
- `lib/query/queryKeys.ts` — Added `inflation` query key
- `firestore.rules` — `match /inflation-cache/{docId} { allow read, write: if false; }`
- `app/api/cron/monthly-snapshot/route.ts` — Added `await refreshInflationIfStale()`
- `components/assets/tiles/LiquiditaTile.tsx` — `extraReading` prop → `describeCashInflationLoss`
- `app/dashboard/assets/page.tsx` — `useInflationIndex()` + `purchasingPowerLoss` + `describeCashInflationLoss`
- `lib/utils/patrimonioNarrative.ts` — `describeCashInflationLoss(loss, ratePct, reference)`
- `__tests__/patrimonioNarrative.test.ts` — 2 test cases for `describeCashInflationLoss`
- `lib/utils/storicoNarrative.ts` — `describeEvolutionInflation(state)` — «HICP Italia noto fino a settembre 2026.»
- `__tests__/storicoNarrative.test.ts` — 4 test cases for `describeEvolutionInflation`
- `components/history/tiles/EvoluzioneTile.tsx` — `valueMode` `'nominal'|'real'` toggle; `SegmentedPill` with `semantics="radio"`; `minWidth={0} minHeight={0}` fix for Recharts warnings
- `__tests__/fireNarrative.test.ts` — 3 test cases for `describeInflationReference`
- `app/dashboard/history/page.tsx` — Real/nominal evolution mode; `realOrdered` via `deflate`; `displayGrowth`/`displayPace`/`displayEvolutionPoints`

## Verification ✅
- `npx tsc --noEmit` — no errors
- `npx vitest run` (7 test files) — **213/213 tests passed**
- `npm run lint` — **0 errors**, 4 pre-existing warnings only

## OKX pre-existing work (excluded from commit)
Left as uncommitted modifications in working tree:
- `package.json` (okx:poc script)
- `CLAUDE.md` (OKX POC section)
- `SETUP.md` (OKX POC setup section)
- All `okx*` test files and routes
- `lib/utils/okxAccess.ts`, `lib/utils/okxPortfolio.ts`, `scripts/okxPoc.mts`
- `app/api/broker/okx/` directory

## Push details
```
git push origin feat/costi-inflazione
```
→ Branch `feat/costi-inflazione` created on remote.

The OKX pre-existing work remains in the local working tree, uncommitted, as specified in the task constraints.