/**
 * Analisi at 390px — the width DESIGN.md designs against first.
 *
 * Three things only a mobile viewport can prove: the tiles stack in the declared reading order
 * with nothing scrolling sideways, the Flusso draws no Sankey (below 640px it is a bar of the
 * spending by type — or of the 50/30/20 roles — and the categories as rows), and the row-to-Scheda
 * flow works under touch at the narrow layout.
 */

import { test, expect, type Page } from '@playwright/test';

const CURRENT_YEAR = new Date().getFullYear();
const PREVIOUS_YEAR = CURRENT_YEAR - 1;

const FIRESTORE = 'http://127.0.0.1:8080/v1/projects/demo-net-worth/databases/(default)/documents';
const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

/** The Sankey's accessible name (CashflowSankeyChart): its absence is what «no Sankey» means. */
const SANKEY_NAME = /^Flusso del periodo/;

/**
 * `main` is the horizontal scroll container (AGENTS.md → Tailwind Breakpoints), and an overflow
 * INSIDE a tile never reaches it — so the Flusso section is also walked against its own two edges,
 * every descendant but the visually hidden ones (`.sr-only` keeps its geometric box) and the ones
 * not rendered at all (a zero box sits at x = 0, left of any tile).
 */
async function measureFlussoOverflow(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main')!;
    const section = document.querySelector('main section[aria-label="Flusso"]')!;
    const edge = section.getBoundingClientRect();
    const culprits = Array.from(section.querySelectorAll('*'))
      .filter((el) => !el.closest('.sr-only'))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return rect.right > edge.right + 1 || rect.left < edge.left - 1;
      })
      .map((el) => `${el.tagName.toLowerCase()} «${(el.textContent ?? '').trim().slice(0, 40)}»`);
    return { scroll: main.scrollWidth - main.clientWidth, culprits };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/dashboard/analisi');
  await expect(page.getByRole('region', { name: 'Verdetto del periodo' })).toBeVisible({ timeout: 30_000 });
});

test('stacks the tiles in the declared order with no horizontal overflow', async ({ page }) => {
  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll('main section[aria-label]'))
      .map((section) => ({ name: section.getAttribute('aria-label')!, top: section.getBoundingClientRect().top }))
      .filter((section) => ['Periodo', 'Fuori scala', 'Spese per categoria', 'Entrate per categoria', 'Spese maggiori', 'Flusso'].includes(section.name))
      .sort((a, b) => a.top - b.top)
      .map((section) => section.name),
  );
  expect(order).toEqual(['Periodo', 'Fuori scala', 'Spese per categoria', 'Entrate per categoria', 'Spese maggiori', 'Flusso']);

  // `main` is the horizontal scroll container (AGENTS.md): measure it and every element in it.
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main')!;
    const limit = main.getBoundingClientRect().left + main.clientWidth + 1;
    const culprits = Array.from(main.querySelectorAll('*')).filter((el) => el.getBoundingClientRect().right > limit).length;
    return { scroll: main.scrollWidth - main.clientWidth, culprits };
  });
  expect(overflow).toEqual({ scroll: 0, culprits: 0 });
});

test('draws the Flusso by type as a bar of the spending and rows, never a Sankey, on the reading\'s own shares', async ({ page }) => {
  const flusso = page.getByRole('region', { name: 'Flusso', exact: true });
  const legend = flusso.getByRole('list', { name: 'Quote del flusso' });
  // Positive anchor first: the legend and the bar are there, so the absence of the chart below means something.
  await expect(legend).toBeVisible();
  await expect(flusso.getByRole('img', { name: 'Quote delle spese per tipo' })).toBeVisible();
  await expect(flusso.getByRole('img', { name: SANKEY_NAME })).toHaveCount(0);

  // The fixture's year: fixed 380 €, variable 400 €, income 2000 €. The bar is the SPENDING, so
  // its legend prints the reading's own «variabili 51%, fisse 49%» — never 20/19 of the income.
  await expect(legend.getByRole('listitem')).toHaveText([/^Variabili\s*51%$/, /^Fisse\s*49%$/]);
  await expect(flusso).toContainText(/variabili 51%, fisse 49%/i);

  // Savings stay out of the bar: a closing block with the amount (every row is in January, so
  // nothing is in the calendar and the note carries no scheduled clause).
  await expect(flusso.getByRole('region', { name: 'Risparmio' }).getByText(/^1220[\s ]*€ avanzati nel periodo\.$/)).toBeVisible();

  // A row opens the Scheda, like every other entry point.
  await flusso.getByRole('region', { name: 'Spese Variabili' }).getByRole('button', { name: /^Alimentari, / }).click();
  await expect(page.getByText(`Totale · ${CURRENT_YEAR}`)).toBeVisible();
  await expect(page.getByText(`Totale · ${CURRENT_YEAR}`).locator('..').getByText(/^400[\s ]*€$/)).toBeVisible();
});

