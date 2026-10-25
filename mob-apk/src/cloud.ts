// Accounts and team data (Firebase Auth + Firestore, Spark plan). Planning stays on the device; only people,
// trips and driver reports are shared. Roles: an admin owns a team and sees every driver in it; a driver joins
// a team with its code and sees only the trips sent to them. Firestore rules (firestore.rules) enforce this.
import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence, connectAuthEmulator, createUserWithEmailAndPassword, indexedDBLocalPersistence, initializeAuth,
  onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut, updateProfile, type User,
} from 'firebase/auth';
import {
  addDoc, Bytes, collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, initializeFirestore, onSnapshot, orderBy, persistentLocalCache,
  query, serverTimestamp, setDoc, Timestamp, updateDoc, where, writeBatch, type Unsubscribe,
} from 'firebase/firestore';
import { EMULATORS, FIREBASE_CONFIG, SHOP_CODE, TEAM_CODE } from './config';

// Local test runs (npm run smoke) talk to the Firebase emulators, never to the live project.
const emulators = location.hostname === EMULATORS.host && new URLSearchParams(location.search).has('emulators');
const app = initializeApp(emulators ? { ...FIREBASE_CONFIG, projectId: EMULATORS.projectId, apiKey: 'demo-key' } : FIREBASE_CONFIG);
const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
const db = initializeFirestore(app, emulators ? {} : { localCache: persistentLocalCache() });
if (emulators) {
  connectAuthEmulator(auth, `http://${EMULATORS.host}:${EMULATORS.authPort}`, { disableWarnings: true });
  connectFirestoreEmulator(db, EMULATORS.host, EMULATORS.firestorePort);
}

export type Role = 'admin' | 'driver';
export type Profile = { uid: string; name: string; email: string; role: Role; orgId: string; phone?: string; vehicle?: string; active: boolean; lastSeen?: any };
export type Stop = { town_id: string; town: string; units: number; items: { product: string; lot: string; units: number; days_left: number }[]; delivered: boolean };
export type Trip = { id: string; driverUid: string; driverName: string; depot_id: string; depot: string; day: string; dataset: string; planKey: string; units: number; stops: Stop[];
  status: 'assigned' | 'loaded' | 'done' | 'cancelled'; createdAt?: any; updatedAt?: any };
export type PlanFile = { id: string; driverUid: string; driverName: string; name: string; dataset: string; day: string; units: number; depots: number;
  size: number; parts: number; createdAt?: any; openedAt?: any };
export type Report = { id: string; driverUid: string; driverName: string; tripId: string | null; kind: string; note: string; createdAt?: any };

// ---------- sign in / sign up ----------
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(TEAM_CODE.length)), (b) => TEAM_CODE.chars[b % TEAM_CODE.chars.length]).join('');

export async function signUpAdmin(name: string, email: string, password: string, teamName: string) {
  const { user } = await createUserWithEmailAndPassword(auth, email.trim(), password);
  await updateProfile(user, { displayName: name });
  const org = doc(collection(db, 'orgs'));
  let code = newCode();
  for (let i = 0; i < 5 && (await getDoc(doc(db, 'joinCodes', code))).exists(); i++) code = newCode();
  const batch = writeBatch(db);
  batch.set(org, { name: teamName.trim(), ownerUid: user.uid, joinCode: code, createdAt: serverTimestamp() });
  batch.set(doc(db, 'joinCodes', code), { orgId: org.id, ownerUid: user.uid, team: teamName.trim() });
  batch.set(doc(db, 'users', user.uid), { name: name.trim(), email: user.email, role: 'admin', orgId: org.id, active: true, createdAt: serverTimestamp(), lastSeen: serverTimestamp() });
  await batch.commit();
}

/** Team name for a join code, checked before the driver's account is created. */
export async function lookupCode(code: string): Promise<{ orgId: string; team: string } | null> {
  const c = code.trim().toUpperCase();
  if (c.length !== TEAM_CODE.length || !/^[A-Z0-9]+$/.test(c)) return null;
  const snap = await getDoc(doc(db, 'joinCodes', c));
  if (!snap.exists()) return null;
  return { orgId: snap.data().orgId, team: snap.data().team ?? '' };
}

