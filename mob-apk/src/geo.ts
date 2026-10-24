// The phone's location for GeoProof deliveries: permission, a watch while a delivery is on its way, and one-off reads.
// Foreground only: Android and iOS may pause it when ARIA is in the background or the screen is off, and the
// driver screen then shows the last reading as old instead of live. Nothing here runs unless a delivery started it.
import { Geolocation, type Position } from '@capacitor/geolocation';
import type { Fix } from './geofence';
import { isNative } from './native';

export type Perm = 'granted' | 'denied' | 'prompt';
export type GeoError = '' | 'denied' | 'off' | 'timeout' | 'unavailable';
export const STALE_MS = 60_000; // a reading older than this is shown as the last known position, not live

export const track = {
  on: false,
  perm: 'prompt' as Perm,
  error: '' as GeoError,
  fixes: [] as Fix[], // newest last, at most 30
};

let watchId: string | null = null;
let listener: () => void = () => {};

const toFix = (p: Position): Fix => ({ lat: p.coords.latitude, lon: p.coords.longitude, acc_m: p.coords.accuracy, fix_at: Math.round(p.timestamp) });

function errorKind(e: any): GeoError {
  const m = `${e?.code ?? ''} ${e?.message ?? e ?? ''}`.toLowerCase();
  if (e?.code === 1 || /denied|permission/.test(m)) return 'denied';
  if (e?.code === 3 || /timeout|timed out/.test(m)) return 'timeout';
  if (/disabled|not enabled|services|turned off/.test(m)) return 'off';
  return 'unavailable';
}

function add(f: Fix) {
  const last = track.fixes[track.fixes.length - 1];
  if (last && last.fix_at === f.fix_at && last.lat === f.lat && last.lon === f.lon) return; // the same reading again
  track.fixes.push(f);
  if (track.fixes.length > 30) track.fixes.shift();
  track.error = '';
  listener();
}

export async function permission(): Promise<Perm> {
  try {
    if (!isNative) {
      const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
      track.perm = p ? (p.state as Perm) : 'prompt';
    } else {
      const p = await Geolocation.checkPermissions();
      track.perm = p.location === 'granted' ? 'granted' : p.location === 'denied' ? 'denied' : 'prompt';
    }
  } catch (e) {
    if (errorKind(e) === 'off') track.error = 'off';
  }
  return track.perm;
}

/** Ask for location access (after the driver has read why). */
export async function askPermission(): Promise<Perm> {
  try {
    if (isNative) {
      const p = await Geolocation.requestPermissions({ permissions: ['location'] });
      track.perm = p.location === 'granted' ? 'granted' : p.location === 'denied' ? 'denied' : 'prompt';
    } else {
      await readOnce(); // browsers ask on first use
      track.perm = 'granted';
    }
  } catch (e) {
    const k = errorKind(e);
    if (k === 'denied') track.perm = 'denied'; else track.error = k;
  }
  listener();
  return track.perm;
}

/** One fresh reading ("Check location again"). */
export async function readOnce(): Promise<Fix | null> {
  try {
    const f = toFix(await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }));
    add(f);
    return f;
  } catch (e) {
    track.error = errorKind(e);
    if (track.error === 'denied') track.perm = 'denied';
    listener();
    return null;
  }
}

/** Follow the phone's position; `onChange` runs on every reading or error. Safe to call again. */
export async function startTracking(onChange: () => void) {
  listener = onChange;
  if (watchId) return;
  track.on = true;
  try {
    watchId = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 30_000, maximumAge: 0 }, (p, err) => {
      if (p) add(toFix(p));
      else if (err) { track.error = errorKind(err); if (track.error === 'denied') track.perm = 'denied'; listener(); }
    });
  } catch (e) {
    track.on = false;
    track.error = errorKind(e);
  }
  listener();
}

/** Stop following the phone and forget the readings. */
export async function stopTracking() {
  const id = watchId;
  watchId = null;
  track.on = false;
  track.fixes = [];
  if (id) await Geolocation.clearWatch({ id }).catch(() => {});
}

export const lastFix = () => track.fixes[track.fixes.length - 1] ?? null;
