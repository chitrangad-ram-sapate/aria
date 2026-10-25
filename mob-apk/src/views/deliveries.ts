// Admin side of GeoProof (D-045): every delivery stop of the latest trips, filtered by state, driver and depot;
// drivers whose location is old; and per stop the map, the phone's arrival evidence, the recipient's proof,
// the history, and the admin's actions (confirm or refuse, recipient code, delivery point).
import {
  DEFAULT_POLICY, makeCode, OPEN_STATES, reviewStop, setPolicy, setStopPoint, when,
  type DeliveryStop, type LiveFix, type Policy, type Trip,
} from '../cloud';
import { distanceM } from '../geofence';
import { readOnce } from '../geo';
import { createMap, MAP_NAME, MAP_PROVIDER } from '../map';
import { shareText } from '../native';
import { state } from '../state';
import { badge, h, kv, mount, num, openSheet, select, toast } from '../ui';
import { ago, historyBox, metres, stateBadge, STATE_TEXT } from './deliver';

const GROUPS: [string, string, (s: DeliveryStop, t: Trip) => boolean][] = [
  ['review', 'To confirm', (s) => s.state === 'submitted'],
  ['road', 'On the way', (s) => s.state === 'in_transit' || s.state === 'arrived'],
  ['waiting', 'Not started', (s) => s.state === 'assigned'],
  ['done', 'Delivered', (s) => s.state === 'delivered'],
  ['problem', 'Problems', (s) => ['failed', 'rejected', 'cancelled'].includes(s.state)],
  ['all', 'All', () => true],
];
const OLD_MS = 2 * 60_000;
let group = 'review';
let driverFilter = '';
let depotFilter = '';

