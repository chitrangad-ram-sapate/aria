// Small SVG charts for the dashboards: donut, horizontal bars, histogram, line, plus a shared tap/hover
// tooltip. Every chart takes values the engine computed (rule R-3) and only lays them out. Each figure has a
// title, units, a legend for 2+ series and a "Show as table" view, so colour never carries meaning alone.
import { h, num, table } from './ui';

/** Categorical slots in fixed order (validated light palette); depots and scenarios keep their slot. */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const OTHER = '#9ca3af';
export const seriesColor = (i: number) => (i >= 0 && i < SERIES.length ? SERIES[i] : OTHER);

const NS = 'http://www.w3.org/2000/svg';
export function s(tag: string, attrs: Record<string, any> = {}, ...kids: (Node | string | null | false | undefined)[]) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids) if (k != null && k !== false) el.append(k);
  return el;
}

// ---------- tooltip ----------
const tipBox = h('div', { class: 'viz-tip', role: 'tooltip' });
document.body.appendChild(tipBox);
let tipOwner: Element | null = null;
function showTip(e: PointerEvent | MouseEvent, text: string, owner: Element) {
  tipBox.textContent = text;
  tipBox.classList.add('show');
  tipOwner = owner;
  const pad = 12, w = tipBox.offsetWidth, hh = tipBox.offsetHeight;
  const x = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX - w / 2));
  const y = e.clientY - hh - pad < 8 ? e.clientY + pad : e.clientY - hh - pad;
  tipBox.style.transform = `translate(${x}px, ${y}px)`;
}
export const hideTip = () => { tipBox.classList.remove('show'); tipOwner = null; };
document.addEventListener('pointerdown', (e) => { if (tipOwner && !(e.target as Element).closest?.('[data-tip]')) hideTip(); });
window.addEventListener('scroll', hideTip, { passive: true });

/** Make a mark (or a bigger invisible hit area) show `text` on hover and on tap. */
export function tip<T extends Element>(el: T, text: string, onTap?: () => void): T {
  el.setAttribute('data-tip', '');
  el.addEventListener('pointerenter', (e) => { if ((e as PointerEvent).pointerType === 'mouse') showTip(e as PointerEvent, text, el); });
  el.addEventListener('pointerleave', (e) => { if ((e as PointerEvent).pointerType === 'mouse') hideTip(); });
  el.addEventListener('click', (e) => { showTip(e as MouseEvent, text, el); onTap?.(); });
  return el;
}

// ---------- frame ----------
export type Fmt = (v: number) => string;

function figure(title: string, sub: string | null, body: Element, legend: HTMLElement | null, rows: any[], cols: Parameters<typeof table>[1]) {
  return h('figure', { class: 'viz' },
    h('figcaption', {}, h('strong', {}, title), sub && h('span', { class: 'small muted' }, sub)),
    body as unknown as Node, legend,
    rows.length > 0 && h('details', { class: 'viz-table' }, h('summary', {}, 'Show as table'), table(rows, cols)));
}

function legend(items: { name: string; color: string; dash?: boolean }[]) {
  return h('ul', { class: 'viz-legend' }, items.map((i) => h('li', {}, h('span', { class: `key${i.dash ? ' dash' : ''}`, style: `--c:${i.color}` }), i.name)));
}

