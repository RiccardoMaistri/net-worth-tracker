# Commit Summary: feat/costi-inflazione

## Overview
One commit implementing two features: (1) 20-year TER cost-drag sentence in Panoramica's Costi tile, and (2) HICP Italy inflation data used outside FIRE (Storico nominal/real toggle, Patrimonio liquidità purchasing-power line, FIRE form reference rate).

---

## ✅ FEATURE 1: 20-year TER cost-drag

### New files (9)
| File | Purpose |
|---|---|
| `lib/utils/costDrag.ts` | `projectCostDrag(input)` — projects gross/net/difference over 20y horizon; returns `null` when TER=0 or invested=0 |
| `lib/utils/fireScenarios.ts` | Pure `getDefaultScenarios()` extracted from `fireService` (server-safe, no Firebase import) |
| `__tests__/costDrag.test.ts` | 6 test cases: projection, exponential horizon, null on zero TER, null on zero-invested/horizon, compound refusal |
| `types/dashboardOverview.ts` | Added `DashboardOverviewCostDrag` interface |
| `lib/services/dashboardOverviewService.ts` | Added `costDrag` computation beside `costDrivers`; uses `COST_DRAG_HORIZON_YEARS` and base FIRE scenario |
| `lib/services/dashboardOverviewConstants.ts` | Bumped `DASHBOARD_OVERVIEW_SOURCE_VERSION` from 20 → 21 |
| `lib/utils/overviewNarrative.ts` | Added `describeCostDrag(costDrag)` — returns `null` when no drag to report |
| `components/dashboard/overview/CostiTile.tsx` | Wired `costDrag` prop; sentence under «TER medio · Costo annuo»; `TileMethodNote` behind «Come si calcola» |
| `app/dashboard/page.tsx` | Wired `<CostiTile costDrag={overview.costDrag ?? null} />` |

### Modified existing files (11)
| File | Change |
|---|---|
| `lib/services/fireService.ts` | Re-export `getDefaultScenarios` from `@/lib/utils/fireScenarios` (server-safe) |
| `lib/utils/overviewNarrative.ts` | Added `describeCostDrag` import and test cases in `__tests__/overviewNarrative.test.ts` |
| `__tests__/overviewNarrative.test.ts` | 3 test cases for `describeCostDrag` |
| `app/dashboard/page.tsx` | Wire CostiTile with costDrag prop |

---

## ✅ FEATURE 2: HICP Italy inflation outside FIRE

### New files (12)
| File | Purpose |
|---|---|
| `lib/constants/inflation.ts` | `INFLATION_CACHE_COLLECTION`, `INFLATION_CACHE_DOC`, `INFLATION_FRED_SERIES`, `INFLATION_CACHE_TTL_MS` (7 days) |
| `types/benchmarks.ts` | `InflationMonthlyIndex`, `InflationIndexResponse`, `InflationValuePoint` types |
| `lib/server/inflationService.ts` | Firestore read/write (`inflation-cache/hicp-it`), FRED fetch, `refreshInflationIfStale()` for daily cron |
| `app/api/benchmarks/inflation/route.ts` | `GET /api/benchmarks/inflation` — authenticated, not owner-scoped, 503 when no cache/FRED, stale flag |
| `lib/utils/inflation.ts` | Pure arithmetic: `deflate()`, `realSeries()`, `purchasingPowerLoss()`, `inflationRateOver()`, `shiftInflationMonth()`, `resolveLatestInflationMonth()`, `formatInflationMonth()` |
| `lib/hooks/useInflationIndex.ts` | React Query hook: `staleTime 6h`, `retry: 1`, error → surface owns the failure |
| `__tests__/inflation.test.ts` | 13 test cases: findIndex, resolveLatest, inflationRateOver, deflate, realSeries, purchasingPowerLoss, formatInflationMonth |
| `__tests__/inflationRoute.test.ts` | 5 test cases: fresh cache, 503 without key, stale on FRED failure, fetch+write, no carry-forward |
| `lib/utils/fireNarrative.ts` | `describeInflationReference(state)` — HICP 12-month rate beside FIRE scenario grid |
| `components/fire-simulations/FireParametri.tsx` | Added `inflationReference` beside scenario params; reads `useInflationIndex()` |

