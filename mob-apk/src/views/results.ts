// Results dashboard for tonight's plan: KPI cards, the network, where units go (donut), why towns are short
// (donut), ARIA against the usual method (bars, % change), units per town against demand (bars), shelf life on
// arrival (histogram), how the plan was made (flowchart, with the real counts), trends (sales history from the CSV,
// or the What-if steps) and the What-if comparison. Data / calculated / projection are labelled. When a past-demand
// replay is bundled for the dataset's network it is shown last, labelled as a historical test.
import { donut, hbars, histogram, kpi as kpiCard, line, seriesColor } from '../charts';
import { engine } from '../engine';
import { KPIS, kpi } from '../kpis';
import { isStale, state } from '../state';
import { Json, badge, errorBox, fmt, h, icon, mount, num, rupees, segmented, table } from '../ui';
import { comparisonCharts, sweepCharts } from './lab';
import { networkDiagram, truck } from './network';
import { planTonight, townName } from './plan';

const POLICY: Record<string, string> = { aria: 'ARIA', baseline_a: 'Usual method (a)', b_prime: 'Forecast + buffer (b′)', b_dprime: 'Forecast + FEFO (b″)', hindsight: 'Perfect hindsight (c)' };
let which: 'aria' | 'baseline_a' = 'aria';
let root: HTMLElement;
let replayDoc: Json = null;
let replayFor = '';
let point = '';

export function render(r: HTMLElement) {
  root = r;
  update();
}

export function update() {
  if (!root) return;
  const cur = state.plan;
  if (!state.scenario) return mount(root, h('section', { class: 'card' }, h('p', { class: 'eyebrow' }, 'No data yet'), h('p', { class: 'small' }, 'Load your CSV on Home, then plan. The dashboard is built from that plan.')));
  if (!cur) {
    return mount(root, h('section', { class: 'card' }, h('p', { class: 'eyebrow' }, 'Nothing planned yet'),
      h('p', { class: 'small' }, `Plan tonight for ${state.scenarioId} and the dashboard fills in.`),
      h('button', { class: 'btn primary block', disabled: !state.report?.valid || state.planBusy, onclick: planTonight }, state.planBusy ? 'Planning on this phone...' : ['Plan tonight', icon('arrow')])),
      historyCard(), replaySection());
  }
  const resp = cur.resp;
  if (!resp.aria) which = 'baseline_a';
  const dash = resp.dashboard?.[which];
  const other = resp.dashboard?.[which === 'aria' ? 'baseline_a' : 'aria'];
  if (!dash) return mount(root, errorBox('This plan has no dashboard data. Plan again.'));
  const stale = isStale(resp);
  const k = dash.kpis, o = other?.kpis;
  const vs = (key: string) => {
    if (!o || k[key] == null || o[key] == null) return null;
    const d = k[key] - o[key];
    if (Math.abs(d) < 1e-9) return { text: 'same as other method', kind: '' as const };
    const better = (d < 0) === kpi(key).lowerIsBetter;
    return { text: `${kpi(key).diff(d)} vs ${which === 'aria' ? 'usual' : 'ARIA'}`, kind: (better ? 'ok' : 'warn') as 'ok' | 'warn' };
  };
  mount(root,
    h('section', { class: `card${stale ? ' stale' : ''}` },
      h('div', { class: 'row between' }, h('div', {}, h('p', { class: 'eyebrow' }, "Tonight's plan"), h('strong', {}, state.scenarioId)),
        stale ? badge('Out of date', 'bad') : k.verified ? badge('Verified', 'ok') : badge('Not verified', 'bad')),
      resp.aria && segmented([['aria', 'ARIA plan'], ['baseline_a', 'Usual method']], which, (v) => { which = v as any; update(); }, 'Plan shown'),
      h('ul', { class: 'legend-kinds small' },
        h('li', {}, badge('Data', ''), ' from your CSV'), h('li', {}, badge('Calculated', 'ok'), ' by the planner'), h('li', {}, badge('Projection', 'warn'), ' from What-if')),
      stale && h('p', { class: 'note' }, 'Inputs changed after planning. Plan again to refresh every chart.')),
    h('div', { class: 'section-head' }, h('h2', {}, 'Key numbers'), badge('Calculated', 'ok')),
    h('div', { class: 'kpi-grid' },
      KPIS.filter((x) => k[x.key] != null && x.key !== 'expected_lost_units').map((x) => kpiCard(x.label, x.fmt(k[x.key]), null, vs(x.key))),
      kpiCard('Shortage rows', num(k.shortfall_rows), 'town and product pairs short')),
    h('section', { class: 'card' }, networkDiagram(dash)),
    h('div', { class: 'viz-grid' },
      h('section', { class: 'card' }, donut('Where tonight\'s units come from', dash.depots.map((d: Json, i: number) => ({ label: d.name, value: d.shipped, color: seriesColor(dash.depots.length > 8 && i >= 7 ? -1 : i) })), num, 'units')),
      h('section', { class: 'card' }, donut('Why towns are short', dash.shortfall_by_reason.map((r: Json, i: number) => ({ label: r.reason, value: r.units, color: seriesColor(i) })), num, 'units short'))),
    other && h('section', { class: 'card' }, methodChart(dash, other)),
    h('section', { class: 'card' }, townChart(dash)),
    h('section', { class: 'card' }, histogram('Shelf life left when stock arrives', dash.life_on_arrival.map((b: Json) => ({ label: b.label, value: b.units })), num, 'days left', 'units',
      (i) => dash.life_on_arrival[i].to <= 2),
      h('p', { class: 'note' }, 'Orange bars: 2 days or less left on arrival. Many units there means a higher risk of expiry in town.')),
    h('section', { class: 'card' }, flowchart(dash.pipeline, k, resp)),
    historyCard(),
    whatIfCard(),
    depotTable(dash),
    replaySection(),
  );
}

