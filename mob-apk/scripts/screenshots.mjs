// README screenshots of the admin side: one phone screen each (390 x 844 at 3x), taken from the built app against
// the Firebase emulators with the bundled Kolhapur sample, so no real team's data appears. Driver screens in the
// README come from a real phone (adb screencap). Start the emulators first (npm run emulators).
// Usage: npm run build && npm run screenshots   (writes ../docs/screenshots/admin-*.png)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const server = await preview({ preview: { port: 4181, strictPort: true } });
const url = 'http://localhost:4181/?emulators=1';
const out = join(import.meta.dirname, '..', '..', 'docs', 'screenshots');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'light' };
const page = await (await browser.newContext(phone)).newPage();
const run = Date.now().toString(36);
const ADMIN = { name: 'Asha Patil', team: 'Patil Distributors', email: `admin-${run}@example.com`, password: 'secret123' };
const DRIVER = { name: 'Ravi Kumar', phone: '9876543210', vehicle: 'MH09 AB 1234', email: `driver-${run}@example.com`, password: 'secret123' };
const tab = (name) => page.locator('nav.tabs button.tab', { hasText: name }).click();
const settle = () => page.waitForTimeout(4200); // toasts fade after 3.5 s; page slides finish well before

/** Scroll `target` to just below the header, then capture the screen. */
async function shot(name, target) {
  if (target) {
    await target.first().evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
      const scroller = document.scrollingElement;
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 76);
      const main = document.getElementById('main');
      if (main && main.scrollHeight > main.clientHeight) main.scrollTop = Math.max(0, main.scrollTop - 76);
    });
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`ok  ${name}`);
}