### Modified existing files (14)
| File | Change |
|---|---|
| `lib/services/fireService.ts` | Already re-export extraction (see Feature 1) |
| `lib/query/queryKeys.ts` | Added `inflation: () => ['benchmarks', 'inflation']` |
| `firestore.rules` | `match /inflation-cache/{docId} { allow read, write: if false; }` (Admin SDK only) |
| `app/api/cron/monthly-snapshot/route.ts` | Added `await refreshInflationIfStale()` (non-blocking) |
| `components/assets/tiles/LiquiditaTile.tsx` | `extraReading` prop → `describeCashInflationLoss` when index available |
| `app/dashboard/assets/page.tsx` | Wired `useInflationIndex()` + `purchasingPowerLoss` + `describeCashInflationLoss` in `extraReading` |
| `lib/utils/patrimonioNarrative.ts` | Added `describeCashInflationLoss(loss, ratePct, reference)` |
| `__tests__/patrimonioNarrative.test.ts` | 2 test cases for `describeCashInflationLoss` |
| `lib/utils/storicoNarrative.ts` | Added `describeEvolutionInflation(state)` — «HICP Italia noto fino a settembre 2026» / real mode message |
| `__tests__/storicoNarrative.test.ts` | 4 test cases for `describeEvolutionInflation` |
| `components/history/tiles/EvoluzioneTile.tsx` | `valueMode` `'nominal'|'real'` toggle; `SegmentedPill` with `semantics="radio"`; inflation status line |
| `__tests__/fireNarrative.test.ts` | 3 test cases for `describeInflationReference` |
| `app/dashboard/history/page.tsx` | Real/nominal evolution mode; `realOrdered` via `deflate`; `displayGrowth`/`displayPace`/`displayEvolutionPoints` |
| `components/fire-simulations/FireParametri.tsx` | Already updated (see above) |

### Test file updates (4 existing files modified)
| File | Added |
|---|---|
| `__tests__/overviewNarrative.test.ts` | 3 cases for `describeCostDrag` |
| `__tests__/storicoNarrative.test.ts` | 4 cases for `describeEvolutionInflation` |
| `__tests__/patrimonioNarrative.test.ts` | 2 cases for `describeCashInflationLoss` |
| `__tests__/fireNarrative.test.ts` | 3 cases for `describeInflationReference` |

---

## ✅ Checks Passed
- `npx tsc --noEmit` — **no errors**
- `npx vitest run` (7 test files) — **213 tests passed**
- `npm run lint` — **0 errors, 4 pre-existing warnings** (not from this session)

---

## ⛔ EXCLUDED: OKX pre-existing work (stays out of this commit)
| File | Content |
|---|---|
| `package.json` | `okx:poc` script addition |
| `CLAUDE.md` | OKX POC section |
| `SETUP.md` | OKX POC setup section |
| `__tests__/okxAccess.test.ts` | OKX POC test |
| `__tests__/okxPocRoute.test.ts` | OKX POC route test |
| `__tests__/okxPortfolio.test.ts` | OKX POC portfolio test |
| `app/api/broker/okx/` | OKX broker routes |
| `lib/utils/okxAccess.ts` | OKX access utils |
| `lib/utils/okxPortfolio.ts` | OKX portfolio utils |
| `scripts/okxPoc.mts` | OKX POC script |

---

## 📌 One commit only — awaiting explicit user OK

To proceed with the commit, run:
```bash
git add \
  __tests__/costDrag.test.ts \
  __tests__/inflation.test.ts \
  __tests__/inflationRoute.test.ts \
  lib/constants/inflation.ts \
  lib/hooks/useInflationIndex.ts \
  lib/server/inflationService.ts \
  app/api/benchmarks/inflation/route.ts \
  lib/utils/costDrag.ts \
  lib/utils/fireScenarios.ts \
  lib/services/dashboardOverviewService.ts \
  lib/services/dashboardOverviewConstants.ts \
  lib/services/fireService.ts \
  lib/query/queryKeys.ts \
  firestore.rules \
  types/dashboardOverview.ts \
  types/benchmarks.ts \
  components/dashboard/overview/CostiTile.tsx \
  app/dashboard/page.tsx \
  lib/utils/overviewNarrative.ts \
  components/assets/tiles/LiquiditaTile.tsx \
  app/dashboard/assets/page.tsx \
  lib/utils/patrimonioNarrative.ts \
  lib/utils/storicoNarrative.ts \
  components/history/tiles/EvoluzioneTile.tsx \
  app/dashboard/history/page.tsx \
  lib/utils/fireNarrative.ts \
  components/fire-simulations/FireParametri.tsx \
  __tests__/overviewNarrative.test.ts \
  __tests__/storicoNarrative.test.ts \
  __tests__/patrimonioNarrative.test.ts \
  __tests__/fireNarrative.test.ts
```

Then `git commit -m "feat: cost-drag sentence + HICP inflation outside FIRE"` — or review individual file diffs first.

**Reply with "OK" to proceed, or let me know what changes you'd like.**