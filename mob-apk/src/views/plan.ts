// Home: what to ship tonight. Scenario picker, readiness, one orange "Plan tonight" action, then a summary card
// (units to ship, verified chip, freight, fill rate), action tiles, the statement's three goals against the usual
// method, shipments by depot, shortages in plain words, extra stock, forecasts and technical details.
import { engine } from '../engine';
import { SVCR_MIME, shareFile } from '../native';
import { forecastLabel, isStale, loadScenario, nextRid, notify, rerender, scheduleValidate, state } from '../state';
import { Json, badge, bandBar, errorBox, fmt, h, icon, kv, label, mount, num, openSheet, pagedTable, rupees, segmented, select, short, table, toast } from '../ui';

let show: 'aria' | 'baseline_a' = 'aria';
let importing = false;
const replays: Record<string, Json> = {};
let godownFilter = '';
let search = '';
let stockBox: HTMLElement;
let statusBox: HTMLElement;
let resultBox: HTMLElement;

/** Plain-language reason for a shortfall row (reason codes stay visible in the detail sheet). */
export function plainReason(s: Json): string {
  const sub = s.sub_reason;
  switch (s.reason) {
    case 'NO_STOCK_ANYWHERE': return 'Out of stock everywhere';
    case 'NO_ELIGIBLE_STOCK': return sub === 'NO_ACTIVE_ROUTE' ? 'No open route to this town' : 'Stock would expire before arriving';
    case 'STOCK_BLOCKED': return sub === 'CAPACITY_BOUND' ? 'Depot loading capacity is full' : 'Freight costs more than the sale saves';
    case 'SUPPLY_USED': return sub === 'SUPPLY_EXHAUSTED' ? 'All available stock already sent here' : 'Stock went to towns where it is worth more';
    default: return 'Not classified';
  }
}

const nameOf = (list: Json[] | undefined, key: string, id: string) => list?.find((x) => x[key] === id)?.name || id;
export const godownName = (id: string) => nameOf(state.scenario?.godowns, 'godown_id', id);
export const townName = (id: string) => nameOf(state.scenario?.towns, 'town_id', id);

export function render(root: HTMLElement) {
  stockBox = h('div', {});
  statusBox = h('section', { class: 'card', 'aria-live': 'polite' });
  resultBox = h('div', {});
  mount(root, pickers(), statusBox, resultBox);
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
  return h('section', { class: 'card' },
    h('div', { class: 'grid2' },
      h('label', {}, 'Distribution network', select(nets, state.networkId, async (v) => {
        state.networkId = v;
        const first = state.scenarios.find((s) => s.network_id === v);
        if (first) await loadScenario(first.scenario_id);
      }, 'Distribution network')),
      h('label', {}, 'Stock and demand for', select(scs, state.scenarioId, (v) => loadScenario(v), 'Scenario'))),
    h('input', { type: 'file', accept: '.csv,text/csv', id: 'csv-file', class: 'visually-hidden', onchange: (e: Event) => importCsv(e.target as HTMLInputElement) }),
    h('label', { for: 'csv-file', class: 'btn small block', role: 'button', tabIndex: 0 }, icon('upload'), importing ? 'Forecasting on this phone...' : 'Use my own sales (CSV)'),
    h('p', { class: 'note' }, 'CSV columns: date, item, outlet/town, qty, price. ARIA forecasts tomorrow from your history.'),
    importInfo());
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

function stockSheet() {
  drawStock();
  openSheet('Edit depot stock', h('p', { class: 'muted small' }, 'Change units or days of shelf life left. Results update to STALE until you plan again.'), stockBox);
}

function drawStock() {
  const sc = state.scenario;
  if (!sc) return mount(stockBox, h('p', { class: 'muted' }, 'Loading...'));
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
        h('div', { class: 'lot-id' }, h('strong', {}, l.product_id), h('span', { class: 'muted small' }, `${godownName(l.godown_id)} · ${l.lot_id}`)),
        h('label', { class: 'mini' }, 'Units', h('input', { type: 'text', inputMode: 'numeric', value: String(l.qty_units), 'aria-label': `Units for ${l.lot_id}`, oninput: (e: Event) => setLot(i, 'qty_units', (e.target as HTMLInputElement).value) })),
        h('label', { class: 'mini' }, 'Days left', h('input', { type: 'text', inputMode: 'numeric', value: String(l.remaining_life_days), 'aria-label': `Days of shelf life left for ${l.lot_id}`, oninput: (e: Event) => setLot(i, 'remaining_life_days', (e.target as HTMLInputElement).value) })),
      ))),
      rows.length > n && h('button', { class: 'btn ghost', onclick: () => { n += 50; paint(); } }, `Show more (${num(rows.length - n)} left)`));
    paint();
  };
  mount(stockBox,
    h('div', { class: 'grid2' },
      select([['', 'All depots'], ...godowns], godownFilter, (v) => { godownFilter = v; draw(); }, 'Filter by depot'),
      h('input', { type: 'search', placeholder: 'Search product or lot', value: search, 'aria-label': 'Search lots', oninput: (e: Event) => { search = (e.target as HTMLInputElement).value; draw(); } })),
    list);
  draw();
}

