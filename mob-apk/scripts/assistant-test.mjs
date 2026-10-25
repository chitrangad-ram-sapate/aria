// Checks how Ask ARIA (src/assistant.ts) reads questions, against the names in two bundled samples.
// Usage: node scripts/assistant-test.mjs   (Node 22.6+ reads the TypeScript file directly)
import { readFileSync } from 'node:fs';
import { describe, scenarioName, toParams, understand } from '../src/assistant.ts';

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const ctxOf = (file) => {
  const s = JSON.parse(readFileSync(new URL(`../engine/data/scenarios/${file}.json`, import.meta.url), 'utf8'));
  return {
    towns: s.towns.map((t) => ({ kind: 'town', id: t.town_id, name: t.name || t.town_id })),
    depots: s.godowns.map((g) => ({ kind: 'depot', id: g.godown_id, name: g.name || g.godown_id })),
    products: s.products.map((p) => ({ kind: 'product', id: p.product_id, name: p.product_id, group: p.category })),
    routes: s.routes.map((r) => ({ g: r.godown_id, t: r.town_id, km: r.road_km, active: r.active })),
  };
};
const kop = ctxOf('kolhapur_normal_week');
const mh = ctxOf('maharashtra_normal_week');
const params = (q, ctx = kop, last = null) => { const i = understand(q, ctx, last); return i.kind === 'scenario' ? toParams(i.changes) : i.kind; };
const kind = (q, ctx = kop) => understand(q, ctx).kind;

// one change at a time
check('demand up 20%', params('What if demand goes up 20%?'), { demand_pct: 20 });
check('demand down, one town', params('what if sales drop 15% in Ichalkaranji'), { demand_pct: -15, demand_town: ['T_ICHALKARANJI'] });
check('two towns joined by "and"', params('demand up 30% in Kolhapur and Jaysingpur'), { demand_pct: 30, demand_town: ['T_KOLHAPUR', 'T_JAYSINGPUR'] });
check('a product group', params('dairy demand up 10%'), { demand_pct: 10, demand_product: kop.products.filter((p) => p.group === 'dairy').map((p) => p.id) });
check('a named town with a change means demand', params('Kolhapur needs 25% more'), { demand_pct: 25, demand_town: ['T_KOLHAPUR'] });
check('festival without a number assumes +30%', params('what if there is a Diwali rush in Kagal'), { demand_pct: 30, demand_town: ['T_KAGAL'] });
check('demand doubles', params('demand doubles'), { demand_pct: 100 });
check('signed number', params('demand -40%'), { demand_pct: -40 });
check('capacity "30% less"', params('Depots load 30% less'), { capacity_pct: 70 });
check('capacity "only 60%" is a level, not a cut', params('Shiroli can load only 60%'), { capacity_pct: 60, capacity_depot: ['G_SHIROLI'] });
check('capacity up', params('capacity up 20%'), { capacity_pct: 120 });
check('half capacity', params('half capacity at Kagal MIDC'), { capacity_pct: 50, capacity_depot: ['G_KAGAL_MIDC'] });
check('strike at a depot loads nothing', params('labour strike at Shiroli'), { capacity_pct: 0, capacity_depot: ['G_SHIROLI'] });
check('a closed depot loads nothing', params('Gokul Shirgaon depot is closed'), { capacity_pct: 0, capacity_depot: ['G_GOKUL_SHIRGAON'] });
check('freight dearer', params('Freight 25% dearer'), { freight_pct: 25 });
check('diesel counts as freight', params('diesel price up 12%'), { freight_pct: 12 });
check('freight cut', params('transport costs cut by 10%'), { freight_pct: -10 });
check('stock lost at a depot', params('lose 20% of stock at Shiroli'), { stock_loss_pct: 20, stock_depot: ['G_SHIROLI'] });
check('"Kagal" means the depot when stock is lost', params('flood damaged 40% of stock in Kagal'), { stock_loss_pct: 40, stock_depot: ['G_KAGAL_MIDC'] });
check('recall of a product removes all of it', params('recall of FOODS_3_007'), { stock_loss_pct: 100, stock_product: ['FOODS_3_007'] });
check('margin', params('margin 5%'), { margin: 0.05 });

