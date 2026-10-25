// Ask ARIA: reads a plain question ("what if demand rises 20% in Pune and the Shiroli road closes?") and turns it into
// the scenario changes engine.compare understands, a step-by-step range, a question about tonight, or a how-to answer.
// Runs on the phone with no network and no model: word rules plus the names in the loaded data. No DOM, no engine
// calls here (the view does both), so scripts/assistant-test.mjs can check it in Node.

export type Ent = { kind: 'town' | 'depot' | 'product'; id: string; name: string };
export type Ctx = {
  towns: Ent[];
  depots: Ent[];
  products: (Ent & { group?: string })[];
  routes: { g: string; t: string; km: number; active: boolean }[];
};

export type Change =
  | { topic: 'demand'; pct: number; towns?: string[]; products?: string[]; text: string }
  | { topic: 'capacity'; pct: number; depots?: string[]; text: string }
  | { topic: 'freight'; pct: number; text: string }
  | { topic: 'stock'; pct: number; depots?: string[]; products?: string[]; text: string }
  | { topic: 'margin'; pct: number; text: string }
  | { topic: 'close'; routes: [string, string][]; text: string }
  | { topic: 'restrict'; routes: [string, string][]; vehicle: string; text: string };

export type SweepParam = 'demand_pct' | 'capacity_pct' | 'freight_pct' | 'stock_loss_pct';
export type Intent =
  | { kind: 'scenario'; changes: Change[]; notes: string[]; followUp: boolean }
  | { kind: 'sweep'; param: SweepParam; from: number; to: number; steps: number; notes: string[] }
  | { kind: 'today'; focus: 'short' | 'freight' | 'general' }
  | { kind: 'help'; topic: string }
  | { kind: 'compare' }
  | { kind: 'reset' }
  | { kind: 'undo' }
  | { kind: 'unknown'; ask?: string };

export const SWEEP: Record<SweepParam, { label: string; from: number; to: number; unit: string; min: number; max: number }> = {
  demand_pct: { label: 'Change in demand', from: -20, to: 40, unit: '%', min: -90, max: 300 },
  capacity_pct: { label: 'Depot capacity', from: 50, to: 120, unit: '% of normal', min: 0, max: 300 },
  freight_pct: { label: 'Change in freight rates', from: 0, to: 100, unit: '%', min: -50, max: 300 },
  stock_loss_pct: { label: 'Stock lost', from: 0, to: 50, unit: '%', min: 0, max: 100 },
};

export const TRUCKS: Record<string, string> = { '6t': 'small', road_avg: 'medium', '55t': 'large' };

// ---------- words ----------
const UP = /\b(up|rises?|rising|raised?|increases?d?|increasing|more|higher|jumps?|grows?|growth|spikes?|surges?|boost(ed)?|dearer|costlier|expensive|extra|hikes?d?|goes up|go up|plus)\b/;
const DOWN = /\b(down|falls?|falling|drops?|dropping|less|lower|decreases?d?|reduced?|reduces|cuts?|fewer|slumps?|shrinks?|cheaper|minus|dips?|declines?)\b/;
const T_STOCK = /\b(stock|inventory|lots?|units in store)\b/;
const T_LOSS = /\b(lose|loses|losing|lost|loss|damaged?|theft|stolen|spoil(ed|t|s)?|recall(ed|s)?|expired?|flood(ed|s)?|fire|destroyed?|written off|write off|missing|rot(ten|s)?)\b/;
const T_CLOSE = /\b(close[sd]?|closing|closure|shut|block(ed|s)?|cut off|washed( out| away)?|landslides?|flood(ed|s)?|no road|not open|out of action|impassable)\b/;
const T_ROAD = /\b(route|routes|road|roads|highway|bridge|lane|way)\b/;
const T_TRUCK = /\b(trucks?|lorr(y|ies)|vehicles?|trailers?|tempos?|6 ?t|55 ?t)\b/;
const T_FREIGHT = /\b(freight|transport|trucking|diesel|fuel|petrol|tolls?|shipping|haulage|truck (rates?|costs?|fares?)|delivery costs?)\b/;
const T_CAP = /\b(capacity|load(ing|s)?|dispatch(es)?|labou?r|staff|workers|loaders|throughput|strike)\b/;
const T_MARGIN = /\b(margin|markup|mark up)\b/;
const T_DEMAND = /\b(demand|sales|sale|orders?|sell|selling|buying|customers?|festival|diwali|holi|ganesh(otsav)?|eid|navratri|dussehra|wedding season|needs?|consumption|rush)\b/;
const FESTIVAL = /\b(festival|diwali|holi|ganesh(otsav)?|eid|navratri|dussehra|wedding season|rush)\b/;
const NUMBER = /(^|[^a-z0-9_.])([+-]?\d+(?:\.\d+)?)\s*(%|percent|per cent|pc|pts?|points?)?(?![a-z0-9_])/;
const GENERIC = new Set(['midc', 'depot', 'godown', 'warehouse', 'dc', 'hub', 'store', 'the', 'of', 'and', 'town', 'city']);

