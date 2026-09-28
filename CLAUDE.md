# CLAUDE.md - Net Worth Tracker (Lean)

> **Read [WORKFLOW.md](WORKFLOW.md) before starting**: standing session rules (one branch and one
> commit per session, never commit without approval, answer in Italian) and the guided-verification
> protocol. A new rule stated in a session is added there, in that session's commit.

## Project Overview
Next.js app for Italian investors: net worth, assets, cashflow, dividends, performance metrics and long-term planning on Firebase.

**This file is the INDEX**: "what it is + where it lives", nothing more — keep it well under 20.000 characters; it is injected into every turn. Repo-wide conventions and gotchas live in **AGENTS.md**; the per-area rules and traps in **`doc/guide/<tema>.md`** (one file per page/tab/subsystem — the feature index below points to each, and AGENTS.md § 3 carries a stub apiece; the test harness is `doc/guide/e2e-emulatori.md`, its two stubs in AGENTS.md § 5); the aesthetic spec in **DESIGN.md**; env/emulators/Playwright in **SETUP.md**; users and positioning in **PRODUCT.md**. Session rules and the guided-verification protocol in **[WORKFLOW.md](WORKFLOW.md)** (see the note at the top).

> **Language**: this file and AGENTS.md are in English. Italian is reserved for user-facing UI text. Page and feature names stay Italian, because they are the labels the product shows: Panoramica, Patrimonio, Cashflow, Analisi, Rendimenti, Allocazione, Storico, Previdenza, Impostazioni.

