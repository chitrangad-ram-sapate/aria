// Locked plan files. A .svcr file carries the whole dataset (stock, prices, demand), so every file that leaves the
// app is locked with the team's key: AES-256-GCM over the gzipped file, behind a one-line header. Outside the app it
// is unreadable; inside, any signed-in member of the same team opens it. The key lives in orgs/{org}/secret/key,
// readable only by the team (firestore.rules), and is kept on the phone after the first use so files open offline.
//
// Layout: "ARIA-LOCKED/1 team=<orgId>\n" + 12-byte IV + ciphertext (the header is bound in as associated data).
import { getTeamKey } from './cloud';

const MAGIC = 'ARIA-LOCKED/1';
const CACHE = 'aria.teamkey.';

export class LockedError extends Error {}

const pipe = async (b: Uint8Array, t: CompressionStream | DecompressionStream) =>
  new Uint8Array(await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(t)).arrayBuffer());

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFor(orgId: string, create: boolean, fresh = false): Promise<CryptoKey> {
  let raw: string | null = null;
  try { raw = fresh ? null : localStorage.getItem(CACHE + orgId); } catch { /* storage blocked: fetch it again */ }
  if (!raw) {
    raw = await getTeamKey(orgId, create ? () => toB64(crypto.getRandomValues(new Uint8Array(32))) : null);
    if (!raw) throw new LockedError('no-key');
    try { localStorage.setItem(CACHE + orgId, raw); } catch { /* kept for this session only */ }
  }
  return crypto.subtle.importKey('raw', fromB64(raw) as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export const isLocked = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) === MAGIC;

/** Lock a plan file for the admin's team. */
export async function lockPlan(bytes: Uint8Array, orgId: string): Promise<Uint8Array> {
  const key = await keyFor(orgId, true);
  const header = new TextEncoder().encode(`${MAGIC} team=${orgId}\n`);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const z = await pipe(bytes, new CompressionStream('gzip'));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, z as Uint8Array<ArrayBuffer>));
  const out = new Uint8Array(header.length + iv.length + ct.length);
  out.set(header);
  out.set(iv, header.length);
  out.set(ct, header.length + iv.length);
  return out;
}

/**
 * The plain plan file inside `bytes`. Files made before locking existed pass through unchanged.
 * Throws LockedError with a plain message when this account cannot open it.
 */
export async function unlockPlan(bytes: Uint8Array, orgId: string | null | undefined): Promise<Uint8Array> {
  if (!isLocked(bytes)) return bytes;
  const nl = bytes.indexOf(10);
  const team = nl > 0 ? /team=(\S+)/.exec(new TextDecoder().decode(bytes.subarray(0, nl)))?.[1] : null;
  if (!team) throw new LockedError('This plan file is damaged.');
  if (!orgId) throw new LockedError('Sign in to open this plan file.');
  if (team !== orgId) throw new LockedError('This plan file belongs to another team. Only that team can open it.');
  let key: CryptoKey;
  try {
    key = await keyFor(orgId, false);
  } catch {
    throw new LockedError('Connect to the internet once to open locked plan files on this phone.');
  }
  const open = async (k: CryptoKey) => {
    const z = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(nl + 1, nl + 13) as Uint8Array<ArrayBuffer>, additionalData: bytes.subarray(0, nl + 1) as Uint8Array<ArrayBuffer> },
      k, bytes.subarray(nl + 13) as Uint8Array<ArrayBuffer>);
    return pipe(new Uint8Array(z), new DecompressionStream('gzip'));
  };
  try {
    return await open(key);
  } catch { /* maybe the key kept on this phone is out of date: try the team's key once more */ }
  try {
    return await open(await keyFor(orgId, false, true));
  } catch {
    throw new LockedError('The file was changed or damaged after it was made.');
  }
}
