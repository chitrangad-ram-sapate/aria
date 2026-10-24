// Plan view: scenario picker, editable godown stock, "Plan tonight", KPIs vs baseline (a),
// impact on the statement's three goals, allocations, shortfalls with reason codes, excess stock,
// demand forecasts, explain sheet, .svcr export, pick lists and on-device CSV import.
import { engine } from '../engine';
import { SVCR_MIME, shareFile } from '../native';
import { currentHash, forecastLabel, isStale, loadScenario, nextRid, notify, rerender, scheduleValidate, state } from '../state';
import { Json, badge, bandBar, errorBox, fmt, h, kv, label, mount, num, openSheet, pagedTable, rupees, segmented, select, short, table, toast } from '../ui';

let show: 'aria' | 'baseline_a' = 'aria';
let sub: 'alloc' | 'short' | 'excess' | 'forecast' | 'pick' = 'alloc';
let importing = false;
const replays: Record<string, Json> = {};
let godownFilter = '';
let search = '';
let stockOpen = false;
let stockBox: HTMLElement;
let statusBox: HTMLElement;
let resultBox: HTMLElement;

export function render(root: HTMLElement) {
  stockBox = h('div', {});
  statusBox = h('div', { class: 'card', 'aria-live': 'polite' });
  resultBox = h('div', {});
  mount(root, h('h1', {}, 'Plan'), pickers(), statusBox, resultBox,
    h('details', { class: 'card stock', open: stockOpen, ontoggle: (e: Event) => { stockOpen = (e.target as HTMLDetailsElement).open; } },
      h('summary', {}, 'Godown stock (edit)'), stockBox));
  drawStock();
  update();
}

export function update() {
  if (!statusBox) return;
  drawStatus();
  drawResult();
}

function pickers() {
  const nets = state.networks.filter((n) => state.scenarios.some((s) => s.network_id === n.network_id))
    .map((n): [string, string] => [n.network_id, n.name || n.network_id]);
  const scs = state.scenarios.filter((s) => s.network_id === state.networkId).map((s): [string, string] => [s.scenario_id, s.scenario_id.replace(/_/g, ' ')]);
  return h('section', { class: 'card grid2' },
    h('label', {}, 'Network', select(nets, state.networkId, async (v) => {
      state.networkId = v;
      const first = state.scenarios.find((s) => s.network_id === v);
      if (first) await loadScenario(first.scenario_id);
    }, 'Network')),
    h('label', {}, 'Scenario', select(scs, state.scenarioId, (v) => loadScenario(v), 'Scenario')),
    h('div', {},
      h('input', { type: 'file', accept: '.csv,text/csv', id: 'csv-file', class: 'visually-hidden', onchange: (e: Event) => importCsv(e.target as HTMLInputElement) }),
      h('label', { for: 'csv-file', class: 'btn', role: 'button', tabIndex: 0 }, importing ? 'Forecasting on device...' : 'Import sales CSV'),
      h('p', { class: 'muted small' }, 'Columns: date, item, outlet/town, qty, price. Forecasts the next day for matching towns and products.')),
    importInfo(),
  );
}

function importInfo() {
  const i = state.importInfo;
  if (!i) return null;
  return h('div', { class: 'small' }, badge(i.method === 'ml' ? 'model forecast' : 'statistical fallback', i.method === 'ml' ? 'ok' : 'warn'),
    h('p', {}, `${i.label}. ${num(i.pairs)} town-product pairs, ${i.first} to ${i.last} (${num(i.days)} days), forecast for ${i.forecast_day}, ${i.seconds} s.`),
    i.note && h('p', { class: 'muted' }, `Fallback reason: ${i.note}`),
    h('p', { class: 'muted' }, `Rows used ${num(i.counts.used)} of ${num(i.counts.rows)}; unknown town ${num(i.counts.unknown_town)}, unknown item ${num(i.counts.unknown_item)}, bad value ${num(i.counts.bad_value)}.`));
}

async function importCsv(input: HTMLInputElement) {
  const f = input.files?.[0];
  input.value = '';
  if (!f || !state.scenario) return;
  importing = true;
  rerender();
  try {
    const r = await engine.importCsv(await f.text(), state.scenario);
    if (!r.ok) {
      toast(`Import failed: ${r.error}`);
    } else {
      const { scenario, ...info } = r;
      state.scenario = scenario;
      state.importInfo = info;
      state.imported = new Set(scenario.demand.slice(-r.pairs).map((d: Json) => `${d.town_id}|${d.product_id}`));
      state.plan = null;
      state.whatif = null;
      scheduleValidate(0);
    }
  } catch (e: any) {
    toast(`Import failed: ${e.message}`);
  }
  importing = false;
  rerender();
}

