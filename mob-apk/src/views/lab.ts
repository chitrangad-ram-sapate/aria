// What-if analysis: build scenarios from model inputs (demand, depot capacity, freight rates, lost stock, margin,
// route closures and truck restrictions), re-plan each on the device and compare with the baseline (the data as
// loaded). A step-by-step sweep varies one input over a range the user picks. All numbers come from engine.compare.
import { engine } from '../engine';
import { compact, hbars, kpi as kpiCard, line, seriesColor } from '../charts';
import { KPIS, chip, kpi } from '../kpis';
import { Variant, currentHash, nextRid, state } from '../state';
import { Json, badge, errorBox, h, icon, mount, num, rupees, select, table } from '../ui';
import { truck } from './network';
import { godownName, townName } from './plan';

let root: HTMLElement;
let timer = 0;
let pending = false;

const lab = state.lab;
const sc = () => state.scenario;

function longestRoute(): [string, string] | null {
  const r = [...(sc()?.routes ?? [])].filter((x: Json) => x.active).sort((a: Json, b: Json) => b.road_km - a.road_km)[0];
  return r ? [r.godown_id, r.town_id] : null;
}

const PRESETS: { name: string; params: () => Json }[] = [
  { name: 'Demand up 20%', params: () => ({ demand_pct: 20 }) },
  { name: 'Demand down 20%', params: () => ({ demand_pct: -20 }) },
  { name: 'Depots load 30% less', params: () => ({ capacity_pct: 70 }) },
  { name: 'Freight 25% dearer', params: () => ({ freight_pct: 25 }) },
  { name: 'Lose 20% of stock', params: () => ({ stock_loss_pct: 20 }) },
  { name: 'Longest route closed', params: () => ({ closures: longestRoute() ? [longestRoute()] : [] }) },
  { name: 'Blank scenario', params: () => ({}) },
];

const variantKey = () => JSON.stringify([currentHash(), lab.variants.map((v) => [v.id, v.params])]);

function addVariant(name: string, params: Json) {
  const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const taken = new Set(lab.variants.map((v) => v.name));
  let n = name, k = 2;
  while (taken.has(n)) n = `${name} (${k++})`;
  lab.variants.push({ id, name: n, params });
  lab.selected = id;
  if (lab.variants.length > 8) lab.variants.shift(); // 8 scenarios + baseline keep every chart readable
  changed();
}

function changed() {
  render(root);
  clearTimeout(timer);
  timer = window.setTimeout(compare, 700);
}

export function render(r: HTMLElement) {
  root = r;
  if (!sc()) return mount(root, h('section', { class: 'card' }, h('p', { class: 'eyebrow' }, 'No data yet'), h('p', { class: 'small' }, 'Load your CSV on Home first. Every scenario here starts from that data.')));
  const v = lab.variants.find((x) => x.id === lab.selected) ?? lab.variants[0];
  mount(root,
    h('section', { class: 'card' },
      h('p', { class: 'eyebrow' }, 'Ask "what if...?"'),
      h('p', { class: 'small' }, 'Start from your data as it is today. Each scenario changes a few things, and ARIA shows what changes in units, rupees and %.'),
      h('div', { class: 'chips', role: 'tablist', 'aria-label': 'Scenarios' },
        h('span', { class: 'chip base' }, 'Today'),
        lab.variants.map((x, i) => h('button', { class: `chip${x === v ? ' on' : ''}`, role: 'tab', 'aria-selected': String(x === v), style: `--c:${seriesColor(i + 1)}`,
          onclick: () => { lab.selected = x.id; render(root); } }, x.name))),
      h('details', { class: 'add', open: lab.variants.length === 0 }, h('summary', { class: 'btn block' }, '+ Add a scenario'),
        h('div', { class: 'preset-grid' }, PRESETS.map((p) => h('button', { class: 'btn small', onclick: () => addVariant(p.name, p.params()) }, p.name))))),
    v && editor(v),
    h('section', { class: 'card', 'aria-live': 'polite' },
      h('div', { class: 'row between' }, h('h2', {}, 'Compare with today'),
        lab.busy ? badge('Re-planning...', 'warn') : lab.result && lab.result.key !== variantKey() ? badge('Out of date', 'bad') : lab.result ? badge('Up to date', 'ok') : null),
      h('button', { class: 'btn primary block', disabled: lab.busy || !lab.variants.length || !state.report?.valid || state.validating, onclick: compare },
        lab.busy ? 'Re-planning on this phone...' : lab.variants.length ? `Compare ${lab.variants.length} scenario${lab.variants.length > 1 ? 's' : ''}` : 'Add a scenario to compare'),
      !state.report?.valid && !state.validating && h('p', { class: 'note' }, 'Your data has problems (see Home). Fix them to run scenarios.'),
      lab.error && errorBox(lab.error)),
    results(),
    sweepCard());
}

