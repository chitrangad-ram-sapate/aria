// Scan → check → plan again. Read a product or lot label with the camera (or type the code), check it against the
// dataset (product, depot, lot, units, expiry; ask for what the label does not say, refuse what cannot be right),
// collect a batch, then update the depot stock, plan again and show what changed against the plan before.
import { engine } from '../engine';
import { parseLabel, readDate, type Label } from '../label';
import { isNative, scanCode } from '../native';
import { issueText } from '../plain';
import { isStale, nextRid, notify, persist, state } from '../state';
import { Json, badge, h, icon, mount, num, openSheet, rupees, select, toast } from '../ui';
import { godownName, townName } from './plan';

type Item = { lot_id: string; godown_id: string; product_id: string; qty_units: number; remaining_life_days: number; expiry: string; was: number | null };
type Draft = { raw: string; product: string; depot: string; lot: string; qty: string; expiry: string; notes: string[] };
type Field = 'product' | 'depot' | 'lot' | 'qty' | 'expiry';

const BARCODES = 'aria.barcodes'; // product number → product id, learned when someone picks the product for a new barcode
let items: Item[] = []; // the batch survives closing the sheet, until it is added to stock
let lastDepot = '';
let body: HTMLElement;
let phase: 'scan' | 'check' | 'busy' | 'done' = 'scan';
let draft: Draft | null = null;
let busyText = '';
let problems: string[] = [];
let result: { before: Json | null; after: Json } | null = null;

const webCamera = () => !isNative && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

function barcodes(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(BARCODES) || '{}'); } catch { return {}; }
}
function learn(gtin: string, product: string) {
  try { localStorage.setItem(BARCODES, JSON.stringify({ ...barcodes(), [gtin]: product })); } catch { /* remembered for this session only */ }
}

