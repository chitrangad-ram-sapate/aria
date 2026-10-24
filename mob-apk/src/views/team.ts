// Admin's Team screen: the team code to share, every driver (active or paused, last seen, tonight's progress),
// sending tonight's plan to drivers (one trip per depot), all trips with delivery progress, and driver reports.
import { deleteTrip, sendTrips, setDriverActive, when, type Profile, type Stop, type Trip } from '../cloud';
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
    driversCard(),
    tripsCard(),
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
    h('ul', { class: 'rows' }, trips.map((t) => h('li', { class: 'assign' },
      h('div', { class: 'row-main' }, h('strong', {}, t.depot), h('span', {}, `${num(t.units)} units · ${t.stops.length} town${t.stops.length > 1 ? 's' : ''}`)),
      sentTo(t.depot_id) ? badge(`Sent to ${sentTo(t.depot_id)!.driverName}`, 'ok')
        : select(opts, choice[t.depot_id] ?? '', (v) => { choice[t.depot_id] = v; update(); }, `Driver for ${t.depot}`)))),
    h('button', { class: 'btn primary block', disabled: sending || !ready.length, onclick: () => send(trips) },
      sending ? 'Sending...' : allSent ? 'Every trip has been sent' : ready.length ? `Send ${ready.length} trip${ready.length > 1 ? 's' : ''} to drivers` : 'Choose a driver for each trip'))];
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
    await sendTrips(me.orgId, out);
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
const progress = (t: Trip) => `${t.stops.filter((s) => s.delivered).length} of ${t.stops.length} delivered`;
const statusBadge = (t: Trip) => (t.status === 'done' ? badge('Delivered', 'ok') : t.status === 'loaded' ? badge('On the road', 'warn') : badge('Not started', ''));

function driversCard() {
  const ds = state.drivers;
  return [h('div', { class: 'section-head' }, h('h2', {}, 'Drivers', h('span', { class: 'count' }, num(ds.length)))),
    ds.length ? h('ul', { class: 'rows' }, ds.map((d) => {
      const mine = state.trips.filter((t) => t.driverUid === d.uid);
      const open = mine.filter((t) => t.status !== 'done');
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
  openSheet(`${t.driverName} · from ${t.depot}`,
    kv([['Day', t.day], ['Data', t.dataset], ['Units', num(t.units)], ['Progress', progress(t)], ['Last update', when(t.updatedAt)]]),
    h('ul', { class: 'rows' }, t.stops.map((s) => h('li', {}, h('div', { class: 'row-main' }, h('strong', {}, s.town), h('span', {}, `${num(s.units)} units · ${s.items.length} product line${s.items.length > 1 ? 's' : ''}`)),
      s.delivered ? badge('Delivered', 'ok') : badge('Not yet', '')))),
    h('button', { class: 'btn block danger', onclick: async () => {
      if (!confirm(`Remove this trip from ${t.driverName}'s phone?`)) return;
      try { await deleteTrip(state.me!.orgId, t.id); toast('Trip removed'); } catch { toast('Could not remove the trip.'); }
      (document.querySelector('dialog.sheet') as HTMLDialogElement | null)?.close();
    } }, 'Remove this trip'));
}

function reportsCard() {
  const rs = state.reports.slice(0, 30);
  return [h('div', { class: 'section-head' }, h('h2', {}, 'Problems reported by drivers', h('span', { class: 'count' }, num(state.reports.length)))),
    rs.length ? h('ul', { class: 'rows' }, rs.map((r) => h('li', {},
      h('div', { class: 'row-main' }, h('strong', {}, `${r.driverName}: ${r.kind}`), h('span', {}, r.note || 'No details given')),
      h('div', { class: 'row-end' }, h('span', {}, when(r.createdAt))))))
      : h('section', { class: 'card' }, h('p', { class: 'small' }, 'No problems reported.'))];
}
