// Ask ARIA's language model (Groq). It does two jobs, and never computes a number:
// 1. interpret(): a question (any wording, English, Hindi or Marathi) -> the same structured request src/assistant.ts
//    makes, checked here against the names and limits in the data before the engine sees it; or a direct answer to a
//    question about the app.
// 2. explain(): two plain sentences about an engine result, using only the figures it is given.
// No DOM and no config import, so scripts/ai-test.mjs can run it in Node. Callers fall back to the word rules on any error.
import { HELP_ANSWERS, SWEEP, TRUCKS, describe, type Change, type Ctx, type Intent, type SweepParam } from './assistant.ts'; // .ts: scripts/ai-test.mjs runs this file in Node

export type AiOpts = {
  key: string;
  url: string;
  model: string;
  fallback?: string;
  timeoutMs: number;
  history?: { role: 'user' | 'assistant'; content: string }[];
  last?: Change[] | null;
  hasData?: boolean;
};
/** intent null: reply is the whole answer (a how-to, or a question back). go: a page to offer. */
export type AiAnswer = { intent: Intent | null; reply: string; go: string | null; notes: string[] };

const PAGES = ['plan', 'results', 'team', 'records'];

/** One request; a busy main model (429, Groq's per-minute token limit) is tried once more on the fallback model. */
async function chat(opts: AiOpts, messages: { role: string; content: string }[], json: boolean, maxTokens: number): Promise<string> {
  try {
    return await call(opts, opts.model, messages, json, maxTokens);
  } catch (e: any) {
    if (e?.status !== 429 || !opts.fallback || opts.fallback === opts.model) throw e;
    return call(opts, opts.fallback, messages, json, maxTokens);
  }
}

async function call(opts: AiOpts, model: string, messages: { role: string; content: string }[], json: boolean, maxTokens: number): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const r = await fetch(opts.url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages, temperature: 0.2, max_completion_tokens: maxTokens,
        ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!r.ok) throw Object.assign(new Error(`AI ${r.status}`), { status: r.status });
    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('AI gave no answer');
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 1. reading a question ----------
/** The names the model may use. Kept short (Groq's free tier allows 8,000 tokens a minute): product groups always,
 *  single products only when the list is short or the question names them; routes are worked out here, not listed. */
function names(ctx: Ctx, question: string, last: Change[] | null | undefined): string {
  const groups = new Map<string, number>();
  for (const p of ctx.products) if (p.group) groups.set(p.group, (groups.get(p.group) ?? 0) + 1);
  const q = question.toLowerCase();
  const inLast = new Set((last ?? []).flatMap((c) => ('products' in c && c.products) || []));
  const word = (id: string) => id.toLowerCase().split(/[_ ]/)[0];
  const named = (id: string) => q.includes(id.toLowerCase()) || q.includes(id.toLowerCase().replace(/_/g, ' ')) || (word(id).length >= 3 && !/\d/.test(word(id)) && q.includes(word(id)));
  const prods = ctx.products.length <= 25 ? ctx.products : ctx.products.filter((p) => inLast.has(p.id) || named(p.id));
  return [
    `Towns (id = name): ${ctx.towns.map((t) => `${t.id} = ${t.name}`).join('; ')}`,
    `Depots (id = name): ${ctx.depots.map((d) => `${d.id} = ${d.name}`).join('; ')}`,
    `Product groups (number of products): ${[...groups].map(([g, n]) => `${g} (${n})`).join(', ') || 'none'}`,
    `Products named in the question: ${prods.length ? prods.map((p) => `${p.id}${p.group ? ` (${p.group})` : ''}`).join(', ') : 'none'}${ctx.products.length > 25 ? ` (${ctx.products.length} products in all; use "groups" for a kind of product)` : ''}`,
  ].join('\n');
}

