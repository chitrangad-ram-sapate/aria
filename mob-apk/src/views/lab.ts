// Disruption Lab: pick a shock (default: ROUTE_RESTRICTION on the network's demo leg), re-plan,
// show before/after KPIs, the diff and τ* before/after.
import { engine } from '../engine';
import { currentHash, network, nextRid, state } from '../state';
import { Json, errorBox, fmt, h, label, mount, num, pagedTable, select, table } from '../ui';
import { metricsTable, resultHeader } from './plan';

const SHOCKS: [string, string][] = [['ROUTE_RESTRICTION', 'Heavy trucks banned on a route'], ['ROUTE_CLOSURE', 'A route is closed'], ['INVENTORY_LOSS', 'Stock lost at a depot'], ['FESTIVAL_SPIKE', 'Festival demand spike']];
let shock: Json = null;
let shockFor = '';
let root: HTMLElement;
let out: HTMLElement;

function defaultLeg(sc: Json): [string, string] {
  const demo = network().demo_route ?? {};
  const routes = sc.routes ?? [];
  const pool = routes.filter((r: Json) => r.town_id === demo.town_id && (demo.godown_id == null || r.godown_id === demo.godown_id));
  const pick = [...(pool.length ? pool : routes)].sort((a: Json, b: Json) => (b.road_km ?? 0) - (a.road_km ?? 0) || a.godown_id.localeCompare(b.godown_id))[0];
  return pick ? [pick.godown_id, pick.town_id] : [sc.godowns[0]?.godown_id, sc.towns[0]?.town_id];
}

function resetShock() {
  const [g, t] = defaultLeg(state.scenario);
  shock = { type: 'ROUTE_RESTRICTION', godown_id: g, town_id: t, product_id: '*', pct: 30, max_vehicle: '6t' };
  shockFor = state.scenarioId;
}

/** The shock as sent to the engine: only the fields its type uses. */
function payload(): Json {
  const s: Json = { type: shock.type };
  if (shock.type !== 'FESTIVAL_SPIKE') s.godown_id = shock.godown_id;
  if (shock.type !== 'INVENTORY_LOSS') s.town_id = shock.town_id;
  if (shock.type === 'ROUTE_RESTRICTION') s.max_vehicle = shock.max_vehicle;
  if (shock.type === 'INVENTORY_LOSS' || shock.type === 'FESTIVAL_SPIKE') { s.product_id = shock.product_id; s.pct = shock.pct; }
  return s;
}

const key = () => JSON.stringify([currentHash(), payload()]);

export function render(r: HTMLElement) {
  root = r;
  const sc = state.scenario;
  if (!sc) return mount(root, h('p', { class: 'muted' }, 'Loading...'));
  if (!shock || shockFor !== state.scenarioId) resetShock();
  out = h('div', {});
  const ids = (xs: Json[], k: string) => xs.map((x): [string, string] => [x[k], x[k]]);
  const set = (k: string) => (v: string) => { shock[k] = v; render(root); };
  const t = shock.type;
  mount(root,
    h('section', { class: 'card' },
      h('p', { class: 'eyebrow' }, 'Something went wrong on the road or in a depot?'),
      h('p', { class: 'small muted' }, 'Pick what happened. ARIA re-plans on this phone and shows exactly what changes.'),
      h('div', { class: 'grid2' },
        h('label', {}, 'What happened', select(SHOCKS, t, set('type'), 'What happened')),
        t !== 'FESTIVAL_SPIKE' && h('label', {}, 'Depot', select(sc.godowns.map((g: Json): [string, string] => [g.godown_id, g.name || g.godown_id]), shock.godown_id, set('godown_id'), 'Depot')),
        t !== 'INVENTORY_LOSS' && h('label', {}, 'Town', select(sc.towns.map((x: Json): [string, string] => [x.town_id, x.name || x.town_id]), shock.town_id, set('town_id'), 'Town')),
        t === 'ROUTE_RESTRICTION' && h('label', {}, 'Largest truck allowed', select([['6t', '6 tonne']], shock.max_vehicle, set('max_vehicle'), 'Largest truck allowed')),
        (t === 'INVENTORY_LOSS' || t === 'FESTIVAL_SPIKE') && h('label', {}, 'Product', select([['*', 'All products'], ...ids(sc.products, 'product_id')], shock.product_id, set('product_id'), 'Product')),
        (t === 'INVENTORY_LOSS' || t === 'FESTIVAL_SPIKE') && h('label', {}, `Percent: ${shock.pct}%`,
          h('input', { type: 'range', min: 0, max: 100, value: shock.pct, 'aria-label': 'Percent', onchange: (e: Event) => { shock.pct = Number((e.target as HTMLInputElement).value); render(root); } }))),
      h('button', { class: 'btn primary block', disabled: state.whatifBusy || !state.report?.valid || state.validating, onclick: run }, state.whatifBusy ? 'Re-planning on this phone...' : 'See the new plan'),
      state.whatifError && errorBox(state.whatifError)),
    out);
  drawResult();
}

export function update() {
  if (root) render(root);
}

