// Checks Ask ARIA's language model (src/ai.ts) against the live Groq API with the Kolhapur sample's names: questions the
// word rules cannot read, follow-ups, how-to answers, made-up names and an explanation that copies only given figures.
// Usage: node scripts/ai-test.mjs   (needs VITE_GROQ_API_KEY in .env.local; skipped without it)
import { existsSync, readFileSync } from 'node:fs';
import { explain, interpret } from '../src/ai.ts';
import { toParams } from '../src/assistant.ts';

const envFile = new URL('../.env.local', import.meta.url);
const env = Object.fromEntries((existsSync(envFile) ? readFileSync(envFile, 'utf8') : '').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
if (!env.VITE_GROQ_API_KEY) { console.log('skipped: no VITE_GROQ_API_KEY in .env.local'); process.exit(0); }
const opts = { key: env.VITE_GROQ_API_KEY, url: 'https://api.groq.com/openai/v1/chat/completions', model: env.VITE_GROQ_MODEL || 'openai/gpt-oss-120b', fallback: 'openai/gpt-oss-20b', timeoutMs: 30000, hasData: true };

const s = JSON.parse(readFileSync(new URL('../engine/data/scenarios/kolhapur_normal_week.json', import.meta.url), 'utf8'));
const ctx = {
  towns: s.towns.map((t) => ({ kind: 'town', id: t.town_id, name: t.name })),
  depots: s.godowns.map((g) => ({ kind: 'depot', id: g.godown_id, name: g.name })),
  products: s.products.map((p) => ({ kind: 'product', id: p.product_id, name: p.product_id, group: p.category })),
  routes: s.routes.map((r) => ({ g: r.godown_id, t: r.town_id, km: r.road_km, active: r.active })),
};

let failed = 0;
const check = (what, ok, got) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (got ${JSON.stringify(got)})`}`); };
// Groq's free tier allows 8,000 tokens a minute per model (a question is about 2,000): wait for the budget, do not fail
const patient = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (e?.status !== 429 || i >= 4) throw e; await new Promise((r) => setTimeout(r, 30000)); } } };
const ask = async (q, extra = {}) => { const t0 = Date.now(); const a = await patient(() => interpret(q, ctx, { ...opts, ...extra })); a.ms = Date.now() - t0; return a; };
const p = (a) => (a.intent?.kind === 'scenario' ? toParams(a.intent.changes) : null);

let a = await ask('Agar Kolhapur mein maang 25% badh jaye to kya hoga?');
check(`Hindi in Latin letters: demand +25% in Kolhapur`, p(a)?.demand_pct === 25 && p(a)?.demand_town?.join() === 'T_KOLHAPUR', a);
a = await ask('कागल MIDC मध्ये कामगार संप झाला तर?');
check('Marathi: a strike at Kagal MIDC loads nothing', p(a)?.capacity_pct === 0 && p(a)?.capacity_depot?.join() === 'G_KAGAL_MIDC', a);
a = await ask("monsoon's washed out the highway into Ratnagiri, and diesel went up by a tenth");
check('roads into Ratnagiri closed and freight +10%', p(a)?.freight_pct === 10 && p(a)?.closures?.length > 0 && p(a).closures.every(([, t]) => t === 'T_RATNAGIRI'), a);
const first = a.intent?.changes ?? null;
a = await ask('ok and make the diesel bit 30% instead', { last: first, history: [{ role: 'user', content: "monsoon's washed out the highway into Ratnagiri, and diesel went up by a tenth" }] });
check('follow-up keeps the closure and changes freight to +30%', p(a)?.freight_pct === 30 && p(a)?.closures?.length > 0 && a.intent.followUp, a);
a = await ask('dairy sales up by a third everywhere');
check('a product group: every dairy product, +33%', Math.round(p(a)?.demand_pct ?? 0) === 33 && p(a)?.demand_product?.length === s.products.filter((x) => x.category === 'dairy').length, a);
a = await ask('what if demand doubles in Mumbai?');
check('a town not in the data is not invented', !p(a)?.demand_town?.includes('T_MUMBAI') && (a.intent === null || a.notes.length > 0 || !p(a)?.demand_town), a);
a = await ask('show me how freight from 0 to 60% changes things');
check('a range', a.intent?.kind === 'sweep' && a.intent.param === 'freight_pct' && a.intent.from === 0 && a.intent.to === 60, a);
a = await ask('where am I short tonight?');
check('tonight, shortages', a.intent?.kind === 'today' && a.intent.focus === 'short', a);
a = await ask('how does my driver prove they delivered?');
check('a how-to answer with a page', a.intent === null && a.reply.length > 20 && a.go === 'team', a);
a = await ask('write me a poem about cricket');
check('off-topic is turned down politely', a.intent === null && a.reply.length > 0, a);

const facts = 'Changes tried: Demand up 20% in Kolhapur\nDemand met (fill rate): tonight 91.5%, with the change 89.5% (-2.2%)\nFreight cost: tonight ₹4,063.36, with the change ₹4,203.10 (+3.4%)\nTown Kolhapur: receives 9,100 -> 9,900 units, short 3,000 -> 4,512 units';
const e = await patient(() => explain('what if demand rises 20% in Kolhapur?', facts, opts));
const given = new Set(facts.match(/\d[\d,.]*/g).map((x) => x.replace(/[,.]$/, '')));
const extra = (e.match(/\d[\d,.]*/g) ?? []).map((x) => x.replace(/[,.]$/, '')).filter((x) => !given.has(x) && x !== '20');
check(`explanation uses only the given figures: "${e}"`, extra.length === 0, extra);

console.log(failed ? `\n${failed} check(s) failed` : '\nall AI checks passed');
process.exit(failed ? 1 : 0);
