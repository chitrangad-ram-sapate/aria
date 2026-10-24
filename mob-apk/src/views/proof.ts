// Proof view: fair-replay bill per policy, pre-registered KPIs with 95% CIs, freight-point selector, exposé.
import { engine } from '../engine';
import { state } from '../state';
import { Json, badge, errorBox, fmt, h, mount, rupees, segmented, table } from '../ui';

const POLICY: Record<string, string> = { aria: 'ARIA', baseline_a: '(a) rule-based', b_prime: 'b′', b_dprime: 'b″', hindsight: '(c) hindsight' };
const POINT: Record<string, string> = { own: 'Own class', road_avg: '₹3.78/t-km', '6t': '₹11.03/t-km', '55t': '₹1.51/t-km' };
let point = '';
let pointNet = '';
let seq = 0;

export async function render(root: HTMLElement) {
  const net = state.networkId;
  if (net !== pointNet) { point = ''; pointNet = net; }
  mount(root, intro(), h('p', { class: 'muted' }, 'Loading...'));
  const my = ++seq;
  let doc: Json;
  try {
    doc = await engine.replay(net, point || undefined);
  } catch (e: any) {
    if (my === seq) mount(root, intro(), errorBox(e.message));
    return;
  }
  if (my !== seq) return;
  const body: any[] = [];
  if (doc.missing) {
    body.push(h('div', { class: 'card' }, h('p', {}, 'Replay results not built yet'), h('p', { class: 'muted small' }, `No replay is bundled for network "${net}". Run make replay, then rebuild the app.`)));
  } else if (!doc.conservation_ok) {
    body.push(errorBox('Conservation or leakage check failed for this replay. Results withheld.'));
  } else {
    point = doc.freight_point;
    const points = (doc.available_freight_points ?? [doc.freight_point]).map((p: string): [string, string] => [p, POINT[p] ?? p]);
    const per = Object.entries(doc.per_policy ?? {}).map(([name, p]: [string, any]) => ({ policy: POLICY[name] ?? name, ...p }));
    body.push(
      h('section', { class: 'card' },
        h('h2', {}, 'Freight rate used'),
        segmented(points, point, (v) => { point = v; render(root); }, 'Freight point'),
        h('div', { class: 'row wrap' }, badge(`network ${doc.network}`), badge(`windows ${fmt('w', doc.windows)}`), badge(`products ${doc.products}`), badge('conservation ok', 'ok'))),
      h('section', { class: 'card' }, h('h2', {}, 'Total cost per method'),
        table(per, [['policy', 'Policy'], ['bill_paise', 'Bill'], ['freight', 'Freight', rupees], ['holding', 'Holding', rupees], ['writeoff', 'Write-off', rupees],
          ['lost_margin', 'Lost margin', rupees], ['fill_rate', 'Fill rate'], ['lost_units', 'Lost units'], ['writeoff_units', 'Write-off units']])),
      h('section', { class: 'card' }, h('h2', {}, 'Tests fixed before the results'),
        kpi('KPI-1: ARIA − b″ bill', doc.kpi1, true, 'Headline: upper 95% CI < 0'),
        kpi('KPI-1b: ARIA − b′ bill', doc.kpi1b, true, 'Value of calibrated forecasting'),
        kpi('KPI-1c: ARIA − (a) bill', doc.kpi1c, true, 'Against current practice'),
        kpi('KPI-3: cost per unit sold − (a)', doc.kpi3, true, 'Upper 95% CI ≤ 0'),
        kpi('KPI-4: write-off units − (a)', doc.kpi4, false, 'Upper 95% CI ≤ 0'),
        doc.kpi10 && 'pass' in doc.kpi10 && h('div', { class: 'kpi' }, h('div', {}, h('strong', {}, 'KPI-10'), h('div', { class: 'muted small' }, 'KPI-1 holds at ₹3.78 and ₹11.03')), doc.kpi10.pass ? badge('PASS', 'ok') : badge('not met', 'warn')),
        doc.gap_closed && h('div', { class: 'kpi' }, h('div', {}, h('strong', {}, '% of (a)-to-(c) gap closed'), h('div', { class: 'muted small' }, 'Display only')), h('span', { class: 'big' }, doc.gap_closed.display ?? 'n/a'))),
      expose(doc.expose),
    );
  }
  mount(root, intro(), body);
}

function intro() {
  return h('section', { class: 'card' }, h('p', { class: 'eyebrow' }, 'Does ARIA really save money?'),
    h('p', { class: 'small' }, 'Every method is replayed on the same 8 weeks of real demand, from the same stock, and pays one bill: freight + holding + write-off + lost sales. Lower is better.'));
}

function kpi(title: string, k: Json, money: boolean, rule: string) {
  if (!k) return null;
  const f = (v: number) => (money ? rupees(v) : fmt('units', v));
  const diff = k.diff_paise ?? k.diff ?? k.diff_paise_per_unit;
  return h('div', { class: 'kpi' },
    h('div', {}, h('strong', {}, title), h('div', { class: 'muted small' }, rule),
      h('div', {}, `${f(diff)}  ·  95% CI ${f(k.ci_low)} to ${f(k.ci_high)}`)),
    'pass' in k && (k.pass ? badge('PASS', 'ok') : badge('not met', 'warn')));
}

function expose(e: Json) {
  if (!e) return h('details', { class: 'card' }, h('summary', {}, 'Is the headline real?'), h('p', { class: 'muted' }, 'Exposé not included in this replay output.'));
  const lost = e.lost_units ?? {}, bill = e.bill_paise ?? {};
  const name = (p: string) => POLICY[p] ?? p;
  return h('details', { class: 'card', open: true }, h('summary', {}, 'Is the headline real?'),
    h('p', { class: 'muted small' }, 'The same replay scored two ways: lost units only vs the full-cost bill.'),
    e.message && h('p', {}, e.message),
    table(Object.keys(lost).map((p) => ({ policy: name(p), lost: lost[p], bill: bill[p] })), [['policy', 'Policy'], ['lost', 'Lost units'], ['bill', 'Full bill', rupees]]),
    h('p', {}, h('strong', {}, 'Ranked by lost units: '), (e.rank_by_lost_units ?? []).map(name).join(' < ')),
    h('p', {}, h('strong', {}, 'Ranked by full cost: '), (e.rank_by_full_cost ?? []).map(name).join(' < ')),
    e.fewer_lost_units_but_dearer?.length > 0 && table(e.fewer_lost_units_but_dearer.map((r: Json) => ({ policy: name(r.policy), than: name(r.than) })),
      [['policy', 'Fewer lost units but dearer'], ['than', 'than']]));
}
