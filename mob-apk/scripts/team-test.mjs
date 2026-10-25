// Two companies, kept apart: admin 1 with driver 1, admin 2 with driver 2. Admin 1's locked plan file (.svcr) must open
// for driver 1 and for nobody in admin 2's team, in the app and straight against the database:
// - driver 2 opens the file (shared outside the app, e.g. on WhatsApp): refused, nothing shown;
// - driver 2 opens a copy with the team in its header rewritten to their own: refused, nothing shown;
// - admin 2 opens the file in Plan files: refused;
// - admin 1 sends the plan inside the app to driver 1: driver 2's Plans stay empty;
// - with their own sign-ins, driver 2 and admin 2 cannot read team 1's key or plan files, and admin 1 cannot send a
//   plan file to driver 2.
// Usage: start the emulators (npm run emulators), then npm run build && node scripts/team-test.mjs
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { addDoc, collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore, query, serverTimestamp, where } from 'firebase/firestore';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const server = await preview({ preview: { port: 4181, strictPort: true } });
const url = 'http://localhost:4181/?emulators=1';
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const run = Date.now().toString(36);
const who = (role, n, extra = {}) => ({ name: `${role} ${n}`, email: `${role.toLowerCase()}${n}-${run}@example.com`, password: 'secret123', ...extra });
const A1 = who('Admin', 1, { team: 'Company One' }), A2 = who('Admin', 2, { team: 'Company Two' });
const D1 = who('Driver', 1, { phone: '9876500001', vehicle: 'MH09 AA 0001' }), D2 = who('Driver', 2, { phone: '9876500002', vehicle: 'MH12 BB 0002' });

let failed = 0;
const check = (what, ok) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const phone = async () => (await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true })).newPage();
const shown = (page, text) => page.getByText(text).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);

async function newAdmin(a) {
  const page = await phone();
  await page.goto(url);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: /I manage a team/ }).click();
  for (const k of ['name', 'team', 'email', 'password']) await page.fill(`input[name=${k}]`, a[k]);
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.getByText('Start with your data').waitFor({ timeout: 240_000 });
  await page.locator('nav.tabs button.tab', { hasText: 'Team' }).click();
  const code = (await page.locator('.join-code').textContent()).trim();
  return { page, code };
}

async function newDriver(d, code, team) {
  const page = await phone();
  await page.goto(url);
  await page.getByRole('button', { name: /I am a driver/ }).click();
  await page.fill('input[name=code]', code);
  await page.getByText(`Team found: ${team}`).waitFor();
  for (const k of ['name', 'phone', 'vehicle', 'email', 'password']) await page.fill(`input[name=${k}]`, d[k]);
  await page.getByRole('button', { name: 'Join team' }).click();
  await page.getByText('No trips right now').waitFor({ timeout: 60_000 });
  await page.locator('nav.tabs button.tab', { hasText: 'Plans' }).click();
  return page;
}

/** Open a .svcr from the phone's files on a driver's Plans page; true when the plan itself is shown. */
async function driverOpens(page, name, bytes) {
  if (await page.getByRole('button', { name: 'Back' }).count()) await page.getByRole('button', { name: 'Back' }).click();
  await page.setInputFiles('#svcr-local', { name, mimeType: 'application/octet-stream', buffer: bytes });
  await page.waitForTimeout(500);
  await page.getByText(/Nothing in the file was changed|another team|changed or damaged|Connect to the internet once/).first().waitFor({ timeout: 60_000 });
  return (await page.getByText('Nothing in the file was changed since it was made').count()) > 0 && (await page.locator('details.card summary strong').count()) > 0;
}