const norm = (s: string) => s.toLowerCase().replace(/[−–—]/g, '-').replace(/[’‘`]/g, "'").replace(/[?!"“”]/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

// ---------- names in the loaded data ----------
type Key = { key: string; ents: Ent[] };
let keysFor: Ctx | null = null;
let keys: Key[] = [];

/** Every way a name can be written in a question, longest first. A key shared by a town and a depot keeps both. */
function nameKeys(ctx: Ctx): Key[] {
  if (keysFor === ctx) return keys;
  const map = new Map<string, Ent[]>();
  const add = (raw: string, e: Ent) => {
    for (const k of uniq([norm(raw), norm(raw.replace(/_/g, ' '))])) { // FOODS_3_007 or "foods 3 007"
      if (k.length < 3 || GENERIC.has(k)) continue;
      const list = map.get(k) ?? [];
      if (!list.some((x) => x.kind === e.kind && x.id === e.id)) list.push(e);
      map.set(k, list);
    }
  };
  const townNames = new Set(ctx.towns.map((t) => norm(t.name)));
  for (const t of ctx.towns) { add(t.name, t); add(t.id.replace(/^t_/i, ''), t); }
  for (const d of ctx.depots) {
    add(d.name, d);
    add(d.id.replace(/^(g|d)_/i, ''), d);
    const bare = d.name.replace(/\(.*?\)/g, ' ');
    add(bare, d);
    const words = norm(bare).split(' ').filter((w) => !GENERIC.has(w));
    add(words.join(' '), d);
    if (words.length > 1) for (const w of words) if (w.length >= 4) add(w, d);
    const inner = /\((.*?)\)/.exec(d.name)?.[1];
    if (inner && !townNames.has(norm(inner))) add(inner, d); // "Chakan MIDC (Pune)": Pune is a town, not this depot
  }
  const firstWord = new Map<string, number>();
  for (const p of ctx.products) { const w = norm(p.id).split(/[_ ]/)[0]; firstWord.set(w, (firstWord.get(w) ?? 0) + 1); }
  for (const p of ctx.products) {
    add(p.id, p);
    if (p.name && p.name !== p.id) add(p.name, p);
    const w = norm(p.id).split(/[_ ]/)[0];
    if (firstWord.get(w) === 1 && !/\d/.test(w)) add(w, p);
    if (p.group) add(p.group, p); // "dairy" means every dairy product
  }
  keys = [...map.entries()].map(([key, ents]) => ({ key, ents })).sort((a, b) => b.key.length - a.key.length);
  keysFor = ctx;
  return keys;
}

type Hit = { at: number; end: number; ents: Ent[] };
/** Names found in the text (longest match wins, no overlaps), and the text with them blanked out. */
function findNames(text: string, ctx: Ctx): { hits: Hit[]; rest: string } {
  const hits: Hit[] = [];
  let rest = text;
  for (const k of nameKeys(ctx)) {
    const re = new RegExp(`(^|[^a-z0-9_])(${esc(k.key)})(e?s)?(?![a-z0-9_])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) {
      const at = m.index + m[1].length, end = at + m[2].length + (m[3]?.length ?? 0);
      hits.push({ at, end, ents: k.ents });
      rest = rest.slice(0, at) + ' '.repeat(end - at) + rest.slice(end);
    }
  }
  return { hits: hits.sort((a, b) => a.at - b.at), rest };
}