export function update() {
  if (root) render(root);
}

// ---------- scenario editor ----------
function slider(labelText: string, value: number, min: number, max: number, step: number, unit: string, set: (v: number) => void, hint?: string) {
  const out = h('strong', {}, `${value > 0 && unit === '%' && min < 0 ? '+' : ''}${value}${unit}`);
  const rng = h('input', { type: 'range', min, max, step, value, 'aria-label': labelText,
    oninput: (e: Event) => { out.textContent = `${(e.target as HTMLInputElement).value}${unit}`; },
    onchange: (e: Event) => set(Number((e.target as HTMLInputElement).value)) });
  const box = h('input', { type: 'number', min, max, step, value, class: 'num', 'aria-label': `${labelText} value`,
    onchange: (e: Event) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) set(Math.min(max, Math.max(min, n))); } });
  return h('div', { class: 'ctl' }, h('div', { class: 'row between' }, h('span', {}, labelText), out), h('div', { class: 'row' }, rng, box), hint && h('p', { class: 'note' }, hint));
}

function editor(v: Variant) {
  const s = sc(), p = v.params;
  const set = (k: string) => (val: any) => { p[k] = val; changed(); };
  const products: [string, string][] = [['*', 'All products'], ...s.products.map((x: Json): [string, string] => [x.product_id, x.product_id])];
  const towns: [string, string][] = [['*', 'All towns'], ...s.towns.map((x: Json): [string, string] => [x.town_id, x.name || x.town_id])];
  const depots: [string, string][] = [['*', 'All depots'], ...s.godowns.map((x: Json): [string, string] => [x.godown_id, x.name || x.godown_id])];
  const anyCap = s.godowns.some((g: Json) => g.dispatch_capacity_units != null);
  const margin = s.policy?.margin ?? 0.035;
  return h('section', { class: 'card editor' },
    h('label', {}, 'Scenario name',
      h('input', { type: 'text', value: v.name, class: 'name', 'aria-label': 'Scenario name', onchange: (e: Event) => { v.name = (e.target as HTMLInputElement).value.trim() || v.name; render(root); } })),
    h('div', { class: 'row editor-actions' },
        h('button', { class: 'btn small', onclick: () => addVariant(`${v.name} copy`, structuredClone(p)) }, 'Copy'),
        h('button', { class: 'btn small', onclick: () => { v.params = {}; changed(); } }, 'Reset'),
        h('button', { class: 'btn small danger', onclick: () => { lab.variants = lab.variants.filter((x) => x !== v); lab.selected = lab.variants[0]?.id ?? ''; changed(); } }, 'Delete')),
    h('h3', {}, 'Demand'),
    slider('Change in demand', p.demand_pct ?? 0, -90, 200, 5, '%', set('demand_pct')),
    h('div', { class: 'grid2' }, select(products, p.demand_product ?? '*', set('demand_product'), 'Demand change applies to product'),
      select(towns, p.demand_town ?? '*', set('demand_town'), 'Demand change applies to town')),
    h('h3', {}, 'Depot loading capacity'),
    slider('Capacity', p.capacity_pct ?? 100, 0, 200, 5, '%', set('capacity_pct'),
      anyCap ? 'Percent of each depot\'s capacity in your data (depots with no limit: of what they ship today).' : 'Your depots have no loading limit, so this is a percent of what each one ships today.'),
    select(depots, p.capacity_depot ?? '*', set('capacity_depot'), 'Capacity change applies to depot'),
    h('h3', {}, 'Costs and stock'),
    slider('Change in freight rates', p.freight_pct ?? 0, -50, 200, 5, '%', set('freight_pct'), `Now: ${Object.entries(s.policy?.freight_paise_per_tkm ?? {}).map(([k, r]) => `${truck(k)} ₹${(Number(r) / 100).toFixed(2)}/t-km`).join(' · ')}`),
    slider('Stock lost (damage, theft, recall)', p.stock_loss_pct ?? 0, 0, 100, 5, '%', set('stock_loss_pct')),
    h('div', { class: 'grid2' }, select(depots, p.stock_depot ?? '*', set('stock_depot'), 'Stock loss at depot'), select(products, p.stock_product ?? '*', set('stock_product'), 'Stock loss of product')),
    slider('Trade margin', Math.round((p.margin ?? margin) * 1000) / 10, 0, 50, 0.5, '%', (x) => { p.margin = x / 100; changed(); }, `Your data: ${(margin * 100).toFixed(1)}%. Higher margin makes each lost sale cost more.`),
    h('h3', {}, 'Routes'),
    routeChanges(v));
}

