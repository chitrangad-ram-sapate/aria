// Driver screens: My trips (load, deliver stop by stop, share the pick list) and Report a problem.
// Drivers see only trips their admin sent them; they cannot change data or plans.
import { errorText, loadPlanFile, markOpened, sendReport, updateTrip, when, type PlanFile, type Trip } from '../cloud';
import { shareFile } from '../native';
import { state } from '../state';
import { badge, h, icon, mount, num, openSheet, select, toast } from '../ui';
import { showPlanFile } from './planfile';

let tripsRoot: HTMLElement | null = null;
let reportRoot: HTMLElement | null = null;
let filesRoot: HTMLElement | null = null;
let viewing = false; // a plan file is open: list updates must not replace it

export function renderTrips(r: HTMLElement) {
  tripsRoot = r;
  reportRoot = filesRoot = null;
  drawTrips();
}

export function renderReport(r: HTMLElement) {
  reportRoot = r;
  tripsRoot = filesRoot = null;
  drawReport();
}

export function update() {
  if (tripsRoot) drawTrips();
  if (reportRoot) drawReport();
  if (filesRoot && !viewing) drawFiles();
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

// ---------- plan files from the admin ----------
export function renderFiles(r: HTMLElement) {
  filesRoot = r;
  tripsRoot = reportRoot = null;
  viewing = false;
  drawFiles();
}

/** A plan file opened from another app (WhatsApp, email, files). */
export function openLocalFile(r: HTMLElement, name: string, bytes: Uint8Array) {
  filesRoot = r;
  tripsRoot = reportRoot = null;
  viewing = true;
  showPlanFile(r, name, bytes, () => { viewing = false; drawFiles(); });
}

function drawFiles() {
  const fs = state.files;
  const input = h('input', { type: 'file', accept: '.svcr,application/vnd.aria.svcr+json', class: 'visually-hidden', id: 'svcr-local',
    onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) openLocalFile(filesRoot!, f.name, new Uint8Array(await f.arrayBuffer()));
    } });
  mount(filesRoot!,
    h('section', { class: 'card' }, h('p', { class: 'eyebrow' }, 'Plan files'),
      h('p', { class: 'small' }, 'Plans your admin sends you appear here. Tap one to see what goes where.'),
      input, h('label', { for: 'svcr-local', class: 'btn block', role: 'button', tabIndex: 0 }, icon('file'), 'Open a plan file from this phone')),
    fs.length ? h('ul', { class: 'rows' }, fs.map((f) => h('li', { class: 'tap', tabIndex: 0, role: 'button', onclick: () => openSent(f), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') openSent(f); } },
      h('div', { class: 'row-main' }, h('strong', {}, f.dataset || f.name), h('span', {}, `${f.day} · ${num(f.units)} units · ${f.depots} depot${f.depots > 1 ? 's' : ''} · sent ${when(f.createdAt)}`)),
      f.openedAt ? badge('Opened', '') : badge('New', 'ok'))))
      : h('section', { class: 'card' }, h('p', { class: 'small' }, 'No plan files yet.')));
}

async function openSent(f: PlanFile) {
  const root = filesRoot!;
  viewing = true;
  mount(root, h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Downloading the plan file...')));
  try {
    const bytes = await loadPlanFile(state.me!.orgId, f);
    if (!f.openedAt) markOpened(state.me!.orgId, f.id).catch(() => {});
    await showPlanFile(root, f.name, bytes, () => { viewing = false; drawFiles(); }, f.dataset || undefined);
  } catch (e) {
    viewing = false;
    drawFiles();
    toast(errorText(e));
  }
}
