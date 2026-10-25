// GeoProof on the driver's phone (D-045): one page per delivery stop with the map, the location check and the
// recipient's proof, plus the location tracking that runs only while one of the driver's stops is on its way.
// "Delivered" stays locked until the arrival check passes; the driver then hands in the recipient's name and code,
// and the admin confirms. Nothing the phone says is taken as final on its own.
import {
  clearLive, loadEvents, OPEN_STATES, sendLive, stepStop, submitProof, updateTrip, when,
  type DeliveryStop, type StopEvent, type StopState, type Trip,
} from '../cloud';
import { checkArrival, distanceM, OUTCOME_TEXT, type Check } from '../geofence';
import { askPermission, lastFix, permission, readOnce, startTracking, stopTracking, STALE_MS, track } from '../geo';
import { createMap, MAP_NAME, MAP_PROVIDER, type DeliveryMap } from '../map';
import { state } from '../state';
import { badge, h, icon, mount, num, openSheet, select, toast } from '../ui';

// ---------- shared words (driver and admin) ----------
export const STATE_TEXT: Record<StopState, [string, '' | 'ok' | 'warn' | 'bad']> = {
  assigned: ['Not started', ''],
  in_transit: ['On the way', 'warn'],
  arrived: ['Arrived · proof needed', 'warn'],
  submitted: ['Awaiting confirmation', 'warn'],
  delivered: ['Delivered', 'ok'],
  rejected: ['Not accepted', 'bad'],
  failed: ['Could not deliver', 'bad'],
  cancelled: ['Cancelled', 'bad'],
};
export const stateBadge = (s: DeliveryStop) => badge(STATE_TEXT[s.state][0], STATE_TEXT[s.state][1]);
const KIND_TEXT: Record<string, string> = {
  start: 'Set off', arrived: 'Location check passed on the phone', proof: 'Proof handed in', confirmed: 'Delivery confirmed', rejected: 'Delivery not accepted',
  failed: 'Could not deliver', cancelled: 'Cancelled', code: 'New recipient code made', point: 'Delivery point set', reassigned: 'Given to another driver',
};
export const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
export const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** The stop's history, loaded when opened. */
export function historyBox(orgId: string, s: DeliveryStop) {
  const box = h('div', {}, h('p', { class: 'small muted' }, 'Loading...'));
  const d = h('details', { class: 'card', ontoggle: async () => {
    if (!d.open) return;
    try {
      const ev: StopEvent[] = await loadEvents(orgId, s);
      mount(box, ev.length ? h('ol', { class: 'events' }, ev.map((e) => h('li', {},
        h('strong', {}, KIND_TEXT[e.kind] ?? e.kind), h('span', { class: 'small muted' }, ` · ${e.name} (${e.role}) · ${when(e.at)}`),
        e.note && h('div', { class: 'small' }, e.note)))) : h('p', { class: 'small muted' }, 'Nothing has happened yet.'));
    } catch { mount(box, h('p', { class: 'small bad-text' }, 'Could not load the history. Check the internet connection.')); }
  } }, h('summary', {}, 'History'), box);
  return d;
}

// ---------- tracking: only while a delivery is on its way ----------
const LIVE_EVERY_MS = 30_000, LIVE_MOVE_M = 50;
let sent: { at: number; lat: number; lon: number } | null = null;
let liveTrip = '';
let liveError = ''; // why the last position did not reach the admin
let redraw: () => void = () => {};

/** The driver's stop that is on its way right now (the first one), with its trip. */
function activeStop(): { t: Trip; s: DeliveryStop } | null {
  for (const t of state.trips) {
    if (t.status !== 'loaded') continue;
    const s = (state.stops[t.id] ?? []).find((x) => x.state === 'in_transit' || x.state === 'arrived');
    if (s) return { t, s };
  }
  return null;
}

