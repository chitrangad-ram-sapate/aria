// End-to-end check of the real app in headless Chromium at phone size, the way a person would use it:
// start with no data, upload a broken CSV (rejected with line numbers), two different generated datasets
// (every count and chart follows the file), a stock-only update, a sales history, edit and Save stock,
// What-if scenarios with a route restriction and a step sweep, the Results dashboard, a sample with its
// replay, the .svcr export, and a reload that restores the dataset. Then the team: a driver joins with the
// admin's code, gets a trip, loads and delivers it and reports a problem; the admin sees it all and pauses the driver.
// Accounts live in the Firebase emulators (start them first: npx firebase-tools emulators:start --only auth,firestore
// --project demo-aria). Screenshots go to a temp folder.
// Usage: npm run build && npm run smoke   (CHROME_PATH=... to pick a browser; default: installed Chrome)
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const server = await preview({ preview: { port: 4179, strictPort: true } });
const url = 'http://localhost:4179/?emulators=1';
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const page = await context.newPage();
const run = Date.now().toString(36);
const ADMIN = { name: 'Asha Patil', team: 'Patil Distributors', email: `admin-${run}@example.com`, password: 'secret123' };
const DRIVER = { name: 'Ravi Kumar', phone: '9876543210', vehicle: 'MH09 AB 1234', email: `driver-${run}@example.com`, password: 'secret123' };
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let allow400 = false; // the wrong-password step makes the sign-in service answer 400 on purpose
page.on('console', (m) => { if (m.type() === 'error' && !(allow400 && /status of 400/.test(m.text()))) errors.push(m.text()); });
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
  await page.getByText('Data looks good').waitFor({ timeout: 60_000 });
  const t = Date.now();
  await page.locator('#main button.btn.primary', { hasText: 'Plan tonight' }).click();
  await page.getByText('To ship tonight').waitFor({ timeout: 180_000 });
  return Date.now() - t;
};

