import './style.css';
import { engine } from './engine';
import { isNative, onFileOpened } from './native';
import { loadScenario, onFullRender, state, subscribe } from './state';
import { errorBox, h, mount } from './ui';
import * as assumptions from './views/assumptions';
import * as lab from './views/lab';
import * as plan from './views/plan';
import * as proof from './views/proof';
import * as records from './views/records';

type Tab = 'plan' | 'proof' | 'lab' | 'records' | 'assumptions';
const VIEWS: Record<Tab, { title: string; icon: string; render: (el: HTMLElement) => void; update?: () => void }> = {
  plan: { title: 'Plan', icon: 'M4 5h16M4 12h16M4 19h10', render: plan.render, update: plan.update },
  proof: { title: 'Proof', icon: 'M5 19V11M12 19V5M19 19v-6', render: proof.render },
  lab: { title: 'Disruption Lab', icon: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3', render: lab.render, update: lab.update },
  records: { title: 'Records', icon: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13l2 2 4-4', render: records.render },
  assumptions: { title: 'Assumptions', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5', render: assumptions.render },
};

let tab: Tab = 'plan';
const app = document.getElementById('app')!;
const main = h('main', { id: 'main', tabIndex: -1 });
const progressBar = h('div', { class: 'bar' }, h('div', { class: 'fill' }));
const progressText = h('p', { class: 'muted', 'aria-live': 'polite' }, 'Starting...');
const engineInfo = h('span', { class: 'muted small' }, 'engine starting');

const tabs = h('nav', { class: 'tabs', 'aria-label': 'Views' }, (Object.keys(VIEWS) as Tab[]).map((t) =>
  h('button', { 'data-tab': t, 'aria-label': VIEWS[t].title, onclick: () => show(t) },
    h('span', { class: 'ico', innerHTML: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${VIEWS[t].icon}"/></svg>` }),
    h('span', {}, t === 'lab' ? 'Lab' : VIEWS[t].title))));

mount(app,
  h('header', { class: 'top' }, h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '', width: 28, height: 28 }), h('strong', {}, 'ARIA')), engineInfo),
  main, tabs);

function show(t: Tab) {
  tab = t;
  for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false');
  VIEWS[t].render(main);
  main.scrollTo?.(0, 0);
  window.scrollTo(0, 0);
}

onFullRender(() => VIEWS[tab].render(main));
subscribe(() => VIEWS[tab].update?.());

// Files can arrive before the engine is ready; the worker queues them behind start-up.
onFileOpened((name, bytes, error) => {
  show('records');
  records.openRecord(name, bytes, error);
});

async function start() {
  mount(main, h('section', { class: 'card loading' }, h('h1', {}, 'Starting the engine'),
    h('p', { class: 'muted small' }, 'ARIA runs entirely on this device. The first start loads the Python engine; later starts are faster.'),
    progressBar, progressText));
  const t0 = performance.now();
  try {
    const info = await engine.boot((pct, stage) => {
      (progressBar.firstChild as HTMLElement).style.width = `${pct}%`;
      progressBar.setAttribute('aria-valuenow', String(pct));
      progressText.textContent = `${stage} (${pct}%)`;
    });
    engineInfo.textContent = `on-device · Python ${info.python} · ${info.backend === 'scipy' ? 'SciPy HiGHS' : info.backend}`;
    (window as any).__ariaBootMs = Math.round(performance.now() - t0);
    [state.networks, state.scenarios] = await Promise.all([engine.listNetworks(), engine.listScenarios()]);
    const first = state.scenarios.find((s) => s.network_id === state.networks[0]?.network_id) ?? state.scenarios[0];
    show(tab);
    if (first) await loadScenario(first.scenario_id);
  } catch (e: any) {
    mount(main, errorBox(`The engine could not start: ${e.message}`));
  }
}

progressBar.setAttribute('role', 'progressbar');
progressBar.setAttribute('aria-valuemin', '0');
progressBar.setAttribute('aria-valuemax', '100');
for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
start();

if (!isNative && import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
