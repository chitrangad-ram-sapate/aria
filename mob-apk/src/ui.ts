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

/** Line icons (Lucide-style paths, 24px grid). Decorative unless the caller gives the button a label. */
const ICONS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  zap: 'M13 2 4 14h7l-1 8 9-12h-7z',
  chat: 'M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.3A8.5 8.5 0 1 1 21 11.5zM8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01',
  swap: 'M17 3l4 4-4 4M21 7H7M7 21l-4-4 4-4M3 17h14',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 14l2 2 4-4',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01',
  back: 'M15 18l-6-6 6-6',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  upload: 'M12 3v12M7 8l5-5 5 5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  truck: 'M3 6h11v10H3zM14 9h4l3 3v4h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a7 7 0 0 1 4 7',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3',
  check: 'M20 6 9 17l-5-5',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 8v8M12 8v8M16 8v8',
  alert: 'M12 3 2 20h20zM12 10v4M12 17.5v.01',
  phone: 'M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z',
};
export const icon = (name: string) => h('span', { class: 'ico', 'aria-hidden': 'true', innerHTML: `<svg class="i" viewBox="0 0 24 24"><path d="${ICONS[name]}"/></svg>` });

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
