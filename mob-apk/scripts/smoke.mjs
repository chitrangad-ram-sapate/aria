// Smoke check: serves dist/ and drives the app in headless Chromium. Boots Pyodide, plans
// kolhapur_normal_week, checks STALE on edit, exports a .svcr, re-opens it (VERIFIED) and a
// tampered copy (REJECTED), runs the default disruption and opens Proof.
// Usage: npm run build && npm run smoke   (CHROME_PATH=... to pick a browser; default: installed Chrome)
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const out = mkdtempSync(join(tmpdir(), 'aria-smoke-'));
const step = (msg) => console.log(`ok  ${msg}`);
const timed = async (fn) => { const t = Date.now(); await fn(); return Date.now() - t; };

try {
  await page.goto(url);
  await page.getByText('on-device').waitFor({ timeout: 240_000 });
  step(`engine booted in ${await page.evaluate(() => window.__ariaBootMs)} ms (${await page.locator('header .muted').textContent()})`);

  await page.selectOption('select[aria-label="Scenario"]', 'kolhapur_normal_week');
  await page.getByText('Inputs valid').waitFor({ timeout: 60_000 });
  const planMs = await timed(async () => {
    await page.getByRole('button', { name: 'Plan tonight' }).click();
    await page.getByText("Tonight's plan").waitFor({ timeout: 120_000 });
  });
  const verified = await page.getByText(/ARIA: stage 1 .* verified/).count();
  step(`plan kolhapur_normal_week in ${planMs} ms (click to result); ARIA verified: ${verified > 0}`);
  if (!verified) throw new Error('ARIA plan not verified');
  await page.getByText('current', { exact: true }).waitFor();

  await page.getByText('Impact tonight: ARIA vs baseline (a)').waitFor();
  await page.getByRole('radio', { name: /Excess/ }).click();
  await page.getByRole('radio', { name: 'Forecasts' }).click();
  await page.locator('.band').first().waitFor();
  step('impact card, excess list and forecast bands render');
  await page.getByText('Godown stock (edit)').click();
  await page.locator('ul.lots input').first().fill('1');
  await page.getByText('STALE · inputs changed, re-run').waitFor({ timeout: 30_000 });
  if (!(await page.getByRole('button', { name: 'Share .svcr' }).isDisabled())) throw new Error('export not disabled when stale');
  step('edit marks result STALE and disables export');
  await page.getByText('Inputs valid').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Plan tonight' }).click();
  await page.getByText('current', { exact: true }).waitFor({ timeout: 120_000 });

  await page.getByRole('radio', { name: /Allocations/ }).click();
  await page.locator('table tbody tr.tap').first().click();
  await page.getByText('Parameters and sources').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Close' }).click();
  step('explain sheet opens');
  await page.screenshot({ path: join(out, 'plan.png'), fullPage: true });

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Share .svcr' }).click()]);
  const svcr = join(out, download.suggestedFilename());
  await download.saveAs(svcr);
  step(`exported ${download.suggestedFilename()} (${readFileSync(svcr).length} bytes)`);

  await page.getByRole('button', { name: 'Records' }).click();
  await page.setInputFiles('#svcr-file', svcr);
  await page.locator('.verdict.ok').getByText('VERIFIED').waitFor({ timeout: 60_000 });
  step('re-opened .svcr: VERIFIED');
  await page.screenshot({ path: join(out, 'records.png') });
  const bytes = readFileSync(svcr);
  const i = bytes.indexOf('"units":') + 8;
  bytes[i] = bytes[i] === 0x39 ? 0x38 : 0x39;
  const bad = join(out, 'tampered.svcr');
  writeFileSync(bad, bytes);
  await page.setInputFiles('#svcr-file', bad);
  await page.locator('.verdict.bad').waitFor({ timeout: 60_000 });
  step(`tampered .svcr rejected: ${(await page.locator('pre.err').textContent()).trim()}`);

  await page.getByRole('button', { name: 'Disruption Lab' }).click();
  const shockMs = await timed(async () => {
    await page.getByRole('button', { name: 'Apply shock and re-plan' }).click();
    await page.getByText('τ* before and after').waitFor({ timeout: 120_000 });
  });
  step(`ROUTE_RESTRICTION on ${await page.locator('select[aria-label="Godown"]').inputValue()} -> ${await page.locator('select[aria-label="Town"]').inputValue()} re-planned in ${shockMs} ms`);

  await page.screenshot({ path: join(out, 'lab.png'), fullPage: true });
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const sc = JSON.parse(readFileSync(new URL('../engine/data/scenarios/kolhapur_normal_week.json', import.meta.url), 'utf8'));
  const lines = ['date,item,outlet/town,qty,price'];
  for (let i = 0; i < 120; i++) {
    const day = new Date(Date.UTC(2016, 0, 1 + i)).toISOString().slice(0, 10);
    for (const t of sc.towns) for (const p of sc.products.slice(0, 4)) lines.push(`${day},${p.product_id},${t.town_id},${(i * 7 + t.town_id.length) % 9},10`);
  }
  const csv = join(out, 'sales.csv');
  writeFileSync(csv, lines.join('\n'));
  const csvMs = await timed(async () => {
    await page.setInputFiles('#csv-file', csv);
    await page.getByText(/model forecast|statistical fallback/).first().waitFor({ timeout: 180_000 });
  });
  step(`CSV import forecast in ${csvMs} ms: ${(await page.locator('.card .small p').first().textContent()).slice(0, 110)}`);
  await page.getByText('Inputs valid').waitFor({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Assumptions' }).click();
  await page.getByText(/Parameters \(\d+\)/).waitFor({ timeout: 30_000 });
  await page.getByText('A9', { exact: true }).waitFor();
  step('assumptions screen lists A1-A9 and the parameter registry');
  await page.screenshot({ path: join(out, 'assumptions.png'), fullPage: true });

  await page.getByRole('button', { name: 'Proof' }).click();
  await page.getByText(/Total bill per policy|Replay results not built yet/).waitFor({ timeout: 30_000 });
  step('proof view renders');
  await page.screenshot({ path: join(out, 'proof.png'), fullPage: true });
  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`);
  console.log(`PASS (artefacts in ${out})`);
} catch (e) {
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  console.error(`FAIL: ${e.message}\n(screenshot in ${out})`);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
