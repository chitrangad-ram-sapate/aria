// Ask ARIA: a chat for what-if questions and how-to help. src/assistant.ts reads each question; this page re-plans
// on the phone with engine.compare and answers in units, rupees and %. Every scenario asked here is also kept in
// state.lab, so Results shows the comparison and the step-by-step trends too. All numbers come from the engine.
import { engine } from '../engine';
import { compact, hbars, kpi as kpiCard, line, seriesColor } from '../charts';
import { KPIS, chip, kpi } from '../kpis';
import { Change, Ctx, Intent, SWEEP, SweepParam, describe, scenarioName, toParams, understand } from '../assistant';
import { ChatMsg, currentHash, goTo, nextRid, state } from '../state';
import { Json, badge, errorBox, h, icon, mount, num, rupees, table } from '../ui';
import { truck } from './network';
import { godownName, townName } from './plan';

let root: HTMLElement;
let drawnHash: string | null | undefined;
let queue: Promise<unknown> = Promise.resolve();
let msgSeq = 0;

const lab = state.lab;
const sc = () => state.scenario;
const LOGO = `${import.meta.env.BASE_URL}logo.png`;

// ---------- the names in the loaded data, for the reader ----------
let ctxFor: Json = undefined;
let ctxVal: Ctx = { towns: [], depots: [], products: [], routes: [] };
function ctx(): Ctx {
  const s = sc();
  if (s === ctxFor) return ctxVal;
  ctxFor = s;
  ctxVal = !s ? { towns: [], depots: [], products: [], routes: [] } : {
    towns: s.towns.map((t: Json) => ({ kind: 'town', id: t.town_id, name: t.name || t.town_id })),
    depots: s.godowns.map((g: Json) => ({ kind: 'depot', id: g.godown_id, name: g.name || g.godown_id })),
    products: s.products.map((p: Json) => ({ kind: 'product', id: p.product_id, name: p.product_id, group: p.category })),
    routes: s.routes.map((r: Json) => ({ g: r.godown_id, t: r.town_id, km: r.road_km, active: r.active })),
  };
  return ctxVal;
}

// ---------- page ----------
const input = h('input', { type: 'text', class: 'ask-input', placeholder: 'Ask "what if..."', 'aria-label': 'Ask ARIA', enterKeyHint: 'send', autocomplete: 'off', maxLength: 300 });
const form = h('form', { class: 'ask-bar', onsubmit: (e: Event) => { e.preventDefault(); send(input.value); } },
  input, h('button', { type: 'submit', class: 'ask-send', 'aria-label': 'Send' }, icon('arrow')));
const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with ARIA' });
const tips = h('div', { class: 'chips ask-tips', 'aria-label': 'Suggested questions' });

export function render(r: HTMLElement) {
  root = r;
  drawLog();
  mount(root, log, h('div', { class: 'ask-dock' }, tips, form));
}

export function update() {
  if (root && currentHash() !== drawnHash) drawLog(); // data changed or was checked: refresh the "out of date" notes
}

function drawLog() {
  drawnHash = currentHash();
  const msgs = lab.chat.length ? lab.chat : [intro()];
  mount(log, msgs.map(bubble));
  drawTips();
}

function intro(): ChatMsg {
  if (!sc()) {
    return { id: 0, from: 'aria', text: 'Hi, I am ARIA. Load your data on Home first, then ask me what would happen tonight if something changes. You can also ask me how to use the app.',
      actions: [{ label: 'Go to Home', run: () => goTo('plan') }] };
  }
  return { id: 0, from: 'aria', text: 'Hi, I am ARIA. Ask me what would happen tonight if something changes: more or less demand, a closed road, dearer freight, lost stock or less depot capacity. I plan again on this phone and tell you what changes. You can also ask me how to use the app.' };
}

