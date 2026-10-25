import './style.css';
import { watchDrivers, watchFiles, watchLive, watchProfile, watchReports, watchStops, watchTeam, watchTrips, logOut, type Profile, type Trip } from './cloud';
import { endTracking } from './views/deliver';
import { backToTop, changePage, moveIndicator, popIcon, trackDock } from './dock';
import { engine } from './engine';
import { isNative, onFileOpened } from './native';
import { network, notify, onFullRender, restoreSaved, state, subscribe } from './state';
import { errorBox, h, icon, mount } from './ui';
import * as account from './views/account';
import * as driver from './views/driver';
import * as lab from './views/lab';
import * as login from './views/login';
import * as plan from './views/plan';
import * as records from './views/records';
import * as results from './views/results';
import * as team from './views/team';

type View = { title: string; tab: string; icon: string; render: (el: HTMLElement) => void; update?: () => void };
// Admin: full control. Driver: only their trips, problem reports and account.
const ADMIN: Record<string, View> = {
  plan: { title: "Tonight's plan", tab: 'Home', icon: 'home', render: plan.render, update: plan.update },
  lab: { title: 'What if', tab: 'What if', icon: 'zap', render: lab.render, update: lab.update },
  results: { title: 'Results', tab: 'Results', icon: 'chart', render: results.render, update: results.update },
  team: { title: 'Team', tab: 'Team', icon: 'users', render: team.render, update: team.update },
  records: { title: 'Plan files', tab: '', icon: 'file', render: records.render },
  account: { title: 'Account', tab: '', icon: 'user', render: account.render },
};
const DRIVER: Record<string, View> = {
  trips: { title: 'My trips', tab: 'My trips', icon: 'truck', render: driver.renderTrips, update: driver.update },
  files: { title: 'Plan files', tab: 'Plans', icon: 'file', render: driver.renderFiles, update: driver.update },
  report: { title: 'Report a problem', tab: 'Report', icon: 'alert', render: driver.renderReport, update: driver.update },
  account: { title: 'Account', tab: 'Account', icon: 'user', render: account.render },
};

let views: Record<string, View> = {};
let tab = '';
const app = document.getElementById('app')!;
const main = h('main', { id: 'main', tabIndex: -1 });
const title = h('h1', {}, 'ARIA');
const sub = h('span', { class: 'sub' }, '');
const left = h('div', {});
const right = h('div', {});
const tabs = h('nav', { class: 'tabs', 'aria-label': 'Main' });
const go = h('button', { class: 'go', 'aria-label': 'Plan tonight', onclick: () => { show('plan'); plan.planTonight(); } }, icon('swap'));
const header = h('header', { class: 'top' }, left, h('div', {}, title, sub), right);
mount(app, header, main, tabs);
trackDock(tabs);

function chrome() {
  if (!views[tab]) return;
  title.textContent = views[tab].title;
  if (state.me?.role === 'admin') {
    sub.textContent = state.scenario ? (network().name?.replace(/\s*\(.*\)$/, '') || state.scenarioId) : 'No data loaded';
    go.disabled = !state.report?.valid || state.validating || state.planBusy;
    go.classList.toggle('busy', state.planBusy);
  } else sub.textContent = state.team?.name ?? '';
  for (const b of tabs.querySelectorAll<HTMLButtonElement>('button.tab')) b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
}

/** Order of pages in the dock, for the slide direction (pages outside the dock count as to the right). */
const position = (t: string) => {
  const ids = [...tabs.querySelectorAll<HTMLElement>('button.tab, button.go')].map((b) => b.dataset.tab ?? 'plan');
  const i = ids.indexOf(t);
  return i < 0 ? ids.length : i;
};

function show(t: string, force = false) {
  if (t === tab && !force) return chrome();
  const from = tab;
  tab = t;
  chrome();
  changePage(main, from, t, position(t) >= position(from) ? 1 : -1, () => views[t].render(main));
  moveIndicator(tabs);
  popIcon(tabs);
}

onFullRender(() => { chrome(); views[tab]?.render(main); });
subscribe(() => { chrome(); views[tab]?.update?.(); });

// Tapping the tab already open takes that page back to the top (as on iPhone) instead of doing nothing.
const tabBtn = (t: string) => h('button', { class: 'tab', 'data-tab': t, onclick: () => (t === tab ? backToTop(main) : show(t)) }, icon(views[t].icon), h('span', {}, views[t].tab));
const iconBtn = (name: string, labelText: string, t: string) => h('button', { class: 'icon-btn', 'aria-label': labelText, onclick: () => show(t) }, icon(name));

function screen(...kids: any[]) {
  tabs.hidden = true;
  header.hidden = true;
  mount(main, h('div', { class: 'center-screen' }, ...kids));
}

// ---------- start: who is signed in decides the whole app ----------
let started = '';
const stops: (() => void)[] = [];
let signupWait = 0;

