import './style.css';
import { watchDrivers, watchProfile, watchReports, watchTeam, watchTrips, logOut, type Profile } from './cloud';
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

function show(t: string) {
  tab = t;
  chrome();
  views[t].render(main);
  window.scrollTo(0, 0);
}

onFullRender(() => { chrome(); views[tab]?.render(main); });
subscribe(() => { chrome(); views[tab]?.update?.(); });

const tabBtn = (t: string) => h('button', { class: 'tab', 'data-tab': t, onclick: () => show(t) }, icon(views[t].icon), h('span', {}, views[t].tab));
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
    return screen(h('section', { class: 'card' }, h('p', { class: 'eyebrow' }, p.name), h('h2', {}, 'Your account is paused'),
      h('p', { class: 'small' }, 'Your admin has paused your access. Contact them to be allowed again.'),
      h('button', { class: 'btn block', onclick: async () => { await logOut(); location.reload(); } }, icon('logout'), 'Sign out')));
  }
  if (started === p.uid + p.role) return notify(); // profile edits: refresh what is on screen
  started = p.uid + p.role;
  stops.splice(0).forEach((s) => s());
  stops.push(watchTeam(p.orgId, (t) => { state.team = t; notify(); }));
  stops.push(watchTrips(p.orgId, p.role === 'driver' ? p.uid : null, (ts) => { state.trips = ts; notify(); }));
  stops.push(watchReports(p.orgId, p.role === 'driver' ? p.uid : null, (rs) => { state.reports = rs; notify(); }));
  if (p.role === 'admin') {
    stops.push(watchDrivers(p.orgId, (ds) => { state.drivers = ds; notify(); }));
    startAdmin();
  } else startDriver(p);
});

function startDriver(_p: Profile) {
  views = DRIVER;
  header.hidden = false;
  tabs.hidden = false;
  tabs.className = 'tabs three';
  mount(left);
  mount(right);
  mount(tabs, tabBtn('trips'), tabBtn('report'), tabBtn('account'));
  show('trips');
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
  mount(main, h('section', { class: 'card loading' }, h('h2', {}, 'Getting ready'),
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
    show(tab);
  } catch {
    mount(main, errorBox('The planner could not start on this phone. Close the app and open it again.'));
  }
}

// Plan files opened from other apps: admins only (drivers get trips, not plan files).
onFileOpened((name, bytes, error) => {
  if (state.me?.role !== 'admin') return;
  show('records');
  records.openRecord(name, bytes, error);
});

if (!isNative && import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