function bubble(m: ChatMsg) {
  if (m.from === 'me') return h('div', { class: 'msg me' }, h('p', { class: 'bubble' }, m.text));
  return h('div', { class: 'msg aria' }, h('img', { class: 'msg-face', src: LOGO, alt: '' }),
    h('div', { class: 'bubble' },
      m.text && h('p', {}, m.text),
      m.lines?.length && h('ul', { class: 'said' }, m.lines.map((l) => h('li', {}, l))),
      m.notes?.map((n) => h('p', { class: 'note' }, n)),
      m.busy && h('p', { class: 'typing' }, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), m.busy),
      m.error && errorBox(m.error),
      m.body?.(),
      m.actions?.length && h('div', { class: 'msg-actions' }, m.actions.map((a) => h('button', { class: 'btn small', onclick: a.run }, a.label)))));
}

function drawTips() {
  mount(tips, suggestions().map((q) => h('button', { class: 'chip plain', onclick: () => send(q) }, q)));
}

function suggestions(): string[] {
  const s = sc();
  if (!s) return ['How do I load my data?', 'What can you ask?', 'How do I send trips?'];
  const c = ctx();
  const town = [...s.towns].sort((a: Json, b: Json) => (b.population ?? 0) - (a.population ?? 0))[0];
  const townN = town?.name || town?.town_id || 'a town';
  const depotN = (c.depots[0]?.name ?? 'a depot').replace(/\s*\(.*\)$/, '').replace(/\s+(MIDC|Depot|Godown|Warehouse)$/i, '');
  const last = lab.last as Change[] | null;
  if (last?.length) {
    const hasNumber = last.some((x) => x.topic !== 'close' && x.topic !== 'restrict');
    return [...(hasNumber ? ['What about 40%?'] : []), 'Also close the longest route', 'Also freight 25% dearer', ...(lab.variants.length > 1 ? ['Which option is best?'] : []), 'Undo'];
  }
  return [`What if demand goes up 20% in ${townN}?`, 'Close the longest route', 'Freight 25% dearer', `Lose 20% of stock at ${depotN}`,
    'Which towns are short tonight?', 'Demand from -20% to 40% step by step', 'How do I send trips?'];
}

function scrollDown() {
  requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' as ScrollBehavior : 'smooth' }));
}

function say(m: Omit<ChatMsg, 'id'>): ChatMsg {
  const msg = { ...m, id: ++msgSeq } as ChatMsg;
  lab.chat.push(msg);
  if (lab.chat.length > 80) lab.chat.splice(0, lab.chat.length - 80);
  if (root) { drawLog(); scrollDown(); }
  return msg;
}

function redraw(m: ChatMsg, patch: Partial<ChatMsg>) {
  Object.assign(m, patch);
  if (root) { drawLog(); scrollDown(); }
}

// ---------- a question in, an answer out ----------
export function send(text: string) {
  const q = text.trim();
  if (!q) return;
  input.value = '';
  say({ from: 'me', text: q });
  queue = queue.then(() => answer(q)).catch(() => say({ from: 'aria', error: 'Something went wrong. Please ask again.' }));
}

async function answer(q: string) {
  const intent = understand(q, ctx(), lab.last as Change[] | null);
  const needsData = intent.kind === 'scenario' || intent.kind === 'sweep' || intent.kind === 'today' || intent.kind === 'compare';
  if (needsData && !sc()) return say({ from: 'aria', text: 'I need your data for that. Load your CSV (or a sample) on Home first.', actions: [{ label: 'Go to Home', run: () => goTo('plan') }] });
  if (needsData && (state.validating || !state.report)) await waitForCheck();
  if (needsData && !state.report?.valid) return say({ from: 'aria', text: 'Your data has problems, so I cannot plan with it yet. Fix them on Home and ask again.', actions: [{ label: 'Go to Home', run: () => goTo('plan') }] });
  switch (intent.kind) {
    case 'scenario': return scenario(q, intent);
    case 'sweep': return sweep(q, intent);
    case 'today': return today(intent.focus);
    case 'compare': return compareAll();
    case 'help': return help(intent.topic);
    case 'undo': return undo();
    case 'reset': return reset();
    default: return say({ from: 'aria', text: intent.ask ?? 'Sorry, I did not get that. I understand changes to demand, depot capacity, freight, stock, margin, roads and trucks, and questions about using the app.',
      actions: intent.ask ? undefined : ['Demand down 10%', 'Depots load 30% less', 'Close the longest route', 'What can you ask?'].map((q) => ({ label: q, run: () => send(q) })) });
  }
}

