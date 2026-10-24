// Home: what to ship tonight. Scenario picker, readiness, one orange "Plan tonight" action, then a summary card
// (units to ship, verified chip, freight, fill rate), action tiles, the statement's three goals against the usual
// method, shipments by depot, shortages in plain words, extra stock, forecasts and technical details.
import { engine } from '../engine';
import { SVCR_MIME, shareFile } from '../native';
import { forecastLabel, isStale, loadCsvText, loadSample, nextRid, notify, persist, rerender, scheduleValidate, state } from '../state';
import { errorText, sendPlanFile } from '../cloud';
import { networkDiagram } from './network';
import { issueText, noteGroups, sampleName } from '../plain';
import { Json, badge, bandBar, errorBox, fmt, h, icon, kv, mount, num, openSheet, pagedTable, rupees, segmented, select, table, toast } from '../ui';

let show: 'aria' | 'baseline_a' = 'aria';
const replays: Record<string, Json> = {};
let godownFilter = '';
let search = '';
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
  statusBox = h('section', { class: 'card', 'aria-live': 'polite' });
  resultBox = h('div', {});
  mount(root, dataCard(), statusBox, resultBox);
  update();
}

export function update() {
  if (!statusBox) return;
  drawStatus();
  drawResult();
}

function dataCard() {
  const d = state.data, sc = state.scenario;
  const samples = state.scenarios.map((x): [string, string] => [x.scenario_id, sampleName(x.scenario_id)]);
  let sample = samples[0]?.[0] ?? '';
  const upload = [
    h('input', { type: 'file', accept: '.csv,text/csv,text/comma-separated-values,text/plain', id: 'csv-file', class: 'visually-hidden', onchange: (e: Event) => uploadCsv(e.target as HTMLInputElement) }),
    h('label', { for: 'csv-file', class: `btn ${sc ? '' : 'primary '}block`, role: 'button', tabIndex: 0, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') document.getElementById('csv-file')?.click(); } },
      icon('upload'), state.dataBusy ? 'Reading your file...' : sc ? 'Upload a CSV' : 'Upload your data (CSV)')];
  const errs = state.dataErrors && h('div', { class: 'alert bad', role: 'alert' },
    h('strong', {}, 'The file was not loaded. Nothing was changed.'),
    h('p', { class: 'small' }, 'Fix these rows in your spreadsheet and upload again:'),
    table(state.dataErrors, [['section', 'Table', (v) => v || '-'], ['line', 'Line', (v) => (v == null ? '-' : String(v))], ['message', 'Problem']]));
  const samplePicker = samples.length > 0 && h('details', { class: 'small' }, h('summary', {}, 'Try a sample dataset instead'),
    h('div', { class: 'grid2' }, select(samples, sample, (v) => { sample = v; }, 'Sample dataset'),
      h('button', { class: 'btn', disabled: state.dataBusy, onclick: () => loadSample(sample) }, 'Load sample')),
    h('p', { class: 'note' }, 'Samples are loaded through the same CSV reader as your own files.'));
  if (!sc) {
    return h('section', { class: 'card' },
      h('p', { class: 'eyebrow' }, 'Start with your data'),
      h('p', { class: 'small' }, 'One CSV file holds your products, depots, towns, routes, stock and demand (or past sales). ARIA plans from exactly what is in it.'),
      upload, errs,
      h('div', { class: 'grid2' },
        h('button', { class: 'btn', onclick: downloadTemplate }, icon('share'), 'Get a template'),
        h('button', { class: 'btn', onclick: formatSheet }, icon('list'), 'What goes in it?')),
      samplePicker);
  }
  const counts = `${num(sc.godowns.length)} depots · ${num(sc.towns.length)} towns · ${num(sc.products.length)} products · ${num(sc.lots.length)} stock lots · ${num(sc.demand.length)} forecasts`;
  return h('section', { class: 'card' },
    h('div', { class: 'row between' }, h('div', {}, h('p', { class: 'eyebrow' }, d?.source === 'sample' ? 'Sample data' : 'Your data'), h('strong', {}, state.scenarioId)),
      badge(d?.source === 'sample' ? 'sample' : 'from CSV', d?.source === 'sample' ? 'warn' : 'ok')),
    h('p', { class: 'small muted' }, counts),
    d?.kept?.length > 0 && h('p', { class: 'note' }, `Last upload replaced ${Object.keys(d.sections ?? {}).join(', ')}; kept ${d.kept.join(', ')} from before.`),
    d?.forecast && h('p', { class: 'note' }, `Demand forecast from ${num(d.forecast.days)} days of sales (${d.forecast.first} to ${d.forecast.last}): ${d.forecast.label}${d.forecast.note ? ` (${d.forecast.note})` : ''}.`),
    d?.warnings?.length > 0 && h('details', { class: 'small' }, h('summary', {}, `${d.warnings.length} note(s) about the file`), h('ul', {}, d.warnings.map((w: string) => h('li', {}, w)))),
    upload, errs,
    h('p', { class: 'note' }, 'A file with only some tables (for example just stock) updates those and keeps the rest.'),
    h('div', { class: 'grid2' },
      h('button', { class: 'btn', onclick: downloadCurrent }, icon('share'), 'Download as CSV'),
      h('button', { class: 'btn', onclick: formatSheet }, icon('list'), 'CSV format')),
    samplePicker);
}

async function uploadCsv(input: HTMLInputElement) {
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) { state.dataErrors = [{ section: '', line: null, message: 'The file is larger than 20 MB.' }]; return rerender(); }
  const ok = await loadCsvText(await f.text(), f.name, 'csv');
  if (ok) toast(`Loaded ${f.name}`);
}