/** Start or stop following the phone to match what the driver is doing. Called on every change; runs one at a time. */
let syncing: Promise<void> = Promise.resolve();
export function syncTracking() {
  syncing = syncing.then(syncNow, syncNow);
  return syncing;
}
async function syncNow() {
  const me = state.me;
  const a = me?.role === 'driver' && me.active ? activeStop() : null;
  const perm = a ? await permission() : '';
  if (a && perm === 'granted') {
    await startTracking(onReading);
    liveTrip = a.t.id;
    return;
  }
  await endTracking();
}

/** Stop tracking and remove the shared position (sign-out, pause, delivery finished). */
export async function endTracking() {
  if (track.on) await stopTracking();
  if (liveTrip && state.me) await clearLive(state.me.orgId, liveTrip, state.me.uid).catch(() => {});
  liveTrip = '';
  sent = null;
}

function onReading() {
  const a = activeStop(), f = lastFix(), me = state.me;
  if (a && f && me && (!sent || Date.now() - sent.at > LIVE_EVERY_MS || distanceM(sent, f) > LIVE_MOVE_M)) {
    sent = { at: Date.now(), lat: f.lat, lon: f.lon };
    sendLive(me.orgId, a.t.id, me.uid, f, a.s.id).then(() => { liveError = ''; }, (e) => { sent = null; liveError = String(e?.code ?? e); console.warn(`live location not shared: ${liveError}`); });
  }
  redraw();
}

// ---------- the stop page ----------
let page: { tripId: string; stopId: string } | null = null;
let mapEl: HTMLElement | null = null;
let mapView: DeliveryMap | null = null;
let mapFor = '';
let ticker = 0;

export const isOpen = () => !!page;
export function openStop(tripId: string, stopId: string) { page = { tripId, stopId }; }
export function closeStop() {
  page = null;
  mapView?.destroy();
  mapView = null;
  mapEl = null;
  mapFor = '';
  clearInterval(ticker);
}

function check(t: Trip, s: DeliveryStop): Check {
  const me = state.me!;
  return checkArrival({
    accountActive: me.active, assigned: t.driverUid === me.uid && s.driverUid === me.uid,
    tripActive: t.status === 'loaded' && s.state === 'in_transit', dest: s, policy: s.policy,
    permission: track.perm, fixes: track.fixes, now: Date.now(),
  });
}