export async function signUpDriver(name: string, email: string, password: string, code: string, phone: string, vehicle: string) {
  const c = code.trim().toUpperCase();
  const found = await lookupCode(c);
  if (!found) throw new Error('code-not-found');
  const { user } = await createUserWithEmailAndPassword(auth, email.trim(), password);
  await updateProfile(user, { displayName: name });
  await setDoc(doc(db, 'users', user.uid), { name: name.trim(), email: user.email, role: 'driver', orgId: found.orgId, joinCode: c, phone: phone.trim(), vehicle: vehicle.trim(),
    active: true, createdAt: serverTimestamp(), lastSeen: serverTimestamp() });
}

export const signIn = (email: string, password: string) => signInWithEmailAndPassword(auth, email.trim(), password);
export const logOut = () => signOut(auth);
export const resetPassword = (email: string) => sendPasswordResetEmail(auth, email.trim());

/** Signed-in user's profile, live (an admin pausing a driver takes effect at once). null = signed out. */
export function watchProfile(cb: (p: Profile | null, user: User | null) => void): Unsubscribe {
  let stopDoc: Unsubscribe | null = null;
  const stopAuth = onAuthStateChanged(auth, (user) => {
    stopDoc?.();
    stopDoc = null;
    if (!user) return cb(null, null);
    let touched = false;
    stopDoc = onSnapshot(doc(db, 'users', user.uid), (snap) => {
      if (!snap.exists()) return cb(null, user); // account made but profile not written yet (sign-up in progress)
      const p = { uid: user.uid, ...snap.data() } as Profile;
      if (!touched) { touched = true; updateDoc(snap.ref, { lastSeen: serverTimestamp() }).catch(() => {}); }
      cb(p, user);
    }, () => { user.reload().then(() => cb(null, user), () => signOut(auth)); }); // a deleted account goes back to sign-in
  });
  return () => { stopDoc?.(); stopAuth(); };
}

/** Plain words for Firebase errors. */
export function errorText(e: any): string {
  const code = String(e?.code ?? e?.message ?? '');
  if (code.includes('code-not-found')) return 'That team code was not found. Ask your admin for the team code.';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Wrong email or password.';
  if (code.includes('email-already-in-use')) return 'An account with this email already exists. Sign in instead.';
  if (code.includes('weak-password')) return 'Use a password of at least 6 characters.';
  if (code.includes('invalid-email')) return 'That email address does not look right.';
  if (code.includes('too-many-requests')) return 'Too many tries. Wait a minute and try again.';
  if (code.includes('network-request-failed') || code.includes('unavailable')) return 'No internet connection. Connect and try again.';
  if (code.includes('permission-denied')) return 'You do not have access to this.';
  if (code.includes('no-key')) return 'Could not get your team\'s lock key. Connect to the internet and try again.';
  if (code.includes('file-incomplete')) return 'The file did not arrive in full. Ask your admin to send it again.';
  return 'Something went wrong. Please try again.';
}

// ---------- team ----------
/** A live query that starts again after an error (a brand-new account is not on the server yet for a moment,
 * and Firestore ends a listener for good on its first error). */
function keep(start: (onError: (e: unknown) => void) => Unsubscribe): Unsubscribe {
  let stop: Unsubscribe = () => {};
  let timer = 0;
  let closed = false;
  const go = (delay: number) => {
    stop = start(() => {
      if (closed) return;
      timer = window.setTimeout(() => go(Math.min(delay * 2, 30000)), delay);
    });
  };
  go(1000);
  return () => { closed = true; clearTimeout(timer); stop(); };
}

export const watchTeam = (orgId: string, cb: (t: { name: string; joinCode: string; geo?: Policy }) => void) =>
  keep((err) => onSnapshot(doc(db, 'orgs', orgId), (s) => s.exists() && cb(s.data() as any), err));

