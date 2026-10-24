// Admin's Team screen: the team code to share, every driver (active or paused, last seen, tonight's progress),
// sending tonight's plan to drivers (one trip per depot), all trips with delivery progress, and driver reports.
import { cancelTrip, DEFAULT_POLICY, deletePlanFile, deleteTrip, reassignTrip, sendTrips, setDriverActive, when, type PlanFile, type Profile, type Stop, type Trip } from '../cloud';
import { deliveriesCard, tripBadge, tripProgress } from './deliveries';
import { shareText } from '../native';
import { isStale, state } from '../state';
import { Json, badge, errorBox, h, icon, kv, mount, num, openSheet, select, toast } from '../ui';
import { godownName, townName } from './plan';

let root: HTMLElement;
const choice: Record<string, string> = {}; // depot -> driver uid, for the send form
let sending = false;

export function render(r: HTMLElement) {
  root = r;
  update();
}

export function update() {
  if (!root) return;
  const t = state.team;
  mount(root,
    h('section', { class: 'card' },
      h('p', { class: 'eyebrow' }, 'Your team'),
      h('strong', {}, t?.name ?? '...'),
      h('div', { class: 'code-box' }, h('span', { class: 'small muted' }, 'Drivers join with this code'), h('strong', { class: 'join-code' }, t?.joinCode ?? '------')),
      h('button', { class: 'btn block', disabled: !t, onclick: async () => {
        const how = await shareText('Join my ARIA team', `Join my delivery team "${t!.name}" in ARIA. Open the app, tap "I am a driver" and enter the code ${t!.joinCode}.`);
        if (how === 'copied') toast('Code copied');
      } }, icon('share'), 'Share the code')),
    sendCard(),
    deliveriesCard(update),
    driversCard(),
    tripsCard(),
    filesCard(),
    reportsCard());
}

// ---------- send tonight's plan ----------
function planned(): { plan: Json; resp: Json } | null {
  const resp = state.plan?.resp;
  if (!resp) return null;
  const plan = resp.recommended === 'aria' ? resp.aria : resp.baseline_a;
  return plan ? { plan, resp } : null;
}

function tripsFromPlan(plan: Json, planKey: string): Omit<Trip, 'id' | 'driverUid' | 'driverName'>[] {
  const byDepot = new Map<string, Json[]>();
  for (const a of plan.allocations as Json[]) byDepot.set(a.godown_id, [...(byDepot.get(a.godown_id) ?? []), a]);
  return [...byDepot].sort(([a], [b]) => godownName(a).localeCompare(godownName(b))).map(([g, rows]) => {
    const towns = new Map<string, Stop>();
    for (const a of rows) {
      const s: Stop = towns.get(a.town_id) ?? { town_id: a.town_id, town: townName(a.town_id), units: 0, items: [], delivered: false };
      s.units += a.units;
      s.items.push({ product: a.product_id, lot: a.lot_id, units: a.units, days_left: a.life_on_arrival });
      towns.set(a.town_id, s);
    }
    const stops = [...towns.values()].sort((x, y) => y.units - x.units);
    return { depot_id: g, depot: godownName(g), day: state.scenario?.day || new Date().toISOString().slice(0, 10), dataset: state.scenarioId, planKey,
      units: stops.reduce((n, s) => n + s.units, 0), stops, status: 'assigned' as const };
  });
}