/** Draw the open stop into `root`; `back` returns to the trip list. */
export function drawStop(root: HTMLElement, back: () => void) {
  const me = state.me!;
  const t = state.trips.find((x) => x.id === page?.tripId);
  const s = t && (state.stops[t.id] ?? []).find((x) => x.id === page!.stopId);
  if (!t || !s) {
    closeStop();
    toast('This delivery is no longer yours.');
    return back();
  }
  // readings and the clock redraw the page, except while the proof form is open (it would clear what is being typed)
  redraw = () => { if (page && root.isConnected && s.state !== 'arrived') drawStop(root, back); };
  clearInterval(ticker);
  // keeps "x s ago" and old-reading warnings true, and asks for a fresh reading when the phone has not sent one lately,
  // so the arrival check does not wait on readings that come in slowly
  if (s.state === 'in_transit') ticker = window.setInterval(() => {
    const last = lastFix();
    if (track.perm === 'granted' && (!last || Date.now() - last.fix_at > Math.min(8_000, s.policy.max_age_s * 500))) readOnce();
    redraw();
  }, 5000);
  const all = state.stops[t.id] ?? [];
  const item = t.stops[s.i];
  const c = check(t, s);
  const f = lastFix();
  const live = !!f && Date.now() - f.fix_at < STALE_MS;
  const hasPoint = typeof s.lat === 'number' && typeof s.lon === 'number';

  // map: made once per stop and kept between redraws
  if (MAP_PROVIDER !== 'none' && mapFor !== s.id) {
    mapView?.destroy();
    mapView = null;
    mapEl = h('div', { class: 'map-box', role: 'region', 'aria-label': 'Delivery map' });
    mapFor = s.id;
    const el = mapEl;
    createMap(el, (id) => mapView?.centerStop(id)).then((m) => {
      if (mapEl !== el) return m?.destroy();
      mapView = m;
      if (!m) mount(el, h('p', { class: 'small muted map-off' }, 'The map could not load (no internet?). The location check below still works.'));
      paintMap(true);
    });
  }
  function paintMap(fit = false) {
    if (!mapView) return;
    mapView.show(all.filter((x) => typeof x.lat === 'number' && typeof x.lon === 'number').map((x) => ({
      id: x.id, n: x.i + 1, label: x.town, lat: x.lat!, lon: x.lon!, radius_m: x.policy.radius_m, done: x.state === 'delivered', current: x.id === s!.id })),
    f ? { lat: f.lat, lon: f.lon, acc_m: f.acc_m, live, label: live ? 'You are here' : `Your last known position (${ago(f.fix_at)})` } : null);
    if (fit) mapView.fitAll();
  }
  paintMap();

  const status = [
    h('div', { class: 'row between' }, h('span', { class: 'small' }, 'Location'),
      track.on ? (live ? badge('Tracking on', 'ok') : badge('Waiting for location', 'warn')) : badge('Tracking off', '')),
    f && h('p', { class: 'small muted' }, `${live ? 'Updated' : 'Last known position'} ${ago(f.fix_at)} · accurate to about ${Math.round(f.acc_m)} m${live ? '' : ' · not live'}`),
    liveError && h('p', { class: 'small bad-text' }, liveError.includes('permission') ? 'Your location is not reaching your admin (not allowed).' : 'Your location is not reaching your admin (no internet). The check on this phone still works.'),
    hasPoint && c.distance_m != null && h('p', { class: 'small' }, `About ${metres(c.distance_m)} from the delivery point (must be within ${s.policy.radius_m} m)`),
  ];

  let action: any;
  const busy = (b: HTMLButtonElement, text: string) => { b.disabled = true; b.textContent = text; };
  const step = async (b: HTMLButtonElement, patch: Partial<DeliveryStop>, kind: string, note?: string) => {
    try { await stepStop(me.orgId, s, patch, kind, me, note); return true; } catch (e: any) {
      toast(String(e?.code).includes('permission-denied') ? 'This was not accepted. The delivery may have changed; showing the latest.' : 'No internet connection. Try again when you are online.');
      b.disabled = false;
      redraw();
      return false;
    }
  };
  if (t.status === 'cancelled' || s.state === 'cancelled') {
    action = h('div', { class: 'alert bad' }, h('strong', {}, 'Cancelled by your admin.'), s.review?.reason && h('p', { class: 'small' }, s.review.reason));
  } else if (t.status === 'assigned') {
    action = h('button', { class: 'btn primary block big', onclick: () => startTrip(t) }, icon('truck'), 'Start delivery');
  } else if (s.state === 'assigned' || s.state === 'rejected') {
    const go = h('button', { class: 'btn primary block big', onclick: async () => {
      if ((await ensureLocation()) !== 'granted') return;
      busy(go, 'Starting...');
      if (await step(go, { state: 'in_transit' }, 'start')) { await syncTracking(); toast('On the way'); }
    } }, icon('truck'), s.state === 'rejected' ? 'Try this delivery again' : 'Go to this stop');
    action = [s.state === 'rejected' && h('div', { class: 'alert bad' }, h('strong', {}, 'Your admin did not accept the delivery.'), h('p', { class: 'small' }, s.review?.reason || '')),
      !hasPoint && h('p', { class: 'note' }, OUTCOME_TEXT.DESTINATION_NOT_CONFIGURED), go];
  } else if (s.state === 'in_transit') {
    const ok = c.outcome === 'ARRIVAL_VERIFIED';
    const arrive = h('button', { class: `btn ${ok ? 'primary' : ''} block big`, disabled: !ok || s.pending, onclick: async () => {
      const now = check(t, s); // check again at the moment of tapping
      if (now.outcome !== 'ARRIVAL_VERIFIED' || !now.fix) { toast(OUTCOME_TEXT[now.outcome]); return redraw(); }
      busy(arrive, 'Saving...');
      const a = { lat: now.fix.lat, lon: now.fix.lon, acc_m: now.fix.acc_m, fix_at: now.fix.fix_at, dist_m: Math.round(now.distance_m ?? 0), readings: now.good };
      if (await step(arrive, { state: 'arrived', arrival: a }, 'arrived', `${metres(a.dist_m)} from the point, accurate to ${Math.round(a.acc_m)} m`)) toast('Location check passed');
    } }, icon('check'), ok ? 'Location check passed · Confirm recipient' : c.outcome === 'OUTSIDE_DESTINATION_RADIUS' ? 'Not at delivery location yet' : 'Delivered (locked until you arrive)');
    action = [
      h('div', { class: `alert ${ok ? 'ok' : c.outcome === 'ARRIVAL_CHECKING' ? 'warn' : c.outcome === 'OUTSIDE_DESTINATION_RADIUS' ? '' : 'warn'}`, role: 'status' },
        h('strong', {}, OUTCOME_TEXT[c.outcome]),
        c.outcome === 'ARRIVAL_CHECKING' && h('p', { class: 'small' }, `${c.good} of ${c.need} readings at the delivery point`)),
      arrive,
      c.outcome === 'GPS_PERMISSION_REQUIRED'
        ? h('button', { class: 'btn block', onclick: async () => { await ensureLocation(); await syncTracking(); redraw(); } }, 'Allow location')
        : h('button', { class: 'btn block', onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; busy(b, 'Checking...'); await readOnce(); redraw(); } }, icon('pin'), 'Check location again'),
      track.error && h('p', { class: 'small bad-text' }, track.error === 'denied' ? 'Location is not allowed for ARIA. Allow it in the phone settings.'
        : track.error === 'off' ? 'Location (GPS) is turned off. Turn it on in the quick settings.'
          : track.error === 'timeout' ? 'The phone took too long to find you. Try again in the open.' : 'Location is not available right now.'),
    ];
  } else if (s.state === 'arrived') {
    action = proofForm(t, s);
  } else if (s.state === 'submitted') {
    action = h('div', { class: 'alert warn', role: 'status' }, h('strong', {}, 'Delivery submitted · awaiting confirmation'),
      h('p', { class: 'small' }, `Recipient: ${s.claim?.name ?? ''}. Your admin will confirm it.`));
  } else if (s.state === 'delivered') {
    action = h('div', { class: 'alert ok' }, h('strong', {}, 'Delivered and confirmed by your admin'), s.review?.reason && h('p', { class: 'small' }, s.review.reason));
  } else if (s.state === 'failed') {
    action = h('div', { class: 'alert bad' }, h('strong', {}, 'Marked as could not deliver'), h('p', { class: 'small' }, s.failReason ?? ''));
  }

  mount(root,
    h('button', { class: 'btn ghost', onclick: () => { closeStop(); back(); } }, icon('back'), 'All trips'),
    h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('div', {}, h('p', { class: 'eyebrow' }, `Stop ${s.i + 1} of ${t.stops.length} · from ${t.depot}`), h('h2', {}, s.town)), stateBadge(s)),
      s.pending && h('p', { class: 'note' }, 'Saved on this phone · waiting to upload. It counts only once your admin\'s app receives it.'),
      h('p', { class: 'small muted' }, `${num(item?.units ?? 0)} units · ${item?.items.length ?? 0} product line${item?.items.length === 1 ? '' : 's'}`)),
    MAP_PROVIDER !== 'none' ? h('section', { class: 'card map-card' }, mapEl,
      h('div', { class: 'map-tools' },
        h('button', { class: 'btn small', disabled: !f, onclick: () => mapView?.centerDriver() }, 'Me'),
        h('button', { class: 'btn small', disabled: !hasPoint, onclick: () => mapView?.centerStop(s.id) }, 'Delivery point'),
        h('button', { class: 'btn small', onclick: () => mapView?.fitAll() }, 'All stops')),
      h('p', { class: 'small muted' }, `${MAP_NAME}. The circle is the area where delivery is allowed. No road route is drawn.`))
      : h('p', { class: 'note' }, 'Map not set up for this app. The location check works without it.'),
    h('section', { class: 'card' }, status, action),
    ['in_transit', 'arrived'].includes(s.state) && t.status === 'loaded' && h('button', { class: 'btn ghost block', onclick: () => failSheet(t, s) }, icon('alert'), 'Could not deliver here'),
    h('details', { class: 'card' }, h('summary', {}, 'What to hand over'),
      h('ul', { class: 'rows' }, (item?.items ?? []).map((it) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, it.product), h('span', {}, `Lot ${it.lot}`)),
        h('div', { class: 'row-end' }, h('strong', {}, num(it.units)), h('span', {}, 'units')))))),
    historyBox(me.orgId, s));
}

