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
  query, serverTimestamp, setDoc, updateDoc, where, writeBatch, type Unsubscribe,
} from 'firebase/firestore';
import { FIREBASE_CONFIG } from './firebase-config';

// Local test runs (npm run smoke) talk to the Firebase emulators, never to the live project.
const emulators = location.hostname === 'localhost' && new URLSearchParams(location.search).has('emulators');
const app = initializeApp(emulators ? { ...FIREBASE_CONFIG, projectId: 'demo-aria', apiKey: 'demo-key' } : FIREBASE_CONFIG);
const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
const db = initializeFirestore(app, emulators ? {} : { localCache: persistentLocalCache() });
if (emulators) {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, 'localhost', 8080);
}

export type Role = 'admin' | 'driver';
export type Profile = { uid: string; name: string; email: string; role: Role; orgId: string; phone?: string; vehicle?: string; active: boolean; lastSeen?: any };
export type Stop = { town_id: string; town: string; units: number; items: { product: string; lot: string; units: number; days_left: number }[]; delivered: boolean };
export type Trip = { id: string; driverUid: string; driverName: string; depot_id: string; depot: string; day: string; dataset: string; planKey: string; units: number; stops: Stop[];
  status: 'assigned' | 'loaded' | 'done'; createdAt?: any; updatedAt?: any };
export type PlanFile = { id: string; driverUid: string; driverName: string; name: string; dataset: string; day: string; units: number; depots: number;
  size: number; parts: number; createdAt?: any; openedAt?: any };
export type Report = { id: string; driverUid: string; driverName: string; tripId: string | null; kind: string; note: string; createdAt?: any };

// ---------- sign in / sign up ----------
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: easy to read out loud
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

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
  if (!/^[A-Z0-9]{6}$/.test(c)) return null;
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
  if (code.includes('code-not-found')) return 'That team code was not found. Ask your admin for the 6-letter code.';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Wrong email or password.';
  if (code.includes('email-already-in-use')) return 'An account with this email already exists. Sign in instead.';
  if (code.includes('weak-password')) return 'Use a password of at least 6 characters.';
  if (code.includes('invalid-email')) return 'That email address does not look right.';
  if (code.includes('too-many-requests')) return 'Too many tries. Wait a minute and try again.';
  if (code.includes('network-request-failed') || code.includes('unavailable')) return 'No internet connection. Connect and try again.';
  if (code.includes('permission-denied')) return 'You do not have access to this.';
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

export const watchTeam = (orgId: string, cb: (t: { name: string; joinCode: string }) => void) =>
  keep((err) => onSnapshot(doc(db, 'orgs', orgId), (s) => s.exists() && cb(s.data() as any), err));

export const watchDrivers = (orgId: string, cb: (ds: Profile[]) => void) =>
  keep((err) => onSnapshot(query(collection(db, 'users'), where('orgId', '==', orgId), where('role', '==', 'driver')),
    (s) => cb(s.docs.map((d) => ({ uid: d.id, ...d.data() }) as Profile).sort((a, b) => a.name.localeCompare(b.name))), err));

export const setDriverActive = (uid: string, active: boolean) => updateDoc(doc(db, 'users', uid), { active });
export const updateMyDetails = (uid: string, patch: { name?: string; phone?: string; vehicle?: string }) => updateDoc(doc(db, 'users', uid), patch);

// ---------- trips ----------
export async function sendTrips(orgId: string, trips: Omit<Trip, 'id'>[]) {
  const batch = writeBatch(db);
  for (const t of trips) batch.set(doc(collection(db, 'orgs', orgId, 'trips')), { ...t, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  await batch.commit();
}

export const watchTrips = (orgId: string, driverUid: string | null, cb: (ts: Trip[]) => void) =>
  keep((err) => onSnapshot(query(collection(db, 'orgs', orgId, 'trips'), ...(driverUid ? [where('driverUid', '==', driverUid)] : []), orderBy('createdAt', 'desc')),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Trip)), err));

export const updateTrip = (orgId: string, id: string, patch: Partial<Pick<Trip, 'status' | 'stops'>>) =>
  updateDoc(doc(db, 'orgs', orgId, 'trips', id), { ...patch, updatedAt: serverTimestamp() });

export const deleteTrip = (orgId: string, id: string) => deleteDoc(doc(db, 'orgs', orgId, 'trips', id));

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
