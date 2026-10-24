// Checks firestore.rules against the emulators by trying what a curious or careless user might try.
// Covers accounts, trips, reports, plan files and the team key that locks plan files.
// Usage: start the emulators (npx firebase-tools emulators:start --only auth,firestore --project demo-aria), then
//   node scripts/rules-test.mjs
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from 'firebase/auth';
import {
  addDoc, Bytes, collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, getFirestore, query, serverTimestamp,
  setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';

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
  return { ...p, orgId: org.id };
}

async function driver(label, code, orgId) {
  const p = await person(label);
  await setDoc(doc(p.db, 'users', p.uid), { name: label, email: 'x', role: 'driver', orgId, joinCode: code, active: true });
  return { ...p, orgId };
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
await denied('admin of another team pauses a driver', () => updateDoc(doc(a2.db, 'users', d1.uid), { active: false }));
await allowed('admin pauses their driver', () => updateDoc(doc(a1.db, 'users', d1.uid), { active: false }));
await denied('driver un-pauses themself', () => updateDoc(doc(d1.db, 'users', d1.uid), { active: true }));
await denied('paused driver reads their trips', () => getDocs(query(collection(d1.db, 'orgs', a1.orgId, 'trips'), where('driverUid', '==', d1.uid))));
await denied('paused driver reads the team key', () => getDoc(keyRef(d1.db, a1.orgId)));
await denied('paused driver sends a report', () => addDoc(collection(d1.db, 'orgs', a1.orgId, 'reports'), { driverUid: d1.uid, driverName: 'x', tripId: null, kind: 'k', note: '' }));
await allowed('active driver sends a report', () => addDoc(collection(d2.db, 'orgs', a1.orgId, 'reports'), { driverUid: d2.uid, driverName: 'x', tripId: null, kind: 'k', note: '' }));
await denied('driver sends a report in someone else\'s name', () => addDoc(collection(d2.db, 'orgs', a1.orgId, 'reports'), { driverUid: d1.uid, driverName: 'x', tripId: null, kind: 'k', note: '' }));
await denied('admin of another team reads the team', () => getDoc(doc(a2.db, 'orgs', a1.orgId)));
await denied('admin changes the team code by hand', () => updateDoc(doc(a1.db, 'orgs', a1.orgId), { joinCode: 'ZZZZZZ' }));

await Promise.all(apps.map((a) => deleteApp(a)));
console.log(failed ? `\n${failed} rule check(s) FAILED` : '\nall rule checks passed');
process.exit(failed ? 1 : 0);