/** Explain why location is needed, then ask the phone. */
async function ensureLocation(): Promise<string> {
  if ((await permission()) === 'granted') return 'granted';
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string) => { if (!done) { done = true; resolve(v); } };
    openSheet('Location for deliveries',
      h('p', {}, 'ARIA uses your location only while a delivery is on its way, to confirm you reached the shop and to show your admin how the delivery is going.'),
      h('ul', { class: 'plain-list small' }, h('li', {}, 'It stops when the delivery is handed in, cancelled, or you sign out.'),
        h('li', {}, 'It works while ARIA is open on the screen. Keep the app open near the shop.'), h('li', {}, 'Only your admin sees where you are.')),
      h('button', { class: 'btn primary block', onclick: async () => {
        const p = await askPermission();
        (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
        if (p !== 'granted') toast('Location was not allowed. You can allow it in the phone settings.');
        finish(p);
      } }, 'Allow location'),
      h('button', { class: 'btn block', onclick: () => { (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close(); finish('denied'); } }, 'Not now'));
    document.querySelector('dialog.sheet')?.addEventListener('close', () => finish('denied'), { once: true });
  });
}

/** Trip: loaded and on the road. */
export async function startTrip(t: Trip) {
  if ((await ensureLocation()) !== 'granted') return;
  try { await updateTrip(state.me!.orgId, t.id, { status: 'loaded' }); toast('Trip started. Open a stop to head there.'); } catch { toast('No internet connection. Try again when you are online.'); }
}