function sendCard() {
  const p = planned();
  const active = state.drivers.filter((d) => d.active);
  const head = h('div', { class: 'section-head' }, h('h2', {}, "Send tonight's trips"));
  if (!p) return [head, h('section', { class: 'card' }, h('p', { class: 'small' }, 'Plan tonight on Home first. Each depot\'s load then becomes one trip you can give to a driver.'))];
  if (isStale(p.resp)) return [head, h('section', { class: 'card' }, h('p', { class: 'small' }, 'Your data changed after planning. Plan again on Home, then send the trips.'))];
  if (!p.plan.verifier?.passed) return [head, h('section', { class: 'card' }, errorBox('This plan did not pass the safety checks, so it cannot be sent.'))];
  const trips = tripsFromPlan(p.plan, p.resp.scenario_hash);
  const sentTo = (depot: string) => state.trips.find((t) => t.planKey === p.resp.scenario_hash && t.depot_id === depot);
  if (!trips.length) return [head, h('section', { class: 'card' }, h('p', { class: 'small' }, 'Nothing to ship tonight.'))];
  const opts: [string, string][] = [['', 'Choose a driver'], ...active.map((d): [string, string] => [d.uid, `${d.name}${d.vehicle ? ` · ${d.vehicle}` : ''}`])];
  const ready = trips.filter((t) => choice[t.depot_id] && !sentTo(t.depot_id));
  const allSent = trips.every((t) => sentTo(t.depot_id));
  return [head, h('section', { class: 'card' },
    !active.length && h('p', { class: 'note' }, 'No active drivers yet. Share your team code so drivers can join.'),
    (() => {
      const missing = [...new Set(trips.flatMap((t) => t.stops.map((x) => x.town_id)))].filter((id) => !deliveryPoint(id));
      return missing.length > 0 && h('p', { class: 'note' }, `${missing.length} town${missing.length > 1 ? 's have' : ' has'} no map position in your data (${missing.map(townName).join(', ')}). Arrival there cannot be checked until you set the delivery point under Deliveries, or add lat and lon to the towns table.`);
    })(),
    h('ul', { class: 'rows' }, trips.map((t) => h('li', { class: 'assign' },
      h('div', { class: 'row-main' }, h('strong', {}, t.depot), h('span', {}, `${num(t.units)} units · ${t.stops.length} town${t.stops.length > 1 ? 's' : ''}`)),
      sentTo(t.depot_id) ? badge(`Sent to ${sentTo(t.depot_id)!.driverName}`, 'ok')
        : select(opts, choice[t.depot_id] ?? '', (v) => { choice[t.depot_id] = v; update(); }, `Driver for ${t.depot}`)))),
    h('button', { class: 'btn primary block', disabled: sending || !ready.length, onclick: () => send(trips) },
      sending ? 'Sending...' : allSent ? 'Every trip has been sent' : ready.length ? `Send ${ready.length} trip${ready.length > 1 ? 's' : ''} to drivers` : 'Choose a driver for each trip'))];
}

/** A town's delivery point from the data, only when it holds real coordinates (nothing is guessed from names). */
function deliveryPoint(townId: string): { lat: number; lon: number } | null {
  const t = state.scenario?.towns?.find((x: Json) => x.town_id === townId);
  const ok = t && typeof t.lat === 'number' && typeof t.lon === 'number' && Math.abs(t.lat) <= 90 && Math.abs(t.lon) <= 180 && !(t.lat === 0 && t.lon === 0);
  return ok ? { lat: t.lat, lon: t.lon } : null;
}

async function send(trips: ReturnType<typeof tripsFromPlan>) {
  const me = state.me!;
  const out = trips.filter((t) => choice[t.depot_id] && !state.trips.some((x) => x.planKey === t.planKey && x.depot_id === t.depot_id)).map((t) => {
    const d = state.drivers.find((x) => x.uid === choice[t.depot_id])!;
    return { ...t, driverUid: d.uid, driverName: d.name };
  });
  sending = true;
  update();
  try {
    await sendTrips(me.orgId, out, deliveryPoint, { ...DEFAULT_POLICY, ...state.team?.geo });
    for (const t of out) delete choice[t.depot_id];
    toast(`Sent ${out.length} trip${out.length > 1 ? 's' : ''}`);
  } catch (e: any) {
    toast('Could not send. Check the internet connection and try again.');
    console.warn(e);
  } finally {
    sending = false;
    update();
  }
}

// ---------- drivers ----------
const progress = tripProgress;
const statusBadge = tripBadge;