export const watchDrivers = (orgId: string, cb: (ds: Profile[]) => void) =>
  keep((err) => onSnapshot(query(collection(db, 'users'), where('orgId', '==', orgId), where('role', '==', 'driver')),
    (s) => cb(s.docs.map((d) => ({ uid: d.id, ...d.data() }) as Profile).sort((a, b) => a.name.localeCompare(b.name))), err));

export const setDriverActive = (uid: string, active: boolean) => updateDoc(doc(db, 'users', uid), { active });
export const updateMyDetails = (uid: string, patch: { name?: string; phone?: string; vehicle?: string }) => updateDoc(doc(db, 'users', uid), patch);

// ---------- trips ----------

export const watchTrips = (orgId: string, driverUid: string | null, cb: (ts: Trip[]) => void) =>
  keep((err) => onSnapshot(query(collection(db, 'orgs', orgId, 'trips'), ...(driverUid ? [where('driverUid', '==', driverUid)] : []), orderBy('createdAt', 'desc')),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Trip)), err));

export const updateTrip = (orgId: string, id: string, patch: Partial<Pick<Trip, 'status' | 'stops'>>) =>
  updateDoc(doc(db, 'orgs', orgId, 'trips', id), { ...patch, updatedAt: serverTimestamp() });

// ---------- GeoProof: delivery stops (D-045) ----------
// Each stop of a trip has its own record under orgs/{org}/trips/{trip}/stops/{i}: the approved delivery point, the
// arrival rules, its state and a counter. Every change writes the numbered event with it (firestore.rules checks both).
export type Policy = { radius_m: number; max_accuracy_m: number; max_age_s: number; readings: number };
export const DEFAULT_POLICY: Policy = { radius_m: 100, max_accuracy_m: 50, max_age_s: 15, readings: 2 };
export type StopState = 'assigned' | 'in_transit' | 'arrived' | 'submitted' | 'delivered' | 'rejected' | 'failed' | 'cancelled';
export type Fix = { lat: number; lon: number; acc_m: number; fix_at: number };
export type DeliveryStop = {
  id: string; tripId: string; i: number; driverUid: string; town_id: string; town: string; depot_id: string;
  lat: number | null; lon: number | null; mlon: number | null; policy: Policy; state: StopState; seq: number; codeGen: number;
  createdAt?: any; updatedAt?: any; startedAt?: any;
  arrival?: Fix & { dist_m: number; readings: number };
  claim?: { name: string; gen: number; n: number };
  review?: { by: string; decision: string; reason: string };
  failReason?: string;
  pending?: boolean; // the last change is on this phone and not yet accepted by the server
};
export type StopEvent = { seq: number; state: StopState; kind: string; by: string; name: string; role: string; at?: any; note?: string };
export type LiveFix = Fix & { at?: any; stop: string };
export const OPEN_STATES: StopState[] = ['assigned', 'in_transit', 'arrived', 'submitted', 'rejected', 'failed'];

/** Metres per degree of longitude at a latitude (the rules use it to check the arrival radius without trigonometry). */
export const metresPerDegLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

const stopRef = (orgId: string, s: Pick<DeliveryStop, 'tripId' | 'id'>) => doc(db, 'orgs', orgId, 'trips', s.tripId, 'stops', s.id);