const typed = { name: '', code: '', msg: '', bad: false }; // kept across redraws of the proof form

function proofForm(_t: Trip, s: DeliveryStop) {
  const me = state.me!;
  const name = h('input', { type: 'text', placeholder: 'Name of the person receiving', 'aria-label': 'Recipient name', autocomplete: 'off', value: typed.name, oninput: () => { typed.name = name.value; } });
  const code = h('input', { type: 'text', inputMode: 'numeric', maxLength: 6, placeholder: '6-digit code from the shop', 'aria-label': 'Recipient code', autocomplete: 'off', class: 'code-input',
    value: typed.code, oninput: () => { typed.code = code.value; } });
  // a live update redraws this form: keep the cursor (and the phone keyboard) in the box being typed in
  const was = document.activeElement?.getAttribute('aria-label');
  const keep = was === 'Recipient name' ? name : was === 'Recipient code' ? code : null;
  if (keep) queueMicrotask(() => { keep.focus(); keep.setSelectionRange(keep.value.length, keep.value.length); });
  const msg = h('p', { class: typed.bad ? 'small bad-text' : 'small', 'aria-live': 'polite' }, typed.msg);
  const say = (text: string, bad = true) => { typed.msg = text; typed.bad = bad; msg.textContent = text; msg.className = bad ? 'small bad-text' : 'small'; };
  const send = h('button', { class: 'btn primary block big', disabled: !s.codeGen || s.pending }, 'Submit delivery proof');
  send.onclick = async () => {
    if (name.value.trim().length < 2) return say('Enter the name of the person receiving the stock.');
    if (!/^\d{6}$/.test(code.value.trim())) return say('The code has 6 digits. Ask the person receiving for it.');
    send.disabled = true;
    send.textContent = 'Sending...';
    try {
      const r = await submitProof(me.orgId, s, code.value.trim(), name.value.trim(), me);
      if (r === 'ok') { typed.name = typed.code = typed.msg = ''; toast('Delivery submitted · awaiting confirmation'); return; }
      say(r === 'wrong' ? 'That code is not right, or it has expired. Check it with the person receiving.' : r === 'no-tries' ? 'Too many wrong codes. Ask your admin for a new code.' : 'There is no code for this shop yet. Ask your admin to make one.');
    } catch {
      say('No internet connection. Nothing was handed in yet; try again when you are online.');
    }
    send.disabled = false;
    send.textContent = 'Submit delivery proof';
  };
  return [h('div', { class: 'alert ok' }, h('strong', {}, 'Location check passed'), h('p', { class: 'small' }, 'Now confirm the recipient. This is checked on your phone; your admin confirms the delivery.')),
    !s.codeGen && h('p', { class: 'note' }, 'No delivery code has been made for this shop yet. Ask your admin to make one and give it to the shop.'),
    h('label', { class: 'field' }, h('span', {}, 'Recipient'), name),
    h('label', { class: 'field' }, h('span', {}, 'Delivery code'), code),
    msg, send];
}