/** The day the plan is for (the dataset's day, else today). */
function planDay(): string {
  const d = state.scenario?.day && readDate(state.scenario.day);
  if (d) return d;
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const addDays = (a: string, n: number) => new Date(Date.parse(a) + n * 86_400_000).toISOString().slice(0, 10);

const findProduct = (s: string) => state.scenario?.products.find((p: Json) => p.product_id.toLowerCase() === s.trim().toLowerCase())?.product_id as string | undefined;
const findDepot = (s: string) => state.scenario?.godowns.find((g: Json) => [g.godown_id, g.name].some((v) => String(v ?? '').toLowerCase() === s.trim().toLowerCase()))?.godown_id as string | undefined;

/** What the label says, matched to the dataset, plus notes about anything that needs the person's help. */
function fromLabel(label: Label): Draft {
  const sc = state.scenario;
  const notes: string[] = [];
  let product = '';
  let lot = label.lot ?? '';
  if (label.product) {
    product = findProduct(label.product) ?? '';
    if (!product) notes.push(`The label says product "${label.product}", which is not in your product list. Choose the right product, or add it to your data first.`);
  }
  if (label.gtin && !product) {
    product = findProduct(barcodes()[label.gtin] ?? '') ?? findProduct(label.gtin) ?? '';
    if (!product) notes.push(`New product number ${label.gtin}. Choose which product it is and ARIA will remember it.`);
  }
  if (label.token) {
    const p = findProduct(label.token);
    if (p && !product) product = p; else if (!p) lot = label.token;
  }
  const existing = lot ? sc.lots.find((l: Json) => l.lot_id === lot) : null;
  if (existing && !product) product = existing.product_id;
  let depot = '';
  if (label.depot) {
    depot = findDepot(label.depot) ?? '';
    if (!depot) notes.push(`The label says depot "${label.depot}", which is not one of your depots. Choose the depot.`);
  }
  depot ||= existing?.godown_id ?? (findDepot(lastDepot) ? lastDepot : sc.godowns.length === 1 ? sc.godowns[0].godown_id : '');
  if (label.badExpiry) notes.push(`The date "${label.badExpiry}" on the label could not be read. Enter it below.`);
  const expiry = label.expiry ?? (existing ? addDays(planDay(), existing.remaining_life_days) : '');
  return { raw: label.raw, product, depot, lot, qty: label.qty ?? '', expiry, notes };
}

/** Check a draft: problems per field (must be fixed), things to know, and the stock row when it can be added. */
function check(d: Draft) {
  const sc = state.scenario;
  const errors: Partial<Record<Field, string>> = {};
  const info: string[] = [];
  const product = sc.products.find((p: Json) => p.product_id === d.product);
  if (!product) errors.product = 'Choose the product.';
  if (!sc.godowns.some((g: Json) => g.godown_id === d.depot)) errors.depot = 'Choose the depot this stock is in.';
  const lot = d.lot.trim();
  let was: number | null = null;
  if (!lot) errors.lot = 'Enter the lot or batch number from the label.';
  else if (!/^[\w\-./]{1,40}$/.test(lot)) errors.lot = 'Use only letters, numbers and - . / _ (up to 40).';
  else if (items.some((i) => i.lot_id === lot)) errors.lot = 'This lot is already in the list below.';
  else {
    const existing = sc.lots.find((l: Json) => l.lot_id === lot);
    if (existing && product && existing.product_id !== product.product_id) errors.lot = `Lot ${lot} is already recorded for ${existing.product_id}. Check the lot number.`;
    else if (existing && d.depot && existing.godown_id !== d.depot) errors.lot = `Lot ${lot} is already counted at ${godownName(existing.godown_id)}.`;
    else if (existing) { was = existing.qty_units; info.push(`This lot is already in stock with ${num(was)} units. Your count will replace it.`); }
  }
  const q = d.qty.trim();
  if (!/^\d+$/.test(q) || Number(q) < 1 || Number(q) > 1_000_000) errors.qty = q ? 'Units must be a whole number from 1 to 10,00,000.' : 'Enter how many units there are.';
  const exp = d.expiry ? readDate(d.expiry) : null;
  let days = 0;
  if (!exp) errors.expiry = d.expiry ? 'Enter a real date.' : 'Enter the expiry or best-before date.';
  else {
    days = daysBetween(planDay(), exp);
    if (days <= 0) errors.expiry = `This lot expired on ${exp}. Expired stock cannot be added.`;
    else if (product && days > product.shelf_life_days) errors.expiry = `That is ${days} days away, but ${product.product_id} keeps only ${product.shelf_life_days} days. Check the date on the label.`;
    else if (product && days < product.min_days_at_receipt) info.push(`Only ${days} days left. Towns need at least ${product.min_days_at_receipt}, so this lot is counted but will not be sent.`);
  }
  const ok = Object.keys(errors).length === 0;
  const item: Item | null = ok ? { lot_id: lot, godown_id: d.depot, product_id: d.product, qty_units: Number(q), remaining_life_days: days, expiry: exp!, was } : null;
  return { errors, info, item };
}

export function scanSheet() {
  if (!state.scenario) return toast('Load your data first.');
  if (phase !== 'busy') { phase = 'scan'; result = null; problems = []; draft = null; }
  body = h('div', { class: 'scan' });
  openSheet('Scan stock labels', body);
  draw();
}

const STEPS = ['Scan', 'Check', 'Plan again'];
function steps() {
  const at = phase === 'scan' ? 0 : phase === 'check' ? 1 : 2;
  return h('ol', { class: 'steps', 'aria-label': 'Steps' }, STEPS.map((s, i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '', 'aria-current': i === at ? 'step' : undefined }, h('span', {}, String(i + 1)), s)));
}