function waitForCheck() {
  return new Promise<void>((resolve) => {
    const t0 = Date.now();
    const tick = () => (!state.validating && state.report) || Date.now() - t0 > 20_000 ? resolve() : setTimeout(tick, 150);
    tick();
  });
}

/** Truck limits only count when the truck is smaller than the route's own; drop the others and say why. */
async function checkTrucks(changes: Change[], notes: string[]) {
  const out: Change[] = [];
  for (const c of changes) {
    if (c.topic !== 'restrict') { out.push(c); continue; }
    const keep: [string, string][] = [];
    for (const [g, t] of c.routes) {
      const opts = await engine.vehicleOptions(sc(), g, t);
      if (opts.includes(c.vehicle)) keep.push([g, t]);
      else {
        const now = sc().routes.find((r: Json) => r.godown_id === g && r.town_id === t)?.vehicle_class;
        notes.push(`${godownName(g)} → ${townName(t)} already uses ${truck(now).toLowerCase()} trucks, so that limit changes nothing there.`);
      }
    }
    if (keep.length) out.push({ ...c, routes: keep });
  }
  return out;
}

async function scenario(q: string, intent: Extract<Intent, { kind: 'scenario' }>) {
  const notes = [...intent.notes];
  const changes = await checkTrucks(intent.changes, notes);
  if (!changes.length) return say({ from: 'aria', text: 'Nothing to change there, so the plan stays the same as tonight.', notes });
  const name = scenarioName(changes, ctx());
  const msg = say({ from: 'aria', text: intent.followUp ? 'Added to the last one. I tried:' : 'I tried:', lines: changes.map((c) => describe(c, ctx())), notes, busy: 'Planning again on this phone...' });
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  lab.variants.push({ id, name, params: toParams(changes), changes });
  if (lab.variants.length > 8) lab.variants.shift(); // 8 scenarios + today keep every chart readable
  lab.selected = id;
  lab.last = changes;
  lab.busy = true;
  try {
    const r = await engine.compare(sc(), lab.variants.map((v) => ({ id: v.id, name: v.name, params: v.params })));
    if (r.valid === false) return redraw(msg, { busy: '', error: 'Your data needs fixing on Home first.' });
    lab.result = { rid: nextRid(), resp: r, key: variantKey() };
    const row = r.variants.find((v: Json) => v.id === id);
    if (!row || row.error) {
      lab.variants = lab.variants.filter((v) => v.id !== id);
      lab.last = null;
      return redraw(msg, { busy: '', error: 'This could not be planned. Try a smaller change, or check the route names.' });
    }
    redraw(msg, { busy: '', body: () => scenarioCard(row, r, q), actions: scenarioActions() });
  } catch {
    redraw(msg, { busy: '', error: 'Planning did not work this time. Please ask again.' });
  } finally {
    lab.busy = false;
  }
}

const variantKey = () => JSON.stringify([currentHash(), lab.variants.map((v) => [v.id, v.params])]);

function scenarioActions() {
  return [
    ...(lab.variants.length > 1 ? [{ label: `Compare all ${lab.variants.length}`, run: () => send('Compare all scenarios') }] : []),
    { label: 'See in Results', run: () => goTo('results') },
  ];
}