function issues(report: Json) {
  const errs = report?.errors ?? [], warns = report?.warnings ?? [];
  return [
    errs.length > 0 && h('div', { class: 'alert bad', role: 'alert' }, `${errs.length} problem(s) in the inputs. Fix them to plan.`,
      table(errs, [['code', 'Code'], ['path', 'Where'], ['message', 'What']])),
    warns.length > 0 && h('details', {}, h('summary', { class: 'small' }, `${warns.length} note(s) about the inputs`), table(warns, [['code', 'Code'], ['path', 'Where'], ['message', 'What']])),
  ];
}

function drawStatus() {
  const r = state.report;
  const valid = !state.validating && r?.valid;
  const sc = state.scenario;
  mount(statusBox,
    h('div', { class: 'row between' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Ready to plan'),
        h('strong', {}, sc ? `${sc.godowns.length} depots · ${sc.towns.length} towns · ${sc.products.length} products` : 'Loading...')),
      state.validating ? badge('Checking...', 'warn') : valid ? badge('Inputs OK', 'ok') : badge('Needs fixing', 'bad')),
    !state.validating && issues(r),
    h('button', { class: 'btn primary block', disabled: !valid || state.planBusy, onclick: planTonight },
      state.planBusy ? 'Planning on this phone...' : ['Plan tonight', icon('arrow')]),
    h('button', { class: 'btn block', onclick: stockSheet }, icon('edit'), 'Edit depot stock'),
    state.planError && errorBox(state.planError));
}

export async function planTonight() {
  if (state.planBusy || !state.report?.valid || state.validating) return;
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
    if (my === state.planRid) state.planError = `Planning failed: ${e.message}`;
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
    stale ? badge('Out of date: inputs changed', 'bad') : badge('Up to date', 'ok'),
    h('span', { class: 'badge mono' }, `scenario_hash ${short(resp.scenario_hash)}`), h('span', { class: 'badge mono' }, `request ${rid}`), extra.map((x) => badge(x)));
}

/** One goal row: ARIA vs the usual method, with a plain "lower / higher" chip. */
function goal(what: string, a: number | null | undefined, b: number | null | undefined, f: (v: number) => string, lowerIsBetter = true) {
  if (a == null || b == null) return null;
  const pct = b ? ((a - b) / Math.abs(b)) * 100 : 0;
  const same = Math.abs(pct) < 0.5;
  const better = same ? null : (pct < 0) === lowerIsBetter;
  const word = same ? 'About the same' : `${Math.abs(pct).toFixed(0)}% ${pct < 0 ? 'lower' : 'higher'}`;
  return h('div', { class: 'goal' }, h('span', { class: 'what' }, what), badge(word, same ? '' : better ? 'ok' : 'warn'),
    h('span', { class: 'vals' }, `ARIA ${f(a)} · usual method ${f(b)}`));
}

