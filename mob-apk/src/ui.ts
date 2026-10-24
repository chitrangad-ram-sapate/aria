// DOM and formatting helpers. Formatting only (rule R-3): no engine numbers are computed here.
export type Json = any;

type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

function append(el: Node, kids: Child[]) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(el: HTMLElement, ...kids: Child[]) {
  el.replaceChildren();
  append(el, kids);
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-IN');

export const rupees = (paise: number | null | undefined) => (paise == null ? '-' : `₹${inr.format(paise / 100)}`);
export const num = (v: number | null | undefined) => (v == null ? '-' : int.format(v));
export const short = (hash: string | null | undefined) => (hash ? String(hash).slice(0, 12) : '-');

export function fmt(key: string, v: any): string {
  if (v == null || typeof v === 'boolean') return String(v ?? '-');
  if (typeof v === 'number' && key.includes('paise')) return rupees(v);
  if (typeof v === 'number' && key === 'fill_rate') return `${(v * 100).toFixed(1)}%`;
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.abs(v) < 10 ? v.toFixed(4) : int.format(Math.round(v * 100) / 100);
  if (typeof v === 'number') return int.format(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export const label = (k: string) => k.replace(/_paise$/, '').replace(/_/g, ' ');

export const badge = (text: string, kind: '' | 'ok' | 'bad' | 'warn' = '') => h('span', { class: `badge ${kind}` }, text);

/** Simple table. cols: [key, header, formatter?]. onRow makes rows tappable. */
export function table(rows: Json[], cols: [string, string, ((v: any, r: Json) => string)?][], onRow?: (r: Json) => void, limit = 0) {
  const shown = limit ? rows.slice(0, limit) : rows;
  const t = h('table', {},
    h('thead', {}, h('tr', {}, cols.map(([, head]) => h('th', { scope: 'col' }, head)))),
    h('tbody', {}, shown.map((r) => {
      const tr = h('tr', {}, cols.map(([k, , f]) => h('td', {}, f ? f(r[k], r) : fmt(k, r[k]))));
      if (onRow) {
        tr.tabIndex = 0;
        tr.classList.add('tap');
        tr.addEventListener('click', () => onRow(r));
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRow(r); });
      }
      return tr;
    })),
  );
  return h('div', { class: 'table-wrap' }, t);
}

/** Table that renders `step` rows at a time with a "Show more" button. */
export function pagedTable(rows: Json[], cols: Parameters<typeof table>[1], onRow?: (r: Json) => void, step = 40) {
  const box = h('div', {});
  let n = step;
  const draw = () => mount(box, table(rows, cols, onRow, n),
    rows.length > n && h('button', { class: 'btn ghost', onclick: () => { n += step * 2; draw(); } }, `Show more (${num(rows.length - n)} left)`));
  draw();
  return box;
}

export function kv(pairs: [string, string][]) {
  return h('dl', { class: 'kv' }, pairs.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

export function select(options: [string, string][], value: string, onchange: (v: string) => void, aria: string) {
  return h('select', { 'aria-label': aria, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
    options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
}

export function segmented(options: [string, string][], value: string, onchange: (v: string) => void, aria: string) {
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': aria },
    options.map(([v, text]) => h('button', { role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '', onclick: () => onchange(v) }, text)));
}

const sheet = h('dialog', { class: 'sheet', 'aria-label': 'Details' });
document.body.appendChild(sheet);
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

export function openSheet(title: string, ...body: Child[]) {
  mount(sheet, h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { class: 'btn ghost', onclick: () => sheet.close(), 'aria-label': 'Close' }, 'Close')), h('div', { class: 'sheet-body' }, body));
  if (!sheet.open) sheet.showModal();
}

let toastTimer = 0;
export function toast(msg: string) {
  let t = document.getElementById('toast');
  if (!t) document.body.appendChild((t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' })));
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), 3500);
}

export function errorBox(msg: string) {
  return h('div', { class: 'alert bad', role: 'alert' }, msg);
}

/** Demand band: 9 quantiles as nested ranges (99%, 95%, 50%) with a median tick, on a 0..max scale. */
export function bandBar(q: number[], max: number) {
  const x = (v: number) => `${(100 * Math.max(0, v)) / (max || 1)}%`;
  const w = (a: number, b: number) => `${(100 * Math.max(0, b - a)) / (max || 1)}%`;
  return h('div', { class: 'band', role: 'img', 'aria-label': `median ${fmt('q', q[4])}, 95% range ${fmt('q', q[1])} to ${fmt('q', q[7])}` },
    h('span', { class: 'b99', style: `left:${x(q[0])};width:${w(q[0], q[8])}` }),
    h('span', { class: 'b95', style: `left:${x(q[1])};width:${w(q[1], q[7])}` }),
    h('span', { class: 'b50', style: `left:${x(q[3])};width:${w(q[3], q[5])}` }),
    h('span', { class: 'med', style: `left:${x(q[4])}` }));
}