try {
  await page.goto(url);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 60_000 });
  await shot('admin-0-sign-in');
  await page.getByRole('button', { name: /I manage a team/ }).click();
  for (const [k, v] of Object.entries({ name: ADMIN.name, team: ADMIN.team, email: ADMIN.email, password: ADMIN.password })) await page.fill(`input[name=${k}]`, v);
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.getByText('Start with your data').waitFor({ timeout: 240_000 });

  await page.getByText('Try a sample dataset instead').click();
  await page.selectOption('select[aria-label="Sample dataset"]', 'kolhapur_normal_week');
  await page.getByRole('button', { name: 'Load sample' }).click();
  await page.getByText('Data looks good').waitFor({ timeout: 60_000 });
  await settle();
  await shot('admin-1-home');
  await page.locator('#main button.btn.primary', { hasText: 'Plan tonight' }).click();
  await page.getByText('To ship tonight').waitFor({ timeout: 180_000 });
  await settle();
  await shot('admin-2-plan', page.getByText('To ship tonight'));
  await shot('admin-3-network', page.getByText('Where the stock goes tonight'));
  await shot('admin-4-compare', page.getByText('Compared with the usual method'));
  await shot('admin-5-shortages', page.locator('.section-head', { hasText: 'Shipments by depot' }));

  // scan a label: checked against the data, then the comparison with the plan before
  await page.locator('#main').evaluate((m) => { m.scrollTop = 0; document.scrollingElement.scrollTop = 0; });
  await page.getByRole('button', { name: 'Scan labels' }).first().click();
  const sheet = page.locator('dialog.sheet');
  await sheet.locator('input[aria-label="Label code"]').fill('ARIA1|product=FOODS_3_007|lot=SCAN-0001|qty=400|exp=2016-04-06|depot=G_SHIROLI');
  await sheet.getByRole('button', { name: 'Use code' }).click();
  await sheet.getByText('Check the details').waitFor();
  await shot('admin-6-scan-check');
  await sheet.getByRole('button', { name: 'Add to the list' }).click();
  await sheet.getByRole('button', { name: /Update stock and plan again/ }).click();
  await sheet.getByText('New plan compared with the one before').waitFor({ timeout: 300_000 });
  await settle();
  await shot('admin-7-scan-compare');
  await sheet.getByRole('button', { name: 'See the new plan' }).click();

  await tab('What if');
  for (const p of ['Demand up 20%', 'Depots load 30% less']) {
    await page.locator('details.add').evaluate((d) => { d.open = true; });
    await page.getByRole('button', { name: p }).click();
  }
  await page.getByRole('button', { name: /^Compare 2 scenarios/ }).click();
  await page.getByText('Which option does best?').waitFor({ timeout: 300_000 });
  await page.getByText('Up to date').waitFor({ timeout: 300_000 });
  await settle();
  await shot('admin-8-whatif', page.getByText('Which option does best?'));

  await tab('Results');
  await page.getByText('How ARIA did on past weeks').waitFor({ timeout: 60_000 });
  await settle();
  await shot('admin-9-results');

  // the team: a driver joins with the code, the admin sends tonight's first depot load
  await tab('Team');
  const code = (await page.locator('.join-code').textContent()).trim();
  const dpage = await (await browser.newContext(phone)).newPage();
  await dpage.goto(url);
  await dpage.getByRole('button', { name: /I am a driver/ }).click();
  await dpage.fill('input[name=code]', code);
  await dpage.getByText(`Team found: ${ADMIN.team}`).waitFor();
  for (const k of ['name', 'phone', 'vehicle', 'email', 'password']) await dpage.fill(`input[name=${k}]`, DRIVER[k]);
  await dpage.getByRole('button', { name: 'Join team' }).click();
  await dpage.getByText('No trips right now').waitFor({ timeout: 60_000 });
  await page.locator('.rows li', { hasText: DRIVER.vehicle }).first().waitFor({ timeout: 30_000 });
  await page.locator('li.assign select').first().selectOption({ label: `${DRIVER.name} · ${DRIVER.vehicle}` });
  await page.getByRole('button', { name: 'Send 1 trip to drivers' }).click();
  await page.getByText(`Sent to ${DRIVER.name}`).waitFor();
  await settle();
  await shot('admin-10-team', page.locator('#main section.card').first());
  await page.getByRole('tab', { name: /Not started/ }).click();
  await shot('admin-11-deliveries', page.locator('.section-head', { hasText: 'Deliveries' }));
  await page.locator('.rows li.tap', { hasText: DRIVER.name }).first().click();
  await page.locator('dialog.sheet').getByText('Delivery code for the shop').waitFor();
  await page.waitForTimeout(2500); // map tiles
  await page.locator('dialog.sheet').evaluate((d) => { d.scrollTop = 0; d.querySelectorAll('*').forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }); });
  await shot('admin-12-stop');
  await page.keyboard.press('Escape');

  // the driver delivers to Kolhapur with a simulated GPS at the sample's shop; the admin makes the code and confirms
  const dshot = async (name, target) => {
    if (target) await target.first().evaluate((el) => { el.scrollIntoView({ block: 'start' }); document.scrollingElement.scrollTop -= 76; });
    await dpage.waitForTimeout(400);
    await dpage.screenshot({ path: join(out, `${name}.png`) });
    console.log(`ok  ${name}`);
  };
  const dctx = dpage.context();
  await dctx.grantPermissions(['geolocation']);
  const [tl, tn] = [16.705, 74.2433];
  await dctx.setGeolocation({ latitude: tl + 0.02, longitude: tn, accuracy: 8 }); // about 2 km away
  await dpage.getByText('1 trip to do').waitFor({ timeout: 30_000 });
  await dpage.waitForTimeout(4200);
  await dshot('driver-1-trips');
  await dpage.getByRole('button', { name: 'Start delivery' }).click();
  await dpage.getByText('On the road').first().waitFor();
  await dpage.locator('section.trip ul.stops li', { hasText: 'Kolhapur' }).first().click();
  await dpage.getByRole('button', { name: 'Go to this stop' }).click();
  await dpage.getByText('Not at delivery location yet').first().waitFor({ timeout: 30_000 });
  await dpage.waitForTimeout(4200); // map tiles, toast
  await dshot('driver-2-on-the-way');
  await dctx.setGeolocation({ latitude: tl + 0.0002, longitude: tn, accuracy: 8 });
  await dpage.waitForTimeout(1200);
  await dctx.setGeolocation({ latitude: tl + 0.0001, longitude: tn, accuracy: 6 });
  const arrive = dpage.getByRole('button', { name: 'Location check passed · Confirm recipient' });
  await arrive.waitFor({ timeout: 30_000 });
  await dshot('driver-3-at-the-shop', dpage.locator('section.card', { hasText: 'Location' }).last());
  await arrive.click();
  await dpage.getByText('Now confirm the recipient').waitFor({ timeout: 30_000 });

  await page.locator('.chips button', { hasText: 'On the way' }).click();
  await page.locator('.rows li', { hasText: `Kolhapur · ${DRIVER.name}` }).click();
  const sheet2 = page.locator('dialog.sheet');
  await sheet2.getByRole('button', { name: 'Make delivery code' }).click();
  const shopCode = (await sheet2.locator('.join-code').textContent()).trim();
  await sheet2.getByText('Delivery code for the shop').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot('admin-13-code');
  await page.keyboard.press('Escape');

  await dpage.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Submit delivery proof'); return b && !b.disabled; }, null, { timeout: 30_000 });
  await dpage.fill('input[aria-label="Recipient name"]', 'Ravi Patil');
  await dpage.fill('input[aria-label="Recipient code"]', shopCode);
  await dpage.locator('input[aria-label="Recipient code"]').blur();
  await dpage.waitForTimeout(4200); // the "Location check passed" message fades
  await dshot('driver-4-proof', dpage.getByText('Location check passed').last());
  await dpage.getByRole('button', { name: 'Submit delivery proof' }).click();
  await dpage.getByText('Delivery submitted · awaiting confirmation').first().waitFor({ timeout: 30_000 });

  await page.locator('.chips button', { hasText: 'To confirm' }).click();
  await page.locator('.rows li', { hasText: `Kolhapur · ${DRIVER.name}` }).click();
  await sheet2.getByText('Received by Ravi Patil').waitFor();
  await sheet2.getByText('Location check on the driver\'s phone').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot('admin-14-confirm');
  await sheet2.getByRole('button', { name: 'Confirm delivered' }).click();
  await dpage.getByText('Delivered and confirmed by your admin').waitFor({ timeout: 30_000 });

  // a locked plan file sent in the app, opened and fully checked on the driver's phone
  await tab('Home');
  await page.locator('button.tile', { hasText: 'Share plan' }).click();
  await page.locator('dialog.sheet input[type=checkbox]').first().check();
  await page.getByRole('button', { name: 'Send to 1 driver' }).click();
  await page.getByText('Plan file sent to 1 driver').waitFor({ timeout: 60_000 });
  await dpage.locator('nav.tabs button.tab', { hasText: 'Plans' }).click();
  await dpage.locator('.rows li.tap').first().click();
  await dpage.getByRole('button', { name: 'Run the full safety check' }).click();
  await dpage.getByText('All 8 safety rules pass').waitFor({ timeout: 300_000 });
  await dshot('driver-5-plan-checked');

  await dpage.locator('nav.tabs button.tab', { hasText: 'Report' }).click();
  await dpage.selectOption('select[aria-label="What happened"]', 'Running late');
  await dpage.fill('textarea[aria-label="Details"]', 'Traffic jam near Shiroli toll plaza, about 40 minutes late.');
  await dshot('driver-6-report');
  console.log(`\nscreenshots in ${out}`);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