test('opens the Scheda from a category row under touch', async ({ page }) => {
  await page.getByRole('region', { name: 'Spese per categoria' }).getByRole('button', { name: /^Casa, / }).click();

  await expect(page.getByText(`Totale · ${CURRENT_YEAR}`)).toBeVisible();
  await expect(page.getByText(`Totale · ${CURRENT_YEAR}`).locator('..').getByText(/^380[\s ]*€$/)).toBeVisible();
  // The per-year table renders as a flat list readable at 390px.
  await expect(page.getByText('Per anno', { exact: true })).toBeVisible();
});

// ── 50/30/20 roles on a phone ───────────────────────────────────────────────────────────────────
//
// Same fixture as analisi.spec.ts's roles block (roles on the categories, the account flag off by
// default): turned on through the emulator for these tests only.

async function setSpendingRolesEnabled(enabled: boolean): Promise<void> {
  const res = await fetch(`${FIRESTORE}/assetAllocationTargets/test-user-analisi?updateMask.fieldPaths=spendingRolesEnabled`, {
    method: 'PATCH',
    headers: OWNER,
    body: JSON.stringify({ fields: { spendingRolesEnabled: { booleanValue: enabled } } }),
  });
  expect(res.ok).toBe(true);
}

test.describe('Flusso by 50/30/20 role at 390', () => {
  test.beforeAll(async () => setSpendingRolesEnabled(true));
  test.afterAll(async () => setSpendingRolesEnabled(false));

  test('draws the 50/30/20 bar and each role\'s categories as rows, no Sankey, nothing past the tile', async ({ page }) => {
    const flusso = page.getByRole('region', { name: 'Flusso', exact: true });
    await flusso.scrollIntoViewIfNeeded();
    // The view switch is the AsideToggle: one named group, the pressed option its only Tab stop.
    const grouping = flusso.getByRole('group', { name: 'Raggruppa il flusso' });
    await expect(grouping.getByRole('button', { name: 'Per ruolo' })).toHaveAttribute('aria-pressed', 'true');
    await expect(grouping.getByRole('button', { name: 'Per tipo' })).toHaveAttribute('tabindex', '-1');

    // The legend carries the figures, on the reading's own base (the 2000 that came in), in the
    // order the reading names them.
    const legend = flusso.getByRole('list', { name: 'Quote del flusso' });
    await expect(legend.getByRole('listitem')).toHaveText([/^Necessità\s*15%$/, /^Desideri\s*4%$/, /^Da classificare\s*20%$/, /^Risparmi\s*61%$/]);
    await expect(flusso).toContainText('tacche a 50 e 80');
    await expect(flusso.getByRole('img', { name: 'Quote per ruolo, sul riferimento 50/30/20' })).toBeVisible();
    await expect(flusso.getByRole('img', { name: SANKEY_NAME })).toHaveCount(0);

    // Casa sits under both roles its rows resolve to; the surplus is named under Risparmi.
    await expect(flusso.getByRole('region', { name: 'Necessità' }).getByRole('button', { name: /^Casa, / })).toBeVisible();
    await expect(flusso.getByRole('region', { name: 'Desideri' }).getByRole('button', { name: /^Casa, / })).toBeVisible();
    await expect(flusso.getByRole('region', { name: 'Da classificare' }).getByRole('button', { name: /^Alimentari, / })).toBeVisible();
    await expect(flusso.getByRole('region', { name: 'Risparmi' })).toContainText(/1220[\s ]*€ avanzati nel periodo\./);

    // The rows' 140px label column is what could run past the tile: measured against the section.
    expect(await measureFlussoOverflow(page)).toEqual({ scroll: 0, culprits: [] });
  });

  test('a role\'s row opens the Scheda under touch', async ({ page }) => {
    const flusso = page.getByRole('region', { name: 'Flusso', exact: true });
    await flusso.getByRole('region', { name: 'Da classificare' }).getByRole('button', { name: /^Alimentari, / }).click();
    await expect(page.getByRole('region', { name: /^Scheda di / })).toContainText('Alimentari');
  });

  test('«Per tipo» swaps the 50/30/20 bar for the bar of the spending by type, still no Sankey', async ({ page }) => {
    const flusso = page.getByRole('region', { name: 'Flusso', exact: true });
    await flusso.getByRole('button', { name: 'Per tipo' }).click();
    await expect(flusso.getByRole('list', { name: 'Quote del flusso' }).getByRole('listitem')).toHaveText([/^Variabili\s*51%$/, /^Fisse\s*49%$/]);
    await expect(flusso.getByRole('img', { name: 'Quote delle spese per tipo' })).toBeVisible();
    await expect(flusso.getByRole('img', { name: SANKEY_NAME })).toHaveCount(0);
  });
});