const ofKind = (hits: Hit[], kind: Ent['kind']) => uniq(hits.flatMap((h) => h.ents.filter((e) => e.kind === kind).map((e) => e.id)));
/** A name both a town and a depot carry ("Kagal") counts as the kind the topic is about, unless the other kind is already named. */
function resolve(hits: Hit[], prefer: 'town' | 'depot') {
  const sure = (k: Ent['kind']) => uniq(hits.filter((h) => h.ents.every((e) => e.kind === k)).flatMap((h) => h.ents.map((e) => e.id)));
  const towns = sure('town'), depots = sure('depot');
  for (const h of hits) {
    const t = h.ents.find((e) => e.kind === 'town'), d = h.ents.find((e) => e.kind === 'depot');
    if (!t || !d) continue;
    const asTown = prefer === 'town' ? !(towns.length && !depots.length) : !!depots.length && !towns.length;
    (asTown ? towns : depots).push(asTown ? t.id : d.id);
  }
  return { towns: uniq(towns), depots: uniq(depots), products: ofKind(hits, 'product') };
}

function firstNumber(rest: string): number | null {
  const m = NUMBER.exec(rest);
  return m ? Number(m[2]) : null;
}

function wordAmount(t: string): number | null {
  if (/\b(double[sd]?|twice|2x|two times)\b/.test(t)) return 100;
  if (/\b(triple[sd]?|three times|3x)\b/.test(t)) return 200;
  if (/\b(half|halve[sd]?|50-50)\b/.test(t)) return -50;
  if (/\ba (quarter|fourth)\b/.test(t)) return 25;
  if (/\ba third\b/.test(t)) return 33;
  return null;
}

function longest(ctx: Ctx): [string, string] | null {
  const r = [...ctx.routes].filter((x) => x.active).sort((a, b) => b.km - a.km)[0];
  return r ? [r.g, r.t] : null;
}

/** Routes a clause points at: "from A to B", "to B" (every route into B), "from A" (every route out of A), "the longest". */
function routesOf(t: string, hits: Hit[], ctx: Ctx, notes: string[]): [string, string][] | null {
  if (/\b(longest|furthest|farthest)\b/.test(t)) { const l = longest(ctx); return l ? [l] : []; }
  const { towns, depots } = resolve(hits, 'town');
  const open = ctx.routes.filter((r) => r.active);
  if (depots.length && towns.length) {
    const pairs = open.filter((r) => depots.includes(r.g) && towns.includes(r.t)).map((r): [string, string] => [r.g, r.t]);
    if (!pairs.length) notes.push('There is no open route between those places in your data.');
    return pairs;
  }
  if (towns.length) return open.filter((r) => towns.includes(r.t)).map((r): [string, string] => [r.g, r.t]);
  if (depots.length) return open.filter((r) => depots.includes(r.g)).map((r): [string, string] => [r.g, r.t]);
  return null;
}