function driversCard() {
  const ds = state.drivers;
  return [h('div', { class: 'section-head' }, h('h2', {}, 'Drivers', h('span', { class: 'count' }, num(ds.length)))),
    ds.length ? h('ul', { class: 'rows' }, ds.map((d) => {
      const mine = state.trips.filter((t) => t.driverUid === d.uid);
      const open = mine.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
      return h('li', { class: 'tap', tabIndex: 0, role: 'button', onclick: () => driverSheet(d), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') driverSheet(d); } },
        h('div', { class: 'row-main' }, h('strong', {}, d.name), h('span', {}, [d.vehicle, open.length ? `${open.length} trip${open.length > 1 ? 's' : ''} open` : 'No open trips'].filter(Boolean).join(' · '))),
        h('div', { class: 'row-end' }, d.active ? badge('Active', 'ok') : badge('Paused', 'bad'), h('span', {}, `seen ${when(d.lastSeen)}`)));
    })) : h('section', { class: 'card' }, h('p', { class: 'small' }, 'No drivers yet. Share your team code above.'))];
}

function driverSheet(d: Profile) {
  const mine = state.trips.filter((t) => t.driverUid === d.uid);
  openSheet(d.name,
    kv([['Status', d.active ? 'Active' : 'Paused: cannot see trips'], ['Phone', d.phone || '-'], ['Vehicle', d.vehicle || '-'], ['Email', d.email], ['Last seen', when(d.lastSeen)]]),
    d.phone && h('a', { class: 'btn block', href: `tel:${d.phone}` }, icon('phone'), `Call ${d.name}`),
    h('button', { class: `btn block${d.active ? ' danger' : ''}`, onclick: async () => {
      try { await setDriverActive(d.uid, !d.active); toast(d.active ? `${d.name} paused` : `${d.name} can use the app again`); } catch { toast('Could not change this. Check the internet connection.'); }
      (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
    } }, d.active ? 'Pause this driver' : 'Allow this driver again'),
    h('h3', {}, 'Trips'),
    mine.length ? h('ul', { class: 'rows' }, mine.map((t) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, `From ${t.depot}`), h('span', {}, `${t.day} · ${num(t.units)} units · ${progress(t)}`)), statusBadge(t))))
      : h('p', { class: 'note' }, 'No trips sent to this driver yet.'));
}

// ---------- trips and reports ----------
function tripsCard() {
  const ts = state.trips.slice(0, 30);
  return [h('div', { class: 'section-head' }, h('h2', {}, 'Trips sent', h('span', { class: 'count' }, num(state.trips.length)))),
    ts.length ? h('ul', { class: 'rows' }, ts.map((t) => h('li', { class: 'tap', tabIndex: 0, role: 'button', onclick: () => tripSheet(t) },
      h('div', { class: 'row-main' }, h('strong', {}, `${t.driverName} · from ${t.depot}`), h('span', {}, `${t.day} · ${num(t.units)} units · ${progress(t)}`)),
      h('div', { class: 'row-end' }, statusBadge(t), h('span', {}, `sent ${when(t.createdAt)}`)))))
      : h('section', { class: 'card' }, h('p', { class: 'small' }, 'No trips sent yet.'))];
}