/** "Demand met falls from 96.0% to 91.2%" and the like, for the measures that moved. */
function headline(row: Json, base: Json): string {
  const part = (key: string, verbUp: string, verbDown: string) => {
    const d = row.diff?.[key], k = kpi(key);
    if (!d || d.better == null) return null;
    return `${k.label.replace(/ \(.*\)$/, '').toLowerCase()} ${d.abs > 0 ? verbUp : verbDown} from ${k.fmt(base.kpis[key])} to ${k.fmt(row.kpis[key])}`;
  };
  const bits = [part('expected_fill_rate', 'rises', 'falls'), part('expected_lost_margin_paise', 'rises', 'falls'), part('freight_paise', 'rises', 'falls')].filter(Boolean) as string[];
  if (!bits.length) return 'Tonight\'s plan would not change in any way that matters.';
  const s = bits.join('; ');
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

function townsHit(row: Json, base: Json) {
  const before = new Map(base.towns.map((t: Json) => [t.town_id, t.short]));
  const moved = row.towns.map((t: Json) => ({ name: t.name, d: t.short - Number(before.get(t.town_id) ?? 0) })).filter((t: Json) => t.d !== 0).sort((a: Json, b: Json) => b.d - a.d);
  if (!moved.length) return h('p', { class: 'small muted' }, 'No town gets more or less short.');
  return h('ul', { class: 'rows compact' }, moved.slice(0, 4).map((t: Json) => h('li', {},
    h('div', { class: 'row-main' }, h('strong', {}, t.name), h('span', {}, t.d > 0 ? `${num(t.d)} more units short` : `${num(-t.d)} fewer units short`)),
    badge(t.d > 0 ? 'Worse' : 'Better', t.d > 0 ? 'warn' : 'ok'))));
}

function stale(r: Json, q: string) {
  return r.scenario_hash !== currentHash() && [h('p', { class: 'note' }, 'Your data changed after this answer.'), h('button', { class: 'btn small', onclick: () => send(q) }, 'Ask again')];
}

function scenarioCard(row: Json, r: Json, q: string) {
  const base = r.baseline;
  return h('div', { class: r.scenario_hash !== currentHash() ? 'stale' : '' },
    h('div', { class: 'row between' }, h('strong', {}, row.name), row.verified ? badge('Verified plan', 'ok') : badge('Not verified', 'bad')),
    h('p', {}, headline(row, base)),
    row.recommended !== 'aria' && h('p', { class: 'note' }, 'ARIA could not make a safe plan here, so the usual method is shown.'),
    h('div', { class: 'kpi-grid' }, ['expected_fill_rate', 'expected_lost_margin_paise', 'freight_paise', 'shortfall_units'].filter((key) => row.kpis[key] != null)
      .map((key) => { const k = kpi(key); return kpiCard(k.label, k.fmt(row.kpis[key]), `tonight ${k.fmt(base.kpis[key])}`, chip(row.diff[key], k)); })),
    h('h3', {}, 'Towns that change most'),
    townsHit(row, base),
    h('details', {}, h('summary', {}, 'Charts and every measure'),
      comparisonCharts({ baseline: base, variants: [row] }),
      table(KPIS.filter((k) => base.kpis[k.key] != null).map((k) => ({ m: k.label, b: k.fmt(base.kpis[k.key]), v: row.kpis[k.key] == null ? '-' : k.fmt(row.kpis[k.key]) })),
        [['m', 'Measure'], ['b', 'Tonight'], ['v', row.name]])),
    h('p', { class: 'note' }, 'A forecast for this case, not a real result.'),
    stale(r, q));
}

// ---------- step by step ----------
async function sweep(q: string, intent: Extract<Intent, { kind: 'sweep' }>) {
  const cfg = SWEEP[intent.param];
  const { from, to, steps } = intent;
  const values = [...new Set(Array.from({ length: steps }, (_, i) => Math.round((from + ((to - from) * i) / (steps - 1)) * 10) / 10))];
  const neutral = intent.param === 'capacity_pct' ? 100 : 0;
  const msg = say({ from: 'aria', text: `${cfg.label} from ${from} to ${to} (${cfg.unit}), in ${values.length} steps.`, notes: intent.notes, busy: 'Planning each step...' });
  lab.sweepBusy = true;
  try {
    const r = await engine.compare(sc(), values.map((v) => ({ id: String(v), name: `${v}`, params: v === neutral ? {} : { [intent.param]: v } })));
    if (r.valid === false) return redraw(msg, { busy: '', error: 'Your data needs fixing on Home first.' });
    const sw = { param: intent.param, values, resp: r, key: JSON.stringify([currentHash(), intent.param, values]) };
    lab.sweep = sw;
    const ok = r.variants.filter((v: Json) => !v.error);
    const fill = (v: Json) => kpi('expected_fill_rate').fmt(v.kpis.expected_fill_rate);
    const text = ok.length >= 2 ? `Demand met goes from ${fill(ok[0])} at ${ok[0].name}${cfg.unit === '%' ? '%' : ''} to ${fill(ok[ok.length - 1])} at ${ok[ok.length - 1].name}${cfg.unit === '%' ? '%' : ''}.` : '';
    redraw(msg, { busy: '', body: () => h('div', { class: r.scenario_hash !== currentHash() ? 'stale' : '' }, text && h('p', {}, text), sweepCharts(sw), stale(r, q)), actions: [{ label: 'See in Results', run: () => goTo('results') }] });
  } catch {
    redraw(msg, { busy: '', error: 'The steps did not work this time. Please ask again.' });
  } finally {
    lab.sweepBusy = false;
  }
}

// ---------- tonight as it is ----------
async function today(focus: 'short' | 'freight' | 'general') {
  const msg = say({ from: 'aria', text: 'Tonight\'s plan with your data as it is:', busy: 'Planning...' });
  try {
    const r = await engine.compare(sc(), []);
    if (r.valid === false) return redraw(msg, { busy: '', error: 'Your data needs fixing on Home first.' });
    const b = r.baseline;
    const short = b.towns.filter((t: Json) => t.short > 0).sort((x: Json, y: Json) => y.short - x.short);
    const freight = new Map<string, number>();
    for (const f of b.flows) freight.set(f.godown_id, (freight.get(f.godown_id) ?? 0) + f.freight_paise);
    const grid = h('div', { class: 'kpi-grid' }, ['expected_fill_rate', 'units_shipped', 'freight_paise', 'shortfall_units'].filter((k) => b.kpis[k] != null)
      .map((key) => kpiCard(kpi(key).label, kpi(key).fmt(b.kpis[key]))));
    const shortList = short.length
      ? h('ul', { class: 'rows compact' }, short.slice(0, 6).map((t: Json) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, t.name), h('span', {}, `${num(t.short)} units short of ${num(Math.round(t.median_demand))} expected`)))))
      : h('p', { class: 'small' }, 'No town is short tonight.');
    const freightList = h('ul', { class: 'rows compact' }, [...freight.entries()].sort((x, y) => y[1] - x[1]).map(([g, p]) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, godownName(g)), h('span', {}, rupees(p))))));
    const body = () => h('div', {},
      b.verified ? badge('Verified plan', 'ok') : badge('Not verified', 'bad'),
      grid,
      focus !== 'freight' && [h('h3', {}, short.length ? `${short.length} town${short.length > 1 ? 's' : ''} short` : 'Shortages'), shortList],
      focus === 'freight' && [h('h3', {}, 'Freight by depot'), freightList],
      short.length > 0 && focus === 'short' && h('p', { class: 'note' }, 'Ask "what if ... ?" to see what would help, for example more capacity at a depot.'));
    redraw(msg, { busy: '', body, actions: [{ label: 'Open Home', run: () => goTo('plan') }] });
  } catch {
    redraw(msg, { busy: '', error: 'Planning did not work this time. Please ask again.' });
  }
}