async function downloadTemplate() {
  try {
    const small = state.scenarios.find((x) => /edge/.test(x.scenario_id)) ?? state.scenarios[0];
    await shareFile('aria_data_template.csv', await engine.sampleCsv(small.scenario_id), 'text/csv');
  } catch (e: any) { toast(`Could not create the template: ${e.message}`); }
}

async function downloadCurrent() {
  try {
    await shareFile(`${String(state.scenarioId).replace(/[^\w-]+/g, '_') || 'aria_data'}.csv`, await engine.exportCsv(state.scenario), 'text/csv');
  } catch (e: any) { toast(`Could not export: ${e.message}`); }
}

const ABOUT: Record<string, string> = {
  settings: 'Optional. Rows of key,value: name, day, margin, salvage_share, repo_rate, freight_rs_per_tkm_55t / _road_avg / _6t.',
  products: 'Each product: weight, shelf life and selling price in rupees.',
  depots: 'Where stock is held. capacity_units = most units it can load in one night (empty = no limit).',
  towns: 'Where stock is needed.',
  routes: 'Which depot can serve which town: road km, days on the road, truck class (55t, road_avg or 6t), active true/false.',
  stock: 'Lots in depots: units and days of shelf life left. lot_id is optional.',
  town_stock: 'Optional. Stock already in towns.',
  demand: 'Expected demand per town and product: either mean (average) and sd (how much it usually varies), or nine forecast columns from lowest to highest, q0.005 … q0.995.',
  sales: 'Instead of demand: past daily sales (date as YYYY-MM-DD). ARIA forecasts the next day on this phone.',
};
let formatDoc: Json[] | null = null;
async function formatSheet() {
  formatDoc ??= await engine.csvFormat();
  const typeName: Record<string, string> = { str: 'text', int: 'whole number', float: 'number', bool: 'true/false' };
  openSheet('CSV format',
    h('p', { class: 'small' }, 'One file, several tables. Start each table with a row whose first cell is "# name" (for example "# products"), then a header row, then the data. A file with a single table needs no marker: its header tells which table it is.'),
    h('pre', { class: 'code' }, '# depots\ndepot_id,name,capacity_units\nD1,North depot,\nD2,South depot,400\n\n# routes\ndepot_id,town_id,road_km,transit_days,vehicle_class\nD1,T1,20,1,road_avg'),
    formatDoc.map((sec: Json) => h('div', {}, h('h3', {}, `# ${sec.section}`), h('p', { class: 'small muted' }, ABOUT[sec.section] ?? ''),
      table(sec.columns.filter((c: Json) => !/^q0\./.test(c.name) || c.name === 'q0.005'),
        [['name', 'Column', (v) => (v === 'q0.005' ? 'q0.005 … q0.995' : v)], ['type', 'Type', (v) => typeName[v] ?? v],
          ['required', 'Needed', (v) => (v ? 'yes' : 'no')], ['default', 'If empty', (v, r) => (r.required ? '-' : v == null ? 'none' : String(v))]]))),
    h('p', { class: 'note' }, 'The nine forecast columns are q0.005, q0.025, q0.165, q0.25, q0.5, q0.75, q0.835, q0.975 and q0.995: each number must be at least as big as the one before.'));
}

