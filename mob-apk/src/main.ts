import './style.css';
import { engine } from './engine';
import { isNative, onFileOpened } from './native';
import { loadScenario, network, onFullRender, state, subscribe } from './state';
import { errorBox, h, icon, mount } from './ui';
import * as assumptions from './views/assumptions';
import * as lab from './views/lab';
import * as plan from './views/plan';
import * as proof from './views/proof';
import * as records from './views/records';

type Tab = 'plan' | 'lab' | 'proof' | 'records' | 'assumptions';
const VIEWS: Record<Tab, { title: string; tab: string; icon: string; render: (el: HTMLElement) => void; update?: () => void }> = {
  plan: { title: "Tonight's plan", tab: 'Home', icon: 'home', render: plan.render, update: plan.update },
  lab: { title: 'What if...', tab: 'What if', icon: 'zap', render: lab.render, update: lab.update },
  proof: { title: 'Results', tab: 'Results', icon: 'chart', render: proof.render },
  records: { title: 'Plan files', tab: 'Files', icon: 'file', render: records.render },
  assumptions: { title: 'How ARIA decides', tab: '', icon: 'help', render: assumptions.render },
};

let tab: Tab = 'plan';
let prev: Tab = 'plan';
const app = document.getElementById('app')!;
const main = h('main', { id: 'main', tabIndex: -1 });
const progressBar = h('div', { class: 'bar' }, h('div', { class: 'fill' }));
const progressText = h('p', { class: 'muted', 'aria-live': 'polite' }, 'Starting...');
const title = h('h1', {}, '');
const sub = h('span', { class: 'sub' }, 'Starting the engine');
const back = h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => show(prev) }, icon('back'));
const help = h('button', { class: 'icon-btn', 'aria-label': 'How ARIA decides', onclick: () => show('assumptions') }, icon('help'));

const tabBtn = (t: Tab) => h('button', { class: 'tab', 'data-tab': t, onclick: () => show(t) }, icon(VIEWS[t].icon), h('span', {}, VIEWS[t].tab));
const go = h('button', { class: 'go', 'aria-label': 'Plan tonight', onclick: () => { show('plan'); plan.planTonight(); } }, icon('swap'));
const tabs = h('nav', { class: 'tabs', 'aria-label': 'Main' }, tabBtn('plan'), tabBtn('lab'), go, tabBtn('proof'), tabBtn('records'));

mount(app, h('header', { class: 'top' }, h('div', {}, back), h('div', {}, title, sub), h('div', {}, help)), main, tabs);

function chrome() {
  title.textContent = VIEWS[tab].title;
  sub.textContent = network().name?.replace(/\s*\(.*\)$/, '') || '';
  back.style.visibility = tab === 'assumptions' ? 'visible' : 'hidden';
  help.style.visibility = tab === 'assumptions' ? 'hidden' : 'visible';
  for (const b of tabs.querySelectorAll<HTMLButtonElement>('button.tab')) b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
  go.disabled = !state.report?.valid || state.validating || state.planBusy;
  go.classList.toggle('busy', state.planBusy);
}

function show(t: Tab) {
  if (t !== tab) prev = tab === 'assumptions' ? prev : tab;
  tab = t;
  chrome();
  VIEWS[t].render(main);
  window.scrollTo(0, 0);
}

onFullRender(() => { chrome(); VIEWS[tab].render(main); });
subscribe(() => { chrome(); VIEWS[tab].update?.(); });

// Files can arrive before the engine is ready; the worker queues them behind start-up.
onFileOpened((name, bytes, error) => {
  show('records');
  records.openRecord(name, bytes, error);
});

async function start() {
  title.textContent = 'ARIA';
  back.style.visibility = 'hidden';
  mount(main, h('section', { class: 'card loading' }, h('h2', {}, 'Getting ready'),
    h('p', { class: 'muted small' }, 'ARIA plans entirely on this phone, with no internet needed. The first start takes a few seconds.'),
    progressBar, progressText));
  const t0 = performance.now();
  try {
    const info = await engine.boot((pct, stage) => {
      (progressBar.firstChild as HTMLElement).style.width = `${pct}%`;
      progressBar.setAttribute('aria-valuenow', String(pct));
      progressText.textContent = `${stage} (${pct}%)`;
    });
    state.engineInfo = `Python ${info.python} · ${info.backend === 'scipy' ? 'SciPy HiGHS' : info.backend}`;
    (window as any).__ariaBootMs = Math.round(performance.now() - t0);
    [state.networks, state.scenarios] = await Promise.all([engine.listNetworks(), engine.listScenarios()]);
    const own = state.scenarios.filter((s) => s.network_id === state.networks[0]?.network_id);
    const first = own.find((s) => /normal/.test(s.scenario_id)) ?? own[0] ?? state.scenarios[0]; // open on a typical day, not a stress test
    show(tab);
    if (first) await loadScenario(first.scenario_id);
  } catch (e: any) {
    mount(main, errorBox(`The engine could not start: ${e.message}`));
  }
}

progressBar.setAttribute('role', 'progressbar');
progressBar.setAttribute('aria-valuemin', '0');
progressBar.setAttribute('aria-valuemax', '100');
start();

if (!isNative && import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