function goalsCard(resp: Json) {
  const a = resp.impact?.aria, b = resp.impact?.baseline_a;
  if (!a || !b) return null;
  const net = state.networkId;
  if (replays[net] === undefined) {
    replays[net] = null;
    engine.replay(net).then((r) => { replays[net] = r; drawResult(); }).catch(() => { replays[net] = { missing: true }; });
  }
  const rp = replays[net];
  const per = rp && !rp.missing && rp.conservation_ok ? rp.per_policy : null;
  const pctf = (v: number) => `${(v * 100).toFixed(1)}%`;
  return [h('div', { class: 'section-head' }, h('h2', {}, 'Compared with the usual method')),
    h('section', { class: 'card' },
      goal('Lost sales value (stockouts)', a.expected_lost_margin_paise, b.expected_lost_margin_paise, rupees),
      goal('Customers served (fill rate)', a.expected_fill_rate, b.expected_fill_rate, pctf, false),
      goal('Transport cost (freight)', a.freight_paise, b.freight_paise, rupees),
      goal('Stock left to expire (wastage)', a.at_risk_units_left, b.at_risk_units_left, num),
      goal('Expected write-off', a.at_risk_writeoff_paise, b.at_risk_writeoff_paise, rupees),
      h('p', { class: 'note' }, 'Tonight, under the demand forecast. The usual method ships forecast plus a fixed safety buffer from the nearest depot. ARIA ranks every unit by what it is worth after freight, so it may skip a few low-value units on costly routes: compare lost sales value, not only units.'),
      per?.aria && per?.baseline_a && [h('h3', {}, 'Over 8 weeks of real demand (replay)'),
        goal('Total cost bill', per.aria.bill_paise, per.baseline_a.bill_paise, rupees),
        goal('Units written off', per.aria.writeoff_units, per.baseline_a.writeoff_units, num),
        goal('Fill rate', per.aria.fill_rate, per.baseline_a.fill_rate, pctf, false)])];
}

function rows<T>(items: T[], li: (x: T) => HTMLElement, empty: string, more?: () => void, limit = 6) {
  if (!items.length) return h('p', { class: 'note' }, empty);
  return [h('ul', { class: 'rows' }, items.slice(0, limit).map(li)),
    items.length > limit && more && h('button', { class: 'btn ghost block', onclick: more }, `See all ${num(items.length)}`)];
}