## Current Status
- Stack: Next.js 16, React 19, TypeScript 5, Tailwind v4, Firebase, Vitest, Framer Motion, Recharts, Yahoo Finance, Borsa Italiana scraping, Anthropic.
- `tsc` clean; **190 files / 4481 tests** green in `Europe/Rome` + **39 Playwright spec files** (144 tests, incl. 6 auth setups; last full run 2026-09-27 on the Windows laptop: 143 green, the one red the known `modal.origin`, green alone right after — doc/guide/e2e-emulatori.md). Run Vitest under `TZ=Europe/Rome` too — every date fixture sits at noon, which structurally hides timezone bugs.
- Latest (2026-09-27): **Three external PRs integrated with changes (#400, #401, #403, by Ciocc128), the open
  proposal #402 turned into a spec, and Divisione's pool netted of the common income.** Analisi › Flusso reads by 50/30/20 role (opt-in, the role lives on the category)
  and below 640px draws a share bar and rows instead of the Sankey; Strumenti splits the class chip of a composite
  instrument. What the review changed: every phone sentence and share moved into `analisiNarrative.ts` /
  `spendingRoles.ts`, printed shares that add up to 100, signed income in the roles summary, a category write that
  invalidates what Analisi reads, `useCssColorTokens` gated by `enabled`, the dead phone-Sankey path deleted, the inert
  E2E assertions rewritten (overflow on `main`, an absence with its anchor). #402 is `doc/perf/PERF-00`, to implement
  BEFORE PERF-01; nine PERF and six MOB specs amended to the code as it is; the owner's decisions in the two READMEs
  § 9. **Verified** (final code): `tsc`, lint 0, Vitest 190 / 4481 in both timezones, Playwright 143 of 144 (the red
  the known `modal.origin`, green alone right after), `npm run build` green before the Divisione change; six E2E
  falsifications seen red. The owner's tour on the mirror (five points, all passed) found three defects no fixture
  could show, each now a Vitest case: two same-named categories labelled alike under one role, the Sankey's shades
  fading to black past the seventh node, «0%» printed over a role that holds money. Same session, owner's request:
  **Divisione — income left «in comune» pays the common spending FIRST**, the shares divide the net, a surplus is
  declared and never distributed, and the base is EVERY income attributed to a person, whatever its category (the
  sentences say «entrate», `laborIncomeCategoryIds` is no longer read); the «In comune» tile shows «Entrate in comune
  −X €» and «Da dividere Y €» under its hero, the verdict says it in the one sentence, the email in its reading
  (doc/guide/cashflow-divisione.md; +13 Vitest, +1 E2E seen red). The two dossiers this work sits between are
  `doc/perf/README.md` (fourteen specs, PERF-00 and PERF-01 first, 2026-09-26) and `doc/mobile/README.md` (nine specs,
  implemented AFTER the PERF ones, 2026-09-27); the owner's decisions are in each README § 9.

## Architecture Snapshot
- App Router; protected pages under `app/dashboard/*`.
- `lib/services/*` (service layer) → pure `lib/utils/*` → `lib/server/*` (server-only). React Query for caching/invalidation.
- Italy timezone helpers in `lib/utils/dateHelpers.ts`.
- Convention: extract logic into pure, tested `lib/utils`/`lib/services` functions; keep Firestore-coupled code thin.

## Key Features (Active)
One line per area: the question it answers, then where it is described. *What the user sees* → README.md; *repo-wide rules* → AGENTS.md; *an area's rules, files and blind spots* → `doc/guide/<tema>.md`; *the aesthetic* → DESIGN.md.

- **Periodic emails · budget email · PDF export**: rule-generated verdict first, AI comment second; every hex from `printTokens.ts`. doc/guide/email-pdf.md; DESIGN → The Out-Of-DOM Token Rule.
- **Collegamenti broker**: sync in sola lettura da due broker, ognuno con la sua sessione e i suoi limiti (Impostazioni → Collegamenti). **Scalable Capital**: il server locale esegue solo `broker holdings/overview --json`, l'anteprima propone creazioni e prezzi ma mai quantità ledger (scostamenti come avvisi), la liquidità è il residuo dei totali. **Trade Republic**: sessione via QR approvata nell'app del broker, sopravvive al riavvio (`brokerSessions/{ownerId}`, solo Admin SDK) e si rinnova da sola; il portafoglio NON porta prezzi, quindi gli asset nascono con `autoUpdatePrice: true` e li quota Yahoo, la cassa è un saldo reale (`cash`) e non un residuo, e gli Sparpläne sono dichiarati e mai scritti. Sincronizzare è sempre e solo leggere: whitelist di argv per Scalable, whitelist di topic per Trade Republic. Metadati per broker in `brokerConnections/{ownerId}/brokers/{broker}`. doc/guide/collegamenti.md.
- **Themes**: twelve theme blocks × nine chart slots through `useChartColors`, every block held to the distinctness floor by `__tests__/chartPaletteDistinctness.test.ts`. doc/guide/temi.md.
- **Collegamenti broker**: sync in sola lettura da due broker, ognuno con la sua sessione e i suoi limiti (Impostazioni → Collegamenti). **Scalable Capital**: il server locale esegue solo `broker holdings/overview --json`, l'anteprima propone creazioni e prezzi ma mai quantità ledger (scostamenti come avvisi), la liquidità è il residuo dei totali. **Trade Republic**: sessione via QR approvata nell'app del broker, sopravvive al riavvio (`brokerSessions/{ownerId}`, solo Admin SDK) e si rinnova da sola; il portafoglio NON porta prezzi, quindi gli asset nascono con `autoUpdatePrice: true` e li quota Yahoo, la cassa è un saldo reale (`cash`) e non un residuo, e gli Sparpläne sono dichiarati e mai scritti. Sincronizzare è sempre e solo leggere: whitelist di argv per Scalable, whitelist di topic per Trade Republic. Metadati per broker in `brokerConnections/{ownerId}/brokers/{broker}`. doc/guide/collegamenti.md.

## Testing
- Vitest: `npx vitest run <file>`, `npm test -- <file>`, `npx tsc --noEmit`. New tests in `__tests__/`; prefer pure functions over Firestore-coupled code.
- **Phantom `tsc` errors** clustered in `e2e/` and `lib/utils/expenseImport.ts` after a branch switch: run `npm install` first (AGENTS → *Commands*).
- **Dev/test without production data**: Firebase Emulator Suite (`npm run emulators` + `emulators:seed` + `dev:emulator`), requires a JDK. SETUP.md → Step 6. **The owner's real data for a tour**: `npm run mirror:seed -- <email>` (production read-only → emulators as `mirror@example.com`, nothing on disk) and `npm run mirror:remove` at the end — the account is the standard, the data is re-read every time (WORKFLOW.md § 3).
- **Performance**: baseline (cold/warm per page, bundle per route), method and the specs in `doc/perf/README.md` —
  PERF-00 (the new Esposizione, issue #402) first, then the fourteen; the benchmark lands in repo with PERF-01
  (`npm run perf:bench` / `perf:budget`).
- **Mobile composition**: the small-screen census (19 surfaces × 390/768/1024), the chosen direction, the nine specs and
  the owner's decisions in `doc/mobile/README.md`; the census script in `doc/mobile/reference/` (MOB-01 ports it to
  `npm run mobile:census` / `mobile:budget`). Implemented after `doc/perf/`.
- **Browser (E2E)**: Playwright, `npm run test:e2e` with the emulators up (needs **Java ≥ 21**); app on :3100 with an isolated build dir. Accounts and fixtures: SETUP.md → Step 7; gotchas: doc/guide/e2e-emulatori.md § Browser-Driven E2E (Playwright).

## Data & Integrations
Firestore client + admin · Yahoo Finance (prices, benchmark history) · Borsa Italiana scraping (Italian bonds, dividends) · Frankfurter (FX) · FRED (`FRED_API_KEY`, series ECBDFR) · Anthropic (`claude-sonnet-5` analysis + assistant, `claude-haiku-4-5` extraction).

## Known Issues (Active)
Only what crosses areas; an area's blind spots — the behaviours that look like bugs and are not — close its `doc/guide/<tema>.md` (§ Per-page blind spots). The demo account's manual setup is in README.md → Known Issues, the shared account's prerequisites in SETUP.md → Step 5b.

- **Two Sonnet generations coexist** (`lib/constants/aiModels.ts`): the Rendimenti analysis runs on `claude-sonnet-4-6`, the assistant and the emails on `claude-sonnet-5`. Aligning them changes cost and output, so it is a product decision still to take; until then the four constants stay distinct and each modal reads its OWN route's.
- **Two deliberate dependency pins keep advisories open.** `firebase-admin` at `^13.6.0` (@14 pulls pure-ESM `jose@6` → `ERR_REQUIRE_ESM` on Vercel; 8 moderate `uuid` advisories stay) and `next` at `~16.2.12` (16.3.0 breaks Vercel at `onBuildComplete`; 2 HIGH libvips advisories via `sharp`, low exposure). **Unpin next and re-run `npm audit fix` once Vercel digests 16.3.x.**
- **Per-page blind spots** — the behaviours that look like bugs and are not — live at the end of each `doc/guide/<page>.md` (one *Per-page blind spots* section per page). Moved there verbatim from this file's Known Issues; CLAUDE.md keeps only the cross-cutting ones.
- **Three Vitest cases fail under `TZ=UTC`** (`budgetUtils` › crossing day, `pensionSummary` › value age, `tracciamentoSummary` › `isScheduledRow`), on a clean `develop` too (checked in a worktree, 2026-09-20): they read «today» by Italian calendar day against fixtures built in the process timezone. The suite's two timezones are the machine's and `Europe/Rome`; a CI in UTC would see them red.
- **Every controlled `ResponsiveModal` opened without `returnFocusTo` drops focus on `body` when it closes** (Radix cancels its own restore when there is no `Trigger`; doc/guide/dialog.md). Rendimenti's two and Hall of Fame's two are fixed; the others take the opener when they are next touched.
- **`--muted-foreground` measures 4,46:1 on `--background` in the default LIGHT theme** (measured in the browser,
  2026-09-21, on the compact `PageHeader`'s description) — just under the AA floor of 4,5:1, on every page that uses
  the shell, not on one. It is a theme-token change with a twelve-block blast radius, so it belongs to a
  `doc/guide/temi.md` session, not to a page's.
- **`e2e/modal.origin.spec.ts` is intermittent in a FULL run** (2026-09-21): it failed twice in a row and then passed
  twice with the same code — once with `components/ui/period-picker.tsx` reverted and once with it restored, so that
  change is not the cause (and it failed once more in the full run of 2026-09-22, green alone right after). When it fails, Rendimenti's «Periodo personalizzato» button has moved **23,4px** between the
  `boundingBox()` the spec takes and the origin captured at the click: a late reflow under suite load, roughly the
  height of the custom-period chip row. It passes alone, and in the `desktop` project alone. Not reproduced on demand,
  so not yet fixed — re-read this before trusting a single red run of it.
- **Four base specs are red in the cloud container only** (2026-09-25): its Chromium groups four-digit euros («1.100 €»),
  the specs expect «1100 €» as on the Mac (doc/guide/e2e-emulatori.md). Read the received text before «fixing» code.
- **The icon rail's 44px targets are measured at 1440 with a mouse**; no fixture covers a ≥1440px tablet in landscape.
- **Two shared primitives stay below 44px on touch, on every page**: the `PageTabBar` pill below 1440 (inactive tabs
  38×32, icon only) and the `Switch` (36×20; its row's `Label` is clickable, the thumb alone is not). Measured on
  Impostazioni, 2026-09-22; left alone there because enlarging either changes every page at once.

## Key Files
Cross-cutting entry points only: each area's files open its guide (`doc/guide/<tema>.md` § Files), every pure module has
`__tests__/{module}.test.ts`, every page its `e2e/{page}*.spec.ts` where one exists.
- **Shell**: `app/dashboard/layout.tsx` (`<main>` = `page-main`), `app/dashboard/template.tsx`, `components/layout/{Sidebar,BottomNavigation,SecondaryMenuDrawer,SceneLink,PageHeader,PageTabBar,PageTabs,PageContainer,ThemePicker,LogoutDialog}.tsx`, `lib/utils/viewTransition.ts` (the ONE `startViewTransition`, `data-vt` scoping) + `lib/hooks/useSceneNavigation.ts` (the page scene), `lib/utils/themeTransition.ts`, `components/ui/sidebar.tsx` (`SIDEBAR_WIDTH_ICON`), `lib/constants/navigation.ts` (the ONE source of the nav arrays); tile primitives `components/ui/{tile,tile-method-note,series-legend,narrative-text,ranked-rows,tile-grid-skeleton,page-verdict}.tsx`, `lib/hooks/useRovingFocus.ts` (a list as ONE Tab stop), `lib/utils/narrative.ts` (`Narrative`, `VerdictTone`, `PageVerdictModel`)
- **Shared primitives / utils** (each the single source of its rule): `components/ui/{composition-list,composition-bar,segmented-pill,drill-breadcrumb,chart-hover}.tsx`; `lib/utils/formatters.ts` · `metricColors.ts` (`getMetricValueColor`) · `assetPricing.ts` (`requiresManualPricing`) · `assetLiquidity.ts` · `expenseTypeTransition.ts` · `firestoreData.ts` (`removeUndefinedDeep`) · `dateHelpers.ts` (`endOfMonthBound`, `getItalyDateIso`, `isItalyDayAfter`) · `spendingProjection.ts` (the ONE month-end projection) · `recurrenceDates.ts` (the ONE source on recurrence)
- **E2E**: `playwright.config.ts`, `e2e/*.ts`, `e2e/global-setup.ts`, fixtures `scripts/{seedEmulator.ts,seedPensionE2E,seedAnalisiE2E,seedCoastFireE2E,seedCostCentersE2E,seedSplitE2E,seedHallOfFameE2E}.mts`; scripts `test:e2e`/`e2e:seed*`/`dev:e2e`; the production mirror `scripts/mirrorProdAccount.mts` (`mirror:seed`/`mirror:remove`)


## Design Context
Authoritative aesthetic spec: **DESIGN.md** — hand-maintained, **never regenerate it**; its YAML frontmatter is the normative layer read by the impeccable detector, `.impeccable/design.json` only the extensions sidecar (its narrative is DESIGN.md verbatim — script-check before rewriting it; its `extensions.motion` is read from the CODE). Product truth: **PRODUCT.md**. Rules are cited by name (DESIGN → **The X Rule**) and enforced by `components/ui/{tile,page-verdict,responsive-modal}.tsx`, `statesNarrative.ts` and `printTokens.ts`. A change to a page starts from its `doc/guide/<page>.md` and DESIGN.md's named rules. History: `git log`.