function routeChanges(v: Variant) {
  const s = sc(), p = v.params;
  const list: Json[] = [...(p.closures ?? []).map((c: string[]) => ({ kind: 'close', g: c[0], t: c[1] })), ...(p.restrictions ?? []).map((r: string[]) => ({ kind: 'restrict', g: r[0], t: r[1], v: r[2] }))];
  const box = h('div', {});
  let g = s.godowns[0]?.godown_id ?? '', t = '', kind = 'close', veh = '';
  let options: string[] = [];
  const townsFor = (gid: string): [string, string][] => s.routes.filter((r: Json) => r.godown_id === gid).map((r: Json): [string, string] => [r.town_id, townName(r.town_id)]);
  const draw = async () => {
    const ts = townsFor(g);
    if (!ts.some(([id]: [string, string]) => id === t)) t = ts[0]?.[0] ?? '';
    options = t ? await engine.vehicleOptions(s, g, t) : [];
    if (!options.includes(veh)) veh = options[0] ?? '';
    const route = s.routes.find((r: Json) => r.godown_id === g && r.town_id === t);
    mount(box,
      h('div', { class: 'grid2' },
        select(s.godowns.map((x: Json): [string, string] => [x.godown_id, x.name || x.godown_id]), g, (x) => { g = x; draw(); }, 'Route from depot'),
        select(ts, t, (x) => { t = x; draw(); }, 'Route to town'),
        select([['close', 'Close this route'], ['restrict', 'Allow only smaller trucks']], kind, (x) => { kind = x; draw(); }, 'Route change'),
        kind === 'restrict' && (options.length ? select(options.map((o): [string, string] => [o, truck(o)]), veh, (x) => { veh = x; }, 'Largest truck allowed') : h('span', {}))),
      kind === 'restrict' && !options.length && h('p', { class: 'note' }, 'This route already uses the smallest truck. Pick another route, or close this one instead.'),
      kind === 'restrict' && options.length > 0 && h('p', { class: 'note' }, `Now: ${truck(route.vehicle_class)}.`),
      h('button', { class: 'btn small block', disabled: !t || (kind === 'restrict' && !veh), onclick: () => {
        if (kind === 'close') p.closures = [...(p.closures ?? []).filter((c: string[]) => !(c[0] === g && c[1] === t)), [g, t]];
        else p.restrictions = [...(p.restrictions ?? []).filter((c: string[]) => !(c[0] === g && c[1] === t)), [g, t, veh]];
        changed();
      } }, 'Add route change'));
  };
  draw();
  return [
    list.length ? h('ul', { class: 'rows' }, list.map((c) => h('li', {},
      h('div', { class: 'row-main' }, h('strong', {}, `${godownName(c.g)} → ${townName(c.t)}`), h('span', {}, c.kind === 'close' ? 'Route closed' : `Only ${truck(c.v).toLowerCase()}`)),
      h('button', { class: 'btn small ghost', 'aria-label': 'Remove route change', onclick: () => {
        if (c.kind === 'close') p.closures = p.closures.filter((x: string[]) => !(x[0] === c.g && x[1] === c.t));
        else p.restrictions = p.restrictions.filter((x: string[]) => !(x[0] === c.g && x[1] === c.t));
        changed();
      } }, 'Remove')))) : h('p', { class: 'note' }, 'No route changes in this scenario.'),
    box];
}