// ---------- every scenario side by side ----------
async function compareAll() {
  if (!lab.variants.length) return say({ from: 'aria', text: 'There is nothing to compare yet. Ask a "what if" first, for example "what if freight is 25% dearer?".' });
  const msg = say({ from: 'aria', text: `Your ${lab.variants.length} scenario${lab.variants.length > 1 ? 's' : ''} against tonight:`, busy: 'Planning each one...' });
  lab.busy = true;
  try {
    const r = await engine.compare(sc(), lab.variants.map((v) => ({ id: v.id, name: v.name, params: v.params })));
    if (r.valid === false) return redraw(msg, { busy: '', error: 'Your data needs fixing on Home first.' });
    lab.result = { rid: nextRid(), resp: r, key: variantKey() };
    redraw(msg, { busy: '', body: () => compareCard(r), actions: [{ label: 'See in Results', run: () => goTo('results') }] });
  } catch {
    redraw(msg, { busy: '', error: 'The comparison did not work. Please try again.' });
  } finally {
    lab.busy = false;
  }
}

function compareCard(resp: Json) {
  const base = resp.baseline;
  const ok: Json[] = resp.variants.filter((v: Json) => !v.error);
  const best = (key: string, max: boolean) => {
    const all = [base, ...ok].filter((r) => r.kpis[key] != null);
    if (all.length < 2) return null;
    const pick = all.reduce((a, b) => ((max ? b.kpis[key] > a.kpis[key] : b.kpis[key] < a.kpis[key]) ? b : a));
    return h('li', {}, h('span', {}, `${kpi(key).label}: `), h('strong', {}, pick.name), h('span', { class: 'muted' }, ` (${kpi(key).fmt(pick.kpis[key])})`));
  };
  return h('div', { class: resp.scenario_hash !== currentHash() ? 'stale' : '' },
    h('h3', {}, 'Which does best?'),
    h('ul', { class: 'best' }, best('expected_fill_rate', true), best('expected_lost_margin_paise', false), best('freight_paise', false), best('at_risk_units_left', false)),
    comparisonCharts(resp),
    h('p', { class: 'note' }, 'These are forecasts for each scenario, not real results.'));
}

