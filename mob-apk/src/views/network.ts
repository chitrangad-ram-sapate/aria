// Distribution network as a two-column flow diagram: depots (sources, squares) on the left, towns
// (destinations, circles) on the right, one arrow per route used tonight with width by units. Towns are
// ordered by the depots that feed them so lines cross as little as possible; rows have a fixed height so
// nodes and labels never overlap. Tap a node or an arrow for its numbers; unused and closed routes on request.
import { OTHER, compact, s, seriesColor, tip } from '../charts';
import { Json, h, kv, mount, num, rupees } from '../ui';

const W = 360, ROW = 50, TOP = 14;
const DX = 6, PORT_L = 126, PORT_R = 232, TX = 246;
const MANY_TOWNS = 25;

export function networkDiagram(d: Json, opts: { title?: string } = {}) {
  let showAll = false, showIdle = false;
  let sel: { kind: 'depot' | 'town' | 'flow' | 'route'; id: string } | null = null;
  const box = h('div', {});
  const info = h('div', { class: 'net-info', 'aria-live': 'polite' });

  const draw = () => {
    const depots: Json[] = d.depots ?? [];
    const flows: Json[] = (d.flows ?? []).filter((f: Json) => f.units > 0);
    const routes: Json[] = d.routes ?? [];
    const colour = new Map(depots.map((g, i) => [g.godown_id, seriesColor(depots.length > 8 && i >= 7 ? -1 : i)]));
    const fed = new Set(flows.map((f) => f.town_id));
    let towns: Json[] = d.towns ?? [];
    const hidden = towns.length > MANY_TOWNS && !showIdle ? towns.filter((t) => !fed.has(t.town_id)).length : 0;
    if (hidden) towns = towns.filter((t) => fed.has(t.town_id));
    // barycentre ordering: each town sits near the depots that send it most
    const dIndex = new Map(depots.map((g, i) => [g.godown_id, i]));
    const bary = new Map(towns.map((t) => {
      const fs = flows.filter((f) => f.town_id === t.town_id);
      const tot = fs.reduce((a, f) => a + f.units, 0);
      return [t.town_id, tot ? fs.reduce((a, f) => a + f.units * (dIndex.get(f.godown_id) ?? 0), 0) / tot : depots.length];
    }));
    towns = [...towns].sort((a, b) => bary.get(a.town_id)! - bary.get(b.town_id)! || String(a.name).localeCompare(String(b.name)));

    const rows = Math.max(depots.length, towns.length, 1);
    const H = TOP * 2 + rows * ROW;
    const ty = new Map(towns.map((t, i) => [t.town_id, TOP + i * ROW + ROW / 2]));
    const dStep = (H - TOP * 2) / Math.max(1, depots.length);
    const dy = new Map(depots.map((g, i) => [g.godown_id, TOP + i * dStep + dStep / 2]));
    const maxU = Math.max(1, ...flows.map((f) => f.units));

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'net', role: 'img', 'aria-label': `Network: ${depots.length} depots, ${towns.length} towns, ${flows.length} shipments` });
    const defs = s('defs');
    for (const c of new Set([...colour.values(), OTHER])) {
      defs.append(s('marker', { id: `arr${c.slice(1)}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' },
        s('path', { d: 'M0 0 L10 5 L0 10 z', fill: c })));
    }
    svg.append(defs);
    svg.addEventListener('click', (e) => { if (e.target === svg) { sel = null; draw(); } });

    const active = (gid: string, tid: string) => !sel || (sel.kind === 'depot' && sel.id === gid) || (sel.kind === 'town' && sel.id === tid)
      || ((sel.kind === 'flow' || sel.kind === 'route') && sel.id === `${gid}|${tid}`);
    const curve = (y1: number, y2: number) => `M ${PORT_L} ${y1} C ${PORT_L + 50} ${y1}, ${PORT_R - 50} ${y2}, ${PORT_R - 2} ${y2}`;

    if (showAll) {
      for (const r of routes) {
        if (!dy.has(r.godown_id) || !ty.has(r.town_id)) continue;
        const used = flows.some((f) => f.godown_id === r.godown_id && f.town_id === r.town_id);
        if (used && r.active) continue;
        const p = s('path', { d: curve(dy.get(r.godown_id)!, ty.get(r.town_id)!), class: r.active ? 'route idle' : 'route closed', opacity: active(r.godown_id, r.town_id) ? 1 : 0.15 });
        const hit = s('path', { d: curve(dy.get(r.godown_id)!, ty.get(r.town_id)!), class: 'hit' });
        const g = s('g', {}, p, hit);
        svg.append(tip(g, `${name(depots, 'godown_id', r.godown_id)} → ${name(towns, 'town_id', r.town_id)}: ${r.active ? 'not used tonight' : 'closed'}`,
          () => { sel = { kind: 'route', id: `${r.godown_id}|${r.town_id}` }; draw(); }));
      }
    }
    for (const f of [...flows].sort((a, b) => b.units - a.units)) {
      if (!ty.has(f.town_id) || !dy.has(f.godown_id)) continue;
      const c = colour.get(f.godown_id) ?? OTHER;
      const on = active(f.godown_id, f.town_id);
      const path = curve(dy.get(f.godown_id)!, ty.get(f.town_id)!);
      const g = s('g', { opacity: on ? 1 : 0.12 },
        s('path', { d: path, fill: 'none', stroke: c, 'stroke-width': 1.5 + (7 * f.units) / maxU, 'stroke-opacity': 0.85, 'marker-end': `url(#arr${c.slice(1)})` }),
        s('path', { d: path, class: 'hit' }));
      svg.append(tip(g, `${name(depots, 'godown_id', f.godown_id)} → ${name(towns, 'town_id', f.town_id)}: ${num(f.units)} units`,
        () => { sel = { kind: 'flow', id: `${f.godown_id}|${f.town_id}` }; draw(); }));
    }
    // unit labels for the selected node's arrows, at the far end of each arrow (one per row: no overlap)
    if (sel?.kind === 'depot' || sel?.kind === 'town') {
      for (const f of flows.filter((f) => (sel!.kind === 'depot' ? f.godown_id : f.town_id) === sel!.id)) {
        if (!ty.has(f.town_id)) continue;
        const atTown = sel.kind === 'depot';
        svg.append(s('text', { x: atTown ? PORT_R - 12 : PORT_L + 8, y: (atTown ? ty.get(f.town_id)! : dy.get(f.godown_id)!) - 7,
          'text-anchor': atTown ? 'end' : 'start', class: 'flow-label' }, num(f.units)));
      }
    }
    depots.forEach((g) => {
      const y = dy.get(g.godown_id)!, c = colour.get(g.godown_id) ?? OTHER;
      const on = !sel || (sel.kind === 'depot' && sel.id === g.godown_id) || flowTouches(sel, g.godown_id, null)
        || (sel.kind === 'town' && flows.some((f) => f.town_id === sel!.id && f.godown_id === g.godown_id));
      const node = s('g', { class: 'node', opacity: on ? 1 : 0.35, tabindex: 0, role: 'button', 'aria-label': `Depot ${g.name}, ships ${g.shipped} units` },
        s('rect', { x: DX, y: y - 13, width: 26, height: 26, rx: 5, fill: c }),
        s('path', { d: `M${DX + 6} ${y + 6} v-7 l7 -5 l7 5 v7 z`, fill: '#fff', opacity: 0.9 }),
        s('text', { x: 38, y: y - 2, class: 'node-name' }, clip(g.name, 14)),
        s('text', { x: 38, y: y + 12, class: 'node-sub' }, `ships ${compact(g.shipped)}`),
        s('circle', { cx: PORT_L, cy: y, r: 3, fill: c }));
      node.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { sel = { kind: 'depot', id: g.godown_id }; draw(); } });
      svg.append(tip(node, `${g.name}: ships ${num(g.shipped)} of ${num(g.stock)} units in stock`, () => { sel = { kind: 'depot', id: g.godown_id }; draw(); }));
    });
    towns.forEach((t) => {
      const y = ty.get(t.town_id)!;
      const on = !sel || (sel.kind === 'town' && sel.id === t.town_id) || flowTouches(sel, null, t.town_id)
        || (sel.kind === 'depot' && flows.some((f) => f.godown_id === sel!.id && f.town_id === t.town_id));
      const node = s('g', { class: 'node', opacity: on ? 1 : 0.35, tabindex: 0, role: 'button', 'aria-label': `Town ${t.name}, gets ${t.received} units` },
        s('circle', { cx: TX, cy: y, r: 11, fill: '#fff', stroke: t.short ? '#d9480f' : '#374151', 'stroke-width': 2 }),
        s('circle', { cx: TX, cy: y, r: 4, fill: t.received ? '#374151' : '#d1d5db' }),
        s('text', { x: TX + 17, y: y - 2, class: 'node-name' }, clip(t.name, 14)),
        s('text', { x: TX + 17, y: y + 12, class: 'node-sub' }, t.short ? `gets ${compact(t.received)} · short ${compact(t.short)}` : `gets ${compact(t.received)}`));
      node.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { sel = { kind: 'town', id: t.town_id }; draw(); } });
      svg.append(tip(node, `${t.name}: gets ${num(t.received)} units${t.short ? `, short ${num(t.short)}` : ''}`, () => { sel = { kind: 'town', id: t.town_id }; draw(); }));
    });

    mount(box,
      h('div', { class: 'row between wrap' },
        h('div', { class: 'net-heads small muted' }, h('span', {}, 'Depots (send)'), h('span', {}, 'Towns (receive)')),
        h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: showAll, onchange: (e: Event) => { showAll = (e.target as HTMLInputElement).checked; draw(); } }), 'Show unused and closed routes')),
      h('div', { class: 'net-scroll' }, svg as unknown as Node),
      hidden > 0 && h('button', { class: 'btn ghost small', onclick: () => { showIdle = true; draw(); } }, `Show ${num(hidden)} towns that get nothing tonight`),
      h('ul', { class: 'viz-legend' },
        h('li', {}, h('span', { class: 'shape sq' }), 'Depot (source)'),
        h('li', {}, h('span', { class: 'shape ci' }), 'Town (destination)'),
        h('li', {}, h('span', { class: 'shape arrow' }), 'Shipment · thicker = more units'),
        h('li', {}, h('span', { class: 'shape ci short' }), 'Town with a shortage'),
        showAll && h('li', {}, h('span', { class: 'key dash', style: '--c:#9ca3af' }), 'Route not used tonight'),
        showAll && h('li', {}, h('span', { class: 'key dash', style: '--c:#dc2626' }), 'Closed route')),
      info);
    drawInfo(d, sel, info, () => { sel = null; draw(); });
  };
  draw();
  return h('figure', { class: 'viz' }, h('figcaption', {}, h('strong', {}, opts.title ?? 'Where the stock goes tonight'),
    h('span', { class: 'small muted' }, 'Tap a depot, town or arrow for its numbers')), box);
}

