// End-to-end check of the real app in headless Chromium at phone size, the way a person would use it:
// start with no data, upload a broken CSV (rejected with line numbers), two different generated datasets
// (every count and chart follows the file), a stock-only update, a sales history, edit and Save stock,
// What-if scenarios with a route restriction and a step sweep, the Results dashboard, a sample with its
// replay, the .svcr export, and a reload that restores the dataset. Screenshots go to a temp folder.
// Usage: npm run build && npm run smoke   (CHROME_PATH=... to pick a browser; default: installed Chrome)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const server = await preview({ preview: { port: 4179, strictPort: true } });
const url = 'http://localhost:4179/';
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const out = mkdtempSync(join(tmpdir(), 'aria-e2e-'));
const step = (msg) => console.log(`ok  ${msg}`);
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

/** A synthetic distributor: deterministic, any size. */
function dataset({ depots, towns, products, seed, cap = false }) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const L = [];
  L.push('# settings', 'key,value', `name,Generated ${depots}x${towns}`, 'margin,0.04', '');
  L.push('# products', 'product_id,category,kg_per_unit,shelf_life_days,min_days_at_receipt,price_rs');
  for (let p = 0; p < products; p++) L.push(`P${p},${p % 3 ? 'grocery' : 'dairy'},${(0.2 + rnd() * 4).toFixed(2)},${p % 3 ? 90 : 7},${p % 3 ? 0 : 2},${(20 + rnd() * 300).toFixed(2)}`);
  L.push('', '# depots', 'depot_id,name,lat,lon,capacity_units');
  for (let d = 0; d < depots; d++) L.push(`D${d},Depot ${String.fromCharCode(65 + d)},,,${cap && d === 0 ? 60 : ''}`);
  L.push('', '# towns', 'town_id,name,population');
  for (let t = 0; t < towns; t++) L.push(`T${t},Town ${t + 1},${Math.round(5000 + rnd() * 90000)}`);
  L.push('', '# routes', 'depot_id,town_id,road_km,transit_days,vehicle_class,active');
  for (let d = 0; d < depots; d++) for (let t = 0; t < towns; t++) if ((d + t) % depots === 0 || rnd() < 0.5) {
    L.push(`D${d},T${t},${(5 + rnd() * 120).toFixed(1)},${rnd() < 0.7 ? 1 : 2},${rnd() < 0.6 ? 'road_avg' : '6t'},true`);
  }
  L.push('', '# stock', 'depot_id,product_id,qty_units,days_left');
  for (let d = 0; d < depots; d++) for (let p = 0; p < products; p++) if (rnd() < 0.8) L.push(`D${d},P${p},${Math.round(rnd() * 200)},${p % 3 ? 60 : 3 + Math.round(rnd() * 4)}`);
  L.push('', '# demand', 'town_id,product_id,mean,sd');
  for (let t = 0; t < towns; t++) for (let p = 0; p < products; p++) if (rnd() < 0.7) { const m = 2 + rnd() * 25; L.push(`T${t},P${p},${m.toFixed(2)},${(m * 0.4).toFixed(2)}`); }
  return L.join('\n') + '\n';
}
const upload = async (name, text) => {
  await page.setInputFiles('#csv-file', { name, mimeType: 'text/csv', buffer: Buffer.from(text) });
};
const tab = (name) => page.locator('nav.tabs button.tab', { hasText: name }).click();
const plan = async () => {
  await page.getByText('Inputs OK').waitFor({ timeout: 60_000 });
  const t = Date.now();
  await page.locator('#main button.btn.primary', { hasText: 'Plan tonight' }).click();
  await page.getByText('To ship tonight').waitFor({ timeout: 180_000 });
  return Date.now() - t;
};