function undo() {
  const gone = lab.variants.pop();
  if (!gone) return say({ from: 'aria', text: 'There is nothing to undo.' });
  lab.last = (lab.variants[lab.variants.length - 1]?.changes as Change[] | undefined) ?? null;
  lab.result = lab.result && lab.variants.length ? { ...lab.result, resp: { ...lab.result.resp, variants: lab.result.resp.variants.filter((v: Json) => v.id !== gone.id) }, key: variantKey() } : null;
  say({ from: 'aria', text: `Removed "${gone.name}".${lab.variants.length ? ` ${lab.variants.length} scenario${lab.variants.length > 1 ? 's' : ''} left.` : ''}` });
}

function reset() {
  Object.assign(lab, { variants: [], selected: '', result: null, sweep: null, chat: [], last: null, error: '' });
  say({ from: 'aria', text: 'Cleared. Ask me anything.' });
}

// ---------- how to use the app ----------
const HELP: Record<string, { text: string; go?: [string, string] }> = {
  hello: { text: 'I answer two kinds of questions. "What if" questions about tonight: more or less demand (all towns, one town or one product), depot capacity, freight rates, stock lost, trade margin, closed roads and truck limits. I plan again on this phone and compare with tonight. And questions about using ARIA: loading data, planning, sending trips, drivers, deliveries and plan files.' },
  whatif: { text: 'Ask in your own words, for example "what if demand rises 20% in Pune and the longest route closes?". Start with "also" to add to the last one, say "what about 30%?" to change its number, "which is best?" to compare them all, "demand from -20% to 40% step by step" for a range, or "undo".' },
  fill: { text: 'Demand met (fill rate) is the share of the demand expected tonight that the plan covers. Lost sales value is the margin lost on demand that is not met. Freight cost is what the trucks cost for tonight\'s loads. Shortage units are units that towns need but do not get.' },
  data: { text: 'On Home, tap "Upload your data (CSV)". "Get a template" gives a file with every section to fill in. No file yet? "Try a sample dataset instead" loads an example.', go: ['plan', 'Go to Home'] },
  stock: { text: 'On Home, open "Edit stock", change the numbers and tap "Save stock". The plan is then marked out of date: plan again to use the new stock.', go: ['plan', 'Go to Home'] },
  scan: { text: 'On Home, tap "Scan labels" and point the camera at a lot label. ARIA checks each label against your data; "Update stock and plan again" adds the stock and shows what changed.', go: ['plan', 'Go to Home'] },
  verify: { text: 'Every plan is checked against 8 safety rules, such as enough stock, shelf life on arrival, open routes and depot capacity. A plan that breaks a rule is not used; it is marked "Not verified".', go: ['results', 'Open Results'] },
  plan: { text: 'Tap the button in the middle of the bar at the bottom, or "Plan tonight" on Home. ARIA plans on this phone in a few seconds and checks the plan before showing it.', go: ['plan', 'Go to Home'] },
  trips: { text: 'Plan tonight first. Then open Team: each depot\'s load becomes one trip. Choose a driver for each and tap "Send trips to drivers". Drivers see their stops on their phone.', go: ['team', 'Open Team'] },
  team: { text: 'Open Team to see your join code. A driver installs ARIA, taps "I am a driver: join my team" and enters the code. You can pause a driver there too.', go: ['team', 'Open Team'] },
  planfile: { text: 'A plan file is a locked copy of a plan that only your team can open. Find them under the file button at the top right. "Share plan" sends one to drivers in the app or to WhatsApp or email.', go: ['records', 'Open plan files'] },
  delivery: { text: 'At each stop the driver\'s phone checks they are at the shop. You give the shop a one-time code; the driver enters it as proof of delivery, and you confirm the delivery in Team.', go: ['team', 'Open Team'] },
  results: { text: 'Results shows tonight\'s plan in charts: demand met, freight, depot loads and shortages, plus every scenario you asked me about.', go: ['results', 'Open Results'] },
  offline: { text: 'Planning and my answers work on this phone without internet. Sending trips, reports and plan files needs a connection; they go out when the phone is back online.' },
};