const FAIL_REASONS: [string, string][] = [['Shop closed', 'Shop closed'], ['Shop refused the stock', 'Shop refused the stock'], ['Could not reach the address', 'Could not reach the address'],
  ['Stock damaged', 'Stock damaged'], ['Something else', 'Something else']];
function failSheet(t: Trip, s: DeliveryStop) {
  let why = FAIL_REASONS[0][0];
  const note = h('textarea', { rows: 3, placeholder: 'More details (optional)', 'aria-label': 'Details' });
  const go = h('button', { class: 'btn danger block', onclick: async () => {
    go.disabled = true;
    const reason = `${why}${note.value.trim() ? `: ${note.value.trim()}` : ''}`.slice(0, 300);
    try {
      await stepStop(state.me!.orgId, s, { state: 'failed', failReason: reason }, 'failed', state.me!, reason);
      (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
      toast('Your admin has been told');
    } catch { go.disabled = false; toast('Could not save. Check the internet connection.'); }
  } }, 'Mark as could not deliver');
  openSheet(`Could not deliver to ${s.town}`, h('label', {}, 'Why', select(FAIL_REASONS, why, (v) => { why = v; }, 'Why')), h('label', {}, 'Details', note), go);
}

/** One line per stop for the trip card. */
export function stopLine(t: Trip, i: number, onOpen: () => void) {
  const s = (state.stops[t.id] ?? []).find((x) => x.i === i);
  const st = t.stops[i];
  return h('li', { class: 'tap', role: 'button', tabIndex: 0, onclick: onOpen, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') onOpen(); } },
    h('div', { class: 'row-main' }, h('strong', {}, `${i + 1}. ${st.town}`), h('span', {}, `${num(st.units)} units · ${st.items.length} product line${st.items.length > 1 ? 's' : ''}`)),
    s ? stateBadge(s) : st.delivered ? badge('Delivered', 'ok') : badge('Loading...', ''));
}

export const openStops = (t: Trip) => (state.stops[t.id] ?? []).filter((s) => OPEN_STATES.includes(s.state));