function setLot(i: number, key: string, raw: string) {
  const lot = state.scenario.lots[i];
  lot[key] = /^-?\d+$/.test(raw.trim()) ? Number(raw) : raw; // non-integers are reported by validate (E_TYPE)
  scheduleValidate();
}

function drawStock() {
  const sc = state.scenario;
  if (!sc) return mount(stockBox, h('p', { class: 'muted' }, 'Loading scenario...'));
  const godowns = sc.godowns.map((g: Json): [string, string] => [g.godown_id, g.name || g.godown_id]);
  const list = h('div', {});
  const draw = () => {
    const q = search.trim().toLowerCase();
    const rows = sc.lots.map((l: Json, i: number) => ({ l, i }))
      .filter(({ l }: Json) => (!godownFilter || l.godown_id === godownFilter) && (!q || `${l.lot_id} ${l.product_id}`.toLowerCase().includes(q)));
    let n = 15;
    const paint = () => mount(list,
      h('p', { class: 'muted small' }, `${num(rows.length)} lots`),
      h('ul', { class: 'lots' }, rows.slice(0, n).map(({ l, i }: Json) => h('li', {},
        h('div', { class: 'lot-id' }, h('strong', {}, l.product_id), h('span', { class: 'muted small' }, `${l.godown_id} · ${l.lot_id}`)),
        h('label', { class: 'mini' }, 'Units', h('input', { type: 'text', inputMode: 'numeric', value: String(l.qty_units), 'aria-label': `Units for ${l.lot_id}`, oninput: (e: Event) => setLot(i, 'qty_units', (e.target as HTMLInputElement).value) })),
        h('label', { class: 'mini' }, 'Life (d)', h('input', { type: 'text', inputMode: 'numeric', value: String(l.remaining_life_days), 'aria-label': `Remaining life days for ${l.lot_id}`, oninput: (e: Event) => setLot(i, 'remaining_life_days', (e.target as HTMLInputElement).value) })),
      ))),
      rows.length > n && h('button', { class: 'btn ghost', onclick: () => { n += 50; paint(); } }, `Show more (${num(rows.length - n)} left)`));
    paint();
  };
  mount(stockBox,
    h('p', { class: 'muted small' }, `${sc.scenario_id} · day ${sc.day} · ${sc.godowns.length} godowns, ${sc.towns.length} towns, ${sc.products.length} products`),
    h('div', { class: 'grid2' },
      select([['', 'All godowns'], ...godowns], godownFilter, (v) => { godownFilter = v; draw(); }, 'Filter by godown'),
      h('input', { type: 'search', placeholder: 'Search lot or product', value: search, 'aria-label': 'Search lots', oninput: (e: Event) => { search = (e.target as HTMLInputElement).value; draw(); } })),
    list);
  draw();
}

function issues(report: Json) {
  const errs = report?.errors ?? [], warns = report?.warnings ?? [];
  return [
    errs.length > 0 && h('div', { class: 'alert bad', role: 'alert' }, `${errs.length} validation error(s). No plan can be produced until they are fixed.`,
      table(errs, [['code', 'Code'], ['path', 'Path'], ['message', 'Message']])),
    warns.length > 0 && h('details', {}, h('summary', {}, `${warns.length} warning(s)`), table(warns, [['code', 'Code'], ['path', 'Path'], ['message', 'Message']])),
  ];
}

function drawStatus() {
  const r = state.report;
  const valid = !state.validating && r?.valid;
  mount(statusBox,
    h('div', { class: 'row' },
      state.validating ? badge('Validating...', 'warn') : valid ? badge('Inputs valid', 'ok') : badge('Inputs invalid', 'bad'),
      badge(`scenario_hash ${short(currentHash())}`)),
    !state.validating && issues(r),
    h('button', { class: 'btn primary block', disabled: !valid || state.planBusy, onclick: planTonight }, state.planBusy ? 'Solving on device...' : 'Plan tonight'),
    state.planError && errorBox(state.planError));
}

async function planTonight() {
  const my = nextRid();
  state.planRid = my;
  state.planBusy = true;
  state.planError = '';
  notify();
  try {
    const r = await engine.plan(state.scenario);
    if (my !== state.planRid) return; // a newer request superseded this one
    if (r.valid === false) {
      state.report = r;
      state.plan = null;
    } else {
      state.plan = { rid: my, resp: r };
      show = r.aria ? 'aria' : 'baseline_a';
    }
  } catch (e: any) {
    if (my === state.planRid) state.planError = `Plan failed: ${e.message}`;
  } finally {
    if (my === state.planRid) state.planBusy = false;
    notify();
  }
}

