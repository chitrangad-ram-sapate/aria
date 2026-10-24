// Records: open .svcr files (file picker, "open with", share-to-app), re-verify them on the device,
// and show the pick list per godown. Recently opened records are remembered in localStorage.
import { engine } from '../engine';
import { Json, badge, h, mount, num, short } from '../ui';
import { explainSheet, pickLists } from './plan';

const KEY = 'aria.records';
let root: HTMLElement | null = null;
let current: { name: string; resp: Json } | null = null;
let busy = '';

function recent(): Json[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

function remember(entry: Json) {
  try {
    const list = [entry, ...recent().filter((r) => !(r.name === entry.name && r.scenario_hash === entry.scenario_hash))].slice(0, 20);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* storage blocked or full: the list is a convenience only */ }
}

/** Open and verify a .svcr file's bytes on the device. */
export async function openRecord(name: string, bytes: Uint8Array | null, error = '') {
  busy = `Verifying ${name || 'file'}...`;
  draw();
  let resp: Json;
  try {
    resp = bytes ? await engine.openSvcr(bytes) : { ok: false, error };
  } catch (e: any) {
    resp = { ok: false, error: e.message };
  }
  busy = '';
  current = { name, resp };
  remember({ name, opened_at: new Date().toISOString(), ok: resp.ok, scenario_hash: resp.scenario_hash ?? null, network_id: resp.network_id ?? null, scenario_id: resp.scenario_id ?? null, error: resp.ok ? null : resp.error });
  draw();
}

export function render(r: HTMLElement) {
  root = r;
  draw();
}

function draw() {
  if (!root) return;
  const input = h('input', { type: 'file', accept: '.svcr,application/vnd.aria.svcr+json', class: 'visually-hidden', id: 'svcr-file',
    onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) await openRecord(f.name, new Uint8Array(await f.arrayBuffer()));
    } });
  const list = recent();
  mount(root, h('h1', {}, 'Records'),
    h('section', { class: 'card' },
      h('p', { class: 'muted' }, 'A .svcr file carries a dispatch plan and the exact inputs it was solved on. Opening one checks its digest and scenario_hash and re-runs the independent verifier on this device.'),
      input, h('label', { for: 'svcr-file', class: 'btn primary block', role: 'button', tabIndex: 0, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') input.click(); } }, 'Open .svcr'),
      busy && h('p', { class: 'muted', 'aria-live': 'polite' }, busy)),
    current && view(current),
    h('section', { class: 'card' }, h('h2', {}, 'Recently opened'),
      list.length ? h('ul', { class: 'recent' }, list.map((r) => h('li', {},
        h('div', {}, h('strong', {}, r.name || 'record'), h('div', { class: 'muted small' }, `${new Date(r.opened_at).toLocaleString()} · ${r.network_id ?? '-'} · ${short(r.scenario_hash)}`)),
        r.ok ? badge('VERIFIED', 'ok') : badge('REJECTED', 'bad'))))
        : h('p', { class: 'muted' }, 'No records opened yet.')));
}

function view({ name, resp }: { name: string; resp: Json }) {
  if (!resp.ok) {
    return h('section', { class: 'card verdict bad', role: 'alert' },
      h('div', { class: 'row between' }, h('h2', {}, name || 'Record'), badge('REJECTED', 'bad')),
      h('p', {}, 'Do not dispatch from this file.'),
      h('pre', { class: 'err' }, resp.error));
  }
  const p = resp.plan;
  return h('section', { class: 'card verdict ok' },
    h('div', { class: 'row between' }, h('h2', {}, name), badge('VERIFIED', 'ok')),
    h('ul', { class: 'checks' }, h('li', {}, 'Digest matches the body'), h('li', {}, 'scenario_hash matches the inputs'), h('li', {}, 'Verifier V1–V8 passed on this device')),
    h('div', { class: 'row wrap' }, badge(`scenario_hash ${short(resp.scenario_hash)}`), badge(`network ${resp.network_id}`), badge(`policy ${p.policy}`), badge(`day ${resp.day}`)),
    h('p', { class: 'muted small' }, `Scenario ${resp.scenario_id} · created ${resp.created_at} · ${num(p.allocations.length)} allocation rows`),
    h('h3', {}, 'Pick list per godown'),
    pickLists(p.allocations, false, (g) => `picklist_${g}_${String(resp.scenario_hash).slice(0, 8)}.csv`),
    p.shortfalls?.length > 0 && h('details', {}, h('summary', {}, `Shortfalls (${num(p.shortfalls.length)})`),
      h('ul', { class: 'recent' }, p.shortfalls.slice(0, 200).map((s: Json) => h('li', { class: 'tap', tabIndex: 0, onclick: () => explainSheet(p, s) },
        h('span', {}, `${s.town_id} / ${s.product_id}: ${num(s.shortfall_units)} short`), badge(s.reason))))));
}