// ---------- compare ----------
async function compare() {
  clearTimeout(timer);
  if (!sc() || !lab.variants.length || !state.report?.valid || state.validating) return;
  if (lab.busy) { pending = true; return; }
  const my = nextRid();
  const key = variantKey();
  lab.busy = true;
  lab.error = '';
  render(root);
  try {
    const r = await engine.compare(sc(), lab.variants.map((v) => ({ id: v.id, name: v.name, params: v.params })));
    if (r.valid === false) lab.error = 'Your data needs fixing on Home first.';
    else lab.result ={ rid: my, resp: r, key };
  } catch (e: any) {
    lab.error = 'The comparison did not work. Please try again.';
  } finally {
    lab.busy = false;
    if (pending) { pending = false; window.setTimeout(compare, 0); }
    render(root);
  }
}

export function comparisonCharts(resp: Json) {
  const rows: Json[] = [resp.baseline, ...resp.variants.filter((v: Json) => !v.error)];
  const cats = rows.map((r) => r.name);
  const colour = (i: number) => (i === 0 ? seriesColor(0) : seriesColor(1 + Math.max(0, lab.variants.findIndex((v) => v.id === rows[i].id))));
  const metric = (key: string, title: string, scale = 1) => {
    const k = kpi(key);
    return hbars(title, cats, [{ name: k.label, values: rows.map((r) => (r.kpis[key] == null ? null : r.kpis[key] * scale)) }],
      (v) => k.fmt(v / scale), `${k.label} (${k.unit})`, k.lowerIsBetter ? 'Lower is better' : 'Higher is better');
  };
  const changeKeys = KPIS.filter((k) => rows.slice(1).some((r) => r.diff?.[k.key]?.pct != null));
  return [
    h('div', { class: 'viz-grid' },
      metric('expected_fill_rate', 'Demand met', 100),
      metric('expected_lost_margin_paise', 'Lost sales value'),
      metric('freight_paise', 'Freight cost'),
      metric('units_shipped', 'Units shipped')),
    rows.length > 1 && changeKeys.length > 0 && hbars('Change from today (%)', changeKeys.map((k) => k.label),
      rows.slice(1).map((r, i) => ({ name: r.name, values: changeKeys.map((k) => r.diff?.[k.key]?.pct ?? null), color: colour(i + 1) })),
      (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`, '% change', 'Bars right of 0 are increases. Whether that is good depends on the measure (see table).'),
    hbars('Units loaded per depot', resp.baseline.depots.map((d: Json) => d.name),
      rows.map((r, i) => ({ name: r.name, values: r.depots.map((d: Json) => d.shipped), color: colour(i) })), num, 'units'),
  ];
}

function results() {
  const res = lab.result;
  if (!res) return lab.busy ? h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Planning today and every scenario...')) : null;
  const resp = res.resp, base = resp.baseline;
  const ok: Json[] = resp.variants.filter((v: Json) => !v.error);
  const failed: Json[] = resp.variants.filter((v: Json) => v.error);
  const best = (key: string, max: boolean) => {
    const all = [base, ...ok].filter((r) => r.kpis[key] != null);
    if (all.length < 2) return null;
    const pick = all.reduce((a, b) => ((max ? b.kpis[key] > a.kpis[key] : b.kpis[key] < a.kpis[key]) ? b : a));
    return h('li', {}, h('span', {}, `${kpi(key).label}: `), h('strong', {}, pick.name), h('span', { class: 'muted' }, ` (${kpi(key).fmt(pick.kpis[key])})`));
  };
  const stale = res.key !== variantKey();
  return h('div', { class: stale ? 'stale' : '' },
    failed.map((f) => errorBox(`${f.name}: this scenario could not be planned. Check its route changes.`)),
    h('section', { class: 'card' }, h('h2', {}, 'Which option does best?'),
      h('ul', { class: 'best' }, best('expected_fill_rate', true), best('expected_lost_margin_paise', false), best('freight_paise', false), best('at_risk_units_left', false)),
      h('p', { class: 'note' }, 'These are forecasts for each scenario, not real results.')),
    h('div', { class: 'section-head' }, h('h2', {}, 'Each scenario against today')),
    ok.map((v) => h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('strong', {}, v.name), v.verified ? badge('Verified plan', 'ok') : badge('Not verified', 'bad')),
      v.recommended !== 'aria' && h('p', { class: 'note' }, 'ARIA could not make a safe plan here, so the usual method is shown.'),
      h('div', { class: 'kpi-grid' }, KPIS.filter((k) => v.kpis[k.key] != null).slice(0, 6).map((k) => kpiCard(k.label, k.fmt(v.kpis[k.key]), `today ${k.fmt(base.kpis[k.key])}`, chip(v.diff[k.key], k)))))),
    h('section', { class: 'card' }, h('h2', {}, 'Charts'), comparisonCharts(resp)),
    h('details', { class: 'card' }, h('summary', {}, 'Full comparison table'),
      table(KPIS.filter((k) => base.kpis[k.key] != null).map((k) => Object.fromEntries([['m', k.label], ['b', k.fmt(base.kpis[k.key])],
        ...ok.map((v, i) => [`v${i}`, v.kpis[k.key] == null ? '-' : `${k.fmt(v.kpis[k.key])} (${v.diff[k.key]?.pct == null ? k.diff(v.diff[k.key]?.abs ?? 0) : `${v.diff[k.key].pct > 0 ? '+' : ''}${v.diff[k.key].pct.toFixed(1)}%`})`])])),
        [['m', 'Measure'], ['b', 'Today'], ...ok.map((v, i): [string, string] => [`v${i}`, v.name])])));
}

// ---------- step-by-step sweep ----------
const SWEEP: Record<string, { label: string; from: number; to: number; unit: string }> = {
  demand_pct: { label: 'Change in demand', from: -20, to: 40, unit: '%' },
  capacity_pct: { label: 'Depot capacity', from: 50, to: 120, unit: '% of today' },
  freight_pct: { label: 'Change in freight rates', from: 0, to: 100, unit: '%' },
  stock_loss_pct: { label: 'Stock lost', from: 0, to: 50, unit: '%' },
};
let sweepParam = 'demand_pct';
let sweepFrom = SWEEP.demand_pct.from, sweepTo = SWEEP.demand_pct.to, sweepSteps = 7;

function sweepCard() {
  const cfg = SWEEP[sweepParam];
  const sw = lab.sweep;
  const nums = (v: number, set: (n: number) => void, l: string, min = -100, max = 300) => h('label', { class: 'mini' }, l,
    h('input', { type: 'number', value: v, min, max, 'aria-label': l, onchange: (e: Event) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) set(n); } }));
  return h('section', { class: 'card' },
    h('h2', {}, 'Step by step: one change over a range'),
    h('p', { class: 'small muted' }, 'Pick one thing to change, a range and how many steps, and see how the results move.'),
    select(Object.entries(SWEEP).map(([k, c]): [string, string] => [k, c.label]), sweepParam, (k) => { sweepParam = k; sweepFrom = SWEEP[k].from; sweepTo = SWEEP[k].to; render(root); }, 'Input to vary'),
    h('div', { class: 'grid3' },
      nums(sweepFrom, (n) => { sweepFrom = n; }, `From (${cfg.unit})`),
      nums(sweepTo, (n) => { sweepTo = n; }, `To (${cfg.unit})`),
      nums(sweepSteps, (n) => { sweepSteps = Math.round(n); }, 'Steps (2-12)', 2, 12)),
    h('button', { class: 'btn block', disabled: lab.sweepBusy || !state.report?.valid, onclick: runSweep }, icon('chart'), lab.sweepBusy ? 'Planning each step...' : 'Run steps'),
    sw && sw.key === JSON.stringify([currentHash(), sw.param, sw.values]) ? sweepCharts(sw) : sw ? h('p', { class: 'note' }, 'Inputs changed since the last run. Run the steps again.') : null);
}

async function runSweep() {
  const steps = Math.min(12, Math.max(2, sweepSteps));
  const lo = Math.min(sweepFrom, sweepTo), hi = Math.max(sweepFrom, sweepTo);
  if (sweepParam === 'demand_pct' && lo < -90) {
    lab.error = 'Demand cannot fall more than 90%.';
    return render(root);
  }
  const values = [...new Set(Array.from({ length: steps }, (_, i) => Math.round((lo + ((hi - lo) * i) / (steps - 1)) * 10) / 10))];
  const neutral = sweepParam === 'capacity_pct' ? 100 : 0;
  lab.sweepBusy = true;
  render(root);
  try {
    const r = await engine.compare(sc(), values.map((v) => ({ id: String(v), name: `${v}`, params: v === neutral ? {} : { [sweepParam]: v } })));
    if (r.valid === false) lab.error = 'Your data needs fixing on Home first.';
    else lab.sweep = { param: sweepParam, values, resp: r, key: JSON.stringify([currentHash(), sweepParam, values]) };
  } catch (e: any) {
    lab.error = 'The steps did not work. Please try again.';
  } finally {
    lab.sweepBusy = false;
    render(root);
  }
}

export function sweepCharts(sw: { param: string; values: number[]; resp: Json }) {
  const cfg = SWEEP[sw.param];
  const rows: Json[] = sw.resp.variants;
  const xs = sw.values.map((v) => `${v}`);
  const val = (key: string, scale = 1) => rows.map((r) => (r.error || r.kpis[key] == null ? null : r.kpis[key] * scale));
  const failed = rows.filter((r) => r.error);
  return [
    failed.length > 0 && h('p', { class: 'note' }, `${failed.length} step(s) could not be planned.`),
    h('div', { class: 'viz-grid' },
      line('Demand met', xs, [{ name: 'Fill rate', values: val('expected_fill_rate', 100) }], (v) => `${v.toFixed(1)}%`, `${cfg.label} (${cfg.unit})`, 'Fill rate (%)'),
      line('Lost sales value', xs, [{ name: 'Lost sales', values: val('expected_lost_margin_paise', 0.01) }], (v) => `₹${compact(v)}`, `${cfg.label} (${cfg.unit})`, 'Lost sales value (₹)'),
      line('Freight cost', xs, [{ name: 'Freight', values: val('freight_paise', 0.01) }], (v) => rupees(v * 100), `${cfg.label} (${cfg.unit})`, 'Freight (₹)'),
      line('Units shipped and short', xs, [{ name: 'Shipped', values: val('units_shipped') }, { name: 'Short', values: val('shortfall_units') }], num, `${cfg.label} (${cfg.unit})`, 'Units')),
    h('p', { class: 'note' }, `Today: demand met ${kpi('expected_fill_rate').fmt(sw.resp.baseline.kpis.expected_fill_rate)}, freight ${rupees(sw.resp.baseline.kpis.freight_paise)}. These are forecasts, not real results.`),
  ];
}

