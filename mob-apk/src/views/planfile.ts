// Read-only view of a .svcr plan file for drivers (who do not load the planner). Checks the file's fingerprint
// (sha256 of the body, as in aria/svcr.py) in the browser, then shows what goes where. The full safety check
// (scenario fingerprint + all 8 rules) needs the planner and runs only when the driver asks for it.
import { engine } from '../engine';
import { LockedError, unlockPlan } from '../seal';
import { state } from '../state';
import { SVCR_MIME, shareFile } from '../native';
import { Json, badge, h, icon, mount, num } from '../ui';
import { plainReason } from './plan';

type Parsed = { ok: true; payload: Json } | { ok: false; error: string };

async function parse(bytes: Uint8Array): Promise<Parsed> {
  const nl = bytes.indexOf(10);
  if (nl < 0) return { ok: false, error: 'This is not an ARIA plan file.' };
  const header = new TextDecoder().decode(bytes.subarray(0, nl)).trim().split(/\s+/);
  if (header.length !== 2 || header[0] !== 'SVCR/1' || !header[1].startsWith('sha256=')) return { ok: false, error: 'This is not an ARIA plan file.' };
  const body = bytes.subarray(nl + 1);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (digest !== header[1].slice(7)) return { ok: false, error: 'The file was changed or damaged after it was made.' };
  try {
    const payload = JSON.parse(new TextDecoder().decode(body));
    if (payload?.format !== 'svcr' || !payload.plan || !payload.scenario) throw new Error();
    return { ok: true, payload };
  } catch {
    return { ok: false, error: 'The file could not be read.' };
  }
}

/** Show a plan file in `root`. */
export async function showPlanFile(root: HTMLElement, name: string, bytes: Uint8Array, back?: () => void, title = name.replace(/\.svcr$/i, '')) {
  const top = back && h('button', { class: 'btn ghost', onclick: back }, icon('back'), 'Back');
  mount(root, top, h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Opening the plan file...')));
  let plain = bytes;
  let r: Parsed;
  try {
    plain = await unlockPlan(bytes, state.me?.orgId);
    r = await parse(plain);
  } catch (e: any) {
    r = { ok: false, error: e instanceof LockedError ? e.message : 'The file could not be read.' };
  }
  if (!r.ok) {
    return mount(root, top, h('section', { class: 'card verdict bad', role: 'alert' },
      h('div', { class: 'row between' }, h('h2', {}, title), badge('Do not use', 'bad')),
      h('p', {}, h('strong', {}, r.error)), h('p', { class: 'small muted' }, 'Ask your admin to send it again.')));
  }
  const p = r.payload, sc = p.scenario, plan = p.plan;
  const depotName = (id: string) => sc.godowns.find((g: Json) => g.godown_id === id)?.name || id;
  const townName = (id: string) => sc.towns.find((t: Json) => t.town_id === id)?.name || id;
  const allocs: Json[] = plan.allocations ?? [];
  const units = allocs.reduce((n, a) => n + a.units, 0);
  const depots = [...new Set(allocs.map((a) => a.godown_id))];
  const towns = new Set(allocs.map((a) => a.town_id));
  const check = h('li', { class: 'pending' }, h('span', { class: 'muted' }, 'Safety rules not checked on this phone yet'));
  const runCheck = h('button', { class: 'btn block', onclick: async () => {
    runCheck.disabled = true;
    mount(check, h('span', { class: 'muted' }, 'Getting the planner ready... (first time takes a few seconds)'));
    try {
      await engine.boot((pct) => { mount(check, h('span', { class: 'muted' }, `Getting the planner ready... ${pct}%`)); });
      const v = await engine.openSvcr(plain);
      check.className = v.ok ? '' : 'failed';
      mount(check, v.ok ? h('span', { class: 'ok-text' }, 'All 8 safety rules pass, and the plan matches the data inside the file')
        : h('span', { class: 'bad-text' }, 'This plan fails the safety check. Do not use it.'));
      runCheck.remove();
    } catch {
      mount(check, h('span', { class: 'bad-text' }, 'The check could not run on this phone.'));
      runCheck.disabled = false;
    }
  } }, icon('check'), 'Run the full safety check');
  const byDepot = depots.sort((a, b) => depotName(a).localeCompare(depotName(b))).map((g) => {
    const rows = allocs.filter((a) => a.godown_id === g);
    const byTown = new Map<string, Json[]>();
    for (const a of rows) byTown.set(a.town_id, [...(byTown.get(a.town_id) ?? []), a]);
    return h('details', { class: 'card' },
      h('summary', {}, h('strong', {}, depotName(g)), h('span', { class: 'small muted' }, ` · ${num(rows.reduce((n, a) => n + a.units, 0))} units · ${byTown.size} towns`)),
      [...byTown].map(([t, items]) => [h('h3', {}, `${townName(t)} · ${num(items.reduce((n, a) => n + a.units, 0))} units`),
        h('ul', { class: 'rows' }, items.map((a) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, a.product_id), h('span', {}, `Lot ${a.lot_id} · ${a.life_on_arrival} days left on arrival`)),
          h('div', { class: 'row-end' }, h('strong', {}, num(a.units)), h('span', {}, 'units')))))]));
  });
  const shorts: Json[] = plan.shortfalls ?? [];
  mount(root, top,
    h('section', { class: 'card verdict ok' },
      h('div', { class: 'row between' }, h('h2', {}, title), badge('Not changed', 'ok')),
      h('p', { class: 'small muted' }, `Made ${p.created_at ? new Date(p.created_at).toLocaleString() : ''}${sc.day ? ` for ${sc.day}` : ''} · ${plan.policy === 'aria' ? 'ARIA plan' : 'usual method'}`),
      h('div', { class: 'split' },
        h('div', {}, h('span', { class: 'small' }, 'Units'), h('strong', {}, num(units))),
        h('div', {}, h('span', { class: 'small' }, 'Depots → towns'), h('strong', {}, `${depots.length} → ${towns.size}`))),
      h('ul', { class: 'checks' }, h('li', {}, h('span', { class: 'ok-text' }, 'Nothing in the file was changed since it was made')), check),
      runCheck,
      h('button', { class: 'btn block', onclick: () => shareFile(name, bytes, SVCR_MIME) }, icon('share'), 'Save or share this file')),
    h('div', { class: 'section-head' }, h('h2', {}, 'What goes where')),
    byDepot.length ? byDepot : h('p', { class: 'note' }, 'Nothing to ship in this plan.'),
    shorts.length > 0 && h('details', { class: 'card' }, h('summary', {}, `Towns that will be short (${num(shorts.length)})`),
      h('ul', { class: 'rows' }, shorts.slice(0, 200).map((s) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, `${townName(s.town_id)} · ${s.product_id}`), h('span', {}, plainReason(s))),
        h('div', { class: 'row-end' }, h('strong', {}, num(s.shortfall_units)), h('span', {}, 'short')))))));
}