function tripSheet(t: Trip) {
  const me = state.me!;
  const all = state.stops[t.id] ?? [];
  const open = t.status === 'assigned' || t.status === 'loaded';
  const others = state.drivers.filter((d) => d.active && d.uid !== t.driverUid);
  let to = others[0]?.uid ?? '';
  const reason = h('input', { type: 'text', placeholder: 'Reason for cancelling', 'aria-label': 'Reason for cancelling' });
  openSheet(`${t.driverName} · from ${t.depot}`,
    kv([['Day', t.day], ['Data', t.dataset], ['Units', num(t.units)], ['Progress', progress(t)], ['Last update', when(t.updatedAt)]]),
    h('ul', { class: 'rows' }, t.stops.map((s, i) => {
      const d = all.find((x) => x.i === i);
      return h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, s.town), h('span', {}, `${num(s.units)} units · ${s.items.length} product line${s.items.length > 1 ? 's' : ''}`)),
        d ? badge(...(({ delivered: ['Delivered', 'ok'], submitted: ['To confirm', 'warn'], in_transit: ['On the way', 'warn'], arrived: ['Arrived', 'warn'], failed: ['Not delivered', 'bad'],
          rejected: ['Not accepted', 'bad'], cancelled: ['Cancelled', 'bad'], assigned: ['Not started', ''] } as Record<string, [string, any]>)[d.state])) : s.delivered ? badge('Delivered', 'ok') : badge('Not yet', ''));
    })),
    open && others.length > 0 && [h('h3', {}, 'Give to another driver'),
      h('div', { class: 'grid2' }, select(others.map((d): [string, string] => [d.uid, d.name]), to, (v) => { to = v; }, 'New driver'),
        h('button', { class: 'btn', onclick: async () => {
          const d = state.drivers.find((x) => x.uid === to);
          if (!d) return;
          try { await reassignTrip(me.orgId, t, all, d, me); toast(`Trip given to ${d.name}`); } catch { toast('Could not change the driver. Check the internet connection.'); }
          (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
        } }, 'Give trip'))],
    open && [h('h3', {}, 'Cancel this trip'), reason,
      h('button', { class: 'btn block danger', onclick: async () => {
        if (reason.value.trim().length < 3) return toast('Write why the trip is cancelled.');
        try { await cancelTrip(me.orgId, t, all, reason.value.trim().slice(0, 300), me); toast('Trip cancelled'); } catch { toast('Could not cancel. Check the internet connection.'); }
        (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
      } }, 'Cancel trip')],
    h('button', { class: 'btn block danger ghost', onclick: async () => {
      if (!confirm(`Remove this trip and its delivery history from ${t.driverName}'s phone?`)) return;
      try { await deleteTrip(me.orgId, t.id); toast('Trip removed'); } catch { toast('Could not remove the trip.'); }
      (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
    } }, 'Remove this trip'));
}

function filesCard() {
  const fs = state.files.slice(0, 30);
  return [h('div', { class: 'section-head' }, h('h2', {}, 'Plan files sent', h('span', { class: 'count' }, num(state.files.length)))),
    fs.length ? h('ul', { class: 'rows' }, fs.map((f) => h('li', { class: 'tap', tabIndex: 0, role: 'button', onclick: () => fileSheet(f) },
      h('div', { class: 'row-main' }, h('strong', {}, `${f.driverName} · ${f.dataset || f.name}`), h('span', {}, `${f.day} · ${num(f.units)} units · sent ${when(f.createdAt)}`)),
      f.openedAt ? badge('Opened', 'ok') : badge('Not opened yet', ''))))
      : h('section', { class: 'card' }, h('p', { class: 'small' }, 'No plan files sent yet. Use Share plan on Home after planning.'))];
}

function fileSheet(f: PlanFile) {
  openSheet(`Plan file for ${f.driverName}`,
    kv([['File', f.name], ['Data', f.dataset], ['Day', f.day], ['Units', num(f.units)], ['Sent', when(f.createdAt)], ['Opened', f.openedAt ? when(f.openedAt) : 'Not yet']]),
    h('button', { class: 'btn block danger', onclick: async () => {
      if (!confirm(`Remove this plan file from ${f.driverName}'s phone?`)) return;
      try { await deletePlanFile(state.me!.orgId, f); toast('Plan file removed'); } catch { toast('Could not remove the file.'); }
      (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
    } }, 'Remove this file'));
}

function reportsCard() {
  const rs = state.reports.slice(0, 30);
  return [h('div', { class: 'section-head' }, h('h2', {}, 'Problems reported by drivers', h('span', { class: 'count' }, num(state.reports.length)))),
    rs.length ? h('ul', { class: 'rows' }, rs.map((r) => h('li', {},
      h('div', { class: 'row-main' }, h('strong', {}, `${r.driverName}: ${r.kind}`), h('span', {}, r.note || 'No details given')),
      h('div', { class: 'row-end' }, h('span', {}, when(r.createdAt))))))
      : h('section', { class: 'card' }, h('p', { class: 'small' }, 'No problems reported.'))];
}