// ---------- one clause -> one change ----------
function clause(raw: string, ctx: Ctx, notes: string[]): Change | null {
  const { hits, rest } = findNames(raw, ctx);
  const t = rest;
  const n = firstNumber(t);
  const signed = n != null && /[+-]\s*\d/.test(t) ? n : null;
  const dir = UP.test(t) && !DOWN.test(t) ? 1 : DOWN.test(t) && !UP.test(t) ? -1 : 0;
  const amount = (fallback: number | null) => {
    if (signed != null) return signed;
    if (n != null) return dir < 0 ? -Math.abs(n) : Math.abs(n);
    const w = wordAmount(t);
    return w ?? fallback;
  };
  const names = resolve(hits, 'town');

  // trucks: "only small trucks to Pune", "no large trucks from Chakan"
  if (T_TRUCK.test(t) && /\b(only|just|no|ban(ned)?|without|not allowed|smaller)\b/.test(t)) {
    let vehicle = '';
    if (/\b(no|ban(ned)?|without|not allowed)\b.*\b(large|big|heavy|55 ?t|trailers?)\b/.test(t)) vehicle = 'road_avg';
    else if (/\b(small|smaller|6 ?t|tempos?|light)\b/.test(t)) vehicle = '6t';
    else if (/\b(medium|average|mid)\b/.test(t)) vehicle = 'road_avg';
    const routes = routesOf(t, hits, ctx, notes);
    if (!vehicle) { notes.push('Say which trucks may still go, for example "only small trucks to Pune".'); return null; }
    if (!routes) { notes.push('Say which route, for example "only small trucks from Chakan to Pune".'); return null; }
    return { topic: 'restrict', routes, vehicle, text: raw };
  }

  // stock lost: needs a stock word, or a recall of a named product
  if ((T_STOCK.test(t) && T_LOSS.test(t)) || (/\brecall/.test(t) && names.products.length)) {
    const sp = resolve(hits, 'depot');
    let pct = n != null ? Math.abs(n) : /\b(recall|all|entire|whole|every)\b/.test(t) ? 100 : wordAmount(t) != null ? Math.abs(wordAmount(t)!) : null;
    if (pct == null) { notes.push('How much stock is lost? For example "lose 20% of stock at Shiroli".'); return null; }
    if (pct > 100) { notes.push('Stock lost cannot be more than 100%, so I used 100%.'); pct = 100; }
    return { topic: 'stock', pct, depots: sp.depots.length ? sp.depots : undefined, products: sp.products.length ? sp.products : undefined, text: raw };
  }

  // closed roads; a closed depot means it loads nothing tonight
  if (T_CLOSE.test(t) && !T_FREIGHT.test(t)) {
    const r = resolve(hits, T_ROAD.test(t) ? 'town' : 'depot');
    if (r.depots.length && !r.towns.length && !T_ROAD.test(t) && !/\b(longest|furthest|farthest)\b/.test(t)) {
      return { topic: 'capacity', pct: 0, depots: r.depots, text: raw };
    }
    const routes = routesOf(t, hits, ctx, notes);
    if (routes) return { topic: 'close', routes, text: raw };
    if (T_ROAD.test(t)) { notes.push('Which route? For example "close the road from Shiroli to Kolhapur", or "close the longest route".'); return null; }
  }

  if (T_FREIGHT.test(t)) {
    let pct = amount(null);
    if (pct == null) { notes.push('By how much? For example "freight 25% dearer".'); return null; }
    if (/\bdiesel|fuel|petrol\b/.test(t)) notes.push('I treated the fuel price change as the same change in freight rates.');
    if (pct < -50 || pct > 300) { notes.push('Freight can change from -50% to +300%; I kept it inside that.'); pct = clamp(pct, -50, 300); }
    return { topic: 'freight', pct, text: raw };
  }

  if (T_CAP.test(t) && !T_DEMAND.test(t)) {
    const r = resolve(hits, 'depot');
    let pct: number | null;
    if (/\b(strike|shut|zero|nothing|no (loading|dispatch))\b/.test(t) && n == null) pct = 0;
    else if (n != null) pct = signed != null ? 100 + signed : dir > 0 ? 100 + Math.abs(n) : dir < 0 ? 100 - Math.abs(n) : Math.abs(n);
    else { const w = wordAmount(t); pct = w == null ? null : 100 + w; }
    if (pct == null) { notes.push('By how much? For example "depots load 30% less" or "Shiroli capacity 60%".'); return null; }
    if (pct === 0 && !r.depots.length && n == null) { notes.push('Which depot stops loading? For example "strike at Shiroli".'); return null; }
    if (pct < 0 || pct > 300) { notes.push('Capacity stays between 0% and 300% of normal.'); pct = clamp(pct, 0, 300); }
    return { topic: 'capacity', pct, depots: r.depots.length ? r.depots : undefined, text: raw };
  }

  if (T_MARGIN.test(t)) {
    if (n == null) { notes.push('What margin? For example "margin 5%".'); return null; }
    let pct = Math.abs(n);
    if (pct > 50) { notes.push('Margin is capped at 50%.'); pct = 50; }
    return { topic: 'margin', pct, text: raw };
  }

  // demand, or a named town/product with a change ("Pune 30% more")
  if (T_DEMAND.test(t) || ((names.towns.length || names.products.length) && (n != null || wordAmount(t) != null) && (dir || signed != null || wordAmount(t) != null))) {
    let pct = amount(FESTIVAL.test(t) ? 30 : null);
    if (pct == null) { notes.push('By how much? For example "demand up 20% in Pune".'); return null; }
    if (n == null && wordAmount(t) == null && FESTIVAL.test(t)) notes.push('I assumed a festival adds 30% to demand. Give a number to change it.');
    if (pct < -90 || pct > 300) { notes.push('Demand can change from -90% to +300%; I kept it inside that.'); pct = clamp(pct, -90, 300); }
    return { topic: 'demand', pct, towns: names.towns.length ? names.towns : undefined, products: names.products.length ? names.products : undefined, text: raw };
  }
  return null;
}

