// Driver screens: My trips (load, deliver stop by stop, share the pick list) and Report a problem.
// Drivers see only trips their admin sent them; they cannot change data or plans.
import { sendReport, updateTrip, when, type Trip } from '../cloud';
import { shareFile } from '../native';
import { state } from '../state';
import { badge, h, icon, mount, num, openSheet, select, toast } from '../ui';

let tripsRoot: HTMLElement | null = null;
let reportRoot: HTMLElement | null = null;

export function renderTrips(r: HTMLElement) {
  tripsRoot = r;
  reportRoot = null;
  drawTrips();
}

export function renderReport(r: HTMLElement) {
  reportRoot = r;
  tripsRoot = null;
  drawReport();
}

export function update() {
  if (tripsRoot) drawTrips();
  if (reportRoot) drawReport();
}

const delivered = (t: Trip) => t.stops.filter((s) => s.delivered).length;

function drawTrips() {
  const open = state.trips.filter((t) => t.status !== 'done');
  const done = state.trips.filter((t) => t.status === 'done').slice(0, 10);
  mount(tripsRoot!,
    h('section', { class: 'card' }, h('p', { class: 'eyebrow' }, `Hello, ${state.me?.name ?? ''}`),
      h('strong', {}, open.length ? `${open.length} trip${open.length > 1 ? 's' : ''} to do` : 'No trips right now'),
      h('p', { class: 'small muted' }, open.length ? 'Load the stock, then tick each town when you hand it over.' : 'New trips from your admin appear here by themselves.')),
    open.map(tripCard),
    done.length > 0 && [h('div', { class: 'section-head' }, h('h2', {}, 'Finished')),
      h('ul', { class: 'rows' }, done.map((t) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, `From ${t.depot}`), h('span', {}, `${t.day} · ${num(t.units)} units`)), badge('Delivered', 'ok'))))]);
}

function tripCard(t: Trip) {
  const orgId = state.me!.orgId;
  const loaded = t.status !== 'assigned';
  const save = async (patch: Partial<Pick<Trip, 'status' | 'stops'>>, ok: string) => {
    try { await updateTrip(orgId, t.id, patch); toast(ok); } catch { toast('Saved on this phone. It will reach your admin when you are back online.'); }
  };
  return h('section', { class: 'card trip' },
    h('div', { class: 'row between' }, h('div', {}, h('p', { class: 'eyebrow' }, `${t.day} · sent ${when(t.createdAt)}`), h('strong', {}, `From ${t.depot}`)),
      loaded ? badge('On the road', 'warn') : badge('New', 'ok')),
    h('div', { class: 'split' },
      h('div', {}, h('span', { class: 'small' }, 'Units'), h('strong', {}, num(t.units))),
      h('div', {}, h('span', { class: 'small' }, 'Towns'), h('strong', {}, `${delivered(t)} / ${t.stops.length}`))),
    !loaded && h('button', { class: 'btn primary block', onclick: () => save({ status: 'loaded' }, 'Marked as loaded') }, icon('truck'), 'I have loaded the truck'),
    h('ul', { class: 'rows stops' }, t.stops.map((s, i) => h('li', {},
      h('div', { class: 'row-main tap', role: 'button', tabIndex: 0, onclick: () => stopSheet(t, i) }, h('strong', {}, `${i + 1}. ${s.town}`), h('span', {}, `${num(s.units)} units · ${s.items.length} product line${s.items.length > 1 ? 's' : ''}`)),
      s.delivered ? badge('Delivered', 'ok')
        : h('button', { class: 'btn small', disabled: !loaded, onclick: () => {
          const stops = t.stops.map((x, k) => (k === i ? { ...x, delivered: true } : x));
          save({ stops, ...(stops.every((x) => x.delivered) ? { status: 'done' as const } : {}) }, `${s.town} delivered`);
        } }, icon('check'), 'Delivered')))),
    h('div', { class: 'grid2' },
      h('button', { class: 'btn', onclick: () => shareFile(`trip_${t.depot.replace(/\W+/g, '_')}_${t.day}.csv`, pickCsv(t), 'text/csv') }, icon('share'), 'Pick list'),
      h('button', { class: 'btn', onclick: () => { reportFor = t.id; document.querySelector<HTMLButtonElement>('nav.tabs button[data-tab="report"]')?.click(); } }, icon('alert'), 'Report a problem')));
}

function stopSheet(t: Trip, i: number) {
  const s = t.stops[i];
  openSheet(`${s.town} · ${num(s.units)} units`,
    h('ul', { class: 'rows' }, s.items.map((it) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, it.product), h('span', {}, `Lot ${it.lot} · ${it.days_left} days left on arrival`)),
      h('div', { class: 'row-end' }, h('strong', {}, num(it.units)), h('span', {}, 'units'))))));
}

function pickCsv(t: Trip) {
  const cell = (v: any) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = t.stops.flatMap((s, i) => s.items.map((it) => [i + 1, s.town, it.product, it.lot, it.units, it.days_left]));
  return [['stop', 'town', 'product', 'lot', 'units', 'days_left'], ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

// ---------- report a problem ----------
const KINDS: [string, string][] = [['Road closed or blocked', 'Road closed or blocked'], ['Truck problem', 'Truck problem'], ['Stock damaged or missing', 'Stock damaged or missing'],
  ['Shop could not take the stock', 'Shop could not take the stock'], ['Running late', 'Running late'], ['Something else', 'Something else']];
let reportFor = '';
let kind = KINDS[0][0];
let sending = false;

function drawReport() {
  const me = state.me!;
  const trips = state.trips.filter((t) => t.status !== 'done');
  const note = h('textarea', { rows: 4, placeholder: 'What happened? Where?', 'aria-label': 'Details' });
  const mine = state.reports.slice(0, 20);
  mount(reportRoot!,
    h('section', { class: 'card' },
      h('p', { class: 'eyebrow' }, 'Tell your admin'),
      h('label', {}, 'What happened', select(KINDS, kind, (v) => { kind = v; }, 'What happened')),
      h('label', {}, 'Which trip', select([['', 'Not about a trip'], ...trips.map((t): [string, string] => [t.id, `From ${t.depot} (${t.day})`])], reportFor, (v) => { reportFor = v; }, 'Which trip')),
      h('label', {}, 'Details', note),
      h('button', { class: 'btn primary block', disabled: sending, onclick: async () => {
        sending = true;
        drawReport();
        try {
          await sendReport(me.orgId, { driverUid: me.uid, driverName: me.name, tripId: reportFor || null, kind, note: note.value.trim() });
          toast('Sent to your admin');
          reportFor = '';
        } catch {
          toast('Could not send. Check the internet connection and try again.');
        } finally {
          sending = false;
          drawReport();
        }
      } }, sending ? 'Sending...' : 'Send to admin')),
    h('div', { class: 'section-head' }, h('h2', {}, 'Sent before')),
    mine.length ? h('ul', { class: 'rows' }, mine.map((r) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, r.kind), h('span', {}, r.note || 'No details')), h('span', { class: 'small muted' }, when(r.createdAt)))))
      : h('p', { class: 'note' }, 'Nothing sent yet.'));
}