async function run() {
  const my = nextRid();
  state.whatifRid = my;
  state.whatifBusy = true;
  state.whatifError = '';
  const k = key();
  render(root);
  try {
    const t0 = performance.now();
    const r = await engine.whatif(state.scenario, [payload()]);
    if (my !== state.whatifRid) return;
    if (r.valid === false) state.whatifError = (r.errors ?? []).map((e: Json) => `${e.code} ${e.path}: ${e.message}`).join('\n');
    else state.whatif = { rid: my, resp: { ...r, elapsed_ms: Math.round(performance.now() - t0) }, key: k };
  } catch (e: any) {
    if (my === state.whatifRid) state.whatifError = `What-if failed: ${e.message}`;
  } finally {
    if (my === state.whatifRid) state.whatifBusy = false;
    render(root);
  }
}

function drawResult() {
  const w = state.whatif;
  if (!w) return;
  const resp = w.resp;
  const stale = w.key !== key();
  const before = resp.before ?? {}, after = resp.after ?? {};
  const shown = payload();
  const tc: Json[] = resp.tau_changes ?? [];
  const leg = tc.filter((r) => r.godown_id === shown.godown_id && r.town_id === shown.town_id);
  const rows = (leg.length ? leg : tc).slice().sort((a, b) => Math.abs((b.before ?? 0) - (b.after ?? 0)) - Math.abs((a.before ?? 0) - (a.after ?? 0)));
  mount(out, h('section', { class: `card result${stale ? ' stale' : ''}` },
    h('h2', {}, 'What changes'),
    resultHeader(resp, w.rid, stale, [`re-plan ${num(resp.elapsed_ms)} ms`]),
    metricsTable([['ARIA before', before.aria], ['ARIA after', after.aria], ['(a) before', before.baseline_a], ['(a) after', after.baseline_a]]),
    ['aria', 'baseline_a'].map((n) => diffBlock(n === 'aria' ? 'ARIA' : 'Usual method (a)', resp.diff?.[n])),
    h('h3', {}, 'Service level on the affected route (τ*)'),
    rows.length ? [tauChart(rows.slice(0, 30)), h('p', { class: 'muted small' }, 'Between the two dots, units stop being worth sending on this route: the freight now costs more than the sale they protect.'),
      pagedTable(rows, [['godown_id', 'Godown'], ['town_id', 'Town'], ['product_id', 'Product'], ['before', 'τ* before'], ['after', 'τ* after'],
        ['freight_before_paise', 'Freight/unit before'], ['freight_after_paise', 'Freight/unit after']], undefined, 20)]
      : h('p', { class: 'muted' }, 'No τ* changes.'),
  ));
}

function diffBlock(title: string, d: Json) {
  if (!d) return h('div', {}, h('h3', {}, title), h('p', { class: 'muted' }, 'No diff (one side has no plan).'));
  const scalars = Object.entries(d).filter(([, v]) => v == null || typeof v !== 'object');
  return h('div', {}, h('h3', {}, title),
    h('div', { class: 'stats' }, scalars.map(([k, v]) => h('div', { class: 'stat' }, h('span', { class: 'muted small' }, label(k)), h('strong', {}, fmt(k, v))))),
    d.changed_rows?.length > 0 && h('details', {}, h('summary', {}, `Changed rows (${num(d.changed_rows.length)})`),
      pagedTable(d.changed_rows, [['godown_id', 'Godown'], ['town_id', 'Town'], ['product_id', 'Product'], ['lot_id', 'Lot'], ['before_units', 'Before'], ['after_units', 'After']], undefined, 20)),
    d.new_reason_codes?.length > 0 && h('details', {}, h('summary', {}, `New reason codes (${num(d.new_reason_codes.length)})`),
      table(d.new_reason_codes, [['town_id', 'Town'], ['product_id', 'Product'], ['reason', 'Reason'], ['sub_reason', 'Detail', (v) => v ?? '']])));
}

function tauChart(rows: Json[]) {
  const W = 340, rowH = 22, left = 110, right = 12, top = 22;
  const x = (v: number) => left + Math.max(0, Math.min(1, v)) * (W - left - right);
  const svgNS = 'http://www.w3.org/2000/svg';
  const el = (tag: string, a: Record<string, any>, text?: string) => {
    const n = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(a)) n.setAttribute(k, String(v));
    if (text) n.textContent = text;
    return n;
  };
  const H = top + rows.length * rowH + 8;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tau', role: 'img', 'aria-label': 'τ* before and after per product on the shocked leg' });
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(el('line', { x1: x(t), x2: x(t), y1: top - 6, y2: H - 6, class: 'grid' }), el('text', { x: x(t), y: 12, 'text-anchor': 'middle', class: 'axis' }, String(t)));
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    svg.append(el('text', { x: left - 6, y: y + 4, 'text-anchor': 'end', class: 'axis' }, r.product_id));
    if (r.before != null && r.after != null) svg.append(el('line', { x1: x(r.before), x2: x(r.after), y1: y, y2: y, class: 'link' }));
    if (r.before != null) svg.append(el('circle', { cx: x(r.before), cy: y, r: 5, class: 'before' }, ''));
    if (r.after != null) svg.append(el('circle', { cx: x(r.after), cy: y, r: 5, class: 'after' }, ''));
  });
  return h('figure', { class: 'chart' }, svg as unknown as Node,
    h('figcaption', { class: 'row small' }, h('span', { class: 'dot before' }), 'before', h('span', { class: 'dot after' }), 'after'));
}