function help(topic: string) {
  const a = HELP[topic] ?? HELP.hello;
  say({ from: 'aria', text: a.text, actions: a.go ? [{ label: a.go[1], run: () => goTo(a.go![0]) }] : undefined });
}

// ---------- charts shared with Results ----------
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
    rows.length > 1 && changeKeys.length > 0 && hbars('Change from tonight (%)', changeKeys.map((k) => k.label),
      rows.slice(1).map((r, i) => ({ name: r.name, values: changeKeys.map((k) => r.diff?.[k.key]?.pct ?? null), color: colour(i + 1) })),
      (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`, '% change', 'Bars right of 0 are increases. Whether that is good depends on the measure.'),
    hbars('Units loaded per depot', resp.baseline.depots.map((d: Json) => d.name),
      rows.map((r, i) => ({ name: r.name, values: r.depots.map((d: Json) => d.shipped), color: colour(i) })), num, 'units'),
  ];
}

export function sweepCharts(sw: { param: string; values: number[]; resp: Json }) {
  const cfg = SWEEP[sw.param as SweepParam];
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
    h('p', { class: 'note' }, `Tonight: demand met ${kpi('expected_fill_rate').fmt(sw.resp.baseline.kpis.expected_fill_rate)}, freight ${rupees(sw.resp.baseline.kpis.freight_paise)}. These are forecasts, not real results.`),
  ];
}
