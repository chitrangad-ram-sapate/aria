// Checks firestore.rules against the emulators by trying what a curious or careless user might try.
// Covers accounts, trips, reports, plan files, the team key that locks plan files, and GeoProof deliveries
// (delivery stops, arrival checks, recipient codes, admin review, cancel and reassign).
// Usage: start the emulators (npx firebase-tools emulators:start --only auth,firestore --project demo-aria), then
//   node scripts/rules-test.mjs
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from 'firebase/auth';
import {
  addDoc, Bytes, collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, getFirestore, query, serverTimestamp,
  setDoc, Timestamp, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { createHash } from 'node:crypto';

const run = Date.now().toString(36);
let n = 0, failed = 0;
const apps = [];

async function person(label) {
  const app = initializeApp({ projectId: 'demo-aria', apiKey: 'demo-key' }, `${label}-${run}-${n++}`);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, 'localhost', 8080);
  const { user } = await createUserWithEmailAndPassword(auth, `${label}-${run}@example.com`, 'secret123');
  return { uid: user.uid, db };
}

async function admin(label, code) {
  const p = await person(label);
  const org = doc(collection(p.db, 'orgs'));
  const b = writeBatch(p.db);
  b.set(org, { name: label, ownerUid: p.uid, joinCode: code, createdAt: serverTimestamp() });
  b.set(doc(p.db, 'joinCodes', code), { orgId: org.id, ownerUid: p.uid, team: label });
  b.set(doc(p.db, 'users', p.uid), { name: label, email: 'x', role: 'admin', orgId: org.id, active: true });
  await b.commit();
  return { ...p, orgId: org.id, role: 'admin' };
}

async function driver(label, code, orgId) {
  const p = await person(label);
  await setDoc(doc(p.db, 'users', p.uid), { name: label, email: 'x', role: 'driver', orgId, joinCode: code, active: true });
  return { ...p, orgId, role: 'driver' };
}

async function allowed(what, fn) {
  try { await fn(); console.log(`ok    allowed: ${what}`); } catch (e) { failed++; console.log(`FAIL  should be allowed: ${what} (${e.code})`); }
}
async function denied(what, fn) {
  try { await fn(); failed++; console.log(`FAIL  should be denied: ${what}`); } catch (e) {
    if (e.code !== 'permission-denied') { failed++; console.log(`FAIL  ${what}: ${e.code}`); } else console.log(`ok    denied:  ${what}`);
  }
}

const c1 = `A${run.slice(-5).toUpperCase()}`, c2 = `B${run.slice(-5).toUpperCase()}`;
const a1 = await admin('admin1', c1);
const a2 = await admin('admin2', c2);
const d1 = await driver('driver1', c1, a1.orgId);
const d2 = await driver('driver2', c1, a1.orgId);
const trip = { driverUid: d1.uid, driverName: 'driver1', depot_id: 'G', depot: 'G', day: 'd', dataset: 'x', units: 1, stops: [], status: 'assigned', createdAt: serverTimestamp() };
let tripId = '';