/** Send trips, each with its stop records. One write batch per trip. */
export async function sendTrips(orgId: string, trips: Omit<Trip, 'id'>[], point: (town_id: string) => { lat: number; lon: number } | null, policy: Policy) {
  for (const t of trips) {
    const batch = writeBatch(db);
    const ref = doc(collection(db, 'orgs', orgId, 'trips'));
    batch.set(ref, { ...t, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    t.stops.forEach((s, i) => {
      const p = point(s.town_id);
      batch.set(doc(ref, 'stops', String(i)), { tripId: ref.id, i, driverUid: t.driverUid, town_id: s.town_id, town: s.town, depot_id: t.depot_id,
        lat: p?.lat ?? null, lon: p?.lon ?? null, mlon: p ? metresPerDegLon(p.lat) : null, policy, state: 'assigned', seq: 0, codeGen: 0,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    await batch.commit();
  }
}

/** Change a stop and write its numbered event in the same batch (plus any `extra` writes). Fails if someone else changed it first. */
export async function stepStop(orgId: string, s: DeliveryStop, patch: Partial<DeliveryStop>, kind: string, me: Profile, note?: string,
  extra?: (b: ReturnType<typeof writeBatch>) => void) {
  const seq = s.seq + 1;
  const batch = writeBatch(db);
  extra?.(batch);
  const { pending: _p, id: _i, ...clean } = patch as any;
  batch.update(stopRef(orgId, s), { ...clean, seq, updatedAt: serverTimestamp() });
  batch.set(doc(stopRef(orgId, s), 'events', String(seq)), { seq, state: patch.state ?? s.state, kind, by: me.uid, name: me.name, role: me.role, at: serverTimestamp(),
    ...(note ? { note } : {}) });
  await batch.commit();
}

export const watchStops = (orgId: string, tripId: string, driverUid: string | null, cb: (ss: DeliveryStop[]) => void) =>
  keep((err) => onSnapshot(query(collection(db, 'orgs', orgId, 'trips', tripId, 'stops'), ...(driverUid ? [where('driverUid', '==', driverUid)] : [])),
    { includeMetadataChanges: true },
    (q) => cb(q.docs.map((d) => ({ ...d.data(), id: d.id, pending: d.metadata.hasPendingWrites }) as DeliveryStop).sort((a, b) => a.i - b.i)), err));

export const loadEvents = async (orgId: string, s: DeliveryStop) =>
  (await getDocs(query(collection(stopRef(orgId, s), 'events'), orderBy('seq')))).docs.map((d) => d.data() as StopEvent);

/** The driver's latest position on an active trip (one document, overwritten). */
export const sendLive = (orgId: string, tripId: string, uid: string, f: Fix, stop: string) =>
  setDoc(doc(db, 'orgs', orgId, 'trips', tripId, 'live', uid), { lat: f.lat, lon: f.lon, acc_m: f.acc_m, fix_at: f.fix_at, stop, at: serverTimestamp() });
export const clearLive = (orgId: string, tripId: string, uid: string) => deleteDoc(doc(db, 'orgs', orgId, 'trips', tripId, 'live', uid));
export const watchLive = (orgId: string, tripId: string, cb: (fs: (LiveFix & { uid: string })[]) => void) =>
  keep((err) => onSnapshot(collection(db, 'orgs', orgId, 'trips', tripId, 'live'), (q) => cb(q.docs.map((d) => ({ ...(d.data() as LiveFix), uid: d.id }))), err));

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Admin: a new recipient code for a stop (SHOP_CODE: digits, hours valid). Only its salted hash is stored; the code is returned once. */
export async function makeCode(orgId: string, s: DeliveryStop, me: Profile): Promise<string> {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10 ** SHOP_CODE.digits).padStart(SHOP_CODE.digits, '0');
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${code}`)));
  const gen = s.codeGen + 1;
  // one batch: a code saved without its step would block that number for good (codes can only be created)
  await stepStop(orgId, s, { codeGen: gen }, 'code', me, undefined, (b) =>
    b.set(doc(stopRef(orgId, s), 'code', String(gen)), { hash, salt, expiresAt: Timestamp.fromMillis(Date.now() + SHOP_CODE.validHours * 3600_000), createdAt: serverTimestamp() }));
  return code;
}

/**
 * Driver: hand in the recipient's code and name. Each try is recorded first (at most SHOP_CODE.maxTries per code), then the stop moves
 * to "submitted" only if the database rules find the code matches. → 'ok' | 'wrong' | 'no-tries' | 'no-code'.
 */
export async function submitProof(orgId: string, s: DeliveryStop, code: string, name: string, me: Profile): Promise<'ok' | 'wrong' | 'no-tries' | 'no-code'> {
  if (!s.codeGen) return 'no-code';
  const key = `aria.try.${s.tripId}.${s.id}.${s.codeGen}`;
  let n = 1;
  try { n = Math.max(1, Number(localStorage.getItem(key) || '1')); } catch { /* start at 1 */ }
  for (; n <= SHOP_CODE.maxTries; n++) {
    try {
      await setDoc(doc(stopRef(orgId, s), 'tries', `${s.codeGen}_${n}`), { gen: s.codeGen, n, code, by: me.uid, at: serverTimestamp() });
      break;
    } catch (e: any) {
      if (!String(e?.code).includes('permission-denied')) throw e; // offline or other: let the caller say so
    }
  }
  try { localStorage.setItem(key, String(n + 1)); } catch { /* counted on the server anyway */ }
  if (n > SHOP_CODE.maxTries) return 'no-tries';
  try {
    await stepStop(orgId, s, { state: 'submitted', claim: { name, gen: s.codeGen, n } }, 'proof', me);
    return 'ok';
  } catch (e: any) {
    if (String(e?.code).includes('permission-denied')) return n >= SHOP_CODE.maxTries ? 'no-tries' : 'wrong';
    throw e;
  }
}

/** Admin review of a submitted delivery. A confirmation also ticks the stop on the trip, and finishes the trip when all are in. */
export async function reviewStop(orgId: string, t: Trip, s: DeliveryStop, ok: boolean, reason: string, me: Profile, all: DeliveryStop[]) {
  await stepStop(orgId, s, { state: ok ? 'delivered' : 'rejected', review: { by: me.uid, decision: ok ? 'confirmed' : 'rejected', reason } }, ok ? 'confirmed' : 'rejected', me, reason || undefined);
  if (!ok) return;
  const stops = t.stops.map((x, i) => (i === s.i ? { ...x, delivered: true } : x));
  const finished = all.every((x) => x.id === s.id || x.state === 'delivered' || x.state === 'cancelled' || x.state === 'failed');
  await updateDoc(doc(db, 'orgs', orgId, 'trips', t.id), { stops, ...(finished ? { status: 'done' } : {}), updatedAt: serverTimestamp() });
  if (finished) await clearLive(orgId, t.id, t.driverUid).catch(() => {});
}

/** Admin: stop a trip. The driver can no longer act on it; every open stop is closed with the reason. */
export async function cancelTrip(orgId: string, t: Trip, all: DeliveryStop[], reason: string, me: Profile) {
  await updateDoc(doc(db, 'orgs', orgId, 'trips', t.id), { status: 'cancelled', updatedAt: serverTimestamp() });
  for (const s of all.filter((x) => OPEN_STATES.includes(x.state))) await stepStop(orgId, s, { state: 'cancelled', review: { by: me.uid, decision: 'cancelled', reason } }, 'cancelled', me, reason);
  await clearLive(orgId, t.id, t.driverUid).catch(() => {});
}

/** Admin: give a trip to another driver. The old driver loses access to it at once. */
export async function reassignTrip(orgId: string, t: Trip, all: DeliveryStop[], to: Profile, me: Profile) {
  await updateDoc(doc(db, 'orgs', orgId, 'trips', t.id), { driverUid: to.uid, driverName: to.name, updatedAt: serverTimestamp() });
  for (const s of all.filter((x) => OPEN_STATES.includes(x.state))) await stepStop(orgId, s, { driverUid: to.uid }, 'reassigned', me, `Given to ${to.name}`);
  await clearLive(orgId, t.id, t.driverUid).catch(() => {});
}

/** Admin: set the delivery point of a stop before the driver sets off. */
export const setStopPoint = (orgId: string, s: DeliveryStop, lat: number, lon: number, me: Profile) =>
  stepStop(orgId, s, { lat, lon, mlon: metresPerDegLon(lat) }, 'point', me, `${lat.toFixed(5)}, ${lon.toFixed(5)}`);

export const setPolicy = (orgId: string, geo: Policy) => updateDoc(doc(db, 'orgs', orgId), { geo });

/** Remove a trip with everything under it. */
export async function deleteTrip(orgId: string, id: string) {
  const tripRef = doc(db, 'orgs', orgId, 'trips', id);
  for (const s of (await getDocs(collection(tripRef, 'stops'))).docs) {
    for (const sub of ['events', 'code', 'tries']) for (const d of (await getDocs(collection(s.ref, sub))).docs) await deleteDoc(d.ref);
    await deleteDoc(s.ref);
  }
  for (const d of (await getDocs(collection(tripRef, 'live'))).docs) await deleteDoc(d.ref);
  await deleteDoc(tripRef);
}

// ---------- reports from drivers ----------
export const sendReport = (orgId: string, r: Omit<Report, 'id' | 'createdAt'>) =>
  addDoc(collection(db, 'orgs', orgId, 'reports'), { ...r, createdAt: serverTimestamp() });

export const watchReports = (orgId: string, driverUid: string | null, cb: (rs: Report[]) => void) =>
  keep((err) => onSnapshot(query(collection(db, 'orgs', orgId, 'reports'), ...(driverUid ? [where('driverUid', '==', driverUid)] : []), orderBy('createdAt', 'desc')),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Report)), err));

// ---------- the team's key for locked plan files (seal.ts) ----------
/** The team key (base64). The admin creates it the first time with `make`; drivers can only read it. */
export async function getTeamKey(orgId: string, make: (() => string) | null): Promise<string | null> {
  const ref = doc(db, 'orgs', orgId, 'secret', 'key');
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data().k;
  if (!make) return null;
  try {
    await setDoc(ref, { k: make() });
  } catch { /* another phone made it first: read theirs */ }
  return (await getDoc(ref)).data()?.k ?? null;
}

// ---------- plan files (.svcr) sent to drivers ----------
// A plan file is about 1 MB (it carries the whole dataset); gzip brings it near 120 KB. It is stored in Firestore
// (Storage is not on the free plan for new projects) in pieces under the 1 MiB document limit.
const PART = 700_000;
const pipe = async (b: Uint8Array, t: CompressionStream | DecompressionStream) =>
  new Uint8Array(await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(t)).arrayBuffer());

export async function sendPlanFile(orgId: string, drivers: { uid: string; name: string }[], name: string, bytes: Uint8Array,
  meta: { dataset: string; day: string; units: number; depots: number }) {
  const z = await pipe(bytes, new CompressionStream('gzip'));
  const parts = Math.max(1, Math.ceil(z.length / PART));
  const batch = writeBatch(db);
  for (const d of drivers) {
    const ref = doc(collection(db, 'orgs', orgId, 'files'));
    batch.set(ref, { driverUid: d.uid, driverName: d.name, name, ...meta, size: bytes.length, parts, createdAt: serverTimestamp() });
    for (let i = 0; i < parts; i++) batch.set(doc(ref, 'parts', String(i)), { i, data: Bytes.fromUint8Array(z.subarray(i * PART, (i + 1) * PART)) });
  }
  await batch.commit();
}

export const watchFiles = (orgId: string, driverUid: string | null, cb: (fs: PlanFile[]) => void) =>
  keep((err) => onSnapshot(query(collection(db, 'orgs', orgId, 'files'), ...(driverUid ? [where('driverUid', '==', driverUid)] : []), orderBy('createdAt', 'desc')),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }) as PlanFile)), err));

/** The file's original bytes, as the admin's phone made them. */
export async function loadPlanFile(orgId: string, f: PlanFile): Promise<Uint8Array> {
  const snap = await getDocs(query(collection(db, 'orgs', orgId, 'files', f.id, 'parts'), orderBy('i')));
  if (snap.size !== f.parts) throw new Error('file-incomplete');
  const chunks = snap.docs.map((d) => (d.data().data as Bytes).toUint8Array());
  const z = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { z.set(c, at); at += c.length; }
  return pipe(z, new DecompressionStream('gzip'));
}

export const markOpened = (orgId: string, id: string) => updateDoc(doc(db, 'orgs', orgId, 'files', id), { openedAt: serverTimestamp() });

export async function deletePlanFile(orgId: string, f: PlanFile) {
  const batch = writeBatch(db);
  for (let i = 0; i < f.parts; i++) batch.delete(doc(db, 'orgs', orgId, 'files', f.id, 'parts', String(i)));
  batch.delete(doc(db, 'orgs', orgId, 'files', f.id));
  await batch.commit();
}

export const when = (ts: any) => (ts?.toDate ? ts.toDate().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'just now');