function tapRow(onTap: () => void, ...kids: any[]) {
  return h('li', { class: 'tap', tabIndex: 0, role: 'button', onclick: onTap, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') onTap(); } }, ...kids);
}

function drawResult() {
  const cur = state.plan;
  if (!cur) return mount(resultBox);
  const resp = cur.resp;
  const stale = isStale(resp);
  const aria = resp.aria, base = resp.baseline_a;
  const shown = show === 'aria' && aria ? aria : base;
  const csvName = (g: string) => `picklist_${g}_${String(resp.scenario_hash).slice(0, 8)}.csv`;
  const allocs: Json[] = shown.allocations;
  const units = allocs.reduce((s, a) => s + a.units, 0);
  const depots = [...new Set(allocs.map((a) => a.godown_id))].sort();
  const towns = new Set(allocs.map((a) => a.town_id));
  const verified = shown.verifier?.passed;
  const shorts: Json[] = [...shown.shortfalls].sort((x, y) => y.shortfall_units - x.shortfall_units);
  const excess: Json[] = resp.excess ?? [];
  const pickSheet = (g?: string) => openSheet(g ? `Pick list · ${godownName(g)}` : 'Pick lists', pickLists(g ? allocs.filter((a) => a.godown_id === g) : allocs, stale, csvName));
  mount(resultBox,
    h('section', { class: `card result${stale ? ' stale' : ''}` },
      h('div', { class: 'row between' }, h('p', { class: 'eyebrow' }, 'To ship tonight'),
        stale ? badge('Out of date', 'bad') : verified ? badge('Verified', 'ok') : badge('Not verified', 'bad')),
      h('div', { class: 'hero-num' }, h('strong', {}, num(units)), h('span', {}, 'units')),
      h('div', { class: 'place' }, icon('pin'), `${depots.length} depots → ${towns.size} towns`),
      !aria && h('div', { class: 'alert warn' }, `ARIA's plan was withheld (${resp.aria_withheld || 'no verified solution'}). Showing the usual method instead, labelled.`),
      h('div', { class: 'split' },
        h('div', {}, h('span', { class: 'small' }, 'Freight'), h('strong', {}, rupees(shown.metrics?.freight_paise))),
        h('div', {}, h('span', { class: 'small' }, 'Shortages'), h('strong', {}, num(shorts.length)))),
      h('div', { class: 'tiles' },
        h('button', { class: 'tile', disabled: !allocs.length, onclick: () => pickSheet() }, icon('list'), 'Pick lists'),
        h('button', { class: 'tile', disabled: stale || !verified, onclick: () => exportSvcr(shown, resp) }, icon('share'), 'Share plan'),
        h('button', { class: 'tile', onclick: stockSheet }, icon('edit'), 'Edit stock')),
      stale && h('p', { class: 'note' }, 'Inputs changed after planning. Plan again before sharing.'),
      h('p', { class: 'note' }, `Planned on this phone in ${(resp.solve_ms / 1000).toFixed(1)} s · ${shown === aria ? 'ARIA' : 'usual method'}`)),
    goalsCard(resp),
    h('div', { class: 'section-head' }, h('h2', {}, 'Shipments by depot', h('span', { class: 'count' }, num(depots.length))), h('span', { class: 'small muted' }, 'Units')),
    rows(depots, (g) => {
      const mine = allocs.filter((a) => a.godown_id === g);
      return tapRow(() => pickSheet(g), h('div', { class: 'row-main' }, h('strong', {}, godownName(g)), h('span', {}, `${new Set(mine.map((a) => a.town_id)).size} towns · ${num(mine.length)} lots`)),
        h('div', { class: 'row-end' }, h('strong', {}, num(mine.reduce((s, a) => s + a.units, 0))), h('span', {}, 'units')));
    }, 'Nothing to ship tonight.', undefined, 50),
    h('div', { class: 'section-head' }, h('h2', {}, 'Shortages', h('span', { class: 'count' }, num(shorts.length))), h('span', { class: 'small muted' }, 'Short by')),
    rows(shorts, (s) => tapRow(() => explainSheet(shown, s),
      h('div', { class: 'row-main' }, h('strong', {}, s.product_id), h('span', {}, `${townName(s.town_id)} · ${plainReason(s)}`)),
      h('div', { class: 'row-end' }, h('strong', {}, num(s.shortfall_units)), h('span', {}, 'units'))),
    'No shortages: every town gets what it is worth sending.', () => openSheet('All shortages', pagedTable(shorts.map((s) => ({ ...s, why: plainReason(s), town: townName(s.town_id) })),
      [['town', 'Town'], ['product_id', 'Product'], ['shortfall_units', 'Short'], ['why', 'Why'], ['reason', 'Code']], (r) => explainSheet(shown, r)))),
    h('div', { class: 'section-head' }, h('h2', {}, 'Extra stock in towns', h('span', { class: 'count' }, num(excess.length))), h('span', { class: 'small muted' }, 'Above need')),
    rows(excess, (x) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, x.product_id), h('span', {}, `${townName(x.town_id)} · has ${num(x.on_hand_units)}, needs ${num(x.target_units)}`)),
      h('div', { class: 'row-end' }, h('strong', {}, num(x.excess_units)), h('span', {}, 'extra'))),
    'No town holds more than it needs.', () => openSheet('Extra stock in towns', pagedTable(excess, [['town_id', 'Town'], ['product_id', 'Product'], ['on_hand_units', 'On hand'], ['target_units', 'Needs'], ['excess_units', 'Extra']])), 4),
    h('details', { class: 'card' }, h('summary', {}, 'Demand forecasts'), forecasts()),
    h('details', { class: 'card' }, h('summary', {}, 'Technical details'),
      resultHeader(resp, cur.rid, stale, [`recommended ${resp.recommended === 'aria' ? 'ARIA' : 'baseline (a)'}`]),
      h('p', { class: 'muted small' }, planLabel(aria, 'ARIA')),
      h('p', { class: 'muted small' }, planLabel(base, 'Baseline (a)')),
      aria && segmented([['aria', 'ARIA'], ['baseline_a', 'Usual method (a)']], show, (v) => { show = v as any; drawResult(); }, 'Plan shown'),
      h('h3', {}, 'All metrics'),
      metricsTable([['ARIA', aria], ['Baseline (a)', base]]),
      h('h3', {}, 'Every shipment'),
      allocs.length ? pagedTable(allocs, [
        ['godown_id', 'Depot'], ['town_id', 'Town'], ['product_id', 'Product'], ['lot_id', 'Lot'], ['units', 'Units'],
        ['freight_paise', 'Freight'], ['life_on_arrival', 'Life on arrival'], ['tau_star', 'τ*'],
      ], (r) => explainSheet(shown, r), 20) : h('p', { class: 'muted' }, 'No shipments.')),
  );
}