await allowed('admin sees the drivers in their team', async () => {
  const s = await getDocs(query(collection(a1.db, 'users'), where('orgId', '==', a1.orgId), where('role', '==', 'driver')));
  if (s.size !== 2) throw Object.assign(new Error(), { code: `saw ${s.size}` });
});
await denied('admin reads drivers of another team', () => getDocs(query(collection(a2.db, 'users'), where('orgId', '==', a1.orgId))));
await denied('driver lists the other drivers', () => getDocs(query(collection(d1.db, 'users'), where('orgId', '==', a1.orgId))));
await allowed('admin sends a trip to their driver', async () => { tripId = (await addDoc(collection(a1.db, 'orgs', a1.orgId, 'trips'), trip)).id; });
await denied('admin sends a trip to a driver of another team', () => addDoc(collection(a2.db, 'orgs', a2.orgId, 'trips'), trip));
await denied('driver creates a trip', () => addDoc(collection(d1.db, 'orgs', a1.orgId, 'trips'), trip));
await allowed('driver reads their own trips', () => getDocs(query(collection(d1.db, 'orgs', a1.orgId, 'trips'), where('driverUid', '==', d1.uid))));
await denied('driver reads every trip in the team', () => getDocs(collection(d1.db, 'orgs', a1.orgId, 'trips')));
await denied('driver reads a trip of another driver', () => getDoc(doc(d2.db, 'orgs', a1.orgId, 'trips', tripId)));
await allowed('driver marks their trip loaded', () => updateDoc(doc(d1.db, 'orgs', a1.orgId, 'trips', tripId), { status: 'loaded', updatedAt: serverTimestamp() }));
await denied('driver reassigns their trip', () => updateDoc(doc(d1.db, 'orgs', a1.orgId, 'trips', tripId), { driverUid: d2.uid }));
await denied('driver deletes a trip', () => deleteDoc(doc(d1.db, 'orgs', a1.orgId, 'trips', tripId)));
await denied('driver makes themself admin', () => updateDoc(doc(d1.db, 'users', d1.uid), { role: 'admin' }));
await denied('driver moves to another team', () => updateDoc(doc(d1.db, 'users', d1.uid), { orgId: a2.orgId }));
await allowed('driver updates their phone and vehicle', () => updateDoc(doc(d1.db, 'users', d1.uid), { phone: '1', vehicle: 'V' }));
await denied('signing up as driver with a made-up team', async () => {
  const p = await person('intruder');
  await setDoc(doc(p.db, 'users', p.uid), { name: 'x', email: 'x', role: 'driver', orgId: a1.orgId, joinCode: 'NOPE00', active: true });
});
await denied('signing up as admin of someone else\'s team', async () => {
  const p = await person('intruder2');
  await setDoc(doc(p.db, 'users', p.uid), { name: 'x', email: 'x', role: 'admin', orgId: a1.orgId, active: true });
});
let fileId = '';
const fileMeta = { driverUid: d1.uid, driverName: 'driver1', name: 'p.svcr', dataset: 'x', day: 'd', units: 1, depots: 1, size: 3, parts: 1, createdAt: serverTimestamp() };
await allowed('admin sends a plan file to their driver', async () => {
  const ref = doc(collection(a1.db, 'orgs', a1.orgId, 'files'));
  const b = writeBatch(a1.db);
  b.set(ref, fileMeta);
  b.set(doc(ref, 'parts', '0'), { i: 0, data: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])) });
  await b.commit();
  fileId = ref.id;
});
await denied('admin sends a plan file to a driver of another team', () => addDoc(collection(a2.db, 'orgs', a2.orgId, 'files'), fileMeta));
await denied('driver sends a plan file', () => addDoc(collection(d1.db, 'orgs', a1.orgId, 'files'), fileMeta));
await allowed('driver reads their plan file', async () => {
  await getDoc(doc(d1.db, 'orgs', a1.orgId, 'files', fileId));
  await getDocs(collection(d1.db, 'orgs', a1.orgId, 'files', fileId, 'parts'));
});
await denied('another driver reads that plan file', () => getDoc(doc(d2.db, 'orgs', a1.orgId, 'files', fileId)));
await denied('another driver reads what is inside that plan file', () => getDocs(collection(d2.db, 'orgs', a1.orgId, 'files', fileId, 'parts')));
await allowed('driver marks the plan file opened', () => updateDoc(doc(d1.db, 'orgs', a1.orgId, 'files', fileId), { openedAt: serverTimestamp() }));
await denied('driver changes who the plan file is for', () => updateDoc(doc(d1.db, 'orgs', a1.orgId, 'files', fileId), { driverUid: d2.uid }));
await denied('driver changes the plan file contents', () => setDoc(doc(d1.db, 'orgs', a1.orgId, 'files', fileId, 'parts', '0'), { i: 0, data: Bytes.fromUint8Array(new Uint8Array([9])) }));
const keyRef = (db, org) => doc(db, 'orgs', org, 'secret', 'key');
await denied('driver makes the team key', () => setDoc(keyRef(d1.db, a1.orgId), { k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }));
await denied('admin makes a key for another team', () => setDoc(keyRef(a2.db, a1.orgId), { k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }));
await denied('admin makes a key that is not 32 bytes', () => setDoc(keyRef(a1.db, a1.orgId), { k: 'short' }));
await allowed('admin makes the team key once', () => setDoc(keyRef(a1.db, a1.orgId), { k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }));
await denied('admin replaces the team key', () => setDoc(keyRef(a1.db, a1.orgId), { k: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' }));
await allowed('driver of the team reads the team key', () => getDoc(keyRef(d1.db, a1.orgId)));
await denied('admin of another team reads the team key', () => getDoc(keyRef(a2.db, a1.orgId)));
await denied('driver lists the team secrets', () => getDocs(collection(d1.db, 'orgs', a1.orgId, 'secret')));
// ---------- GeoProof (D-045): trips, delivery stops, arrival, recipient code, review ----------
const P = { radius_m: 100, max_accuracy_m: 50, max_age_s: 15, readings: 2 };
const KOL = { lat: 16.705, lon: 74.2433 };
const mlon = 111320 * Math.cos((KOL.lat * Math.PI) / 180);
const north = (m) => KOL.lat + m / 110574;
const tripDoc = (db, id) => doc(db, 'orgs', a1.orgId, 'trips', id);
const stopDoc = (db, tid, sid) => doc(db, 'orgs', a1.orgId, 'trips', tid, 'stops', sid);
const stopData = (tid, i, drv, pt) => ({ tripId: tid, i, driverUid: drv, town_id: `T${i}`, town: `Town ${i}`, depot_id: 'G', lat: pt?.lat ?? null, lon: pt?.lon ?? null,
  mlon: pt ? mlon : null, policy: P, state: 'assigned', seq: 0, codeGen: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
async function newTrip(drv, points) {
  const ref = doc(collection(a1.db, 'orgs', a1.orgId, 'trips'));
  const b = writeBatch(a1.db);
  b.set(ref, { ...trip, driverUid: drv.uid, driverName: 'x', stops: points.map((_, i) => ({ town_id: `T${i}`, town: `Town ${i}`, units: 1, items: [], delivered: false })) });
  points.forEach((pt, i) => b.set(doc(ref, 'stops', String(i)), stopData(ref.id, i, drv.uid, pt)));
  await b.commit();
  return { id: ref.id, s: points.map(() => ({ seq: 0, state: 'assigned' })) };
}
async function step(p, t, i, patch, { event = true, seq, by } = {}) {
  const cur = t.s[i];
  const n = seq ?? cur.seq + 1;
  const b = writeBatch(p.db);
  b.update(stopDoc(p.db, t.id, String(i)), { ...patch, seq: n, updatedAt: serverTimestamp() });
  if (event) b.set(doc(stopDoc(p.db, t.id, String(i)), 'events', String(n)), { seq: n, state: patch.state ?? cur.state, kind: 't', by: by ?? p.uid, name: 'x', role: p.role, at: serverTimestamp() });
  await b.commit();
  cur.seq = n;
  if (patch.state) cur.state = patch.state;
}
const fix = (m, { acc = 10, ageS = 2, lat } = {}) => ({ lat: lat ?? north(m), lon: KOL.lon, acc_m: acc, fix_at: Date.now() - ageS * 1000, dist_m: m, readings: 2 });
const sha = (s) => createHash('sha256').update(s).digest('hex');

const anon = (() => {
  const app = initializeApp({ projectId: 'demo-aria', apiKey: 'demo-key' }, `anon-${run}`);
  apps.push(app);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, 'localhost', 8080);
  return db;
})();

let T;
await allowed('admin sends a trip with its delivery stops to their driver', async () => { T = await newTrip(d1, [KOL, null]); });
await denied('driver reads delivery stops of another driver', () => getDoc(stopDoc(d2.db, T.id, '0')));
await denied('signed-out visitor reads a trip or a delivery stop', async () => { await getDoc(tripDoc(anon, T.id)).catch((e) => { throw e; }); });
await denied('signed-out visitor reads a delivery stop', () => getDoc(stopDoc(anon, T.id, '0')));
await denied('admin of another team reads the delivery stops', () => getDoc(doc(a2.db, 'orgs', a1.orgId, 'trips', T.id, 'stops', '0')));
await allowed('driver reads their own delivery stop', () => getDoc(stopDoc(d1.db, T.id, '0')));
await denied('driver ticks a stop delivered on the trip by hand', () => updateDoc(tripDoc(d1.db, T.id), { stops: [{ town_id: 'T0', town: 'Town 0', units: 1, items: [], delivered: true }] }));
await denied('driver marks the trip finished', () => updateDoc(tripDoc(d1.db, T.id), { status: 'done' }));
await denied('driver shares location before the trip starts', () => setDoc(doc(d1.db, 'orgs', a1.orgId, 'trips', T.id, 'live', d1.uid), { lat: KOL.lat, lon: KOL.lon, acc_m: 5, fix_at: Date.now(), stop: '0', at: serverTimestamp() }));
await denied('driver starts a stop before starting the trip', () => step(d1, T, 0, { state: 'in_transit' }));
await allowed('driver starts the trip (loaded)', () => updateDoc(tripDoc(d1.db, T.id), { status: 'loaded', updatedAt: serverTimestamp() }));
await allowed('driver shares location on their active trip', () => setDoc(doc(d1.db, 'orgs', a1.orgId, 'trips', T.id, 'live', d1.uid), { lat: KOL.lat, lon: KOL.lon, acc_m: 5, fix_at: Date.now(), stop: '0', at: serverTimestamp() }));
await denied('driver shares impossible coordinates', () => setDoc(doc(d1.db, 'orgs', a1.orgId, 'trips', T.id, 'live', d1.uid), { lat: 120, lon: KOL.lon, acc_m: 5, fix_at: Date.now(), stop: '0', at: serverTimestamp() }));
await denied('another driver shares location on that trip', () => setDoc(doc(d2.db, 'orgs', a1.orgId, 'trips', T.id, 'live', d2.uid), { lat: KOL.lat, lon: KOL.lon, acc_m: 5, fix_at: Date.now(), stop: '0', at: serverTimestamp() }));
await denied('another driver reads where the driver is', () => getDoc(doc(d2.db, 'orgs', a1.orgId, 'trips', T.id, 'live', d1.uid)));
await allowed('admin sees where the driver is', () => getDoc(doc(a1.db, 'orgs', a1.orgId, 'trips', T.id, 'live', d1.uid)));
await denied('driver changes a stop without writing its event', () => step(d1, T, 0, { state: 'in_transit' }, { event: false }));
await denied('driver changes a stop skipping the counter', () => step(d1, T, 0, { state: 'in_transit' }, { seq: 5 }));
await denied('driver writes an event in someone else\'s name', () => step(d1, T, 0, { state: 'in_transit' }, { by: a1.uid }));
await allowed('driver sets off to a stop (with its event)', () => step(d1, T, 0, { state: 'in_transit' }));
await denied('driver moves the delivery point', () => step(d1, T, 0, { lat: north(500) }));
await denied('driver marks the stop delivered', () => step(d1, T, 0, { state: 'delivered' }));
await denied('driver hands in proof before arriving', () => step(d1, T, 0, { state: 'submitted', claim: { name: 'Ravi', gen: 1, n: 1 } }));
await denied('driver says "verified" without a location', () => step(d1, T, 0, { state: 'arrived', isVerified: true }));
await denied('arrival 500 m away is refused', () => step(d1, T, 0, { state: 'arrived', arrival: fix(500) }));
await denied('arrival with poor accuracy (80 m) is refused', () => step(d1, T, 0, { state: 'arrived', arrival: fix(10, { acc: 80 }) }));
await denied('arrival from a 10-minute-old reading is refused', () => step(d1, T, 0, { state: 'arrived', arrival: fix(10, { ageS: 600 }) }));
await denied('arrival with impossible coordinates is refused', () => step(d1, T, 0, { state: 'arrived', arrival: fix(10, { lat: 95 }) }));
await denied('arrival with one reading when two are needed is refused', () => step(d1, T, 0, { state: 'arrived', arrival: { ...fix(10), readings: 1 } }));
await allowed('driver arrives inside the circle with fresh, precise readings', () => step(d1, T, 0, { state: 'arrived', arrival: fix(20) }));
await allowed('driver sets off to a stop that has no delivery point', () => step(d1, T, 1, { state: 'in_transit' }));
await denied('a stop without a delivery point can never pass the arrival check', () => step(d1, T, 1, { state: 'arrived', arrival: fix(0) }));
await allowed('admin sets the missing point while the driver is on the way', () => step(a1, T, 1, { lat: KOL.lat, lon: KOL.lon, mlon }));
await denied('admin cannot move the point once the driver arrived', () => step(a1, T, 0, { lat: north(300), lon: KOL.lon, mlon }));
await denied('admin change with an old change number is refused', () => step(a1, T, 1, { lat: north(5), lon: KOL.lon, mlon }, { seq: T.s[1].seq }));
await denied('driver hands in proof when no code exists', () => step(d1, T, 0, { state: 'submitted', claim: { name: 'Ravi', gen: 0, n: 1 } }));
await denied('driver makes the recipient code', () => setDoc(doc(stopDoc(d1.db, T.id, '0'), 'code', '1'), { hash: 'x', salt: 'y', expiresAt: Timestamp.fromMillis(Date.now() + 3600e3) }));
const salt = 'a1b2c3', code = '482913';
await allowed('admin makes a recipient code (only its salted hash is stored)', async () => {
  await setDoc(doc(stopDoc(a1.db, T.id, '0'), 'code', '1'), { hash: sha(`${salt}:${code}`), salt, expiresAt: Timestamp.fromMillis(Date.now() + 3600e3), createdAt: serverTimestamp() });
  await step(a1, T, 0, { codeGen: 1 });
});
await denied('driver reads the recipient code', () => getDoc(doc(stopDoc(d1.db, T.id, '0'), 'code', '1')));
const tryDoc = (db, n, c) => setDoc(doc(stopDoc(db, T.id, '0'), 'tries', `1_${n}`), { gen: 1, n, code: c, by: d1.uid, at: serverTimestamp() });
await allowed('driver records a code try (a wrong one)', () => tryDoc(d1.db, 1, '111111'));
await denied('a wrong code does not hand in the proof', () => step(d1, T, 0, { state: 'submitted', claim: { name: 'Ravi', gen: 1, n: 1 } }));
await denied('code tries cannot skip numbers', () => tryDoc(d1.db, 4, code));
await denied('more than 5 code tries are refused', () => tryDoc(d1.db, 6, code));
await denied('a code try cannot be rewritten', () => tryDoc(d1.db, 1, code));
await denied('driver reads the code tries', () => getDoc(doc(stopDoc(d1.db, T.id, '0'), 'tries', '1_1')));
await allowed('driver records a second try with the right code', () => tryDoc(d1.db, 2, code));
await denied('missing recipient name is refused', () => step(d1, T, 0, { state: 'submitted', claim: { name: '', gen: 1, n: 2 } }));
await allowed('right code hands in the proof (checked by the rules)', () => step(d1, T, 0, { state: 'submitted', claim: { name: 'Ravi Patil', gen: 1, n: 2 } }));
await denied('the same proof handed in twice is refused', () => step(d1, T, 0, { state: 'submitted', claim: { name: 'Ravi Patil', gen: 1, n: 2 } }, { seq: T.s[0].seq }));
await denied('driver confirms their own delivery', () => step(d1, T, 0, { state: 'delivered', review: { by: d1.uid, decision: 'confirmed', reason: '' } }));
await denied('another driver confirms the delivery', () => step(d2, T, 0, { state: 'delivered', review: { by: d2.uid, decision: 'confirmed', reason: '' } }));
await denied('admin of another team confirms the delivery', async () => {
  const b = writeBatch(a2.db);
  b.update(doc(a2.db, 'orgs', a1.orgId, 'trips', T.id, 'stops', '0'), { state: 'delivered', seq: T.s[0].seq + 1, updatedAt: serverTimestamp(), review: { by: a2.uid, decision: 'confirmed', reason: '' } });
  await b.commit();
});
await denied('admin refuses a delivery without a reason', () => step(a1, T, 0, { state: 'rejected', review: { by: a1.uid, decision: 'rejected', reason: '' } }));
await allowed('admin refuses a delivery with a reason (recorded)', () => step(a1, T, 0, { state: 'rejected', review: { by: a1.uid, decision: 'rejected', reason: 'Wrong shop' } }));
await allowed('driver tries the refused delivery again', () => step(d1, T, 0, { state: 'in_transit' }));
await allowed('driver arrives again', () => step(d1, T, 0, { state: 'arrived', arrival: fix(15) }));
await allowed('driver hands in the proof again with a new try', async () => { await tryDoc(d1.db, 3, code); await step(d1, T, 0, { state: 'submitted', claim: { name: 'Ravi Patil', gen: 1, n: 3 } }); });
await allowed('admin confirms the delivery', () => step(a1, T, 0, { state: 'delivered', review: { by: a1.uid, decision: 'confirmed', reason: '' } }));
await denied('a confirmed delivery cannot be confirmed again', () => step(a1, T, 0, { state: 'delivered', review: { by: a1.uid, decision: 'confirmed', reason: '' } }));
await denied('a confirmed delivery cannot be cancelled', () => step(a1, T, 0, { state: 'cancelled', review: { by: a1.uid, decision: 'cancelled', reason: 'late' } }));
await denied('driver edits the delivery history', () => setDoc(doc(stopDoc(d1.db, T.id, '0'), 'events', '1'), { seq: 1, state: 'delivered', kind: 'x', by: d1.uid, name: 'x', role: 'driver', at: serverTimestamp() }));
await allowed('driver reads the history of their stop', () => getDocs(collection(stopDoc(d1.db, T.id, '0'), 'events')));
await denied('another driver reads that history', () => getDocs(collection(stopDoc(d2.db, T.id, '0'), 'events')));

let T2;
await allowed('admin sends a second trip (to driver2)', async () => { T2 = await newTrip(d2, [KOL]); });
await allowed('admin moves the delivery point before the driver sets off', () => step(a1, T2, 0, { lat: north(30), lon: KOL.lon, mlon }));
T2.s[0].state = 'assigned';
await allowed('admin gives the trip to driver1', async () => {
  await updateDoc(tripDoc(a1.db, T2.id), { driverUid: d1.uid, driverName: 'driver1' });
  await step(a1, T2, 0, { driverUid: d1.uid });
});
await denied('the old driver can no longer act on it', async () => {
  await updateDoc(tripDoc(d2.db, T2.id), { status: 'loaded', updatedAt: serverTimestamp() });
});
await allowed('the new driver starts it', async () => { await updateDoc(tripDoc(d1.db, T2.id), { status: 'loaded', updatedAt: serverTimestamp() }); await step(d1, T2, 0, { state: 'in_transit' }); });
await allowed('admin moves the point while the driver is on the way', () => step(a1, T2, 0, { lat: north(10), lon: KOL.lon, mlon }));
await denied('admin cancels without a reason', () => step(a1, T2, 0, { state: 'cancelled', review: { by: a1.uid, decision: 'cancelled', reason: '' } }));
await allowed('admin cancels the trip and its stop with a reason', async () => {
  await updateDoc(tripDoc(a1.db, T2.id), { status: 'cancelled' });
  await step(a1, T2, 0, { state: 'cancelled', review: { by: a1.uid, decision: 'cancelled', reason: 'Shop closed today' } });
});
await denied('a cancelled delivery cannot be continued', () => step(d1, T2, 0, { state: 'arrived', arrival: fix(5) }));
await denied('a cancelled trip cannot be restarted by the driver', () => updateDoc(tripDoc(d1.db, T2.id), { status: 'loaded' }));
await denied('arrival rules outside the allowed range are refused', () => updateDoc(doc(a1.db, 'orgs', a1.orgId), { geo: { ...P, radius_m: 5 } }));
await allowed('admin sets the arrival rules', () => updateDoc(doc(a1.db, 'orgs', a1.orgId), { geo: { ...P, radius_m: 150 } }));
await denied('driver changes the arrival rules', () => updateDoc(doc(d1.db, 'orgs', a1.orgId), { geo: P }));

await denied('admin of another team pauses a driver', () => updateDoc(doc(a2.db, 'users', d1.uid), { active: false }));
await allowed('admin pauses their driver', () => updateDoc(doc(a1.db, 'users', d1.uid), { active: false }));
await denied('driver un-pauses themself', () => updateDoc(doc(d1.db, 'users', d1.uid), { active: true }));
await denied('paused driver reads their trips', () => getDocs(query(collection(d1.db, 'orgs', a1.orgId, 'trips'), where('driverUid', '==', d1.uid))));
await denied('paused driver starts a new trip', () => updateDoc(tripDoc(d1.db, T.id), { status: 'loaded' }));
await denied('paused driver hands in a delivery step', () => step(d1, T, 1, { state: 'failed', failReason: 'Shop closed' }));
await denied('paused driver shares location', () => setDoc(doc(d1.db, 'orgs', a1.orgId, 'trips', T.id, 'live', d1.uid), { lat: KOL.lat, lon: KOL.lon, acc_m: 5, fix_at: Date.now(), stop: '1', at: serverTimestamp() }));
await denied('admin sends a trip to a paused driver', () => newTrip(d1, [KOL]));
await denied('paused driver reads the team key', () => getDoc(keyRef(d1.db, a1.orgId)));
await denied('paused driver sends a report', () => addDoc(collection(d1.db, 'orgs', a1.orgId, 'reports'), { driverUid: d1.uid, driverName: 'x', tripId: null, kind: 'k', note: '' }));
await allowed('active driver sends a report', () => addDoc(collection(d2.db, 'orgs', a1.orgId, 'reports'), { driverUid: d2.uid, driverName: 'x', tripId: null, kind: 'k', note: '' }));
await denied('driver sends a report in someone else\'s name', () => addDoc(collection(d2.db, 'orgs', a1.orgId, 'reports'), { driverUid: d1.uid, driverName: 'x', tripId: null, kind: 'k', note: '' }));
await denied('admin of another team reads the team', () => getDoc(doc(a2.db, 'orgs', a1.orgId)));
await denied('admin changes the team code by hand', () => updateDoc(doc(a1.db, 'orgs', a1.orgId), { joinCode: 'ZZZZZZ' }));

await Promise.all(apps.map((a) => deleteApp(a)));
console.log(failed ? `\n${failed} rule check(s) FAILED` : '\nall rule checks passed');
process.exit(failed ? 1 : 0);