export const empty = (title: string, msg: string) => h('figure', { class: 'viz' }, h('figcaption', {}, h('strong', {}, title)), h('p', { class: 'note' }, msg));

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}
const ticks = (max: number, n = 4) => Array.from({ length: n + 1 }, (_, i) => (max * i) / n);
/** Short axis numbers in the Indian system (k, lakh, crore), without a trailing ".0". */
export const compact = (v: number) => {
  const a = Math.abs(v);
  const f = (x: number, u: string) => `${x.toFixed(1).replace(/\.0$/, '')}${u}`;
  if (a >= 1e7) return f(v / 1e7, 'Cr');
  if (a >= 1e5) return f(v / 1e5, 'L');
  if (a >= 1e3) return f(v / 1e3, 'k');
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

// ---------- donut ----------
export function donut(title: string, items: { label: string; value: number; color?: string }[], fmt: Fmt, unit: string, centre?: string) {
  const pos = items.filter((i) => i.value > 0);
  const total = pos.reduce((a, i) => a + i.value, 0);
  if (!total) return empty(title, `Nothing to show: every category is 0 ${unit}.`);
  let parts = pos.map((i, k) => ({ ...i, color: i.color ?? seriesColor(k) }));
  if (parts.length > 8) {
    const rest = parts.slice(7).reduce((a, i) => a + i.value, 0);
    parts = [...parts.slice(0, 7), { label: `Other (${parts.length - 7})`, value: rest, color: OTHER }];
  }
  const R = 70, r = 46, C = 90;
  const svg = s('svg', { viewBox: '0 0 180 180', class: 'donut', role: 'img', 'aria-label': `${title}: ${parts.map((p) => `${p.label} ${fmt(p.value)}`).join(', ')}` });
  let a0 = -Math.PI / 2;
  for (const p of parts) {
    const a1 = a0 + (2 * Math.PI * p.value) / total;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (rad: number, a: number) => `${C + rad * Math.cos(a)} ${C + rad * Math.sin(a)}`;
    const d = parts.length === 1
      ? `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${C - 0.01} ${C - R} L ${C - 0.01} ${C - r} A ${r} ${r} 0 1 0 ${C} ${C - r} Z`
      : `M ${pt(R, a0)} A ${R} ${R} 0 ${big} 1 ${pt(R, a1)} L ${pt(r, a1)} A ${r} ${r} 0 ${big} 0 ${pt(r, a0)} Z`;
    svg.append(tip(s('path', { d, fill: p.color, stroke: '#fff', 'stroke-width': 2 }), `${p.label}: ${fmt(p.value)} (${((100 * p.value) / total).toFixed(1)}%)`));
    a0 = a1;
  }
  svg.append(s('text', { x: C, y: C - 2, 'text-anchor': 'middle', class: 'donut-total' }, centre ?? fmt(total)),
    s('text', { x: C, y: C + 16, 'text-anchor': 'middle', class: 'axis' }, unit));
  const leg = h('ul', { class: 'viz-legend col' }, parts.map((p) => h('li', {}, h('span', { class: 'key', style: `--c:${p.color}` }),
    h('span', { class: 'grow' }, p.label), h('strong', {}, `${((100 * p.value) / total).toFixed(0)}%`), h('span', { class: 'muted' }, fmt(p.value)))));
  return figure(title, null, h('div', { class: 'donut-wrap' }, svg as unknown as Node, leg), null,
    parts.map((p) => ({ label: p.label, value: fmt(p.value), share: `${((100 * p.value) / total).toFixed(1)}%` })),
    [['label', 'Category'], ['value', unit], ['share', 'Share']]);
}

// ---------- horizontal bars (one or more series) ----------
export type Series = { name: string; values: (number | null)[]; color?: string; dash?: boolean };

export function hbars(title: string, cats: string[], series: Series[], fmt: Fmt, axis: string, sub: string | null = null, onTap?: (i: number) => void) {
  const vals = series.flatMap((x) => x.values.filter((v): v is number => v != null));
  if (!cats.length || !vals.length) return empty(title, 'No data for this chart yet.');
  const minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals);
  const stepV = niceMax((maxV - minV) / 4 || 1);
  const lo = Math.floor(minV / stepV) * stepV, hi = Math.max(lo + stepV, Math.ceil(maxV / stepV) * stepV);
  const W = 340, left = 124, right = 14, bar = 12, gap = 2, groupGap = 12, top = 6;
  const groupH = series.length * bar + (series.length - 1) * gap;
  const H = top + cats.length * (groupH + groupGap) + 22;
  const x = (v: number) => left + ((v - lo) / (hi - lo || 1)) * (W - left - right);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bars', role: 'img', 'aria-label': title });
  for (let t = lo; t <= hi + stepV / 1e6; t += stepV) {
    svg.append(s('line', { x1: x(t), x2: x(t), y1: top, y2: H - 20, class: t === 0 ? 'zero' : 'grid' }),
      s('text', { x: x(t), y: H - 6, 'text-anchor': 'middle', class: 'axis' }, compact(t)));
  }
  cats.forEach((c, i) => {
    const y0 = top + i * (groupH + groupGap);
    const lab = c.length > 20 ? `${c.slice(0, 19)}…` : c;
    svg.append(tip(s('text', { x: left - 6, y: y0 + groupH / 2 + 4, 'text-anchor': 'end', class: 'cat' }, lab), c));
    series.forEach((se, k) => {
      const v = se.values[i];
      if (v == null) return;
      const y = y0 + k * (bar + gap);
      const x0 = x(Math.min(0, v)), x1 = x(Math.max(0, v));
      const g = s('g', {});
      g.append(s('rect', { x: x0, y, width: Math.max(1, x1 - x0), height: bar, rx: 3, fill: se.color ?? seriesColor(k), 'fill-opacity': se.dash ? 0.45 : 1 }),
        s('rect', { x: left, y: y - 1, width: W - left - right, height: bar + 2, fill: 'transparent' }));
      svg.append(tip(g, `${c} · ${se.name}: ${fmt(v)}`, onTap ? () => onTap(i) : undefined));
    });
  });
  const rows = cats.map((c, i) => Object.fromEntries([['cat', c], ...series.map((se, k) => [`s${k}`, se.values[i] == null ? '-' : fmt(se.values[i]!)])]));
  return figure(title, sub ?? axis, svg, series.length > 1 ? legend(series.map((se, k) => ({ name: se.name, color: se.color ?? seriesColor(k), dash: se.dash }))) : null,
    rows, [['cat', 'Category'], ...series.map((se, k): [string, string] => [`s${k}`, se.name])]);
}

