/**
 * Throwaway lab benchmark (session 2026-09-26, deleted at the end).
 *
 * Measures, per dashboard route, on the PRODUCTION build served on :3100 against the emulators:
 *   - TTFB, FCP, LCP, CLS, long-task total (Performance API / PerformanceObserver)
 *   - t(auth): when ProtectedRoute's spinner leaves (Firebase Auth resolved)
 *   - t(h1): first page heading rendered · t(data): first euro figure on screen (a tile has data)
 *   - JS/CSS/font bytes transferred, request counts by kind (Firestore channel, /api/*, Yahoo…)
 *   - /api/* calls with their durations
 * Scenarios: COLD (fresh context, real login, full reload) and WARM (client-side navigation from
 * the previous route in the same context — the app's own scene navigation), each N runs, medians.
 * Optional CPU throttle (4x) via CDP to approximate a mid-range phone.
 *
 * Usage: node .tmp-perf-measure.mjs [--runs=3] [--cpu=4] [--email=mirror@example.com] [--routes=a,b] [--warm-only] [--cold-only]
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const RUNS = Number(args.runs ?? 3);
const CPU = Number(args.cpu ?? 1);
const EMAIL = args.email ?? 'mirror@example.com';
const PASSWORD = 'test1234';
const BASE = 'http://localhost:3100';
const OUT = args.out ?? `.tmp-perf-${EMAIL.split('@')[0]}-cpu${CPU}.json`;
const WARM_ONLY = args['warm-only'] === 'true';
const COLD_ONLY = args['cold-only'] === 'true';
const ALL_ROUTES = [
  '/dashboard',
  '/dashboard/assets',
  '/dashboard/cashflow',
  '/dashboard/analisi',
  '/dashboard/performance',
  '/dashboard/history',
  '/dashboard/allocation',
  '/dashboard/pension',
  '/dashboard/fire-simulations',
  '/dashboard/hall-of-fame',
  '/dashboard/settings',
];
const ROUTES = args.routes ? args.routes.split(',').map((r) => (r.startsWith('/') ? r : `/dashboard/${r}`)) : ALL_ROUTES;

/** Injected before any page script: observers that survive the whole navigation. */
const INIT_SCRIPT = `
  window.__perf = { lcp: 0, cls: 0, longTasks: 0, longTaskCount: 0, fcp: 0, marks: {} };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__perf.longTasks += e.duration; window.__perf.longTaskCount++; } })
      .observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__perf.fcp = e.startTime; })
      .observe({ type: 'paint', buffered: true });
  } catch {}
  // Milestones, polled from a MutationObserver: auth resolved (spinner gone), h1 present, first euro figure.
  const check = () => {
    const seen = window.__perf.marks;
    const now = performance.now();
    if (!seen.spinnerSeen && document.querySelector('.animate-spin.rounded-full')) seen.spinnerSeen = now;
    if (seen.spinnerSeen && !seen.auth && !document.querySelector('.animate-spin.rounded-full')) seen.auth = now;
    if (!seen.h1 && document.querySelector('main h1, h1')) seen.h1 = now;
    if (!seen.data) {
      const main = document.querySelector('main') || document.body;
      if (/\\d\\s?€/.test(main.textContent || '')) seen.data = now;
    }
    if (!seen.skeleton && document.querySelector('[data-slot="skeleton"], .animate-pulse')) seen.skeleton = now;
    if (seen.skeleton && !seen.skeletonGone && !document.querySelector('[data-slot="skeleton"], .animate-pulse')) seen.skeletonGone = now;
  };
  const start = () => { new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true }); check(); };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
`;

function median(xs) {
  const s = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}

function classify(url) {
  if (url.includes('127.0.0.1:8080') || url.includes('firestore')) return 'firestore';
  if (url.includes('127.0.0.1:9099') || url.includes('identitytoolkit') || url.includes('securetoken')) return 'auth';
  if (url.includes('/api/')) return 'api';
  if (url.includes('/_next/static/chunks') || url.endsWith('.js')) return 'js';
  if (url.endsWith('.css')) return 'css';
  if (url.endsWith('.woff2')) return 'font';
  if (url.includes('yahoo') || url.includes('borsaitaliana') || url.includes('frankfurter')) return 'external';
  return 'other';
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'load' });
  await page.locator('#email').fill(EMAIL);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Accedi', exact: true }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
  await page.locator('main').waitFor({ timeout: 60_000 });
}