export function pickLists(allocs: Json[], disabled: boolean, name: (g: string) => string) {
  const godowns = [...new Set(allocs.map((a) => a.godown_id))].sort();
  if (!godowns.length) return h('p', { class: 'muted' }, 'Nothing to pick.');
  return godowns.map((g) => {
    const rows = allocs.filter((a) => a.godown_id === g);
    return h('div', { class: 'pick' },
      h('div', { class: 'row between' }, h('h3', {}, godownName(g)), h('button', { class: 'btn small', disabled, onclick: () => shareFile(name(g), pickCsv(rows), 'text/csv') }, icon('share'), 'Share CSV')),
      pagedTable(rows, [['town_id', 'Town', (v) => townName(v)], ['product_id', 'Product'], ['lot_id', 'Lot'], ['units', 'Units'], ['life_on_arrival', 'Days left on arrival']], undefined, 15));
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
    toast(`Sharing failed: ${e.message}`);
  }
}

export async function explainSheet(p: Json, row: Json) {
  const head = `${row.product_id} · ${townName(row.town_id)}`;
  openSheet(head, h('p', { class: 'muted' }, 'Loading...'));
  let c: Json;
  try {
    c = await engine.explain(p.plan_id, row.town_id, row.product_id);
  } catch (e: any) {
    return openSheet(head, errorBox(e.message));
  }
  const reason = c.reason;
  const shadow = c.lot_shadow_price_paise ?? {};
  openSheet(head,
    reason && h('div', { class: 'alert warn' }, h('strong', {}, plainReason(reason)), h('div', { class: 'small' }, `Code ${reason.reason}${reason.sub_reason ? ` · ${reason.sub_reason}` : ''}`),
      kv(Object.entries(reason.facts ?? {}).map(([k, v]): [string, string] => [label(k), fmt(k, v)]))),
    kv([['Service level on this route (τ*)', fmt('tau', c.tau_star)], ['Freight per unit', rupees(c.freight_per_unit_paise)], ['Already in town', num(c.on_hand_units)], ['Shipped tonight', num(c.shipped_units)]]),
    c.forecast && [h('h3', {}, 'Demand forecast'),
      h('p', { class: 'muted small' }, `${forecastLabel(c.town_id, c.product_id)}. Most likely ${fmt('q', c.forecast.quantiles[4])}; 99% range ${fmt('q', c.forecast.quantiles[0])} to ${fmt('q', c.forecast.quantiles[8])}.`),
      bandBar(c.forecast.quantiles, c.forecast.quantiles[8] || 1),
      table([Object.fromEntries(c.forecast.levels.map((l: number, i: number) => [String(l), fmt('q', c.forecast.quantiles[i])]))],
        c.forecast.levels.map((l: number): [string, string, (v: any) => string] => [String(l), `q${l}`, String]))],
    c.life_on_arrival?.length > 0 && [h('h3', {}, 'Lots shipped'), table(c.life_on_arrival.map((r: Json) => ({ ...r, shadow: shadow[r.lot_id] })),
      [['lot_id', 'Lot'], ['godown_id', 'Depot'], ['units', 'Units'], ['life_on_arrival', 'Days left on arrival'], ['shadow', 'Shadow price', (v) => rupees(v)]]),
      h('p', { class: 'muted small' }, `Shadow price: ${c.lot_shadow_price_note}`)],
    h('details', {}, h('summary', {}, 'Demand segments'),
      h('div', { class: 'scroll' }, table(c.segments, [['j', 'j'], ['tau', 'τ'], ['width', 'Width'], ['value_paise', 'Value / unit'], ['filled', 'Filled']]))),
    h('details', {}, h('summary', {}, 'Parameters and sources'),
      table(c.params, [['name', 'Name'], ['value', 'Value', (v) => String(v)], ['source', 'Source']])),
  );
}

function forecasts() {
  const rows: Json[] = state.scenario?.demand ?? [];
  const max = Math.max(1, ...rows.map((d) => d.quantiles[8] ?? 0));
  const model = (r: Json) => (state.imported?.has(`${r.town_id}|${r.product_id}`) ? (state.importInfo?.method === 'ml' ? 'imported: model' : 'imported: fallback') : 'bundled');
  return [h('p', { class: 'muted small' }, `Tomorrow's demand per town and product: the bar shows the likely range (darkest = middle half), the tick the most likely value. ${forecastLabel()}.`),
    h('ul', { class: 'list-cards' }, rows.slice(0, 40).map((d) => h('li', {},
      h('div', { class: 'row between small' }, h('span', {}, `${townName(d.town_id)} · ${d.product_id}`), h('span', { class: 'muted' }, `about ${fmt('q', d.quantiles[4])} · ${model(d)}`)),
      bandBar(d.quantiles, max)))),
    rows.length > 40 && h('h3', {}, 'All rows'),
    rows.length > 40 && pagedTable(rows, [['town_id', 'Town', (v) => townName(v)], ['product_id', 'Product'], ['quantiles', 'Most likely', (q) => fmt('q', q[4])],
      ['point', 'Range', (_, r) => `${fmt('q', r.quantiles[0])} to ${fmt('q', r.quantiles[8])}`], ['sigma', 'Model', (_, r) => model(r)]], undefined, 30)];
}