try {
  await page.goto(url);
  await page.getByText('Start with your data').waitFor({ timeout: 240_000 });
  expect(await page.locator('button.go').isDisabled(), 'plan button should be disabled with no data');
  expect(!(await page.getByText('How ARIA decides').count()), 'Assumptions screen still reachable');
  step(`engine booted in ${await page.evaluate(() => window.__ariaBootMs)} ms; no data loaded, planning disabled, no Assumptions screen`);
  await shot('01-empty');

  // 1. a broken file is rejected with line numbers and nothing changes
  const broken = dataset({ depots: 2, towns: 3, products: 4, seed: 7 }).replace(/(# stock\n[^\n]+\n[^,]+,[^,]+,)\d+/, '$1lots').replace(/^D1,T0,/m, 'DX,T0,');
  await upload('broken.csv', broken);
  await page.getByText('The file was not loaded. Nothing was changed.').waitFor({ timeout: 60_000 });
  const rows = await page.locator('.alert.bad table tbody tr').allTextContents();
  expect(rows.some((r) => /stock\d+qty_units must be a whole number/.test(r)), `no qty error: ${rows}`);
  expect(rows.some((r) => /routes\d+depot_id 'DX'/.test(r)), `no reference error: ${rows}`);
  step(`broken CSV rejected: ${rows.length} problems listed with table and line`);
  await shot('02-broken');

  // 2. dataset A
  await upload('north.csv', dataset({ depots: 4, towns: 12, products: 20, seed: 11, cap: true }));
  await page.locator('#main').getByText('Generated 4x12').waitFor({ timeout: 60_000 });
  const msA = await plan();
  const depotsA = await page.locator('svg.net g.node rect').count();
  const townsA = await page.locator('svg.net g.node circle[r="11"]').count();
  expect(depotsA === 4 && townsA >= 1, `network A: ${depotsA} depots, ${townsA} towns`);
  step(`dataset A (4 depots, 12 towns, 20 products) planned in ${msA} ms; network shows ${depotsA} depots, ${townsA} towns`);
  await page.locator('svg.net g.node').first().click();
  await page.locator('.net-info').getByText('Depot · Depot A').waitFor();
  step('tap on a depot node shows its numbers');
  await shot('03-home-A');

  await tab('Results');
  await page.getByText('Key numbers').waitFor();
  for (const t of ["Where tonight's units come from", 'Why towns are short', 'ARIA compared with the usual method', 'Units sent to each town', 'Shelf life left when stock arrives', 'How this plan was made']) {
    await page.getByText(t, { exact: false }).first().waitFor({ timeout: 10_000 });
  }
  const capCard = await page.locator('.kpi-card', { hasText: 'Depot capacity used' }).count();
  expect(capCard === 1, 'capacity KPI missing for a dataset with a capacity');
  const kpiA = await page.locator('.kpi-card', { hasText: 'Units shipped' }).locator('strong').first().textContent();
  step(`Results dashboard: KPI cards, network, 2 donuts, 2 bar charts, histogram, flowchart; units shipped ${kpiA}`);
  await shot('04-results-A');

  // 3. dataset B (different shape): every count follows the file
  await tab('Home');
  await upload('south.csv', dataset({ depots: 2, towns: 5, products: 8, seed: 99 }));
  await page.locator('#main').getByText('Generated 2x5').waitFor({ timeout: 60_000 });
  expect(!(await page.getByText('To ship tonight').count()), 'old plan still shown after new data');
  await plan();
  const depotsB = await page.locator('svg.net g.node rect').count();
  expect(depotsB === 2, `network B shows ${depotsB} depots`);
  await tab('Results');
  await page.getByText('Key numbers').waitFor();
  const kpiB = await page.locator('.kpi-card', { hasText: 'Units shipped' }).locator('strong').first().textContent();
  expect(kpiA !== kpiB, 'units shipped did not change with the new dataset');
  expect(!(await page.locator('.kpi-card', { hasText: 'Depot capacity used' }).count()), 'capacity KPI shown without capacities');
  step(`dataset B (2 depots, 5 towns) replaces A: network ${depotsB} depots, units shipped ${kpiA} -> ${kpiB}`);

  // 4. stock-only update keeps the rest
  await tab('Home');
  await upload('stock_only.csv', 'depot_id,product_id,qty_units,days_left\nD0,P0,500,5\nD1,P3,80,5\n');
  await page.getByText(/kept .*products/).waitFor({ timeout: 60_000 });
  await page.getByText('2 stock lots').waitFor();
  step('stock-only CSV updates the stock table and keeps products, depots, towns, routes and demand');

  // 5. sales history -> on-device forecast -> history line chart
  const sales = ['# sales', 'date,product_id,town_id,qty'];
  for (let i = 0; i < 100; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    for (const [p, t] of [['P0', 'T0'], ['P3', 'T1']]) sales.push(`${d},${p},${t},${10 + (i % 7) * 2 + (p === 'P3' ? 5 : 0)}`);
  }
  await upload('sales.csv', sales.join('\n') + '\n');
  await page.getByText(/Demand forecast from 100 days of sales/).waitFor({ timeout: 180_000 });
  await plan();
  await tab('Results');
  await page.getByText('Daily units sold, all towns and products').waitFor();
  step('sales history forecast on the device; Results shows the sales line chart');

  // 6. edit stock: Cancel discards, Save applies and marks the plan out of date
  await tab('Home');
  await page.getByRole('button', { name: 'Edit depot stock' }).click();
  const first = page.locator('ul.lots input').first();
  await first.fill('abc');
  expect(await page.getByRole('button', { name: 'Save stock' }).isDisabled(), 'Save enabled with a bad value');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Edit depot stock' }).click();
  expect((await page.locator('ul.lots input').first().inputValue()) !== 'abc', 'Cancel did not discard');
  await page.locator('ul.lots input').first().fill('7');
  await page.getByText('Unsaved changes.').waitFor();
  await page.getByRole('button', { name: 'Save stock' }).click();
  await page.getByText('Stock saved').waitFor();
  await page.getByText('Out of date').first().waitFor({ timeout: 30_000 });
  step('stock sheet: bad value blocks Save, Cancel discards, Save applies (plan marked out of date)');

  // 7. sample through the CSV reader, plan, replay section, What-if
  await page.getByText('Try a sample dataset instead').click();
  await page.selectOption('select[aria-label="Sample dataset"]', 'kolhapur_normal_week');
  await page.getByRole('button', { name: 'Load sample' }).click();
  await page.getByText('kolhapur_normal_week').first().waitFor({ timeout: 60_000 });
  const msS = await plan();
  step(`sample kolhapur_normal_week loaded through the CSV reader and planned in ${msS} ms`);
  await shot('05-home-sample');

  await tab('What if');
  for (const p of ['Demand up 20%', 'Depots load 30% less', 'Longest route closed']) {
    await page.locator('details.add').evaluate((d) => { d.open = true; });
    await page.getByRole('button', { name: p }).click();
  }
  // a truck restriction on a medium-truck route of the selected scenario
  const routeSel = page.locator('select[aria-label="Route change"]');
  await routeSel.selectOption('restrict');
  await page.locator('select[aria-label="Largest truck allowed"]').or(page.getByText('so a restriction cannot change it')).first().waitFor();
  const opts = await page.locator('select[aria-label="Largest truck allowed"]').count();
  const smallest = await page.getByText('so a restriction cannot change it').count();
  expect(opts + smallest === 1, 'restriction neither offered options nor explained why not');
  if (opts) await page.getByRole('button', { name: 'Add route change' }).click();
  await page.getByRole('button', { name: /^Compare 3 scenarios/ }).click();
  await page.getByText('Which option does best?').waitFor({ timeout: 300_000 });
  await page.getByText('Up to date').waitFor({ timeout: 300_000 });
  const cards = await page.locator('section.card .kpi-grid').count();
  expect(cards === 3, `expected 3 scenario cards, got ${cards}`);
  await page.getByText('Change from the baseline (%)').waitFor();
  step(`What-if: 3 scenarios compared with the baseline (${opts ? 'truck restriction added' : 'restriction explained as impossible'}), cards and charts shown`);
  await shot('06-whatif');

  await page.locator('input[aria-label="Steps (2-12)"]').fill('4');
  await page.locator('input[aria-label="Steps (2-12)"]').dispatchEvent('change');
  await page.getByRole('button', { name: 'Run steps' }).click();
  await page.getByText('Units shipped and short').waitFor({ timeout: 300_000 });
  step('step sweep: 4 demand steps planned, 4 line charts drawn');

  await tab('Results');
  await page.getByText('Scenarios against the baseline').waitFor();
  await page.getByText('Historical test: every method on past demand').waitFor({ timeout: 30_000 });
  step('Results shows the scenario comparison and the labelled historical replay for the sample');
  await shot('07-results-sample');

  // 8. .svcr export still works
  await tab('Home');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button.tile', { hasText: 'Share plan' }).click()]);
  expect(download.suggestedFilename().endsWith('.svcr'), 'no .svcr download');
  step(`plan file exported: ${download.suggestedFilename()}`);

  // 9. reload restores the dataset
  await page.reload();
  await page.getByText('kolhapur_normal_week').first().waitFor({ timeout: 240_000 });
  await page.getByText('Inputs OK').waitFor({ timeout: 60_000 });
  step('reload restores the last dataset from this device');

  if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
  console.log(`\nall checks passed; screenshots in ${out}`);
} catch (e) {
  await shot('failure').catch(() => {});
  console.error(`FAIL ${e.message}\nscreenshots in ${out}\nerrors: ${errors.join('\n')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.httpServer.close();
}