/** Attach request accounting to a page; returns a collector reset per navigation. */
function attachNetwork(page) {
  const state = { entries: [] };
  page.on('response', async (res) => {
    const req = res.request();
    const url = req.url();
    let bytes = 0;
    try {
      const sizes = await req.sizes();
      bytes = sizes.responseBodySize + sizes.responseHeadersSize;
    } catch {}
    state.entries.push({ url, kind: classify(url), bytes, status: res.status(), timing: req.timing(), method: req.method() });
  });
  return state;
}

async function readPerf(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      ttfb: nav ? Math.round(nav.responseStart) : null,
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load: nav ? Math.round(nav.loadEventEnd) : null,
      fcp: Math.round(window.__perf.fcp),
      lcp: Math.round(window.__perf.lcp),
      cls: Number(window.__perf.cls.toFixed(3)),
      longTasksMs: Math.round(window.__perf.longTasks),
      longTaskCount: window.__perf.longTaskCount,
      marks: Object.fromEntries(Object.entries(window.__perf.marks).map(([k, v]) => [k, Math.round(v)])),
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      scripts: performance.getEntriesByType('resource').filter((r) => r.initiatorType === 'script').length,
    };
  });
}

function summarise(entries) {
  const byKind = {};
  for (const e of entries) {
    byKind[e.kind] ??= { count: 0, bytes: 0 };
    byKind[e.kind].count++;
    byKind[e.kind].bytes += e.bytes;
  }
  const api = entries
    .filter((e) => e.kind === 'api')
    .map((e) => ({ path: e.url.replace(BASE, '').split('?')[0], ms: Math.round(e.timing.responseEnd - e.timing.startTime), status: e.status }));
  return { byKind, api };
}

async function waitForData(page, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const done = await page.evaluate(() => {
      const m = window.__perf?.marks ?? {};
      return !!m.data && !!m.h1;
    });
    if (done) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function measureCold(browser, route) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await page.addInitScript(INIT_SCRIPT);
  await login(page);
  // Full reload of the route: the app boots from zero (JS, auth, queries) with a warm HTTP cache.
  const net = attachNetwork(page);
  await page.goto(`${BASE}${route}`, { waitUntil: 'load' });
  const settled = await waitForData(page, 20_000);
  await page.waitForTimeout(1500); // let LCP/CLS observers settle
  const perf = await readPerf(page);
  const result = { route, scenario: 'cold', settled, ...perf, ...summarise(net.entries) };
  await context.close();
  return result;
}

/**
 * Warm: after the URL has changed (the new route committed), poll the page every 50 ms until a
 * euro figure is on screen with no skeleton left. `skeleton` = the new page showed a wait state
 * at all (a React Query hit shows none); `data` = ms from the click to the settled figure.
 */
async function waitForWarmData(page, t0, timeoutMs) {
  const start = Date.now();
  let skeletonSeen = false;
  let skeletonAt = null;
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      return {
        now: performance.now(),
        skeleton: !!document.querySelector('[data-slot="skeleton"], .animate-pulse'),
        euro: /\d\s?€/.test(main.textContent || ''),
        long: window.__perf.longTasks,
      };
    });
    if (s.skeleton && !skeletonSeen) { skeletonSeen = true; skeletonAt = Math.round(s.now - t0); }
    if (!s.skeleton && s.euro) return { settled: true, data: Math.round(s.now - t0), skeleton: skeletonAt, longAfter: s.long };
    await page.waitForTimeout(50);
  }
  return { settled: false, data: null, skeleton: skeletonAt, longAfter: null };
}

async function measureWarmSequence(browser) {
  // One context, one login, then the routes one after the other by client-side navigation.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await page.addInitScript(INIT_SCRIPT);
  await login(page);
  await waitForData(page, 20_000);
  const results = [];
  const net = attachNetwork(page);
  for (const route of ROUTES) {
    if (route === '/dashboard' && new URL(page.url()).pathname === '/dashboard') {
      // Leave and come back so the Panoramica is also measured as a navigation.
      await page.locator('a[href="/dashboard/history"]').first().click();
      await page.waitForURL(/history/);
      await waitForWarmData(page, 0, 20_000);
    }
    net.entries.length = 0;
    const longBefore = await page.evaluate(() => window.__perf.longTasks);
    const t0 = await page.evaluate(() => performance.now());
    const link = page.locator(`a[href="${route}"]`).first();
    if ((await link.count()) && (await link.isVisible())) await link.click();
    else await page.evaluate((r) => { window.history.pushState({}, '', r); window.dispatchEvent(new PopStateEvent('popstate')); }, route);
    await page.waitForURL((u) => u.pathname === route, { timeout: 30_000 });
    const tUrl = Math.round((await page.evaluate(() => performance.now())) - t0);
    const w = await waitForWarmData(page, t0, 20_000);
    await page.waitForTimeout(600);
    const longAfter = await page.evaluate(() => window.__perf.longTasks);
    results.push({ route, scenario: 'warm', settled: w.settled, marks: { url: tUrl, skeleton: w.skeleton, data: w.data }, longTasksMs: Math.round(longAfter - longBefore), ...summarise(net.entries) });
  }
  await context.close();
  return results;
}

