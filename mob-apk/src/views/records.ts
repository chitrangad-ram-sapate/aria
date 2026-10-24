// Records: open .svcr files (file picker, "open with", share-to-app), re-verify them on the device,
// and show the pick list per godown. Recently opened records are remembered in localStorage.
import { engine } from '../engine';
import { LockedError, unlockPlan } from '../seal';
import { state } from '../state';
import { Json, badge, h, mount, num } from '../ui';
import { explainSheet, pickLists, plainReason, townName } from './plan';

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
    resp = bytes ? await engine.openSvcr(await unlockPlan(bytes, state.me?.orgId)) : { ok: false, error };
  } catch (e: any) {
    resp = { ok: false, error: e.message, locked: e instanceof LockedError };
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
  mount(root,
    h('section', { class: 'card' },
      h('p', { class: 'eyebrow' }, 'Got a plan from someone?'),
      h('p', { class: 'small' }, 'Open a .svcr plan file. ARIA checks it is safe to use before showing it.'),
      input, h('label', { for: 'svcr-file', class: 'btn primary block', role: 'button', tabIndex: 0, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') input.click(); } }, 'Open a plan file'),
      busy && h('p', { class: 'muted', 'aria-live': 'polite' }, busy)),
    current && view(current),
    h('section', { class: 'card' }, h('h2', {}, 'Recently opened'),
      list.length ? h('ul', { class: 'recent' }, list.map((r) => h('li', {},
        h('div', {}, h('strong', {}, r.name || 'Plan file'), h('div', { class: 'muted small' }, new Date(r.opened_at).toLocaleString())),
        r.ok ? badge('Safe to use', 'ok') : badge('Do not use', 'bad'))))
        : h('p', { class: 'muted' }, 'No plan files opened yet.')));
}

function view({ name, resp }: { name: string; resp: Json }) {
  if (!resp.ok) {
    return h('section', { class: 'card verdict bad', role: 'alert' },
      h('div', { class: 'row between' }, h('h2', {}, name || 'Plan file'), badge('Do not use', 'bad')),
      resp.locked ? h('p', {}, h('strong', {}, resp.error))
        : h('p', {}, h('strong', {}, 'Do not dispatch from this file.'), ' It was changed, damaged, or is not valid for its inputs.'),
      h('p', { class: 'small muted' }, 'Ask the sender to share the plan again.'));
  }
  const p = resp.plan;
  return h('section', { class: 'card verdict ok' },
    h('div', { class: 'row between' }, h('h2', {}, name), badge('Safe to use', 'ok')),
    h('ul', { class: 'checks' }, h('li', {}, 'Nothing in the file was altered'), h('li', {}, 'The plan belongs to these exact inputs'), h('li', {}, 'All 8 safety checks passed on this phone')),
    h('p', { class: 'muted small' }, `Made ${resp.created_at ? new Date(resp.created_at).toLocaleString() : ''}${resp.day ? ` for ${resp.day}` : ''} · ${num(p.allocations.length)} pick rows · ${p.policy === 'aria' ? 'ARIA plan' : 'usual method'}`),
    h('h3', {}, 'Pick list per depot'),
    pickLists(p.allocations, false, (g) => `picklist_${g}_${String(resp.scenario_hash).slice(0, 8)}.csv`),
    p.shortfalls?.length > 0 && h('details', {}, h('summary', {}, `Shortages (${num(p.shortfalls.length)})`),
      h('ul', { class: 'recent' }, p.shortfalls.slice(0, 200).map((s: Json) => h('li', { class: 'tap', tabIndex: 0, onclick: () => explainSheet(p, s) },
        h('span', {}, `${townName(s.town_id)} · ${s.product_id}: ${num(s.shortfall_units)} short`), h('span', { class: 'small muted' }, plainReason(s)))))));
}