// ---------- histogram ----------
export function histogram(title: string, bins: { label: string; value: number }[], fmt: Fmt, xLabel: string, yLabel: string, highlight?: (i: number) => boolean) {
  if (!bins.length || bins.every((b) => !b.value)) return empty(title, 'No values to count yet.');
  const W = 340, H = 190, left = 40, right = 8, top = 10, bottom = 40;
  const hi = niceMax(Math.max(...bins.map((b) => b.value)));
  const bw = (W - left - right) / bins.length;
  const y = (v: number) => top + (1 - v / hi) * (H - top - bottom);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hist', role: 'img', 'aria-label': `${title}, ${yLabel} by ${xLabel}` });
  for (const t of ticks(hi)) svg.append(s('line', { x1: left, x2: W - right, y1: y(t), y2: y(t), class: t ? 'grid' : 'zero' }), s('text', { x: left - 4, y: y(t) + 4, 'text-anchor': 'end', class: 'axis' }, compact(t)));
  const every = Math.ceil(bins.length / 9);
  bins.forEach((b, i) => {
    const x = left + i * bw;
    const g = s('g', {});
    g.append(s('rect', { x: x + 1, y: y(b.value), width: Math.max(1, bw - 2), height: Math.max(0, y(0) - y(b.value)), rx: 3, fill: highlight?.(i) ? SERIES[1] : SERIES[0] }),
      s('rect', { x, y: top, width: bw, height: H - top - bottom, fill: 'transparent' }));
    svg.append(tip(g, `${b.label} ${xLabel}: ${fmt(b.value)} ${yLabel}`));
    if (i % every === 0) svg.append(s('text', { x: x + bw / 2, y: H - bottom + 14, 'text-anchor': 'middle', class: 'axis' }, b.label));
  });
  svg.append(s('text', { x: left + (W - left - right) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-title' }, xLabel));
  return figure(title, yLabel, svg, null, bins.map((b) => ({ bin: b.label, value: fmt(b.value) })), [['bin', xLabel], ['value', yLabel]]);
}

// ---------- line ----------
export function line(title: string, xs: string[], series: Series[], fmt: Fmt, xLabel: string, yLabel: string, sub: string | null = null) {
  const vals = series.flatMap((x) => x.values.filter((v): v is number => v != null));
  if (xs.length < 2 || !vals.length) return empty(title, 'Needs at least two points.');
  const W = 340, H = 200, left = 44, right = 12, top = 12, bottom = 42;
  const lo0 = Math.min(...vals), hi0 = Math.max(...vals);
  const lo = lo0 >= 0 && lo0 < hi0 * 0.5 ? 0 : lo0 - (hi0 - lo0) * 0.1;
  const hi = hi0 + (hi0 - lo || Math.abs(hi0) || 1) * 0.08;
  const x = (i: number) => left + (i / (xs.length - 1)) * (W - left - right);
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo || 1)) * (H - top - bottom);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'line', role: 'img', 'aria-label': `${title}, ${yLabel} by ${xLabel}` });
  for (let k = 0; k <= 4; k++) {
    const t = lo + ((hi - lo) * k) / 4;
    svg.append(s('line', { x1: left, x2: W - right, y1: y(t), y2: y(t), class: 'grid' }), s('text', { x: left - 4, y: y(t) + 4, 'text-anchor': 'end', class: 'axis' }, compact(t)));
  }
  const every = Math.ceil(xs.length / 6);
  xs.forEach((lab, i) => { if (i % every === 0 || i === xs.length - 1) svg.append(s('text', { x: x(i), y: H - bottom + 14, 'text-anchor': 'middle', class: 'axis' }, lab)); });
  series.forEach((se, k) => {
    const c = se.color ?? seriesColor(k);
    const pts = se.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean) as number[][];
    svg.append(s('polyline', { points: pts.map((p) => p.join(',')).join(' '), fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-dasharray': se.dash ? '5 4' : null }));
    if (xs.length <= 40) se.values.forEach((v, i) => { if (v != null) svg.append(s('circle', { cx: x(i), cy: y(v), r: 4, fill: c, stroke: '#fff', 'stroke-width': 2 })); });
  });
  // one hit column per x: the crosshair reads every series at that point
  const cross = s('line', { x1: 0, x2: 0, y1: top, y2: H - bottom, class: 'cross', visibility: 'hidden' });
  svg.append(cross);
  xs.forEach((lab, i) => {
    const w = (W - left - right) / Math.max(1, xs.length - 1);
    const hit = s('rect', { x: x(i) - w / 2, y: top, width: w, height: H - top - bottom, fill: 'transparent' });
    hit.addEventListener('pointerenter', () => { cross.setAttribute('x1', String(x(i))); cross.setAttribute('x2', String(x(i))); cross.setAttribute('visibility', 'visible'); });
    svg.append(tip(hit, `${lab}: ${series.map((se) => `${se.name} ${se.values[i] == null ? '-' : fmt(se.values[i]!)}`).join(' · ')}`));
  });
  svg.append(s('text', { x: left + (W - left - right) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-title' }, xLabel));
  const rows = xs.map((lab, i) => Object.fromEntries([['x', lab], ...series.map((se, k) => [`s${k}`, se.values[i] == null ? '-' : fmt(se.values[i]!)])]));
  return figure(title, sub ?? yLabel, svg, series.length > 1 ? legend(series.map((se, k) => ({ name: se.name, color: se.color ?? seriesColor(k), dash: se.dash }))) : null,
    rows, [['x', xLabel], ...series.map((se, k): [string, string] => [`s${k}`, se.name])]);
}

/** KPI card: value, label, and an optional change chip against a reference. */
export function kpi(labelText: string, value: string, note?: string | null, chip?: { text: string; kind: '' | 'ok' | 'warn' | 'bad' } | null) {
  return h('div', { class: 'kpi-card' }, h('span', { class: 'small muted' }, labelText), h('strong', {}, value),
    chip && h('span', { class: `badge ${chip.kind}` }, chip.text), note && h('span', { class: 'note' }, note));
}

export const pctText = (p: number | null | undefined) => (p == null ? '' : `${p > 0 ? '+' : ''}${Math.abs(p) < 10 ? p.toFixed(1) : p.toFixed(0)}%`);
export const units = (v: number) => num(Math.round(v));