function draw() {
  if (!body?.isConnected) return;
  if (phase === 'busy') return mount(body, steps(), h('section', { class: 'card' }, h('p', { class: 'muted', 'aria-live': 'polite' }, busyText)));
  if (phase === 'done' && result) return mount(body, steps(), compare(result.before, result.after),
    h('div', { class: 'grid2' },
      h('button', { class: 'btn', onclick: () => { phase = 'scan'; result = null; draw(); } }, icon('scan'), 'Scan more'),
      h('button', { class: 'btn primary', onclick: () => (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close() }, 'See the new plan')));
  mount(body, steps(), phase === 'check' && draft ? checkCard(draft) : scanCard(), batchCard());
}

function scanCard() {
  const status = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const code = h('input', { type: 'text', placeholder: 'Type or paste the code', 'aria-label': 'Label code', autocapitalize: 'off', spellcheck: false,
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') useCode(code.value); } });
  const camera = isNative || webCamera();
  const cam: HTMLButtonElement | null = camera ? h('button', { class: 'btn primary block', onclick: async () => {
    cam!.disabled = true;
    try {
      const text = isNative ? await scanCode((m) => { status.textContent = m; }) : await webScan(status);
      if (text) useCode(text); else status.textContent = 'Nothing scanned.';
    } catch {
      status.textContent = 'The camera could not be used. Allow camera access for ARIA in your phone settings, or type the code.';
    } finally { if (cam) cam.disabled = false; }
  } }, icon('scan'), 'Scan with camera') : null;
  return h('section', { class: 'card' },
    h('p', { class: 'eyebrow' }, 'Scan a product or lot label'),
    h('p', { class: 'small' }, 'Point the camera at the QR code or barcode on the label. ARIA reads the product, lot, units and expiry date it carries.'),
    cam, status,
    h('div', { class: 'row gap' }, code, h('button', { class: 'btn', onclick: () => useCode(code.value) }, 'Use code')),
    problems.length > 0 && h('div', { class: 'alert bad', role: 'alert' }, h('strong', {}, 'The stock was not changed:'), h('ul', { class: 'plain-list' }, problems.map((p) => h('li', {}, p)))));
}

function useCode(text: string) {
  if (!text.trim()) return toast('Type or scan a code first.');
  draft = fromLabel(parseLabel(text));
  phase = 'check';
  problems = [];
  draw();
}

/** Browser camera with the built-in barcode reader (Chrome on Android and Mac). */
async function webScan(status: HTMLElement): Promise<string | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  const video = h('video', { class: 'scan-video', playsInline: true, muted: true, autoplay: true }) as HTMLVideoElement;
  video.srcObject = stream;
  const stop = h('button', { class: 'btn ghost block' }, 'Stop');
  const box = h('div', {}, video, stop);
  status.replaceWith(box);
  const detector = new (window as any).BarcodeDetector();
  try {
    return await new Promise<string | null>((resolve) => {
      stop.onclick = () => resolve(null);
      const tick = async () => {
        if (!box.isConnected) return resolve(null);
        try {
          const found = video.readyState >= 2 ? await detector.detect(video) : [];
          if (found[0]?.rawValue) return resolve(found[0].rawValue);
        } catch { /* frame not ready */ }
        setTimeout(tick, 200);
      };
      tick();
    });
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    box.replaceWith(status);
  }
}

function checkCard(d: Draft) {
  const sc = state.scenario;
  const msg: Record<Field, HTMLElement> = { product: h('p', { class: 'field-msg' }), depot: h('p', { class: 'field-msg' }), lot: h('p', { class: 'field-msg' }), qty: h('p', { class: 'field-msg' }), expiry: h('p', { class: 'field-msg' }) };
  const infoBox = h('div', {});
  const add = h('button', { class: 'btn primary block' }, 'Add to the list');
  const inputs: Partial<Record<Field, HTMLElement>> = {};
  const refresh = () => {
    const r = check(d);
    for (const f of Object.keys(msg) as Field[]) {
      msg[f].textContent = r.errors[f] ?? '';
      inputs[f]?.setAttribute('aria-invalid', String(!!r.errors[f]));
    }
    mount(infoBox, r.info.map((t) => h('p', { class: 'note' }, t)));
    add.disabled = !r.item;
    return r;
  };
  const text = (f: 'lot' | 'qty', label: string, mode: string) => {
    const el = h('input', { type: 'text', inputMode: mode, value: d[f], 'aria-label': label, autocapitalize: 'off', oninput: () => { d[f] = el.value; refresh(); } });
    inputs[f] = el;
    return h('label', { class: 'field' }, h('span', {}, label), el, msg[f]);
  };
  inputs.product = select([['', 'Choose...'], ...sc.products.map((p: Json): [string, string] => [p.product_id, `${p.product_id} · ${p.category}`])], d.product, (v) => { d.product = v; refresh(); }, 'Product');
  inputs.depot = select([['', 'Choose...'], ...sc.godowns.map((g: Json): [string, string] => [g.godown_id, g.name || g.godown_id])], d.depot, (v) => { d.depot = v; refresh(); }, 'Depot');
  const date = h('input', { type: 'date', value: d.expiry, 'aria-label': 'Expiry date', oninput: () => { d.expiry = date.value; refresh(); } });
  inputs.expiry = date;
  add.onclick = () => {
    const r = refresh();
    if (!r.item) return;
    const gtin = parseLabel(d.raw).gtin;
    if (gtin) learn(gtin, r.item.product_id);
    lastDepot = r.item.godown_id;
    items.push(r.item);
    draft = null;
    phase = 'scan';
    toast(`${r.item.product_id} · lot ${r.item.lot_id} added to the list`);
    draw();
  };
  const card = h('section', { class: 'card' },
    h('p', { class: 'eyebrow' }, 'Check the details'),
    h('p', { class: 'small muted code-line' }, `Read: ${d.raw.replace(/\x1d/g, ' ').slice(0, 120)}`),
    d.notes.length > 0 && h('div', { class: 'alert warn' }, d.notes.map((n) => h('p', { class: 'small' }, n))),
    h('label', { class: 'field' }, h('span', {}, 'Product'), inputs.product, msg.product),
    h('label', { class: 'field' }, h('span', {}, 'Depot'), inputs.depot, msg.depot),
    text('lot', 'Lot number', 'text'),
    h('div', { class: 'grid2' }, text('qty', 'Units', 'numeric'), h('label', { class: 'field' }, h('span', {}, 'Expiry date'), date, msg.expiry)),
    infoBox,
    h('div', { class: 'grid2' }, h('button', { class: 'btn', onclick: () => { draft = null; phase = 'scan'; draw(); } }, 'Cancel'), add));
  refresh();
  return card;
}

function batchCard() {
  if (!items.length) return null;
  return h('section', { class: 'card' },
    h('div', { class: 'row between' }, h('p', { class: 'eyebrow' }, `Ready to add (${items.length})`), h('span', { class: 'small muted' }, `${num(items.reduce((n, i) => n + i.qty_units, 0))} units`)),
    h('ul', { class: 'rows' }, items.map((it, k) => h('li', {},
      h('div', { class: 'row-main' }, h('strong', {}, `${it.product_id} · lot ${it.lot_id}`),
        h('span', {}, `${godownName(it.godown_id)} · ${num(it.qty_units)} units · ${it.remaining_life_days} days left`)),
      h('div', { class: 'row-end' }, it.was == null ? badge('New', 'ok') : badge('Recount', ''),
        h('button', { class: 'btn ghost small', 'aria-label': `Remove lot ${it.lot_id}`, onclick: () => { items.splice(k, 1); draw(); } }, 'Remove'))))),
    phase === 'scan' && h('button', { class: 'btn primary block', onclick: apply }, 'Update stock and plan again', icon('arrow')),
    h('p', { class: 'note' }, 'ARIA adds these lots to the depot stock, plans again and shows what changed.'));
}

/** Add the batch to the stock, check it, plan again and keep both plans for the comparison. */
async function apply() {
  const sc = state.scenario;
  const busy = (t: string) => { busyText = t; phase = 'busy'; draw(); };
  try {
    let before: Json | null = state.plan && !isStale(state.plan.resp) ? state.plan.resp : null;
    if (!before && state.report?.valid) {
      busy('Planning with the stock you had before...');
      const r = await engine.plan(sc);
      before = r.valid === false ? null : r;
    }
    const next = structuredClone(sc);
    for (const it of items) {
      const lot = { lot_id: it.lot_id, godown_id: it.godown_id, product_id: it.product_id, qty_units: it.qty_units, remaining_life_days: it.remaining_life_days };
      const at = next.lots.findIndex((l: Json) => l.lot_id === it.lot_id);
      if (at >= 0) next.lots[at] = lot; else next.lots.push(lot);
    }
    busy('Checking the new stock...');
    const report = await engine.validate(next);
    if (!report.valid) {
      problems = (report.errors ?? []).slice(0, 10).map((e: Json) => issueText(e, next));
      phase = 'scan';
      return draw();
    }
    busy('Planning again with the new stock...');
    const after = await engine.plan(next);
    if (after.valid === false) {
      problems = (after.errors ?? []).slice(0, 10).map((e: Json) => issueText(e, next));
      phase = 'scan';
      return draw();
    }
    if (state.scenario !== sc) { problems = ['Your data changed while planning. Nothing was added; please try again.']; phase = 'scan'; return draw(); }
    state.scenario = next;
    state.report = report;
    state.validating = false;
    const rid = nextRid();
    state.plan = { rid, resp: after };
    state.planRid = rid;
    state.planError = '';
    state.lab.result = null;
    state.lab.sweep = null;
    const n = items.length;
    items = [];
    persist();
    notify();
    result = { before, after };
    phase = 'done';
    toast(`${n} lot${n > 1 ? 's' : ''} added to stock`);
    draw();
  } catch {
    problems = ['Planning did not work. Your stock was not changed. Please try again.'];
    phase = 'scan';
    draw();
  }
}

function summary(r: Json) {
  const key = r.aria ? 'aria' : 'baseline_a';
  const p = r[key], imp = r.impact?.[key] ?? {};
  const allocs: Json[] = p.allocations ?? [];
  return {
    allocs, verified: !!p.verifier?.passed,
    units: allocs.reduce((n, a) => n + a.units, 0),
    shorts: (p.shortfalls ?? []).length,
    shortUnits: (p.shortfalls ?? []).reduce((n: number, s: Json) => n + s.shortfall_units, 0),
    fill: imp.expected_fill_rate as number | undefined,
    freight: p.metrics?.freight_paise as number | undefined,
    lost: imp.expected_lost_margin_paise as number | undefined,
  };
}

function compare(before: Json | null, after: Json) {
  const a = summary(after), b = before ? summary(before) : null;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const line = (what: string, x: number | undefined, y: number | undefined, f: (v: number) => string, higherIsBetter: boolean) => {
    if (y == null) return null;
    const d = x == null ? 0 : y - x;
    const same = x == null || f(x) === f(y);
    const good = !same && (d > 0) === higherIsBetter;
    return h('tr', {}, h('th', { scope: 'row' }, what), h('td', {}, x == null ? '-' : f(x)), h('td', {}, h('strong', {}, f(y))),
      h('td', {}, same ? badge('Same', '') : badge(`${d > 0 ? '▲' : '▼'} ${f(Math.abs(d))}`, good ? 'ok' : 'warn')));
  };
  const key = (x: Json) => `${x.godown_id}|${x.town_id}|${x.product_id}`;
  const units = (list: Json[]) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + x.units), new Map<string, number>());
  const ub = units(b?.allocs ?? []), ua = units(a.allocs);
  const moves = [...new Set([...ub.keys(), ...ua.keys()])].map((k) => ({ k, d: (ua.get(k) ?? 0) - (ub.get(k) ?? 0) })).filter((m) => m.d !== 0).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  return [
    h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('p', { class: 'eyebrow' }, 'New plan compared with the one before'), a.verified ? badge('Verified', 'ok') : badge('Not verified', 'bad')),
      !b && h('p', { class: 'note' }, 'There was no plan before this scan, so only the new numbers are shown.'),
      h('table', { class: 'compare' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Before'), h('th', {}, 'Now'), h('th', {}, 'Change'))),
        h('tbody', {},
          line('Units to ship', b?.units, a.units, num, true),
          line('Shortages', b?.shorts, a.shorts, num, false),
          line('Units short', b?.shortUnits, a.shortUnits, num, false),
          line('Customers served', b?.fill, a.fill, pct, true),
          line('Transport cost', b?.freight, a.freight, rupees, false),
          line('Lost sales value', b?.lost, a.lost, rupees, false)))),
    b && h('section', { class: 'card' },
      h('p', { class: 'eyebrow' }, `Shipments that changed (${num(moves.length)})`),
      moves.length ? h('ul', { class: 'rows' }, moves.slice(0, 15).map(({ k, d }) => {
        const [g, t, p] = k.split('|');
        return h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, p), h('span', {}, `${godownName(g)} → ${townName(t)}`)),
          h('div', { class: 'row-end' }, h('strong', { class: d > 0 ? 'ok-text' : 'bad-text' }, `${d > 0 ? '+' : '−'}${num(Math.abs(d))}`), h('span', {}, 'units')));
      })) : h('p', { class: 'note' }, 'No shipment changed. The new stock was not needed tonight.'),
      moves.length > 15 && h('p', { class: 'small muted' }, `…and ${num(moves.length - 15)} more.`)),
  ];
}