/** Stock editor: changes stay a draft until Save, which applies them, re-checks the inputs and stores the dataset. */
function stockSheet() {
  const sc = state.scenario;
  if (!sc) return;
  const draft: Json[] = sc.lots.map((l: Json) => ({ ...l }));
  const bad = new Set<number>();
  let dirty = false;
  const godowns = sc.godowns.map((g: Json): [string, string] => [g.godown_id, g.name || g.godown_id]);
  const list = h('div', {});
  const status = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const save = h('button', { class: 'btn primary block', disabled: true, onclick: () => {
    sc.lots = draft;
    dirty = false;
    scheduleValidate(0);
    persist();
    toast('Stock saved');
    paintStatus();
    (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
  } }, 'Save stock');
  const discard = h('button', { class: 'btn block', onclick: () => (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close() }, 'Cancel');
  const paintStatus = () => {
    save.disabled = !dirty || bad.size > 0;
    status.textContent = bad.size ? `${bad.size} value(s) must be whole numbers of 0 or more.` : dirty ? 'Unsaved changes.' : 'No changes yet.';
    status.className = bad.size ? 'small bad-text' : 'small muted';
  };
  const edit = (i: number, key: string, input: HTMLInputElement) => {
    const raw = input.value.trim();
    const ok = /^\d+$/.test(raw);
    input.setAttribute('aria-invalid', String(!ok));
    const k = i * 2 + (key === 'qty_units' ? 0 : 1);
    if (ok) { draft[i][key] = Number(raw); bad.delete(k); } else bad.add(k);
    dirty = true;
    paintStatus();
  };
  const draw = () => {
    const q = search.trim().toLowerCase();
    const rows = draft.map((l, i) => ({ l, i }))
      .filter(({ l }) => (!godownFilter || l.godown_id === godownFilter) && (!q || `${l.lot_id} ${l.product_id}`.toLowerCase().includes(q)));
    let n = 15;
    const paint = () => mount(list,
      h('p', { class: 'muted small' }, `${num(rows.length)} lots`),
      h('ul', { class: 'lots' }, rows.slice(0, n).map(({ l, i }) => h('li', {},
        h('div', { class: 'lot-id' }, h('strong', {}, l.product_id), h('span', { class: 'muted small' }, `${godownName(l.godown_id)} · ${l.lot_id}`)),
        h('label', { class: 'mini' }, 'Units', h('input', { type: 'text', inputMode: 'numeric', value: String(l.qty_units), 'aria-label': `Units for ${l.lot_id}`, oninput: (e: Event) => edit(i, 'qty_units', e.target as HTMLInputElement) })),
        h('label', { class: 'mini' }, 'Days left', h('input', { type: 'text', inputMode: 'numeric', value: String(l.remaining_life_days), 'aria-label': `Days of shelf life left for ${l.lot_id}`, oninput: (e: Event) => edit(i, 'remaining_life_days', e.target as HTMLInputElement) })),
      ))),
      rows.length > n && h('button', { class: 'btn ghost', onclick: () => { n += 50; paint(); } }, `Show more (${num(rows.length - n)} left)`));
    paint();
  };
  openSheet('Edit depot stock',
    h('p', { class: 'muted small' }, 'Change units or days of shelf life left, then tap Save. Saved stock is kept on this phone and used for the next plan.'),
    h('div', { class: 'grid2' },
      select([['', 'All depots'], ...godowns], godownFilter, (v) => { godownFilter = v; draw(); }, 'Filter by depot'),
      h('input', { type: 'search', placeholder: 'Search product or lot', value: search, 'aria-label': 'Search lots', oninput: (e: Event) => { search = (e.target as HTMLInputElement).value; draw(); } })),
    list,
    h('div', { class: 'sheet-actions' }, status, h('div', { class: 'grid2' }, discard, save)));
  draw();
  paintStatus();
}

function issues(report: Json) {
  const errs = report?.errors ?? [], warns = report?.warnings ?? [];
  const sc = state.scenario;
  return [
    errs.length > 0 && h('div', { class: 'alert bad', role: 'alert' },
      h('strong', {}, errs.length === 1 ? 'One thing in your data needs fixing before planning:' : `${errs.length} things in your data need fixing before planning:`),
      h('ul', { class: 'plain-list' }, errs.slice(0, 30).map((e: Json) => h('li', {}, issueText(e, sc)))),
      errs.length > 30 && h('p', { class: 'small' }, `…and ${errs.length - 30} more.`),
      h('p', { class: 'small' }, 'Correct them in your spreadsheet and upload it again, or use Edit depot stock.')),
    warns.length > 0 && h('details', {}, h('summary', { class: 'small' }, 'Good to know about your data'),
      noteGroups(warns).map((g) => h('details', { class: 'small' }, h('summary', {}, g.title),
        h('ul', { class: 'plain-list' }, g.items.slice(0, 50).map((w: Json) => h('li', {}, issueText(w, sc))))))),
  ];
}

function drawStatus() {
  const r = state.report;
  const valid = !state.validating && r?.valid;
  const sc = state.scenario;
  statusBox.hidden = !sc; // nothing to check or plan until a dataset is loaded
  if (!sc) return mount(statusBox);
  mount(statusBox,
    h('div', { class: 'row between' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Ready to plan'),
        h('strong', {}, sc ? `${sc.godowns.length} depots · ${sc.towns.length} towns · ${sc.products.length} products` : 'Loading...')),
      state.validating ? badge('Checking...', 'warn') : valid ? badge('Data looks good', 'ok') : badge('Needs fixing', 'bad')),
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
      per?.aria && per?.baseline_a && [h('h3', {}, 'Over 8 past weeks of real sales'),
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
      !aria && h('div', { class: 'alert warn' }, 'ARIA could not make a plan that passes every safety check tonight, so this is the usual method\'s plan.'),
      h('div', { class: 'split' },
        h('div', {}, h('span', { class: 'small' }, 'Freight'), h('strong', {}, rupees(shown.metrics?.freight_paise))),
        h('div', {}, h('span', { class: 'small' }, 'Shortages'), h('strong', {}, num(shorts.length)))),
      h('div', { class: 'tiles' },
        h('button', { class: 'tile', disabled: !allocs.length, onclick: () => pickSheet() }, icon('list'), 'Pick lists'),
        h('button', { class: 'tile', disabled: stale || !verified, onclick: () => shareSheet(shown, resp) }, icon('share'), 'Share plan'),
        h('button', { class: 'tile', onclick: stockSheet }, icon('edit'), 'Edit stock')),
      stale && h('p', { class: 'note' }, 'Inputs changed after planning. Plan again before sharing.'),
      h('p', { class: 'note' }, `Planned on this phone in ${(resp.solve_ms / 1000).toFixed(1)} s · ${shown === aria ? 'ARIA' : 'usual method'}`)),
    resp.dashboard?.[shown === aria ? 'aria' : 'baseline_a'] && h('section', { class: 'card' }, networkDiagram(resp.dashboard[shown === aria ? 'aria' : 'baseline_a'])),
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
      [['town', 'Town'], ['product_id', 'Product'], ['shortfall_units', 'Short'], ['why', 'Why']], (r) => explainSheet(shown, r)))),
    h('div', { class: 'section-head' }, h('h2', {}, 'Extra stock in towns', h('span', { class: 'count' }, num(excess.length))), h('span', { class: 'small muted' }, 'Above need')),
    rows(excess, (x) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, x.product_id), h('span', {}, `${townName(x.town_id)} · has ${num(x.on_hand_units)}, needs ${num(x.target_units)}`)),
      h('div', { class: 'row-end' }, h('strong', {}, num(x.excess_units)), h('span', {}, 'extra'))),
    'No town holds more than it needs.', () => openSheet('Extra stock in towns', pagedTable(excess, [['town_id', 'Town'], ['product_id', 'Product'], ['on_hand_units', 'On hand'], ['target_units', 'Needs'], ['excess_units', 'Extra']])), 4),
    h('details', { class: 'card' }, h('summary', {}, 'Demand forecasts'), forecasts()),
    h('details', { class: 'card' }, h('summary', {}, 'Every shipment'),
      aria && segmented([['aria', 'ARIA plan'], ['baseline_a', 'Usual method']], show, (v) => { show = v as any; drawResult(); }, 'Plan shown'),
      allocs.length ? pagedTable(allocs, [
        ['godown_id', 'Depot', (v) => godownName(v)], ['town_id', 'Town', (v) => townName(v)], ['product_id', 'Product'], ['units', 'Units'],
        ['freight_paise', 'Freight'], ['life_on_arrival', 'Days left on arrival'],
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

const svcrName = (_p: Json, resp: Json) => `aria_${String(state.scenarioId).replace(/[^\w-]+/g, '_').slice(0, 40)}_${resp.scenario_hash.slice(0, 8)}.svcr`;

/** Share the plan file: straight to drivers inside the app, or to any other app as a .svcr file. */
function shareSheet(p: Json, resp: Json) {
  const me = state.me;
  const drivers = state.drivers.filter((d) => d.active);
  const picked = new Set<string>();
  const send = h('button', { class: 'btn primary block', disabled: true }, 'Choose at least one driver');
  const paint = () => {
    send.disabled = !picked.size;
    send.textContent = picked.size ? `Send to ${picked.size} driver${picked.size > 1 ? 's' : ''}` : 'Choose at least one driver';
  };
  send.onclick = async () => {
    send.disabled = true;
    send.textContent = 'Sending...';
    try {
      const bytes = await engine.exportSvcr(p.plan_id);
      const depots = new Set((p.allocations as Json[]).map((a) => a.godown_id));
      await sendPlanFile(me!.orgId, drivers.filter((d) => picked.has(d.uid)).map((d) => ({ uid: d.uid, name: d.name })), svcrName(p, resp), bytes,
        { dataset: state.scenarioId, day: state.scenario?.day || new Date().toISOString().slice(0, 10), units: (p.allocations as Json[]).reduce((n, a) => n + a.units, 0), depots: depots.size });
      toast(`Plan file sent to ${picked.size} driver${picked.size > 1 ? 's' : ''}`);
      (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
    } catch (e) {
      toast(errorText(e));
      paint();
    }
  };
  openSheet('Share plan',
    h('h3', {}, 'Send to drivers in the app'),
    me?.role === 'admin' && drivers.length
      ? [h('ul', { class: 'rows' }, drivers.map((d) => h('li', {}, h('label', { class: 'check' },
          h('input', { type: 'checkbox', 'aria-label': `Send to ${d.name}`, onchange: (e: Event) => { (e.target as HTMLInputElement).checked ? picked.add(d.uid) : picked.delete(d.uid); paint(); } }),
          h('span', {}, h('strong', {}, d.name), d.vehicle ? ` · ${d.vehicle}` : ''))))), send,
        h('p', { class: 'note' }, 'They open it under Plans in their app and see what goes where.')]
      : h('p', { class: 'note' }, 'No active drivers yet. Share your team code from the Team screen.'),
    h('h3', {}, 'Or share as a file'),
    h('button', { class: 'btn block', onclick: async () => {
      try { await shareFile(svcrName(p, resp), await engine.exportSvcr(p.plan_id), SVCR_MIME); } catch { toast('Sharing did not work. Please try again.'); }
    } }, icon('share'), 'Share to WhatsApp, email...'));
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
  const went: Json[] = reason?.facts?.recipients ?? [];
  openSheet(head,
    reason && h('div', { class: 'alert warn' }, h('strong', {}, plainReason(reason)),
      went.length > 0 && h('p', { class: 'small' }, `The stock went to: ${went.map((r) => `${townName(r.town_id)} (${num(r.units)})`).join(', ')}.`)),
    kv([['Already in town', `${num(c.on_hand_units)} units`], ['Sent tonight', `${num(c.shipped_units)} units`], ['Transport cost per unit', rupees(c.freight_per_unit_paise)],
      ['Share of demand worth covering on this route', c.tau_star == null ? '-' : `${Math.round(c.tau_star * 100)}%`]]),
    c.forecast && [h('h3', {}, 'Expected demand'),
      h('p', { class: 'muted small' }, `Most likely ${fmt('q', c.forecast.quantiles[4])} units; almost surely between ${fmt('q', c.forecast.quantiles[0])} and ${fmt('q', c.forecast.quantiles[8])}. Forecast by: ${forecastLabel(c.town_id, c.product_id)}.`),
      bandBar(c.forecast.quantiles, c.forecast.quantiles[8] || 1)],
    c.life_on_arrival?.length > 0 && [h('h3', {}, 'Stock sent'), table(c.life_on_arrival,
      [['godown_id', 'From', (v) => godownName(v)], ['lot_id', 'Lot'], ['units', 'Units'], ['life_on_arrival', 'Days left on arrival']])],
  );
}

function forecasts() {
  const rows: Json[] = state.scenario?.demand ?? [];
  const max = Math.max(1, ...rows.map((d) => d.quantiles[8] ?? 0));
  const model = (r: Json) => forecastLabel(r.town_id, r.product_id);
  return [h('p', { class: 'muted small' }, `Demand per town and product: the bar shows the likely range (darkest = most likely half), the tick the single most likely number. Forecast by: ${forecastLabel()}.`),
    h('ul', { class: 'list-cards' }, rows.slice(0, 40).map((d) => h('li', {},
      h('div', { class: 'row between small' }, h('span', {}, `${townName(d.town_id)} · ${d.product_id}`), h('span', { class: 'muted' }, `about ${fmt('q', d.quantiles[4])}`)),
      bandBar(d.quantiles, max)))),
    rows.length > 40 && h('h3', {}, 'All rows'),
    rows.length > 40 && pagedTable(rows, [['town_id', 'Town', (v) => townName(v)], ['product_id', 'Product'], ['quantiles', 'Most likely', (q) => fmt('q', q[4])],
      ['point', 'Range', (_, r) => `${fmt('q', r.quantiles[0])} to ${fmt('q', r.quantiles[8])}`], ['sigma', 'Forecast by', (_, r) => model(r)]], undefined, 30)];
}