const browser = await chromium.launch();
const cold = [];
if (!WARM_ONLY) {
  for (const route of ROUTES) {
    for (let i = 0; i < RUNS; i++) {
      const r = await measureCold(browser, route);
      cold.push(r);
      console.log(`[cold ${i + 1}/${RUNS}] ${route} ttfb=${r.ttfb} fcp=${r.fcp} lcp=${r.lcp} auth=${r.marks.auth ?? '-'} h1=${r.marks.h1 ?? '-'} data=${r.marks.data ?? '-'} cls=${r.cls} long=${r.longTasksMs}ms js=${Math.round((r.byKind.js?.bytes ?? 0) / 1024)}KB fs=${r.byKind.firestore?.count ?? 0} api=${r.api.length} settled=${r.settled}`);
    }
  }
}
const warm = [];
if (!COLD_ONLY) {
  for (let i = 0; i < RUNS; i++) {
    const seq = await measureWarmSequence(browser);
    warm.push(...seq);
    for (const r of seq) console.log(`[warm ${i + 1}/${RUNS}] ${r.route} url=${r.marks.url} skeleton=${r.marks.skeleton ?? '-'} data=${r.marks.data ?? '-'} long=${r.longTasksMs}ms js=${Math.round((r.byKind.js?.bytes ?? 0) / 1024)}KB fs=${r.byKind.firestore?.count ?? 0} api=${r.api.length} settled=${r.settled}`);
  }
}
await browser.close();

// Medians per route
const table = ROUTES.map((route) => {
  const c = cold.filter((r) => r.route === route);
  const w = warm.filter((r) => r.route === route);
  const kb = (rs, kind) => median(rs.map((r) => Math.round((r.byKind[kind]?.bytes ?? 0) / 1024)));
  return {
    route,
    cold: {
      ttfb: median(c.map((r) => r.ttfb)), fcp: median(c.map((r) => r.fcp)), lcp: median(c.map((r) => r.lcp)),
      auth: median(c.map((r) => r.marks.auth)), h1: median(c.map((r) => r.marks.h1)), data: median(c.map((r) => r.marks.data)),
      cls: median(c.map((r) => r.cls)), longTasksMs: median(c.map((r) => r.longTasksMs)), heapMB: median(c.map((r) => r.heapMB)),
      jsKB: kb(c, 'js'), cssKB: kb(c, 'css'), fontKB: kb(c, 'font'), scripts: median(c.map((r) => r.scripts)),
      firestoreReqs: median(c.map((r) => r.byKind.firestore?.count ?? 0)), apiCalls: median(c.map((r) => r.api.length)),
      api: c[0]?.api ?? [],
    },
    warm: {
      url: median(w.map((r) => r.marks.url)), skeleton: median(w.map((r) => r.marks.skeleton)), data: median(w.map((r) => r.marks.data)),
      longTasksMs: median(w.map((r) => r.longTasksMs)),
      jsKB: kb(w, 'js'), firestoreReqs: median(w.map((r) => r.byKind.firestore?.count ?? 0)), apiCalls: median(w.map((r) => r.api.length)),
      api: w[0]?.api ?? [],
    },
  };
});
writeFileSync(OUT, JSON.stringify({ email: EMAIL, cpu: CPU, runs: RUNS, table, cold, warm }, null, 2));
console.log('\nMEDIANS (ms unless noted) — cold = full reload after login, warm = client-side navigation');
console.log('route | ttfb | fcp | lcp | auth | h1 | data | cls | longTasks | jsKB | scripts | fsReqs | api || warm url | warm skeleton | warm data | warm long | warm fsReqs | warm api');
for (const t of table) {
  const c = t.cold, w = t.warm;
  console.log(`${t.route} | ${c.ttfb} | ${c.fcp} | ${c.lcp} | ${c.auth} | ${c.h1} | ${c.data} | ${c.cls} | ${c.longTasksMs} | ${c.jsKB} | ${c.scripts} | ${c.firestoreReqs} | ${c.apiCalls} || ${w.url} | ${w.skeleton} | ${w.data} | ${w.longTasksMs} | ${w.firestoreReqs} | ${w.apiCalls}`);
}
console.log(`\nwritten ${OUT}`);