function system(ctx: Ctx, question: string, opts: AiOpts): string {
  const guide = Object.entries(HELP_ANSWERS).map(([k, v]) => `- ${k}: ${v.text}${v.go ? ` [page: ${v.go[0]}]` : ''}`).join('\n');
  const last = opts.last?.length ? JSON.stringify(opts.last.map(({ text: _t, ...c }) => c)) : 'none';
  return `You are ARIA, the planning assistant in a mobile app for a distributor in India. Each evening the app plans which depot ships which product to which town, on the phone. You turn the user's message into ONE JSON object. You never calculate or invent numbers: the app's planner does that.

JSON fields:
- "kind": one of
  "scenario" (a what-if change to tonight's plan),
  "sweep" (one change over a range of values, step by step),
  "today" (how tonight's plan looks: shortages, freight, demand met),
  "compare" (compare or rank the scenarios asked so far / which is best),
  "undo" (remove the last scenario), "reset" (clear the chat),
  "answer" (a question about using the app, what a measure means, or anything else),
  "clarify" (a what-if that is missing something essential, e.g. no amount).
- "changes" (scenario only): a list, at most one item per topic except routes. Items:
  {"topic":"demand","pct":<change in %, -90..300>,"towns":[town ids] or omit for all,"products":[product ids],"groups":[product groups] (omit both for all products)}
  {"topic":"capacity","pct":<% of NORMAL capacity, 0..300: "30% less" = 70, "20% more" = 120, depot shut or strike = 0>,"depots":[depot ids] or omit for all}
  {"topic":"freight","pct":<change in %, -50..300; fuel/diesel price changes count as freight>}
  {"topic":"stock","pct":<% of stock lost, 0..100; a recall = 100>,"depots":[...],"products":[...],"groups":[...]}
  {"topic":"margin","pct":<new trade margin in %, 0..50>}
  {"topic":"close","towns":[town ids],"depots":[depot ids],"longest":true|false} (closed roads: a depot and a town = the road between them; only towns = every road into them; only depots = every road out of them; "longest":true = the longest open route. When repeating the last scenario, keep its "routes" as given.)
  {"topic":"restrict","towns":[...],"depots":[...],"longest":true|false,"vehicle":"6t" (small) | "road_avg" (medium)} (the largest truck still allowed on those roads)
  Use ONLY ids and groups from the lists below.
  A festival with no amount: demand +30% and say so in "reply".
- "follow_up" (scenario): true when the message adds to or changes the last scenario ("also...", "what about 30%?", "Kagal instead"). Then "changes" must be the FULL new list (last scenario with the change applied).
- "sweep" (sweep only): {"param":"demand_pct"|"capacity_pct"|"freight_pct"|"stock_loss_pct","from":n,"to":n,"steps":2..12 (default 5)}. capacity_pct is % of normal (default 50..120); the others are changes in % (defaults demand -20..40, freight 0..100, stock 0..50).
- "focus" (today only): "short" (any question about shortages, where or which towns are short or miss out) | "freight" (freight or transport cost) | "general".
- "reply": for answer/clarify, the full answer: plain everyday words, at most 70 words, no technical terms, no numbers you were not given. For other kinds: one short sentence saying what you will check. Write in the language and script the user wrote in.
- "go" (answer only): the page that helps, one of ${PAGES.join(', ')}, or null.

If the message is not about the app, planning, stock, deliveries or the business, use kind "answer" and say briefly what you can help with.
${opts.hasData === false ? 'No data is loaded yet: what-ifs need data loaded on Home first.\n' : ''}
How the app works (use for "answer"):
${guide}

Data loaded on this phone:
${names(ctx, question, opts.last)}

Last scenario (for follow-ups): ${last}`;
}

const ids = (v: unknown, ok: Set<string>, bad: string[]) => {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((x): x is string => typeof x === 'string'))];
  for (const x of out) if (!ok.has(x)) bad.push(x);
  const good = out.filter((x) => ok.has(x));
  return good.length ? good : undefined;
};
const pctIn = (v: unknown, lo: number, hi: number, notes: string[], what: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < lo || n > hi) notes.push(`${what} can go from ${lo}% to ${hi}%; I kept it inside that.`);
  return Math.round(Math.min(hi, Math.max(lo, n)) * 10) / 10;
};

/** The model's changes, kept only where every id exists and every number is in range. */
export function checkChanges(raw: unknown, ctx: Ctx, notes: string[]): Change[] {
  const towns = new Set(ctx.towns.map((t) => t.id)), depots = new Set(ctx.depots.map((d) => d.id)), products = new Set(ctx.products.map((p) => p.id));
  const openRoutes = ctx.routes.filter((r) => r.active);
  const open = new Set(openRoutes.map((r) => `${r.g}>${r.t}`));
  const bad: string[] = [];
  const out: Change[] = [];
  // roads: pairs as given (a repeated scenario), or towns/depots/longest worked out here, the way the word rules do it
  const routes = (c: any): [string, string][] => {
    const given = (Array.isArray(c.routes) ? c.routes : []).filter((r: unknown) => Array.isArray(r) && open.has(`${r[0]}>${r[1]}`)).map((r: string[]): [string, string] => [r[0], r[1]]);
    if (given.length) return given;
    if (c.longest) { const l = [...openRoutes].sort((a, b) => b.km - a.km)[0]; return l ? [[l.g, l.t]] : []; }
    const ts = ids(c.towns, towns, bad), ds = ids(c.depots, depots, bad);
    if (!ts && !ds) return [];
    return openRoutes.filter((r) => (!ts || ts.includes(r.t)) && (!ds || ds.includes(r.g))).map((r): [string, string] => [r.g, r.t]);
  };
  // products: ids named, plus every product in the groups named ("dairy")
  const prods = (c: any) => {
    const gs = Array.isArray(c.groups) ? c.groups.map((g: unknown) => String(g).toLowerCase()) : [];
    const all = [...new Set([...(ids(c.products, products, bad) ?? []), ...ctx.products.filter((p) => p.group && gs.includes(p.group.toLowerCase())).map((p) => p.id)])];
    return all.length ? all : undefined;
  };
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || typeof c !== 'object') continue;
    let ch: Change | null = null;
    const pct = (lo: number, hi: number, what: string) => pctIn(c.pct, lo, hi, notes, what);
    switch (c.topic) {
      case 'demand': { const p = pct(-90, 300, 'Demand'); if (p != null) ch = { topic: 'demand', pct: p, towns: ids(c.towns, towns, bad), products: prods(c), text: '' }; break; }
      case 'capacity': { const p = pct(0, 300, 'Capacity'); if (p != null) ch = { topic: 'capacity', pct: p, depots: ids(c.depots, depots, bad), text: '' }; break; }
      case 'freight': { const p = pct(-50, 300, 'Freight'); if (p != null) ch = { topic: 'freight', pct: p, text: '' }; break; }
      case 'stock': { const p = pct(0, 100, 'Stock lost'); if (p != null) ch = { topic: 'stock', pct: p, depots: ids(c.depots, depots, bad), products: prods(c), text: '' }; break; }
      case 'margin': { const p = pct(0, 50, 'Margin'); if (p != null) ch = { topic: 'margin', pct: p, text: '' }; break; }
      case 'close': { const r = routes(c); if (r.length) ch = { topic: 'close', routes: r, text: '' }; break; }
      case 'restrict': { const r = routes(c); if (r.length && c.vehicle in TRUCKS) ch = { topic: 'restrict', routes: r, vehicle: c.vehicle, text: '' }; break; }
    }
    if (!ch) continue;
    // a zero change is no change; the words double as the follow-up text the word rules can read again offline
    if ('pct' in ch && ch.topic !== 'capacity' && ch.topic !== 'margin' && ch.pct === 0) continue;
    if (ch.topic === 'capacity' && ch.pct === 100) continue;
    ch.text = describe(ch, ctx);
    out.push(ch);
  }
  if (bad.length) notes.push(`I left out names that are not in your data (${[...new Set(bad)].slice(0, 3).join(', ')}).`);
  return out;
}