// ── A deficit on a phone ────────────────────────────────────────────────────────────────────────
//
// The seed carries no deficit, and none can be added to it: every Analisi figure the other specs
// pin reads the previous and the current year whole (the «Anno corrente» pacing is twelve months
// against twelve, analisi.spec.ts's Confronto ranks the previous year). So two months of the
// PREVIOUS year are planted here, for this block only, and removed after it: March, spending far
// past a tiny income — the income line near the bar's left end — and April, spending with no income.

const DEFICIT_ROWS = [
  { id: 'e2e-exp-deficit-income', month: 2, type: 'income', categoryId: 'e2e-cat-stipendio', categoryName: 'Stipendio', amount: 30 },
  { id: 'e2e-exp-deficit-food', month: 2, type: 'variable', categoryId: 'e2e-cat-alimentari', categoryName: 'Alimentari', amount: -1500 },
  { id: 'e2e-exp-noincome-food', month: 3, type: 'variable', categoryId: 'e2e-cat-alimentari', categoryName: 'Alimentari', amount: -200 },
] as const;

async function plantDeficitRows(): Promise<void> {
  for (const row of DEFICIT_ROWS) {
    // Noon UTC on the 15th: the same Italian calendar day whatever the runner's timezone.
    const date = new Date(Date.UTC(PREVIOUS_YEAR, row.month, 15, 12)).toISOString();
    const res = await fetch(`${FIRESTORE}/expenses/${row.id}`, {
      method: 'PATCH',
      headers: OWNER,
      body: JSON.stringify({
        fields: {
          userId: { stringValue: 'test-user-analisi' },
          type: { stringValue: row.type },
          categoryId: { stringValue: row.categoryId },
          categoryName: { stringValue: row.categoryName },
          amount: { doubleValue: row.amount },
          currency: { stringValue: 'EUR' },
          date: { timestampValue: date },
          createdAt: { timestampValue: date },
          updatedAt: { timestampValue: date },
        },
      }),
    });
    expect(res.ok).toBe(true);
  }
}

async function removeDeficitRows(): Promise<void> {
  for (const row of DEFICIT_ROWS) {
    await fetch(`${FIRESTORE}/expenses/${row.id}`, { method: 'DELETE', headers: OWNER });
    // A DELETE on a missing document answers 200 too: the GET is what proves it is gone.
    expect((await fetch(`${FIRESTORE}/expenses/${row.id}`, { headers: OWNER })).status).toBe(404);
  }
}

test.describe('Flusso in deficit at 390', () => {
  test.beforeAll(plantDeficitRows);
  test.afterAll(removeDeficitRows);

  test('the income line sits on the bar where the income ends, its word inside the tile', async ({ page }) => {
    await page.goto(`/dashboard/analisi?period=year&year=${PREVIOUS_YEAR}&month=3`);
    const flusso = page.getByRole('region', { name: 'Flusso', exact: true });
    const legend = flusso.getByRole('list', { name: 'Quote del flusso' });
    await expect(legend).toBeVisible({ timeout: 30_000 });
    await expect(legend.getByRole('listitem')).toHaveText([/^Variabili\s*100%$/]);

    // 1500 spent on 30 of income: the caption names the 1470 the wealth covered, and nothing was put aside.
    await expect(flusso).toContainText(/Quote delle spese \(1500[\s ]*€\)\. Oltre la linea delle entrate: 1470[\s ]*€ dal patrimonio\./);
    await expect(flusso.getByRole('region', { name: 'Risparmio' })).toHaveCount(0);

    // The line is at 2% of the bar: its word must take the right of it, or it paints left of the tile.
    const word = flusso.getByText('entrate', { exact: true });
    await expect(word).toBeVisible();
    const [wordBox, tileBox] = [await word.boundingBox(), await flusso.boundingBox()];
    expect(wordBox!.x).toBeGreaterThanOrEqual(tileBox!.x);
    expect(wordBox!.x + wordBox!.width).toBeLessThanOrEqual(tileBox!.x + tileBox!.width);
    expect(await measureFlussoOverflow(page)).toEqual({ scroll: 0, culprits: [] });
  });

  test('with no income there is no income line, and the caption says so', async ({ page }) => {
    await page.goto(`/dashboard/analisi?period=year&year=${PREVIOUS_YEAR}&month=4`);
    const flusso = page.getByRole('region', { name: 'Flusso', exact: true });
    // Positive anchor: the bar's legend is drawn, so the missing line below is a decision, not a blank page.
    await expect(flusso.getByRole('list', { name: 'Quote del flusso' }).getByRole('listitem')).toHaveText([/^Variabili\s*100%$/], { timeout: 30_000 });
    await expect(flusso).toContainText(/Quote delle spese \(200[\s ]*€\)\. Nessuna entrata: tutto è coperto dal patrimonio\./);
    await expect(flusso.getByText('entrate', { exact: true })).toHaveCount(0);
  });
});