/** Sign in with the Firebase SDK as that person, to try the database directly (as a modified app could). */
async function signIn(p) {
  const app = initializeApp({ projectId: 'demo-aria', apiKey: 'demo-key' }, `${p.email}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, 'localhost', 8080);
  const { user } = await signInWithEmailAndPassword(auth, p.email, p.password);
  const me = (await getDoc(doc(db, 'users', user.uid))).data();
  return { uid: user.uid, db, orgId: me.orgId };
}
const refused = (fn) => fn().then(() => false, (e) => /permission/i.test(String(e?.code ?? e)));

try {
  // two companies, each with its own driver
  const one = await newAdmin(A1), two = await newAdmin(A2);
  const d1 = await newDriver(D1, one.code, A1.team), d2 = await newDriver(D2, two.code, A2.team);
  console.log(`setup: ${A1.team} (code ${one.code}) with ${D1.name}; ${A2.team} (code ${two.code}) with ${D2.name}`);

  // admin 1 plans and exports a locked plan file
  const a1 = one.page;
  await a1.locator('nav.tabs button.tab', { hasText: 'Home' }).click();
  await a1.getByText('Try a sample dataset instead').click();
  await a1.selectOption('select[aria-label="Sample dataset"]', 'kolhapur_normal_week');
  await a1.getByRole('button', { name: 'Load sample' }).click();
  await a1.getByText('Data looks good').waitFor({ timeout: 120_000 });
  await a1.locator('#main button.btn.primary', { hasText: 'Plan tonight' }).click();
  await a1.getByText('To ship tonight').waitFor({ timeout: 180_000 });
  await a1.locator('button.tile', { hasText: 'Share plan' }).click();
  const [download] = await Promise.all([a1.waitForEvent('download'), a1.getByRole('button', { name: /Share to WhatsApp/ }).click()]);
  const file = readFileSync(await download.path());
  const header = file.subarray(0, file.indexOf(10)).toString();
  check(`admin 1's plan file is locked to their team (${header})`, header.startsWith('ARIA-LOCKED/1 team='));

  // in the app: driver 1 opens it, driver 2 cannot
  check('driver 1 (same company) opens the plan file and sees the plan', await driverOpens(d1, download.suggestedFilename(), file));
  check('driver 2 (other company) cannot open it: nothing of the plan is shown', !(await driverOpens(d2, download.suggestedFilename(), file)));
  check('driver 2 is told it belongs to another team', await shown(d2, 'This plan file belongs to another team. Only that team can open it.'));

  // a forged copy: team 1 in the header replaced by driver 2's own team
  const s2 = await signIn(D2);
  const forged = Buffer.concat([Buffer.from(`ARIA-LOCKED/1 team=${s2.orgId}\n`), file.subarray(file.indexOf(10) + 1)]);
  check("driver 2 cannot open a copy relabelled with their own team (it is locked with team 1's key)", !(await driverOpens(d2, 'relabelled.svcr', forged)));
  check('the relabelled copy is reported as changed or damaged', await shown(d2, /changed or damaged|Connect to the internet once/));

  // admin 2 cannot open it either
  const a2 = two.page;
  await a2.locator('header button[aria-label="Plan files"]').click();
  await a2.setInputFiles('#svcr-file', { name: download.suggestedFilename(), mimeType: 'application/octet-stream', buffer: file });
  check('admin 2 (other company) cannot open it in Plan files', await shown(a2, 'This plan file belongs to another team. Only that team can open it.') && await shown(a2, 'Do not use'));

  // inside the app: admin 1 sends the plan to driver 1 only; driver 2 never sees it
  await a1.keyboard.press('Escape');
  await a1.locator('button.tile', { hasText: 'Share plan' }).click();
  const names = await a1.locator('input[aria-label^="Send to "]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  check(`admin 1 can send only to their own drivers (${names.join(', ')})`, names.length === 1 && names[0] === `Send to ${D1.name}`);
  await a1.locator(`input[aria-label="Send to ${D1.name}"]`).check();
  await a1.getByRole('button', { name: 'Send to 1 driver' }).click();
  await a1.getByText('Plan file sent to 1 driver').waitFor({ timeout: 60_000 });
  if (await d1.getByRole('button', { name: 'Back' }).count()) await d1.getByRole('button', { name: 'Back' }).click();
  check('driver 1 gets the plan file in the app', await shown(d1, 'Kolhapur: a normal week'));
  if (await d2.getByRole('button', { name: 'Back' }).count()) await d2.getByRole('button', { name: 'Back' }).click();
  await d2.waitForTimeout(3000);
  check("driver 2's Plans stay empty", await shown(d2, 'No plan files yet.') && !(await d2.getByText('Kolhapur: a normal week').count()));

  // straight against the database, with each person's own sign-in
  const s1 = await signIn(A1), sd1 = await signIn(D1), sa2 = await signIn(A2);
  const key = (db) => getDoc(doc(db, 'orgs', s1.orgId, 'secret', 'key'));
  check("driver 1 can read their team's key (control)", (await key(sd1.db)).exists());
  check("driver 2 cannot read team 1's key", await refused(() => key(s2.db)));
  check("admin 2 cannot read team 1's key", await refused(() => key(sa2.db)));
  check("driver 2 cannot list team 1's plan files", await refused(() => getDocs(query(collection(s2.db, 'orgs', s1.orgId, 'files'), where('driverUid', '==', s2.uid)))));
  check("admin 2 cannot list team 1's plan files", await refused(() => getDocs(collection(sa2.db, 'orgs', s1.orgId, 'files'))));
  check('admin 1 cannot send a plan file to driver 2', await refused(() => addDoc(collection(s1.db, 'orgs', s1.orgId, 'files'),
    { driverUid: s2.uid, driverName: D2.name, name: 'x.svcr', size: 1, parts: 1, sentAt: serverTimestamp() })));
} catch (e) {
  failed++;
  console.log(`FAIL ${e.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.httpServer.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall team checks passed');
process.exit(failed ? 1 : 0);