function methodChart(a: Json, b: Json) {
  const [mine, theirs] = which === 'aria' ? [a.kpis, b.kpis] : [b.kpis, a.kpis];
  const keys = KPIS.filter((x) => mine[x.key] != null && theirs[x.key] && x.key !== 'capacity_utilisation');
  return [hbars('ARIA compared with the usual method', keys.map((x) => x.label),
    [{ name: 'ARIA vs usual (%)', values: keys.map((x) => ((mine[x.key] - theirs[x.key]) / Math.abs(theirs[x.key])) * 100) }],
    (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`, '% difference, ARIA against the usual method', 'Left of 0 = ARIA lower. Lower is better for costs, losses and shortages; higher is better for demand met and units shipped.'),
  table(keys.map((x) => ({ m: x.label, a: x.fmt(mine[x.key]), u: x.fmt(theirs[x.key]) })), [['m', 'Measure'], ['a', 'ARIA'], ['u', 'Usual method']])];
}

function townChart(d: Json) {
  const towns: Json[] = [...d.towns].sort((x, y) => y.median_demand - x.median_demand).slice(0, 15);
  return [hbars('Units sent to each town and its expected demand', towns.map((t) => t.name),
    [{ name: 'Sent tonight (calculated)', values: towns.map((t) => t.received) },
      { name: 'Expected demand, median (data)', values: towns.map((t) => Math.round(t.median_demand)), dash: true },
      { name: 'Short (calculated)', values: towns.map((t) => t.short) }], num, 'units',
    d.towns.length > 15 ? `Top 15 of ${d.towns.length} towns by demand` : 'Sent can exceed one day\'s demand: stock also covers the days until the next delivery.')];
}

function flowchart(p: Json, k: Json, resp: Json) {
  const step = (title: string, body: string, kind = '') => h('li', { class: `step ${kind}` }, h('strong', {}, title), h('span', {}, body));
  return h('figure', { class: 'viz' }, h('figcaption', {}, h('strong', {}, 'How this plan was made'), h('span', { class: 'small muted' }, 'Each step with the numbers from tonight')),
    h('ol', { class: 'flow' },
      step('1 · Your data', `${num(p.products)} products · ${num(p.lots)} stock lots · ${num(p.active_routes)} of ${num(p.routes)} routes open · ${num(p.demand_pairs)} demand forecasts`),
      step('2 · Worth of each unit', 'For every route, the sale a unit protects is weighed against its freight and the risk it expires (service level τ*).'),
      step('3 · Best total value', `Linear program, stage 1: ${p.stage1}`, p.stage1 === 'Optimal' || p.stage1 === 'n/a' ? 'ok' : 'warn'),
      step('4 · Freshest stock first', `Stage 2 tie-break: ${p.stage2}`, p.stage2 === 'Optimal' || p.stage2 === 'n/a' ? 'ok' : 'warn'),
      step('5 · Independent check', p.verified ? 'All 8 safety rules passed' : `${p.violations} rule(s) failed: plan withheld`, p.verified ? 'ok' : 'bad'),
      step('6 · Plan', `${num(p.rows)} pick rows · ${num(k.units_shipped)} units · ${rupees(k.freight_paise)} freight · planned in ${(resp.solve_ms / 1000).toFixed(1)} s`, 'ok')));
}

function historyCard() {
  const hist = state.data?.history;
  if (!hist?.dates?.length) return null;
  return h('section', { class: 'card' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Sales history'), badge('Data', '')),
    line('Daily units sold, all towns and products', hist.dates.map((d: string) => d.slice(5)), [{ name: 'Units sold', values: hist.qty }], (v) => num(Math.round(v)), 'date (MM-DD)', 'Units sold per day',
      `${hist.dates[0]} to ${hist.dates[hist.dates.length - 1]}, from the sales table in your CSV`));
}

function whatIfCard() {
  const res = state.lab.result, sw = state.lab.sweep;
  if (!res && !sw) {
    return h('section', { class: 'card' }, h('div', { class: 'section-head' }, h('h2', {}, 'Scenarios'), badge('Projection', 'warn')),
      h('p', { class: 'note' }, 'Build scenarios in What if (demand up, less capacity, a closed route...) and their comparison and step-by-step trends appear here too.'));
  }
  return h('section', { class: 'card' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Scenarios against the baseline'), badge('Projection', 'warn')),
    res && res.resp.scenario_hash !== state.report?.scenario_hash && h('p', { class: 'note' }, 'Computed for earlier inputs. Compare again in What if.'),
    res && comparisonCharts(res.resp),
    sw && [h('h3', {}, 'Step by step'), sweepCharts(sw)]);
}

function depotTable(d: Json) {
  return h('details', { class: 'card' }, h('summary', {}, 'Depot and route table'),
    table(d.depots, [['name', 'Depot'], ['shipped', 'Ships'], ['stock', 'Stock'], ['stock_used', 'Stock sent', (v) => (v == null ? '-' : `${(v * 100).toFixed(0)}%`)],
      ['capacity', 'Capacity', (v) => (v == null ? 'no limit' : num(v))], ['utilisation', 'Capacity used', (v) => (v == null ? '-' : `${(v * 100).toFixed(0)}%`)]]),
    table(d.flows, [['godown_id', 'From', (v) => d.depots.find((x: Json) => x.godown_id === v)?.name ?? v], ['town_id', 'To', (v) => townName(v)],
      ['units', 'Units'], ['products', 'Products'], ['freight_paise', 'Freight', rupees]]));
}

// ---------- historical replay (bundled for the sample networks only) ----------
function replaySection() {
  const net = state.networkId;
  const box = h('div', {});
  if (replayFor !== net) { replayFor = net; replayDoc = null; point = ''; }
  const draw = () => {
    const doc = replayDoc;
    if (!doc || doc.missing || !doc.conservation_ok || state.data?.source !== 'sample') return mount(box);
    point = doc.freight_point;
    const per = doc.per_policy ?? {};
    const names = Object.keys(per);
    const days = Object.values(doc.window_days ?? {}).map((w: any) => `${w[0]} to ${w[1]}`).join(', ');
    mount(box, h('details', { class: 'card' },
      h('summary', {}, 'Historical test: every method on past demand'),
      h('p', { class: 'small' }, `Replayed on real demand (${days}) for this sample network, from the same stock. One bill each: freight + holding + write-off + lost sales. Lower is better.`),
      badge('Historical replay', ''),
      segmented((doc.available_freight_points ?? [point]).map((p: string): [string, string] => [p, p === 'own' ? 'Each route\'s own truck' : `All ${truck(p).toLowerCase()}`]), point,
        async (v) => { replayDoc = await engine.replay(net, v); draw(); }, 'Freight rate'),
      hbars('Total bill per method', names.map((n) => POLICY[n] ?? n), [{ name: 'Bill', values: names.map((n) => per[n].bill_paise / 100) }], (v) => rupees(v * 100), '₹, lower is better'),
      hbars('Demand met per method', names.map((n) => POLICY[n] ?? n), [{ name: 'Fill rate', values: names.map((n) => per[n].fill_rate * 100) }], (v) => `${v.toFixed(1)}%`, '%, higher is better'),
      h('h3', {}, 'Tests fixed before the results'),
      kpiRow('ARIA − forecast + FEFO (b″) bill', doc.kpi1, true, 'Headline: upper 95% CI below 0'),
      kpiRow('ARIA − forecast + buffer (b′) bill', doc.kpi1b, true, 'Value of calibrated forecasting'),
      kpiRow('ARIA − usual method (a) bill', doc.kpi1c, true, 'Against current practice'),
      kpiRow('Cost per unit sold − usual method', doc.kpi3, true, 'Upper 95% CI ≤ 0'),
      kpiRow('Write-off units − usual method', doc.kpi4, false, 'Upper 95% CI ≤ 0')));
  };
  if (replayDoc === null) {
    replayDoc = { missing: true };
    engine.replay(net, point || undefined).then((d) => { replayDoc = d; draw(); }).catch(() => { replayDoc = { missing: true }; });
  } else draw();
  return box;
}

function kpiRow(title: string, k: Json, money: boolean, rule: string) {
  if (!k) return null;
  const f = (v: number) => (money ? rupees(v) : fmt('units', v));
  const diff = k.diff_paise ?? k.diff ?? k.diff_paise_per_unit;
  return h('div', { class: 'kpi' },
    h('div', {}, h('strong', {}, title), h('div', { class: 'muted small' }, rule), h('div', {}, `${f(diff)}  ·  95% CI ${f(k.ci_low)} to ${f(k.ci_high)}`)),
    'pass' in k && (k.pass ? badge('PASS', 'ok') : badge('not met', 'warn')));
}