export async function interpret(question: string, ctx: Ctx, opts: AiOpts): Promise<AiAnswer> {
  const text = await chat(opts, [{ role: 'system', content: system(ctx, question, opts) }, ...(opts.history ?? []).slice(-8), { role: 'user', content: question }], true, 1500);
  let o: any;
  try { o = JSON.parse(text); } catch { throw new Error('AI answer was not JSON'); }
  const reply = typeof o.reply === 'string' ? o.reply.trim().slice(0, 700) : '';
  const go = PAGES.includes(o.go) ? o.go : null;
  const notes: string[] = [];
  switch (o.kind) {
    case 'scenario': {
      const changes = checkChanges(o.changes, ctx, notes);
      if (!changes.length) return { intent: null, reply: reply || 'I could not match that to your data. Try naming a town, depot or product from your file.', go: null, notes };
      return { intent: { kind: 'scenario', changes, notes, followUp: !!o.follow_up && !!opts.last?.length }, reply, go: null, notes };
    }
    case 'sweep': {
      const s = o.sweep ?? {};
      if (!(s.param in SWEEP)) throw new Error('AI sweep without a known measure');
      const cfg = SWEEP[s.param as SweepParam];
      let from = pctIn(s.from ?? cfg.from, cfg.min, cfg.max, notes, cfg.label) ?? cfg.from, to = pctIn(s.to ?? cfg.to, cfg.min, cfg.max, notes, cfg.label) ?? cfg.to;
      if (from > to) [from, to] = [to, from];
      if (from === to) throw new Error('AI sweep with no range');
      const steps = Math.min(12, Math.max(2, Math.round(Number(s.steps) || 5)));
      return { intent: { kind: 'sweep', param: s.param, from, to, steps, notes }, reply, go: null, notes };
    }
    case 'today': return { intent: { kind: 'today', focus: ['short', 'freight'].includes(o.focus) ? o.focus : 'general' }, reply, go: null, notes };
    case 'compare': return { intent: { kind: 'compare' }, reply, go: null, notes };
    case 'undo': return { intent: { kind: 'undo' }, reply, go: null, notes };
    case 'reset': return { intent: { kind: 'reset' }, reply, go: null, notes };
    case 'answer':
    case 'clarify':
      if (!reply) throw new Error('AI answer was empty');
      return { intent: null, reply, go, notes };
    default: throw new Error('AI answer of an unknown kind');
  }
}

// ---------- 2. explaining a result ----------
/** facts: plain-text figures from the engine. Returns at most two sentences, or throws (keep the app's own sentence). */
export async function explain(question: string, facts: string, opts: AiOpts): Promise<string> {
  const text = await chat(opts, [
    { role: 'system', content: 'You explain a planning result to a distributor in India in at most two short sentences of plain everyday words, in the language and script of their question. Say what changes and the most likely reason. Use ONLY the figures given, copied exactly; do not add any other number. No greeting, no lists, no technical terms.' },
    { role: 'user', content: `Question: ${question}\n\nFigures from the planner:\n${facts}` },
  ], false, 400);
  return text.replace(/\s+/g, ' ').slice(0, 400);
}