/** Changes from several clauses; one change per topic (a later one replaces an earlier one), routes add up. */
export function mergeChanges(a: Change[], b: Change[]): Change[] {
  const out = [...a];
  for (const c of b) {
    const i = out.findIndex((x) => x.topic === c.topic);
    if (i < 0) { out.push(c); continue; }
    const old = out[i];
    if ((c.topic === 'close' && old.topic === 'close') || (c.topic === 'restrict' && old.topic === 'restrict' && old.vehicle === c.vehicle)) {
      const seen = new Set(old.routes.map((r) => r.join('>')));
      out[i] = { ...c, routes: [...old.routes, ...c.routes.filter((r) => !seen.has(r.join('>')))] } as Change;
    } else if (c.topic === 'restrict') out.push(c);
    else out[i] = c;
  }
  return out;
}

const SPLIT = /\s*(?:,|;|\. |\band then\b|\band also\b|\bas well as\b|\bon top of that\b|\band\b|\bplus\b|\balso\b|\bwhile\b|\bbut\b|\bwith\b)\s*/;
const LEAD = /^(so |ok |okay |now |then |and |hey |aria )*(what if|what happens if|what would happen if|what will happen if|suppose|imagine|let'?s say|say|if|assume|tell me what happens if|show me)\b\s*/;
const QUESTION = /^(how|where|what|why|when|who|can|do|does|is|which|explain|tell me|help)\b/;

const HELP: [string, RegExp][] = [
  ['hello', /^(hi|hello|hey|namaste|namaskar|good (morning|afternoon|evening)|help|what can (you|i) (do|ask)|who are you|what do you do|what (do|can) you (know|understand)|menu)\b/],
  ['fill', /\b(fill rate|demand met|what is lost sales|lost sales value|what does .* mean)\b/],
  ['data', /\b(csv|upload|template|data file|load (my )?data|my data|sample data|spreadsheet|excel)\b/],
  ['stock', /\b(edit|change|update|fix) (the )?stock\b/],
  ['scan', /\b(scan|label|barcode|qr)/],
  ['verify', /\b(verif|safety|safe|rules?|check(ed|s)? the plan)/],
  ['trips', /\b(send|assign|give)\b.*\b(trips?|loads?|drivers?)\b|\btrips?\b/],
  ['team', /\b(join code|team code|add (a )?driver|invite|new driver|pause|drivers?)\b/],
  ['planfile', /\b(plan file|svcr|share (the )?plan|send (the )?plan)\b/],
  ['delivery', /\b(deliver|proof|shop code|arriv|geoproof|gps|location|confirm)/],
  ['results', /\b(results?|charts?|dashboard|report)\b/],
  ['offline', /\b(offline|internet|network|without net|no signal|data pack)\b/],
  ['plan', /\b(plan tonight|make (a |the )?plan|planning|how .*plan|optimi[sz])/],
  ['whatif', /\b(what if|scenario|how (do|does) (you|this|it) work|how do i ask)\b/],
];

const TODAY = /\b(tonight|today|current|right now|this evening)\b|\b(where|which|what)\b.*\b(short|shortage|missing|run out)\b|\bshort(ages?|falls?)?\b.*\b(where|which|tonight)\b/;
const COMPARE = /\b(compare|comparison|side by side|best (option|scenario|one)|which (one|option|scenario|is) (is )?(the )?(best|better)|summar(y|ise|ize)|all (the |my )?scenarios)\b/;
const RESET = /\b(start over|start again|clear( the)?( chat| all| everything)?|reset|new chat|forget (all|everything))\b/;
const UNDO = /\b(undo|remove (the )?last|forget that|scrap that|delete (the )?last|take (that|it) back)\b/;

/** What the person asked. last: the changes of the previous scenario, for follow-ups ("also...", "what about 30%?"). */
export function understand(input: string, ctx: Ctx, last: Change[] | null = null): Intent {
  let t = norm(input);
  if (!t) return { kind: 'unknown' };
  if (UNDO.test(t)) return { kind: 'undo' };
  if (RESET.test(t) && t.split(' ').length <= 5) return { kind: 'reset' };
  if (COMPARE.test(t)) return { kind: 'compare' };
  const asked = LEAD.test(t);
  t = t.replace(LEAD, '');
  const notes: string[] = [];

  // a range: "demand from -20% to 40%", "freight between 0 and 100 in 6 steps", "step through capacity"
  const range = /\b(?:from|between)\s+([+-]?\d+(?:\.\d+)?)\s*%?\s*(?:to|and|-)\s*([+-]?\d+(?:\.\d+)?)\s*%?/.exec(t);
  const stepWord = /\b(steps?|step by step|range|sweep|trend|curve|sensitiv|one by one|each level)/.test(t);
  if (range || stepWord) {
    const topic = /\bstock\b/.test(t) ? 'stock_loss_pct' : T_FREIGHT.test(t) ? 'freight_pct' : T_CAP.test(t) ? 'capacity_pct' : T_DEMAND.test(t) ? 'demand_pct' : null;
    if (topic) {
      const cfg = SWEEP[topic];
      const sm = /(\d+)\s*steps?/.exec(t);
      const steps = clamp(sm ? Number(sm[1]) : 5, 2, 12);
      let from = range ? Number(range[1]) : cfg.from, to = range ? Number(range[2]) : cfg.to;
      if (from > to) [from, to] = [to, from];
      if (from < cfg.min || to > cfg.max) notes.push(`${cfg.label} goes from ${cfg.min} to ${cfg.max}${cfg.unit === '%' ? '%' : ''}; I kept the range inside that.`);
      return { kind: 'sweep', param: topic, from: clamp(from, cfg.min, cfg.max), to: clamp(to, cfg.min, cfg.max), steps, notes };
    }
  }

  // a number only, after a scenario: "what about 30%?", "make it 40"
  const only = /^(?:what about|how about|try|make it|and|or|now|instead|rather)?\s*([+-]?\d+(?:\.\d+)?)\s*(%|percent)?\s*(instead|then)?$/.exec(t);
  if (only && last?.length) {
    const target = [...last].reverse().find((c) => firstNumber(findNames(c.text, ctx).rest) != null);
    if (target) {
      // swap the number where it stands (names are blanked to the same length, so a code like EGGS_12 is never touched)
      const m = NUMBER.exec(findNames(target.text, ctx).rest)!;
      const at = m.index + m[1].length, old = m[2];
      const num = /^[+-]/.test(only[1]) || !/^[+-]/.test(old) ? only[1] : `${old[0]}${only[1]}`;
      const c = clause(target.text.slice(0, at) + num + target.text.slice(at + old.length), ctx, notes);
      if (c) return { kind: 'scenario', changes: last.map((x) => (x === target ? c : x)), notes, followUp: true };
    }
  }

  const parts = t.split(SPLIT).filter(Boolean);
  let changes: Change[] = [];
  let prev: Change | null = null;
  let leftovers = 0;
  for (const p of parts) {
    const c = clause(p, ctx, notes);
    if (c) { changes = mergeChanges(changes, [c]); prev = c; continue; }
    // "...in Pune and Kolhapur": a name on its own joins the change before it
    const { hits, rest } = findNames(p, ctx);
    if (prev && hits.length && !/[a-z]{3,}/.test(rest.replace(/\b(in|at|for|to|from|of|the|too|as well|also|both)\b/g, ''))) {
      const joined = clause(`${prev.text} ${p}`, ctx, []);
      if (joined) { changes = changes.map((x) => (x === prev ? joined : x)); prev = joined; continue; }
    }
    leftovers++;
  }

  // a name on its own after a scenario: "what about Kolhapur instead?"
  if (!changes.length && last?.length) {
    const { hits, rest } = findNames(t, ctx);
    if (hits.length && !/[a-z]{4,}/.test(rest.replace(/\b(what|how|about|instead|then|rather|try|for|in|at|and|or|to|from)\b/g, ''))) {
      const target = [...last].reverse().find((c) => c.topic !== 'freight' && c.topic !== 'margin');
      if (target) {
        const blanked = findNames(target.text, ctx);
        let base = target.text;
        for (const h of [...blanked.hits].reverse()) base = base.slice(0, h.at) + base.slice(h.end);
        const c = clause(`${base} ${t.replace(/\b(what|how) about|instead|then|rather|try\b/g, ' ')}`, ctx, notes);
        if (c) return { kind: 'scenario', changes: last.map((x) => (x === target ? c : x)), notes, followUp: true };
      }
    }
  }

  if (changes.length) {
    const followUp = !!last?.length && /^(and|also|plus|add|then|now also|on top|as well|together with|with that)\b|\b(as well|on top of (that|this)|too|also)$/.test(norm(input).replace(LEAD, ''));
    if (leftovers && !notes.length) notes.push('I did not understand every part of that, so this covers only what is listed.');
    return { kind: 'scenario', changes: followUp ? mergeChanges(last!, changes) : changes, notes, followUp };
  }
  if (notes.length) return { kind: 'unknown', ask: notes[0] };
  if (/^(how (do|can|should) (i|we)|how to|where (do|can) (i|we)|can (i|we)|explain)\b/.test(t)) for (const [topic, re] of HELP) if (re.test(t)) return { kind: 'help', topic };
  if (TODAY.test(t)) return { kind: 'today', focus: /\bshort|missing|run out|lost\b/.test(t) ? 'short' : /\b(freight|cost|spend)\b/.test(t) ? 'freight' : 'general' };
  if (!asked || QUESTION.test(t)) for (const [topic, re] of HELP) if (re.test(t)) return { kind: 'help', topic };
  return { kind: 'unknown' };
}

// ---------- changes -> engine parameters and plain words ----------
export function toParams(changes: Change[]): Record<string, any> {
  const p: Record<string, any> = {};
  for (const c of changes) {
    if (c.topic === 'demand') { p.demand_pct = c.pct; if (c.towns) p.demand_town = c.towns; if (c.products) p.demand_product = c.products; }
    else if (c.topic === 'capacity') { p.capacity_pct = c.pct; if (c.depots) p.capacity_depot = c.depots; }
    else if (c.topic === 'freight') p.freight_pct = c.pct;
    else if (c.topic === 'stock') { p.stock_loss_pct = c.pct; if (c.depots) p.stock_depot = c.depots; if (c.products) p.stock_product = c.products; }
    else if (c.topic === 'margin') p.margin = c.pct / 100;
    else if (c.topic === 'close') p.closures = [...(p.closures ?? []), ...c.routes];
    else p.restrictions = [...(p.restrictions ?? []), ...c.routes.map(([g, t]) => [g, t, c.vehicle])];
  }
  return p;
}

const list = (ids: string[] | undefined, all: Ent[]) => {
  const names = (ids ?? []).map((id) => all.find((e) => e.id === id)?.name ?? id);
  return names.length <= 3 ? names.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
};
const sign = (v: number) => `${v > 0 ? 'up' : 'down'} ${round1(Math.abs(v))}%`;

/** One plain line per change, with the names from the data. */
export function describe(c: Change, ctx: Ctx): string {
  const route = ([g, t]: [string, string]) => `${ctx.depots.find((d) => d.id === g)?.name ?? g} → ${ctx.towns.find((x) => x.id === t)?.name ?? t}`;
  const routes = (rs: [string, string][]) => (rs.length <= 2 ? rs.map(route).join(', ') : `${rs.length} routes (${route(rs[0])}, ...)`);
  switch (c.topic) {
    case 'demand': return `Demand ${sign(c.pct)}${c.products ? ` for ${list(c.products, ctx.products)}` : ''}${c.towns ? ` in ${list(c.towns, ctx.towns)}` : ' everywhere'}`;
    case 'capacity': return c.pct === 0 ? `${c.depots ? list(c.depots, ctx.depots) : 'No depot'} loads nothing tonight` : `${c.depots ? list(c.depots, ctx.depots) : 'Every depot'} can load ${round1(c.pct)}% of normal`;
    case 'freight': return `Freight rates ${sign(c.pct)}`;
    case 'stock': return `${round1(c.pct)}% of ${c.products ? list(c.products, ctx.products) : 'stock'} lost${c.depots ? ` at ${list(c.depots, ctx.depots)}` : ''}`;
    case 'margin': return `Trade margin set to ${round1(c.pct)}%`;
    case 'close': return c.routes.length ? `Closed: ${routes(c.routes)}` : 'No open route matched, so nothing is closed';
    case 'restrict': return `Only ${TRUCKS[c.vehicle] ?? c.vehicle} trucks: ${routes(c.routes)}`;
  }
}

/** A short name for the scenario chip and the Results charts. */
export function scenarioName(changes: Change[], ctx: Ctx): string {
  const one = (c: Change) => {
    const pct = 'pct' in c ? `${c.pct > 0 && c.topic !== 'capacity' && c.topic !== 'stock' && c.topic !== 'margin' ? '+' : ''}${round1(c.pct)}%` : '';
    const where = (ids: string[] | undefined, all: Ent[]) => (ids?.length === 1 ? ` ${all.find((e) => e.id === ids[0])?.name ?? ids[0]}` : ids?.length ? ` (${ids.length})` : '');
    switch (c.topic) {
      case 'demand': return `Demand ${pct}${where(c.towns, ctx.towns)}`;
      case 'capacity': return `Capacity ${pct}${where(c.depots, ctx.depots)}`;
      case 'freight': return `Freight ${pct}`;
      case 'stock': return `Stock −${round1(c.pct)}%${where(c.depots, ctx.depots)}`;
      case 'margin': return `Margin ${pct}`;
      case 'close': return c.routes.length === 1 ? `${ctx.towns.find((x) => x.id === c.routes[0][1])?.name ?? c.routes[0][1]} road closed` : `${c.routes.length} roads closed`;
      case 'restrict': return `Small trucks (${c.routes.length})`;
    }
  };
  const name = changes.map(one).join(' + ');
  return name.length > 42 ? `${name.slice(0, 40)}…` : name;
}