// roads and trucks
const longest = [...kop.routes].filter((r) => r.active).sort((a, b) => b.km - a.km)[0];
check('longest route closed', params('Longest route closed'), { closures: [[longest.g, longest.t]] });
check('every road into a town', params('the road to Ratnagiri is blocked').closures.every(([, t]) => t === 'T_RATNAGIRI'), true);
check('one route by both names', params('close the road from Shiroli to Kolhapur'), { closures: [['G_SHIROLI', 'T_KOLHAPUR']] });
check('"Kagal" is the depot when a town is also named', params('close the route from Kagal to Kolhapur'), { closures: [['G_KAGAL_MIDC', 'T_KOLHAPUR']] });
check('"Kagal" alone on a road is the town', params('road to Kagal closed').closures.every(([, t]) => t === 'T_KAGAL'), true);
check('only small trucks', params('only small trucks from Shiroli to Kolhapur'), { restrictions: [['G_SHIROLI', 'T_KOLHAPUR', '6t']] });
check('no large trucks means medium at most', params('no large trucks to Kolhapur').restrictions.every((r) => r[2] === 'road_avg' && r[1] === 'T_KOLHAPUR'), true);

// several changes in one question
check('three changes at once', params('what if demand rises 20% in Kolhapur, freight is 10% dearer and Shiroli loads 30% less'),
  { demand_pct: 20, demand_town: ['T_KOLHAPUR'], freight_pct: 10, capacity_pct: 70, capacity_depot: ['G_SHIROLI'] });

// follow-ups
const first = understand('demand up 20% in Kolhapur', kop);
check('"also" adds to the last scenario', params('also freight 25% dearer', kop, first.changes), { demand_pct: 20, demand_town: ['T_KOLHAPUR'], freight_pct: 25 });
check('a number alone changes the last number', params('what about 40%?', kop, first.changes), { demand_pct: 40, demand_town: ['T_KOLHAPUR'] });
check('a name alone moves the last change', params('what about Kagal instead', kop, first.changes), { demand_pct: 20, demand_town: ['T_KAGAL'] });
const cut = understand('capacity down 30%', kop);
check('a number alone keeps the sense of the change', params('make it 50', kop, cut.changes), { capacity_pct: 50 });
check('without "also" a new question starts fresh', params('freight 25% dearer', kop, first.changes), { freight_pct: 25 });

// ranges, tonight, help, commands
check('range with steps', understand('demand from -20% to 40% in 4 steps', kop), { kind: 'sweep', param: 'demand_pct', from: -20, to: 40, steps: 4, notes: [] });
check('step through freight uses the default range', (({ kind, param, from, to }) => ({ kind, param, from, to }))(understand('show freight step by step', kop)), { kind: 'sweep', param: 'freight_pct', from: 0, to: 100 });
check('range clamped', understand('demand between -95 and 20', kop).from, -90);
check('which towns are short', understand('which towns are short tonight?', kop), { kind: 'today', focus: 'short' });
check('how is tonight', kind("how does tonight's plan look"), 'today');
check('how-to beats "tonight"', understand('how do I plan tonight?', kop), { kind: 'help', topic: 'plan' });
check('help: trips', understand('How do I send trips to drivers?', kop), { kind: 'help', topic: 'trips' });
check('help: csv', understand('where do I upload my csv', kop), { kind: 'help', topic: 'data' });
check('help: hello', understand('hi', kop), { kind: 'help', topic: 'hello' });
check('help: what can you ask', understand('What can you ask?', kop), { kind: 'help', topic: 'hello' });
check('help: fill rate', understand('what is fill rate', kop), { kind: 'help', topic: 'fill' });
check('compare', kind('which option is best?'), 'compare');
check('undo', kind('undo'), 'undo');
check('reset', kind('start over'), 'reset');
check('nonsense is not guessed', kind('the weather is nice'), 'unknown');
check('missing amount is asked for', understand('what if freight goes up', kop).ask, 'By how much? For example "freight 25% dearer".');

// another network: depot names with towns in brackets, a renamed city
check('"Chakan MIDC (Pune)": Pune stays the town', params('demand up 10% in Pune', mh), { demand_pct: 10, demand_town: ['T_PUNE'] });
check('a city known by two names', params('Sambhajinagar demand up 15%', mh), { demand_pct: 15, demand_town: ['T_SAMBHAJINAGAR'] });
check('a depot by its area name', params('Chakan loads 20% less', mh), { capacity_pct: 80, capacity_depot: ['D_CHAKAN'] });

// words shown to the person
const three = understand('demand up 20% in Kolhapur and freight 10% dearer', kop).changes;
check('plain description', three.map((c) => describe(c, kop)), ['Demand up 20% in Kolhapur', 'Freight rates up 10%']);
check('short scenario name', scenarioName(three, kop), 'Demand +20% Kolhapur + Freight +10%');

console.log(failed ? `\n${failed} check(s) failed` : '\nall assistant checks passed');
process.exit(failed ? 1 : 0);