const clip = (t: string, n: number) => (String(t).length > n ? `${String(t).slice(0, n - 1)}…` : String(t));
const name = (list: Json[], key: string, id: string) => list.find((x) => x[key] === id)?.name ?? id;
function flowTouches(sel: Json, gid: string | null, tid: string | null) {
  if (sel.kind !== 'flow' && sel.kind !== 'route') return false;
  const [g, t] = sel.id.split('|');
  return gid === g || tid === t;
}

function drawInfo(d: Json, sel: Json, el: HTMLElement, clear: () => void) {
  if (!sel) return mount(el, h('p', { class: 'note' }, 'Nothing selected. Tap any shape to see its numbers.'));
  const flows: Json[] = d.flows ?? [];
  const close = h('button', { class: 'btn ghost small', onclick: clear }, 'Clear');
  if (sel.kind === 'depot') {
    const g = d.depots.find((x: Json) => x.godown_id === sel.id);
    const out = flows.filter((f) => f.godown_id === sel.id);
    return mount(el, h('div', { class: 'row between' }, h('strong', {}, `Depot · ${g.name}`), close),
      kv([['Ships tonight', `${num(g.shipped)} units`], ['Stock held', `${num(g.stock)} units`],
        ['Share of stock sent', g.stock_used == null ? '-' : `${(g.stock_used * 100).toFixed(0)}%`],
        ['Loading capacity', g.capacity == null ? 'No limit set' : `${num(g.capacity)} units (${((g.utilisation ?? 0) * 100).toFixed(0)}% used)`],
        ['Towns served', `${out.length}`], ['Freight', rupees(out.reduce((a, f) => a + f.freight_paise, 0))]]));
  }
  if (sel.kind === 'town') {
    const t = d.towns.find((x: Json) => x.town_id === sel.id);
    const inn = flows.filter((f) => f.town_id === sel.id);
    return mount(el, h('div', { class: 'row between' }, h('strong', {}, `Town · ${t.name}`), close),
      kv([['Gets tonight', `${num(t.received)} units`], ['Expected demand (median, all products)', `${num(Math.round(t.median_demand))} units`],
        ['Short by', `${num(t.short)} units`], ['Supplied from', inn.length ? inn.map((f) => name(d.depots, 'godown_id', f.godown_id)).join(', ') : 'nobody']]));
  }
  const [gid, tid] = sel.id.split('|');
  const f = flows.find((x) => x.godown_id === gid && x.town_id === tid);
  const r = (d.routes ?? []).find((x: Json) => x.godown_id === gid && x.town_id === tid);
  mount(el, h('div', { class: 'row between' }, h('strong', {}, `${name(d.depots, 'godown_id', gid)} → ${name(d.towns, 'town_id', tid)}`), close),
    kv([['Units', f ? num(f.units) : '0 (not used tonight)'], ['Products', f ? String(f.products) : '-'], ['Freight', f ? rupees(f.freight_paise) : '-'],
      ['Road distance', r ? `${r.road_km} km` : '-'], ['Days on the road', r ? String(r.transit_days) : '-'],
      ['Truck class', r ? truck(r.vehicle_class) : '-'], ['Route open', r ? (r.active ? 'yes' : 'no, closed') : '-']]));
}

export const truck = (v: string) => ({ '55t': 'Large (55 t trailer)', road_avg: 'Medium (average lorry)', '6t': 'Small (6 t truck)' } as Record<string, string>)[v] ?? v;