watchProfile((p, user) => {
  clearTimeout(signupWait);
  if (!user) {
    started = '';
    stops.splice(0).forEach((s) => s()); // the old account's listeners would keep retrying and keep its data in memory
    dropTripSubs();
    endTracking();
    Object.assign(state, { me: null, team: null, trips: [], reports: [], files: [], drivers: [] });
    header.hidden = true;
    tabs.hidden = true;
    login.render(main);
    return;
  }
  if (!p) {
    screen(h('section', { class: 'card loading' }, h('h2', {}, 'Setting up your account...')));
    // a sign-up that stopped half-way (no connection) leaves an account without a profile: let the user start over
    signupWait = window.setTimeout(() => screen(h('section', { class: 'card' }, h('h2', {}, 'Sign-up did not finish'),
      h('p', { class: 'small' }, 'Check the internet connection, then sign in again.'),
      h('button', { class: 'btn primary block', onclick: async () => { await logOut(); location.reload(); } }, 'Back to sign in'))), 12000);
    return;
  }
  state.me = p;
  if (!p.active) {
    started = '';
    stops.splice(0).forEach((s) => s());
    dropTripSubs();
    endTracking();
    return screen(h('section', { class: 'card' }, h('p', { class: 'eyebrow' }, p.name), h('h2', {}, 'Your account is paused'),
      h('p', { class: 'small' }, 'Your admin has paused your access. Contact them to be allowed again.'),
      h('button', { class: 'btn block', onclick: async () => { await logOut(); location.reload(); } }, icon('logout'), 'Sign out')));
  }
  if (started === p.uid + p.role) return notify(); // profile edits: refresh what is on screen
  started = p.uid + p.role;
  stops.splice(0).forEach((s) => s());
  dropTripSubs();
  stops.push(watchTeam(p.orgId, (t) => { state.team = t; notify(); }));
  stops.push(watchTrips(p.orgId, p.role === 'driver' ? p.uid : null, (ts) => { state.trips = ts; syncTripSubs(p, ts); notify(); }));
  stops.push(watchReports(p.orgId, p.role === 'driver' ? p.uid : null, (rs) => { state.reports = rs; notify(); }));
  stops.push(watchFiles(p.orgId, p.role === 'driver' ? p.uid : null, (fs) => { state.files = fs; notify(); }));
  if (p.role === 'admin') {
    stops.push(watchDrivers(p.orgId, (ds) => { state.drivers = ds; notify(); }));
    startAdmin();
  } else startDriver(p);
});

// Delivery stops of the latest 30 trips, and (admin) where drivers on the road are. Listeners follow the trip list.
const tripSubs = new Map<string, () => void>();
function syncTripSubs(p: Profile, ts: Trip[]) {
  const want = new Map<string, () => () => void>();
  for (const t of ts.slice(0, 30)) {
    want.set(`s:${t.id}`, () => watchStops(p.orgId, t.id, p.role === 'driver' ? p.uid : null, (ss) => { state.stops[t.id] = ss; notify(); }));
    if (p.role === 'admin' && t.status === 'loaded') want.set(`l:${t.id}`, () => watchLive(p.orgId, t.id, (ls) => { state.live[t.id] = ls; notify(); }));
  }
  for (const [k, stop] of tripSubs) if (!want.has(k)) { stop(); tripSubs.delete(k); delete (k[0] === 's' ? state.stops : state.live)[k.slice(2)]; }
  for (const [k, start] of want) if (!tripSubs.has(k)) tripSubs.set(k, start());
}
function dropTripSubs() {
  tripSubs.forEach((stop) => stop());
  tripSubs.clear();
  state.stops = {};
  state.live = {};
}

function startDriver(_p: Profile) {
  views = DRIVER;
  header.hidden = false;
  tabs.hidden = false;
  tabs.className = 'tabs four';
  mount(left);
  mount(right);
  mount(tabs, tabBtn('trips'), tabBtn('files'), tabBtn('report'), tabBtn('account'));
  show('trips', true);
}

async function startAdmin() {
  views = ADMIN;
  header.hidden = false;
  tabs.hidden = false;
  tabs.className = 'tabs';
  mount(left, iconBtn('user', 'Account', 'account'));
  mount(right, iconBtn('file', 'Plan files', 'records'));
  mount(tabs, tabBtn('plan'), tabBtn('lab'), go, tabBtn('results'), tabBtn('team'));
  tab = 'plan';
  title.textContent = "Tonight's plan";
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div', { class: 'fill' }));
  const text = h('p', { class: 'muted', 'aria-live': 'polite' }, 'Getting the planner ready...');
  mount(main, h('section', { class: 'card loading' }, h('img', { class: 'boot-logo', src: `${import.meta.env.BASE_URL}logo.png`, alt: '' }), h('h2', {}, 'Getting ready'),
    h('p', { class: 'muted small' }, 'ARIA plans on this phone, so it works without internet. The first start takes a few seconds.'), bar, text));
  const t0 = performance.now();
  try {
    await engine.boot((pct) => {
      (bar.firstChild as HTMLElement).style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
      text.textContent = `Getting the planner ready... ${pct}%`;
    });
    (window as any).__ariaBootMs = Math.round(performance.now() - t0);
    [state.networks, state.scenarios] = await Promise.all([engine.listNetworks(), engine.listScenarios()]);
    await restoreSaved(); // the last dataset on this phone; otherwise Home asks for a CSV
    show(tab, true);
  } catch {
    mount(main, errorBox('The planner could not start on this phone. Close the app and open it again.'));
  }
}

// Plan files opened from other apps: admins check them with the planner, drivers view them.
onFileOpened((name, bytes, error) => {
  if (state.me?.role === 'admin') {
    show('records');
    records.openRecord(name, bytes, error);
  } else if (state.me?.role === 'driver' && bytes) {
    show('files');
    driver.openLocalFile(main, name, bytes);
  }
});

if (!isNative && import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