const close = () => (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
const liveOf = (t: Trip): (LiveFix & { uid: string }) | undefined => (state.live[t.id] ?? []).find((l) => l.uid === t.driverUid);

function rows() {
  const out: { t: Trip; s: DeliveryStop }[] = [];
  for (const t of state.trips.slice(0, 30)) for (const s of state.stops[t.id] ?? []) out.push({ t, s });
  return out;
}

export function deliveriesCard(redraw: () => void) {
  const all = rows();
  const fn = GROUPS.find((g) => g[0] === group)![2];
  const shown = all.filter(({ s, t }) => fn(s, t) && (!driverFilter || t.driverUid === driverFilter) && (!depotFilter || t.depot_id === depotFilter))
    .sort((a, b) => (b.s.updatedAt?.toMillis?.() ?? 0) - (a.s.updatedAt?.toMillis?.() ?? 0));
  const onRoad = state.trips.filter((t) => t.status === 'loaded' && (state.stops[t.id] ?? []).some((s) => s.state === 'in_transit' || s.state === 'arrived'));
  const quiet = onRoad.filter((t) => { const l = liveOf(t); return !l || Date.now() - l.fix_at > OLD_MS; });
  const drivers: [string, string][] = [['', 'All drivers'], ...[...new Map(state.trips.map((t) => [t.driverUid, t.driverName]))]];
  const depots: [string, string][] = [['', 'All depots'], ...[...new Map(state.trips.map((t) => [t.depot_id, t.depot]))]];
  return [h('div', { class: 'section-head' }, h('h2', {}, 'Deliveries', h('span', { class: 'count' }, num(all.length)))),
    h('section', { class: 'card' },
      h('div', { class: 'chips', role: 'tablist', 'aria-label': 'Delivery state' }, GROUPS.map(([k, label, f]) => {
        const n = all.filter(({ s, t }) => f(s, t)).length;
        return h('button', { class: `chip plain${group === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(group === k), onclick: () => { group = k; redraw(); } },
          label, k !== 'all' && n > 0 && h('span', { class: 'chip-n' }, String(n)));
      })),
      h('div', { class: 'grid2' }, select(drivers, driverFilter, (v) => { driverFilter = v; redraw(); }, 'Filter by driver'),
        select(depots, depotFilter, (v) => { depotFilter = v; redraw(); }, 'Filter by depot')),
      quiet.length > 0 && h('div', { class: 'alert warn' }, h('strong', {}, 'No recent location'),
        h('p', { class: 'small' }, quiet.map((t) => { const l = liveOf(t); return `${t.driverName} (${l ? `last ${ago(l.fix_at)}` : 'none yet'})`; }).join(', '))),
      shown.length ? h('ul', { class: 'rows' }, shown.slice(0, 60).map(({ t, s }) => h('li', { class: 'tap', tabIndex: 0, role: 'button', onclick: () => stopSheet(t, s),
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') stopSheet(t, s); } },
        h('div', { class: 'row-main' }, h('strong', {}, `${s.town} · ${t.driverName}`),
          h('span', {}, `From ${t.depot} · ${t.day}${s.lat == null ? ' · no delivery point' : ''}${s.state === 'submitted' ? ` · received by ${s.claim?.name ?? ''}` : ''}`)),
        h('div', { class: 'row-end' }, stateBadge(s), h('span', {}, when(s.updatedAt))))))
        : h('p', { class: 'note' }, group === 'review' ? 'Nothing to confirm right now.' : 'No deliveries here.')),
    policyCard()];
}

function policyCard() {
  const p: Policy = { ...DEFAULT_POLICY, ...state.team?.geo };
  const field = (k: keyof Policy, label: string, min: number, max: number) => h('label', { class: 'field' }, h('span', {}, label),
    h('input', { type: 'number', inputMode: 'numeric', min, max, value: String(p[k]), 'aria-label': label, oninput: (e: Event) => { p[k] = Number((e.target as HTMLInputElement).value); } }));
  return h('details', { class: 'card' }, h('summary', {}, 'Arrival rules'),
    h('p', { class: 'small muted' }, 'When the driver\'s phone may unlock Delivered. They apply to trips sent from now on.'),
    h('div', { class: 'grid2' }, field('radius_m', 'Distance from the shop (m)', 20, 1000), field('max_accuracy_m', 'Location accurate to (m)', 5, 200)),
    h('div', { class: 'grid2' }, field('max_age_s', 'Location newer than (s)', 5, 300), field('readings', 'Readings in a row', 1, 5)),
    h('button', { class: 'btn block', onclick: async () => {
      const ok = p.radius_m >= 20 && p.radius_m <= 1000 && p.max_accuracy_m >= 5 && p.max_accuracy_m <= 200 && p.max_age_s >= 5 && p.max_age_s <= 300
        && Number.isInteger(p.readings) && p.readings >= 1 && p.readings <= 5;
      if (!ok) return toast('Use: distance 20-1000 m, accuracy 5-200 m, newer than 5-300 s, 1-5 readings.');
      try { await setPolicy(state.me!.orgId, p); toast('Arrival rules saved'); } catch { toast('Could not save. Check the internet connection.'); }
    } }, 'Save arrival rules'),
    h('p', { class: 'note' }, 'A 100 m circle and 50 m accuracy show the driver was near the shop, not at its door. Location comes from the driver\'s phone and can be faked with special apps, so you confirm each delivery.'));
}

function stopSheet(t: Trip, s0: DeliveryStop) {
  const me = state.me!;
  const s = (state.stops[t.id] ?? []).find((x) => x.id === s0.id) ?? s0;
  // the stop as it is now: each change bumps its number, so an action must not reuse the copy from when the sheet opened
  const cur = () => (state.stops[t.id] ?? []).find((x) => x.id === s.id) ?? s;
  const live = liveOf(t);
  const liveNow = !!live && Date.now() - live.fix_at < OLD_MS;
  const point = typeof s.lat === 'number' && typeof s.lon === 'number' ? { lat: s.lat, lon: s.lon } : null;
  const mapBox = MAP_PROVIDER !== 'none' && (point || live) ? h('div', { class: 'map-box small-map', role: 'region', 'aria-label': 'Delivery map' }) : null;
  const codeBox = h('div', {});
  const reason = h('textarea', { rows: 2, placeholder: 'Reason (needed to refuse)', 'aria-label': 'Reason' });
  const decide = async (ok: boolean, b: HTMLButtonElement) => {
    if (!ok && reason.value.trim().length < 3) return toast('Write why the delivery is not accepted.');
    b.disabled = true;
    try {
      await reviewStop(me.orgId, state.trips.find((x) => x.id === t.id) ?? t, cur(), ok, reason.value.trim().slice(0, 300), me, state.stops[t.id] ?? []);
      toast(ok ? 'Delivery confirmed' : 'Delivery not accepted; the driver can try again');
      close();
    } catch (e: any) {
      b.disabled = false;
      toast(String(e?.code).includes('permission-denied') ? 'This delivery changed meanwhile. Open it again.' : 'Could not save. Check the internet connection.');
    }
  };
  const lat = h('input', { type: 'text', inputMode: 'decimal', placeholder: 'Latitude, e.g. 16.70500', 'aria-label': 'Latitude', value: point ? String(point.lat) : '' });
  const lon = h('input', { type: 'text', inputMode: 'decimal', placeholder: 'Longitude, e.g. 74.24330', 'aria-label': 'Longitude', value: point ? String(point.lon) : '' });
  const savePoint = async () => {
    const a = Number(lat.value), b = Number(lon.value);
    if (!lat.value.trim() || !lon.value.trim() || !Number.isFinite(a) || !Number.isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180 || (a === 0 && b === 0)) return toast('Enter a real latitude and longitude.');
    try { await setStopPoint(me.orgId, cur(), a, b, me); toast('Delivery point saved'); close(); }
    catch (e: any) { toast(String(e?.code).includes('permission-denied') ? 'Could not save. The driver has already arrived, or this delivery changed; open it again.' : 'Could not save. Check the internet connection.'); }
  };
  openSheet(`${s.town} · ${t.driverName}`,
    h('div', { class: 'row between' }, h('span', { class: 'small muted' }, `Stop ${s.i + 1} of ${t.stops.length} · from ${t.depot} · ${t.day}`), stateBadge(s)),
    mapBox && h('div', {}, mapBox, h('p', { class: 'small muted' }, `${MAP_NAME}. Circle: where delivery is allowed.${live ? ` Dot: driver's latest location${liveNow ? '' : ' (old, grey)'}.` : ''}`)),
    kv([
      ['Delivery point', point ? `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` : 'Not set: arrival cannot be checked'],
      ['Arrival rules', `within ${s.policy.radius_m} m · accurate to ${s.policy.max_accuracy_m} m · newer than ${s.policy.max_age_s} s · ${s.policy.readings} reading${s.policy.readings > 1 ? 's' : ''}`],
      ['Driver location', live ? `${liveNow ? 'Live' : 'Old'}: ${ago(live.fix_at)}, accurate to ${Math.round(live.acc_m)} m${point ? `, ${metres(distanceM(live, point))} from the point` : ''}` : OPEN_STATES.includes(s.state) && s.state !== 'submitted' && s.state !== 'assigned' ? 'Not shared yet' : 'Not shared (only while on the way)'],
      ['Last change', when(s.updatedAt)],
    ]),
    s.arrival && h('div', { class: 'alert' }, h('strong', {}, 'Location check on the driver\'s phone'),
      h('p', { class: 'small' }, `${metres(s.arrival.dist_m)} from the point, accurate to ${Math.round(s.arrival.acc_m)} m, ${s.arrival.readings} readings, at ${new Date(s.arrival.fix_at).toLocaleTimeString()}.`),
      h('p', { class: 'small muted' }, 'The database checked these numbers are inside the circle and recent. The position itself comes from the phone.')),
    s.claim && h('div', { class: 'alert ok' }, h('strong', {}, `Received by ${s.claim.name}`),
      h('p', { class: 'small' }, `The shop's delivery code matched (checked by the database, try ${s.claim.n} of 5).`)),
    s.failReason && h('div', { class: 'alert bad' }, h('strong', {}, 'Driver could not deliver'), h('p', { class: 'small' }, s.failReason)),
    s.review?.reason && h('p', { class: 'note' }, `${STATE_TEXT[s.state][0]}: ${s.review.reason}`),
    s.state === 'submitted' && [h('h3', {}, 'Confirm this delivery?'), reason,
      h('div', { class: 'grid2' },
        h('button', { class: 'btn danger', onclick: (e: Event) => decide(false, e.currentTarget as HTMLButtonElement) }, 'Not accepted'),
        h('button', { class: 'btn primary', onclick: (e: Event) => decide(true, e.currentTarget as HTMLButtonElement) }, 'Confirm delivered'))],
    OPEN_STATES.includes(s.state) && s.state !== 'submitted' && t.status !== 'cancelled' && [h('h3', {}, 'Delivery code for the shop'),
      h('p', { class: 'small muted' }, s.codeGen ? 'A code has been made. Make a new one if the shop lost it; the old one stops working.' : 'The driver needs this code from the shop to hand in the delivery. Make it and send it to the shop.'),
      codeBox,
      h('button', { class: 'btn block', onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        try {
          const code = await makeCode(me.orgId, cur(), me);
          const text = `ARIA delivery code for ${s.town}: ${code}. Give it to the driver (${t.driverName}) only when the stock is handed over. Valid for 24 hours.`;
          mount(codeBox, h('div', { class: 'alert ok' }, h('p', { class: 'small' }, 'Send this to the shop now. It is shown only once.'), h('strong', { class: 'join-code' }, code),
            h('button', { class: 'btn block', onclick: async () => { if ((await shareText('Delivery code', text)) === 'copied') toast('Copied'); } }, 'Send to the shop')));
          b.remove();
        } catch { b.disabled = false; toast('Could not make a code. Check the internet connection.'); }
      } }, s.codeGen ? 'Make a new code' : 'Make delivery code')],
    ['assigned', 'in_transit', 'rejected'].includes(s.state) && t.status !== 'cancelled' && [h('h3', {}, 'Delivery point'),
      h('p', { class: 'small muted' }, 'Where the driver must be to hand over. Taken from your data; you can change it until the driver arrives.'),
      h('div', { class: 'grid2' }, lat, lon),
      h('div', { class: 'grid2' },
        h('button', { class: 'btn', onclick: async () => { const f = await readOnce(); if (!f) return toast('Could not read this phone\'s location.'); lat.value = f.lat.toFixed(6); lon.value = f.lon.toFixed(6); toast(`This phone: accurate to ${Math.round(f.acc_m)} m`); } }, 'Use this phone\'s location'),
        h('button', { class: 'btn primary', onclick: savePoint }, 'Save point'))],
    historyBox(me.orgId, s));
  if (mapBox) createMap(mapBox).then((m) => {
    if (!m) return mount(mapBox, h('p', { class: 'small muted map-off' }, 'The map could not load. The details below still apply.'));
    m.show(point ? [{ id: s.id, n: s.i + 1, label: s.town, lat: point.lat, lon: point.lon, radius_m: s.policy.radius_m, done: s.state === 'delivered', current: true }] : [],
      live ? { lat: live.lat, lon: live.lon, acc_m: live.acc_m, live: liveNow, label: `${t.driverName}, ${ago(live.fix_at)}` } : null);
    m.fitAll();
    document.querySelector('dialog.sheet')?.addEventListener('close', () => m.destroy(), { once: true });
  });
}

/** Progress of a trip in words, from its stops. */
export function tripProgress(t: Trip) {
  const ss = state.stops[t.id] ?? [];
  if (!ss.length) return `${t.stops.filter((s) => s.delivered).length} of ${t.stops.length} delivered`;
  const n = (st: string) => ss.filter((s) => s.state === st).length;
  return [`${n('delivered')} of ${ss.length} delivered`, n('submitted') && `${n('submitted')} to confirm`, n('failed') && `${n('failed')} not delivered`].filter(Boolean).join(' · ');
}

export const tripBadge = (t: Trip) => (t.status === 'done' ? badge('Delivered', 'ok') : t.status === 'cancelled' ? badge('Cancelled', 'bad')
  : t.status === 'loaded' ? badge('On the road', 'warn') : badge('Not started', ''));
