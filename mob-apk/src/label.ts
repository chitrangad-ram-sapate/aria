// Reading product and lot labels. Three kinds are understood:
//  - ARIA labels (QR): "ARIA1|product=MILK_1L|lot=L-0042|qty=240|exp=2026-10-29|depot=D_HADAPSAR", or the same keys as JSON;
//  - GS1 barcodes on retail packs: (01) product number, (10) lot, (17)/(15) expiry YYMMDD, (37)/(30) count;
//  - a plain code: a product number (8 to 14 digits), a product id, or a lot number.
// Nothing here checks the values against the dataset; scan.ts does that.

export type Label = {
  raw: string;
  kind: 'aria' | 'gs1' | 'plain';
  product?: string; // product id as written on the label
  gtin?: string; // product number from a retail barcode
  lot?: string;
  qty?: string; // kept as text so "12.5" or "-3" can be reported, not silently fixed
  expiry?: string; // YYYY-MM-DD when the date could be read
  badExpiry?: string; // the date as written when it could not be read
  depot?: string;
  token?: string; // a plain code that is not a product number: a product id or a lot number
};

const KEYS: Record<string, keyof Label> = {
  product: 'product', p: 'product', item: 'product', sku: 'product', product_id: 'product',
  gtin: 'gtin', ean: 'gtin', barcode: 'gtin',
  lot: 'lot', l: 'lot', batch: 'lot', lot_id: 'lot', lot_no: 'lot',
  qty: 'qty', q: 'qty', units: 'qty', quantity: 'qty', count: 'qty', qty_units: 'qty',
  exp: 'expiry', e: 'expiry', expiry: 'expiry', expires: 'expiry', best_before: 'expiry', use_by: 'expiry', bb: 'expiry',
  depot: 'depot', d: 'depot', godown: 'depot', warehouse: 'depot', depot_id: 'depot',
};

const pad = (n: number) => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** A date written as YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY or GS1 YYMMDD → YYYY-MM-DD, or null. */
export function readDate(s: string, gs1 = false): string | null {
  const t = s.trim();
  let y = 0, m = 0, d = 0;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t))) [d, m, y] = [+r[1], +r[2], +r[3]];
  else if (gs1 && (r = /^(\d{2})(\d{2})(\d{2})$/.exec(t))) {
    [y, m, d] = [2000 + +r[1], +r[2], +r[3]];
    if (d === 0) d = new Date(Date.UTC(y, m, 0)).getUTCDate(); // GS1: day 00 means the end of the month
  } else return null;
  return valid(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

// GS1 application identifiers we use, with their fixed length (0 = variable, ended by the separator or the end).
const AI: Record<string, number> = { '00': 18, '01': 14, '02': 14, '10': 0, '11': 6, '13': 6, '15': 6, '16': 6, '17': 6, '21': 0, '30': 0, '37': 0 };

function gs1Fields(s: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (s.startsWith('(')) {
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) out[m[1]] = m[2].trim();
    return Object.keys(out).length ? out : null;
  }
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1d') { i++; continue; }
    const ai = s.slice(i, i + 2);
    if (!(ai in AI)) return Object.keys(out).length ? out : null;
    i += 2;
    const len = AI[ai];
    if (len) { out[ai] = s.slice(i, i + len); i += len; } else {
      const end = s.indexOf('\x1d', i);
      out[ai] = s.slice(i, end < 0 ? undefined : end);
      i = end < 0 ? s.length : end + 1;
    }
  }
  return out;
}

export function parseLabel(input: string): Label {
  const raw = input.replace(/^\][A-Za-z]\d/, '').trim(); // drop a scanner's symbology prefix such as ]C1 or ]Q3
  const label: Label = { raw, kind: 'plain' };
  const setDate = (v: string, gs1 = false) => {
    const iso = readDate(v, gs1);
    if (iso) label.expiry = iso; else label.badExpiry = v;
  };

  let pairs: [string, string][] | null = null;
  if (raw.startsWith('{')) {
    try { pairs = Object.entries(JSON.parse(raw)).map(([k, v]) => [k, String(v ?? '')]); } catch { pairs = null; }
  } else if (raw.includes('=')) {
    pairs = raw.split(/[|;&\n]/).map((p) => p.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k, v.join('=')]);
  }
  if (pairs?.length) {
    label.kind = 'aria';
    for (const [k, v] of pairs) {
      const key = KEYS[k.trim().toLowerCase()];
      const val = v.trim();
      if (!key || !val) continue;
      if (key === 'expiry') setDate(val);
      else (label as any)[key] = val;
    }
    return label;
  }

  const looksGs1 = raw.startsWith('(') || raw.includes('\x1d') || (/^01\d{14}/.test(raw) && raw.length > 16);
  const f = looksGs1 ? gs1Fields(raw) : null;
  if (f && (f['01'] || f['10'])) {
    label.kind = 'gs1';
    if (f['01']) label.gtin = f['01'].replace(/^0+(?=\d{8})/, '');
    if (f['10']) label.lot = f['10'];
    const exp = f['17'] ?? f['15'];
    if (exp) setDate(exp, true);
    const n = f['37'] ?? f['30'];
    if (n) label.qty = String(Number(n));
    return label;
  }

  if (/^\d{8}$|^\d{12,14}$/.test(raw)) label.gtin = raw.replace(/^0+(?=\d{8})/, '');
  else if (raw) label.token = raw;
  return label;
}
