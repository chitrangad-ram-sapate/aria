import './style.css';
import { watchDrivers, watchFiles, watchLive, watchProfile, watchReports, watchStops, watchTeam, watchTrips, logOut, type Profile, type Trip } from './cloud';
import { LIST } from './config';
import { endTracking } from './views/deliver';
import { backToTop, changePage, moveIndicator, popIcon, trackDock } from './dock';
import { engine } from './engine';
import { isNative, onFileOpened } from './native';
import { track } from './geo';
import { isStale, network, notify, onFullRender, onGoTo, restoreSaved, state, subscribe } from './state';
import { errorBox, h, icon, mount } from './ui';
import * as account from './views/account';
import * as ask from './views/ask';
import * as driver from './views/driver';
import * as login from './views/login';
import * as plan from './views/plan';
import * as records from './views/records';
import * as results from './views/results';
import * as team from './views/team';

type View = { title: string; tab: string; icon: string; render: (el: HTMLElement) => void; update?: () => void };
// Admin: full control. Driver: only their trips, problem reports and account.
const ADMIN: Record<string, View> = {
  plan: { title: '', tab: 'Home', icon: 'home', render: plan.render, update: plan.update },
  ask: { title: 'Ask ARIA', tab: 'Ask', icon: 'chat', render: ask.render, update: ask.update },
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
// Header: who is signed in (initials, to Account), a greeting over the page title, and a live status chip with a
// matching rail along the bottom edge that says where tonight's work stands; tapping the chip goes there.
const title = h('h1', {}, 'ARIA');
const greet = h('span', { class: 'greet' }, '');
const avatar = h('button', { class: 'avatar', 'aria-label': 'Account', onclick: () => show('account') }, '');
const chipText = h('span', {}, '');
const chip = h('button', { class: 'status-chip', onclick: () => show(state.me?.role === 'admin' ? 'plan' : 'trips') }, h('span', { class: 'dot' }), chipText);
const right = h('div', { class: 'head-right' }, chip);
const tabs = h('nav', { class: 'tabs', 'aria-label': 'Main' });
const go = h('button', { class: 'go', 'aria-label': 'Plan tonight', onclick: () => { show('plan'); plan.planTonight(); } }, icon('swap'));
const header = h('header', { class: 'top' }, avatar, h('div', { class: 'head-text' }, greet, title), right);
mount(app, header, main, tabs);
trackDock(tabs);

type Tone = 'idle' | 'busy' | 'ok' | 'warn' | 'bad' | 'live';
/** Where tonight's work stands, in two words, and its colour. */
function status(): [string, Tone] {
  if (state.me?.role === 'admin') {
    if (!state.scenario) return ['No data', 'idle'];
    if (state.planBusy) return ['Planning', 'busy'];
    if (state.validating) return ['Checking', 'busy'];
    if (!state.report?.valid) return ['Fix data', 'bad'];
    const p = state.plan?.resp;
    if (p && isStale(p)) return ['Plan again', 'warn'];
    if (p) return (p.recommended === 'aria' ? p.aria : p.baseline_a)?.verifier?.passed ? ['Verified', 'ok'] : ['Not verified', 'bad'];
    return ['Ready', 'idle'];
  }
  const trips = state.trips.filter((t) => t.status === 'assigned' || t.status === 'loaded');
  const open = trips.flatMap((t) => state.stops[t.id] ?? []).filter((s) => ['assigned', 'in_transit', 'arrived', 'rejected'].includes(s.state));
  if (track.on) return ['Tracking', 'live'];
  if (open.length) return [`${open.length} stop${open.length > 1 ? 's' : ''} left`, 'warn'];
  if (trips.some((t) => !state.stops[t.id])) return [`${trips.length} trip${trips.length > 1 ? 's' : ''}`, 'warn']; // stops still loading
  return [state.trips.length ? 'All done' : 'No trips', state.trips.length ? 'ok' : 'idle'];
}

const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
const greeting = () => { const hr = new Date().getHours(); return hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'; };

function chrome() {
  if (!views[tab]) return;
  const me = state.me;
  const first = me?.name.trim().split(/\s+/)[0] ?? '';
  // Home has no page title: "Good evening" over the person's first name; other pages greet over their title
  title.textContent = views[tab].title || first;
  title.classList.toggle('long', title.textContent.length > 10); // long names (common in India) still fit
  greet.textContent = views[tab].title ? (first ? `${greeting()}, ${first}` : '') : greeting();
  avatar.textContent = initials(me?.name);
  const [text, tone] = status();
  chipText.textContent = text;
  chip.dataset.tone = tone;
  header.dataset.tone = tone;
  chip.setAttribute('aria-label', `Status: ${text}${me?.role === 'admin' && state.scenario ? ` · ${network().name?.replace(/\s*\(.*\)$/, '') || state.scenarioId}` : ''}`);
  if (me?.role === 'admin') {
    go.disabled = !state.report?.valid || state.validating || state.planBusy;
    go.classList.toggle('busy', state.planBusy);
  }
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
onGoTo((t) => views[t] && show(t));
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

// Delivery stops of the latest LIST.trips trips, and (admin) where drivers on the road are. Listeners follow the trip list.
const tripSubs = new Map<string, () => void>();
function syncTripSubs(p: Profile, ts: Trip[]) {
  const want = new Map<string, () => () => void>();
  for (const t of ts.slice(0, LIST.trips)) {
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
  mount(right, chip);
  mount(tabs, tabBtn('trips'), tabBtn('files'), tabBtn('report'), tabBtn('account'));
  show('trips', true);
}

async function startAdmin() {
  views = ADMIN;
  header.hidden = false;
  tabs.hidden = false;
  tabs.className = 'tabs';
  mount(right, chip, iconBtn('file', 'Plan files', 'records'));
  mount(tabs, tabBtn('plan'), tabBtn('ask'), go, tabBtn('results'), tabBtn('team'));
  tab = 'plan';
  title.textContent = '';
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div', { class: 'fill' }));
  const text = h('p', { class: 'muted', 'aria-live': 'polite' }, 'Loading the planner...');
  mount(main, h('section', { class: 'card loading' }, h('img', { class: 'boot-logo', src: `${import.meta.env.BASE_URL}logo.png`, alt: '' }), h('h2', {}, 'Starting ARIA'),
    h('p', { class: 'muted small' }, "Setting up tonight's planner. The first start takes a few seconds."), bar, text));
  const t0 = performance.now();
  try {
    await engine.boot((pct) => {
      (bar.firstChild as HTMLElement).style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
      text.textContent = `Loading the planner... ${pct}%`;
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
