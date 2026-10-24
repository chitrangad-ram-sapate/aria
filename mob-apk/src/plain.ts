// Everyday wording for things the engine names in code: sample datasets and input problems.
import type { Json } from './ui';

const SAMPLES: Record<string, string> = {
  kolhapur_normal_week: 'Kolhapur: a normal week',
  kolhapur_monsoon_squeeze: 'Kolhapur: monsoon week with roads cut',
  kolhapur_edge_cases: 'Kolhapur: small example',
  maharashtra_normal_week: 'Maharashtra: a normal week',
};
export const sampleName = (id: string) => SAMPLES[id] ?? id.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const nameIn = (list: Json[] | undefined, key: string, id: any) => list?.find((x) => x[key] === id)?.name || String(id ?? '');

/** "Milk at North depot" style label for the row an issue points at ($.lots[3].qty_units → that lot). */
function what(path: string, sc: Json): string {
  const m = /^\$\.(\w+)\[(\d+)\]/.exec(path ?? '');
  if (!m || !sc) return 'Your data';
  const row = sc[m[1]]?.[Number(m[2])] ?? {};
  const depot = nameIn(sc.godowns, 'godown_id', row.godown_id), town = nameIn(sc.towns, 'town_id', row.town_id);
  switch (m[1]) {
    case 'lots': return `Stock of ${row.product_id} at ${depot}`;
    case 'town_stock': return `Stock of ${row.product_id} already in ${town}`;
    case 'routes': return `The route ${depot} → ${town}`;
    case 'demand': return `Demand for ${row.product_id} in ${town}`;
    case 'products': return `Product ${row.product_id}`;
    case 'towns': return `Town ${town}`;
    case 'godowns': return `Depot ${nameIn(sc.godowns, 'godown_id', row.godown_id)}`;
    default: return 'Your data';
  }
}

/** One input problem in plain words. */
export function issueText(i: Json, sc: Json): string {
  const field = String(i.path ?? '').split('.').pop() ?? '';
  const msg = String(i.message ?? '');
  const subject = what(i.path, sc);
  switch (i.code) {
    case 'E_RANGE':
      if (field === 'remaining_life_days') return `${subject} has more days left than the product's whole shelf life.`;
      if (field === 'qty_units') return `${subject} has a quantity below zero.`;
      if (field === 'min_days_at_receipt') return `${subject} needs more days left on delivery than its whole shelf life.`;
      if (field === 'priority') return `${subject} has a priority outside 0.1 to 10.`;
      if (field === 'road_km') return `${subject} has a distance below zero.`;
      if (field === 'quantiles') return `${subject} has forecast numbers that go down instead of up.`;
      if (field === 'price_paise') return `${subject} has a price below zero.`;
      return `${subject}: ${msg}.`;
    case 'E_BAD_REF': return `${subject} mentions something that is not in your lists (${msg.replace(/^unknown \w+ /, '')}).`;
    case 'E_DUPLICATE_ID': return `${subject} appears twice.`;
    case 'W_EXPIRED_STOCK': return `${subject} has already expired and will be thrown away.`;
    case 'W_INACTIVE_ROUTE': return `${subject} is closed.`;
    case 'W_NO_ELIGIBLE_SUPPLY': return `${subject} cannot be met: no stock can reach the town in time.`;
    default: return msg ? `${subject}: ${msg}.` : `${subject} needs checking.`;
  }
}

/** Notes grouped by kind, e.g. "6 routes are closed". */
export function noteGroups(warnings: Json[]): { title: string; items: Json[] }[] {
  const titles: Record<string, (n: number) => string> = {
    W_INACTIVE_ROUTE: (n) => `${n} route${n > 1 ? 's are' : ' is'} closed`,
    W_EXPIRED_STOCK: (n) => `${n} stock lot${n > 1 ? 's have' : ' has'} already expired`,
    W_NO_ELIGIBLE_SUPPLY: (n) => `${n} town and product pair${n > 1 ? 's' : ''} cannot be supplied in time`,
  };
  const by = new Map<string, Json[]>();
  for (const w of warnings) by.set(w.code, [...(by.get(w.code) ?? []), w]);
  return [...by].map(([code, items]) => ({ title: (titles[code] ?? ((n: number) => `${n} other note${n > 1 ? 's' : ''}`))(items.length), items }));
}