export function planLabel(p: Json, name: string) {
  if (!p) return `${name}: withheld`;
  const v = p.verifier ?? {};
  return `${name}: stage 1 ${p.stage1_status} · stage 2 ${p.stage2_status} · ${v.passed ? 'verified' : `verifier FAILED (${(v.violations ?? []).length})`}${p.label ? ` · ${p.label}` : ''}`;
}

export function metricsTable(plans: [string, Json][]) {
  const keys: string[] = [];
  for (const [, p] of plans) for (const k of Object.keys(p?.metrics ?? {})) if (!keys.includes(k)) keys.push(k);
  const rows = keys.map((k) => Object.fromEntries([['metric', label(k)], ...plans.map(([n, p]) => [n, fmt(k, p?.metrics?.[k])])]));
  return table(rows, [['metric', 'Metric'], ...plans.map(([n]): [string, string] => [n, n])].map(([k, head]) => [k, head, (v: any) => String(v)]));
}

export function resultHeader(resp: Json, rid: number, stale: boolean, extra: string[] = []) {
  return h('div', { class: 'row wrap' },
    stale ? badge('STALE · inputs changed, re-run', 'bad') : badge('current', 'ok'),
    badge(`scenario_hash ${short(resp.scenario_hash)}`), badge(`request ${rid}`), extra.map((x) => badge(x)));
}

function drawResult() {
  const cur = state.plan;
  if (!cur) return mount(resultBox);
  const resp = cur.resp;
  const stale = isStale(resp);
  const aria = resp.aria, base = resp.baseline_a;
  const shown = show === 'aria' && aria ? aria : base;
  const csvName = (g: string) => `picklist_${g}_${String(resp.scenario_hash).slice(0, 8)}.csv`;
  mount(resultBox, h('section', { class: `card result${stale ? ' stale' : ''}` },
    h('h2', {}, 'Tonight\'s plan'),
    resultHeader(resp, cur.rid, stale, [`solved in ${num(resp.solve_ms)} ms`, `recommended ${resp.recommended === 'aria' ? 'ARIA' : 'baseline (a)'}`]),
    !aria && h('div', { class: 'alert warn' }, `ARIA plan withheld (${resp.aria_withheld || 'no solution or verifier failure'}). Showing rule-based baseline (a), labelled.`),
    h('p', { class: 'muted small' }, planLabel(aria, 'ARIA')),
    h('p', { class: 'muted small' }, planLabel(base, 'Baseline (a)')),
    impactCard(resp, stale),
    h('h3', {}, 'KPIs vs baseline (a)'),
    metricsTable([['ARIA', aria], ['Baseline (a)', base]]),
    h('div', { class: 'row wrap gap' },
      aria && segmented([['aria', 'ARIA'], ['baseline_a', 'Baseline (a)']], show, (v) => { show = v as any; drawResult(); }, 'Plan shown'),
      h('button', { class: 'btn', disabled: stale || !shown?.verifier?.passed, onclick: () => exportSvcr(shown, resp) }, 'Share .svcr')),
    stale && h('p', { class: 'muted small' }, 'Export disabled: results are STALE.'),
    segmented([['alloc', `Allocations (${num(shown.allocations.length)})`], ['short', `Shortfalls (${num(shown.shortfalls.length)})`], ['excess', `Excess (${num((resp.excess ?? []).length)})`], ['forecast', 'Forecasts'], ['pick', 'Pick lists']], sub, (v) => { sub = v as any; drawResult(); }, 'Plan detail'),
    sub === 'alloc' && (shown.allocations.length ? pagedTable(shown.allocations, [
      ['godown_id', 'Godown'], ['town_id', 'Town'], ['product_id', 'Product'], ['lot_id', 'Lot'], ['units', 'Units'],
      ['freight_paise', 'Freight'], ['life_on_arrival', 'Life on arrival'], ['tau_star', 'τ*'],
    ], (r) => explainSheet(shown, r)) : h('p', { class: 'muted' }, 'No shipments in this plan.')),
    sub === 'short' && (shown.shortfalls.length ? pagedTable(shown.shortfalls, [
      ['town_id', 'Town'], ['product_id', 'Product'], ['shortfall_units', 'Short'], ['reason', 'Reason'], ['sub_reason', 'Detail', (v) => v ?? ''],
      ['facts', 'Facts', (v) => Object.entries(v ?? {}).map(([k, x]) => `${label(k)}=${fmt(k, x)}`).join('; ')],
    ], (r) => explainSheet(shown, r)) : h('p', { class: 'muted' }, 'No shortfall rows.')),
    sub === 'excess' && [h('p', { class: 'muted small' }, 'Town stock already above its target T (the τ*-quantile of demand on the cheapest eligible route): stock sitting here while other towns may run short.'),
      (resp.excess ?? []).length ? pagedTable(resp.excess, [['town_id', 'Town'], ['product_id', 'Product'], ['on_hand_units', 'On hand'], ['target_units', 'Target T'], ['excess_units', 'Excess'], ['tau_star', 'τ*']])
        : h('p', { class: 'muted' }, 'No town holds more than its target.')],
    sub === 'forecast' && forecasts(),
    sub === 'pick' && pickLists(shown.allocations, stale, csvName),
  ));
}