try {
  await page.goto(url);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect(await page.locator('input[name=email]:invalid').count() === 1, 'empty sign-in not blocked');
  await page.getByRole('button', { name: /I manage a team/ }).click();
  for (const [k, v] of Object.entries({ name: ADMIN.name, team: ADMIN.team, email: ADMIN.email, password: '123' })) await page.fill(`input[name=${k}]`, v);
  await page.getByRole('button', { name: 'Create team' }).click();
  expect(await page.locator('input[name=password]:invalid').count() === 1, 'short password not blocked');
  await page.fill('input[name=password]', ADMIN.password);
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.getByText('Start with your data').waitFor({ timeout: 240_000 });
  step('admin creates a team (short password refused) and lands on Home');
  expect(await page.locator('button.go').isDisabled(), 'plan button should be disabled with no data');
  expect(!(await page.getByText('How ARIA decides').count()), 'Assumptions screen still reachable');
  expect(!(await page.getByText(/edge cases|scenario_hash|E_RANGE/i).count()), 'developer wording on Home');
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
  await page.locator('#main').getByText('Kolhapur: a normal week').first().waitFor({ timeout: 60_000 });
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
  await page.getByText('Change from today (%)').waitFor();
  step(`What-if: 3 scenarios compared with the baseline (${opts ? 'truck restriction added' : 'restriction explained as impossible'}), cards and charts shown`);
  await shot('06-whatif');

  await page.locator('input[aria-label="Steps (2-12)"]').fill('4');
  await page.locator('input[aria-label="Steps (2-12)"]').dispatchEvent('change');
  await page.getByRole('button', { name: 'Run steps' }).click();
  await page.getByText('Units shipped and short').waitFor({ timeout: 300_000 });
  step('step sweep: 4 demand steps planned, 4 line charts drawn');

  await tab('Results');
  await page.getByText('Scenarios against today').waitFor();
  await page.getByText('How ARIA did on past weeks').waitFor({ timeout: 30_000 });
  step('Results shows the scenario comparison and the labelled historical replay for the sample');
  await shot('07-results-sample');

  // 8. .svcr export still works
  await tab('Home');
  await page.locator('button.tile', { hasText: 'Share plan' }).click();
  await page.getByText('No active drivers yet').waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Share to WhatsApp/ }).click()]);
  expect(download.suggestedFilename().endsWith('.svcr'), 'no .svcr download');
  const svcrBytes = readFileSync(await download.path());
  await page.keyboard.press('Escape');
  step(`plan file exported: ${download.suggestedFilename()}`);

  // 9. reload restores the dataset
  await page.reload();
  await page.locator('#main').getByText('Kolhapur: a normal week').first().waitFor({ timeout: 240_000 });
  await page.getByText('Data looks good').waitFor({ timeout: 60_000 });
  step('reload keeps the admin signed in and restores the last dataset');

  // 10. team: a driver joins with the code
  await plan();
  await tab('Team');
  const code = (await page.locator('.join-code').textContent()).trim();
  expect(/^[A-Z0-9]{6}$/.test(code), `bad team code ${code}`);
  const dctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const dpage = await dctx.newPage();
  dpage.on('pageerror', (e) => errors.push(`driver: ${e}`));
  await dpage.goto(url);
  await dpage.getByRole('button', { name: /I am a driver/ }).click();
  await dpage.fill('input[name=code]', 'ZZZZZZ');
  await dpage.getByText('No team with this code').waitFor();
  await dpage.fill('input[name=code]', code.toLowerCase());
  await dpage.getByText(`Team found: ${ADMIN.team}`).waitFor();
  for (const k of ['name', 'phone', 'vehicle', 'email', 'password']) await dpage.fill(`input[name=${k}]`, DRIVER[k]);
  await dpage.getByRole('button', { name: 'Join team' }).click();
  await dpage.getByText('No trips right now').waitFor({ timeout: 60_000 });
  const dtabs = await dpage.locator('nav.tabs button.tab').allTextContents();
  expect(dtabs.join('|') === 'My trips|Plans|Report|Account', `driver tabs: ${dtabs}`);
  expect(!(await dpage.locator('button.go').count()) && !(await dpage.getByText('Upload your data').count()), 'driver can reach planning');
  step(`driver joins with code ${code} (a wrong code is refused) and sees only My trips, Plans, Report and Account`);
  await dpage.screenshot({ path: join(out, '08-driver-empty.png'), fullPage: true });

  // 11. admin sends trips; the driver works through one
  await page.locator('.rows li', { hasText: DRIVER.vehicle }).first().waitFor({ timeout: 30_000 });
  const pickers = page.locator('li.assign select');
  const n = await pickers.count();
  expect(n >= 1, 'no depot trips to send');
  await pickers.first().selectOption({ label: `${DRIVER.name} · ${DRIVER.vehicle}` });
  await page.getByRole('button', { name: 'Send 1 trip to drivers' }).click();
  await page.getByText('Sent 1 trip').waitFor();
  await page.getByText(`Sent to ${DRIVER.name}`).waitFor();
  step(`admin sends tonight's first depot load (${n} depot trips in the plan) to the driver`);
  await page.screenshot({ path: join(out, '09-admin-team.png'), fullPage: true });

  await dpage.getByText('1 trip to do').waitFor({ timeout: 30_000 });
  await dpage.getByRole('button', { name: 'I have loaded the truck' }).click();
  await dpage.getByText('On the road').first().waitFor();
  let left = await dpage.locator('section.trip button', { hasText: 'Delivered' }).count();
  const stopsN = left;
  while (left > 0) {
    await dpage.locator('section.trip button', { hasText: 'Delivered' }).first().click();
    await dpage.waitForFunction((k) => document.querySelectorAll('section.trip button').length === 0 || [...document.querySelectorAll('section.trip button')].filter((b) => b.textContent.includes('Delivered')).length < k, left);
    left = await dpage.locator('section.trip button', { hasText: 'Delivered' }).count();
  }
  await dpage.getByText('Finished').waitFor({ timeout: 30_000 });
  step(`driver loads the truck and delivers all ${stopsN} stops; the trip moves to Finished`);
  await page.locator('.rows li', { hasText: `${DRIVER.name} · from` }).getByText('Delivered').waitFor({ timeout: 30_000 });
  step('admin sees the trip as delivered');

  await dpage.locator('nav.tabs button.tab', { hasText: 'Report' }).click();
  await dpage.selectOption('select[aria-label="What happened"]', 'Road closed or blocked');
  await dpage.fill('textarea', 'Bridge closed near the market');
  await dpage.getByRole('button', { name: 'Send to admin' }).click();
  await dpage.getByText('Sent to your admin').waitFor();
  await page.getByText(`${DRIVER.name}: Road closed or blocked`).waitFor({ timeout: 30_000 });
  step('driver reports a closed road; it appears on the admin Team screen');
  await dpage.screenshot({ path: join(out, '10-driver-report.png'), fullPage: true });

  // 12. admin sends the plan file inside the app; the driver opens and checks it
  await tab('Home');
  await page.locator('button.tile', { hasText: 'Share plan' }).click();
  await page.locator(`input[aria-label="Send to ${DRIVER.name}"]`).check();
  await page.getByRole('button', { name: 'Send to 1 driver' }).click();
  await page.getByText('Plan file sent to 1 driver').waitFor({ timeout: 60_000 });
  await dpage.locator('nav.tabs button.tab', { hasText: 'Plans' }).click();
  await dpage.locator('.rows li', { hasText: 'Kolhapur: a normal week' }).getByText('New').waitFor({ timeout: 30_000 });
  await dpage.locator('.rows li', { hasText: 'Kolhapur: a normal week' }).click();
  await dpage.getByText('Nothing in the file was changed since it was made').waitFor({ timeout: 60_000 });
  const depotsShown = await dpage.locator('details.card summary strong').count();
  expect(depotsShown >= 1, 'no depots in the plan file view');
  await dpage.screenshot({ path: join(out, '11-driver-planfile.png'), fullPage: true });
  await dpage.getByRole('button', { name: 'Run the full safety check' }).click();
  await dpage.getByText('All 8 safety rules pass').waitFor({ timeout: 300_000 });
  step(`admin sends the plan file in the app; the driver opens it (${depotsShown} depots), it is unchanged and passes all 8 safety rules on the driver's phone`);
  await tab('Team');
  await page.locator('.rows li', { hasText: `${DRIVER.name} · Kolhapur` }).getByText('Opened').waitFor({ timeout: 30_000 });
  step('admin sees that the driver opened the plan file');
  await dpage.getByRole('button', { name: 'Back' }).click();
  const bad = Buffer.from(svcrBytes);
  bad[bad.length - 20] = bad[bad.length - 20] === 0x31 ? 0x32 : 0x31; // change one character
  await dpage.setInputFiles('#svcr-local', { name: 'changed.svcr', mimeType: 'application/octet-stream', buffer: bad });
  await dpage.getByText('The file was changed or damaged after it was made.').waitFor({ timeout: 30_000 });
  step('a plan file changed by one character is refused on the driver phone');

  // 13. admin pauses the driver
  await page.locator('.rows li', { hasText: DRIVER.name }).filter({ hasText: 'Active' }).click();
  await page.getByRole('button', { name: 'Pause this driver' }).click();
  await dpage.getByText('Your account is paused').waitFor({ timeout: 30_000 });
  step('admin pauses the driver; the driver is locked out at once');

  // 14. sign out and back in as the admin
  await page.locator('header button[aria-label="Account"]').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 30_000 });
  await page.fill('input[name=email]', ADMIN.email);
  await page.fill('input[name=password]', 'wrongpass');
  allow400 = true;
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('Wrong email or password.').waitFor({ timeout: 30_000 });
  allow400 = false;
  await page.fill('input[name=password]', ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('nav.tabs button.tab', { hasText: 'Team' }).waitFor({ timeout: 240_000 });
  step('sign out, wrong password refused in plain words, sign back in as admin');

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