export function pickLists(allocs: Json[], disabled: boolean, name: (g: string) => string) {
  const godowns = [...new Set(allocs.map((a) => a.godown_id))].sort();
  if (!godowns.length) return h('p', { class: 'muted' }, 'Nothing to pick.');
  return godowns.map((g) => {
    const rows = allocs.filter((a) => a.godown_id === g);
    return h('div', { class: 'pick' },
      h('div', { class: 'row between' }, h('h3', {}, g), h('button', { class: 'btn small', disabled, onclick: () => shareFile(name(g), pickCsv(rows), 'text/csv') }, 'Share CSV')),
      pagedTable(rows, [['town_id', 'Town'], ['product_id', 'Product'], ['lot_id', 'Lot'], ['units', 'Units'], ['life_on_arrival', 'Life on arrival']], undefined, 15));
  });
}

function pickCsv(rows: Json[]) {
  const cols = ['godown_id', 'town_id', 'product_id', 'lot_id', 'units', 'life_on_arrival'];
  const cell = (v: any) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

async function exportSvcr(p: Json, resp: Json) {
  try {
    const bytes = await engine.exportSvcr(p.plan_id);
    await shareFile(`aria_${resp.scenario_hash.slice(0, 8)}_${p.policy}.svcr`, bytes, SVCR_MIME);
  } catch (e: any) {
    toast(`Export failed: ${e.message}`);
  }
}

export async function explainSheet(p: Json, row: Json) {
  openSheet(`${row.town_id} / ${row.product_id}`, h('p', { class: 'muted' }, 'Loading...'));
  let c: Json;
  try {
    c = await engine.explain(p.plan_id, row.town_id, row.product_id);
  } catch (e: any) {
    return openSheet(`${row.town_id} / ${row.product_id}`, errorBox(e.message));
  }
  const reason = c.reason;
  const shadow = c.lot_shadow_price_paise ?? {};
  openSheet(`${c.town_id} / ${c.product_id}`,
    kv([['τ* (route)', fmt('tau', c.tau_star)], ['Freight / unit', rupees(c.freight_per_unit_paise)], ['On hand', num(c.on_hand_units)], ['Shipped', num(c.shipped_units)]]),
    c.forecast && [h('h3', {}, 'Demand forecast'),
      h('p', { class: 'muted small' }, `${forecastLabel(c.town_id, c.product_id)}. Median ${fmt('q', c.forecast.quantiles[4])}; 99% range ${fmt('q', c.forecast.quantiles[0])} to ${fmt('q', c.forecast.quantiles[8])}.`),
      bandBar(c.forecast.quantiles, c.forecast.quantiles[8] || 1),
      table([Object.fromEntries(c.forecast.levels.map((l: number, i: number) => [String(l), fmt('q', c.forecast.quantiles[i])]))],
        c.forecast.levels.map((l: number): [string, string, (v: any) => string] => [String(l), `q${l}`, String]))],
    reason && h('div', { class: 'alert warn' }, h('strong', {}, `Reason: ${reason.reason}${reason.sub_reason ? ` (${reason.sub_reason})` : ''}`),
      kv(Object.entries(reason.facts ?? {}).map(([k, v]): [string, string] => [label(k), fmt(k, v)]))),
    c.life_on_arrival?.length > 0 && [h('h3', {}, 'Lots shipped'), table(c.life_on_arrival.map((r: Json) => ({ ...r, shadow: shadow[r.lot_id] })),
      [['lot_id', 'Lot'], ['godown_id', 'Godown'], ['units', 'Units'], ['life_on_arrival', 'Life on arrival'], ['shadow', 'Shadow price', (v) => rupees(v)]]),
      h('p', { class: 'muted small' }, `Shadow price: ${c.lot_shadow_price_note}`)],
    h('h3', {}, 'Demand segments'),
    h('div', { class: 'scroll' }, table(c.segments, [['j', 'j'], ['tau', 'τ'], ['width', 'Width'], ['value_paise', 'Value / unit'], ['filled', 'Filled']])),
    h('h3', {}, 'Parameters and sources'),
    table(c.params, [['name', 'Name'], ['value', 'Value', (v) => String(v)], ['source', 'Source']]),
  );
}

const IMPACT: [string, string, string][] = [
  ['Stockouts', 'expected_lost_units', 'Expected lost units'], ['Stockouts', 'expected_fill_rate', 'Expected fill rate'], ['Stockouts', 'expected_lost_margin_paise', 'Expected lost margin'],
  ['Transportation cost', 'freight_paise', 'Freight'], ['Transportation cost', 'units_shipped', 'Units shipped'],
  ['Wastage', 'at_risk_units_shipped', 'Near-expiry units shipped'], ['Wastage', 'at_risk_units_left', 'Near-expiry units left (write-off)'], ['Wastage', 'at_risk_writeoff_paise', 'Expected write-off'],
];
const REPLAY_ROWS: [string, string][] = [['lost_units', 'Lost units'], ['fill_rate', 'Fill rate'], ['freight', 'Freight'], ['writeoff_units', 'Write-off units'], ['bill_paise', 'Full bill']];

function impactCard(resp: Json, stale: boolean) {
  const imp = resp.impact ?? {};
  const v = (p: Json, k: string) => (k === 'expected_fill_rate' ? (p ? `${(p[k] * 100).toFixed(1)}%` : '-') : fmt(k, p?.[k]));
  const net = state.networkId;
  const rp = replays[net];
  if (rp === undefined) {
    replays[net] = null;
    engine.replay(net).then((r) => { replays[net] = r; drawResult(); }).catch(() => { replays[net] = { missing: true }; });
  }
  const per = rp && !rp.missing && rp.conservation_ok ? rp.per_policy : null;
  const rv = (p: Json, k: string) => (k === 'freight' ? rupees(p[k]) : fmt(k, p[k]));
  const cols: [string, string, (x: any) => string][] = [['name', 'Measure', String], ['aria', 'ARIA', String], ['base', '(a)', String]];
  return h('section', { class: `card${stale ? ' stale' : ''}` },
    h('h3', {}, 'Impact tonight: ARIA vs baseline (a)'),
    h('p', { class: 'muted small' }, "Under the demand forecast. Lost units and fill rate count expected sales from town stock plus tonight's shipments; near-expiry units are lots that cannot ship tomorrow."),
    h('div', { class: 'impact' }, ['Stockouts', 'Transportation cost', 'Wastage'].map((g) => h('div', {}, h('h4', {}, g),
      table(IMPACT.filter((r) => r[0] === g).map(([, k, name]) => ({ name, aria: v(imp.aria, k), base: v(imp.baseline_a, k) })), cols)))),
    per?.aria && per?.baseline_a && [h('h4', {}, 'Fair replay totals (realised demand, see Proof)'),
      table(REPLAY_ROWS.map(([k, name]) => ({ name, aria: rv(per.aria, k), base: rv(per.baseline_a, k) })), cols)]);
}

function forecasts() {
  const rows: Json[] = state.scenario?.demand ?? [];
  const max = Math.max(1, ...rows.map((d) => d.quantiles[8] ?? 0));
  const model = (r: Json) => (state.imported?.has(`${r.town_id}|${r.product_id}`) ? (state.importInfo?.method === 'ml' ? 'imported: model' : 'imported: fallback') : 'bundled');
  return [h('p', { class: 'muted small' }, `Demand per town and product for the planning day: median and the 9 quantiles (bands: 50%, 95%, 99%). Bundled forecasts: ${forecastLabel()}.`),
    h('ul', { class: 'list-cards' }, rows.slice(0, 40).map((d) => h('li', {},
      h('div', { class: 'row between small' }, h('span', {}, `${d.town_id} / ${d.product_id}`), h('span', { class: 'muted' }, `median ${fmt('q', d.quantiles[4])} · ${model(d)}`)),
      bandBar(d.quantiles, max)))),
    rows.length > 40 && h('h4', {}, 'All rows'),
    rows.length > 40 && pagedTable(rows, [['town_id', 'Town'], ['product_id', 'Product'], ['quantiles', 'Median', (q) => fmt('q', q[4])],
      ['point', 'Range', (_, r) => `${fmt('q', r.quantiles[0])} to ${fmt('q', r.quantiles[8])}`], ['sigma', 'Model', (_, r) => model(r)]], undefined, 30)];
}
