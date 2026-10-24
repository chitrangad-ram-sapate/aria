// Arrival check for one delivery stop (GeoProof, D-045). Pure: no app state, so it is tested on its own
// (scripts/geofence-test.mjs). The phone runs it to decide when "Delivered" may unlock; firestore.rules repeats the
// radius, accuracy, age and reading-count checks on the arrival it is sent. Neither can prove the phone is honest
// about where it is: GPS comes from the device, so the admin still confirms each delivery.

export type Fix = { lat: number; lon: number; acc_m: number; fix_at: number };
export type Policy = { radius_m: number; max_accuracy_m: number; max_age_s: number; readings: number };
export type Outcome =
  | 'ACCOUNT_NOT_ACTIVE' | 'TRIP_NOT_ASSIGNED' | 'TRIP_NOT_ACTIVE' | 'DESTINATION_NOT_CONFIGURED' | 'GPS_PERMISSION_REQUIRED'
  | 'LOCATION_UNAVAILABLE' | 'INVALID_LOCATION' | 'LOCATION_TOO_OLD' | 'GPS_ACCURACY_TOO_LOW' | 'OUTSIDE_DESTINATION_RADIUS'
  | 'ARRIVAL_CHECKING' | 'ARRIVAL_VERIFIED';

export type Check = {
  outcome: Outcome;
  distance_m: number | null; // from the newest usable reading to the delivery point
  good: number; // consecutive good readings so far
  need: number;
  fix: Fix | null; // the newest reading the result is based on
};

const R = 6371008.8; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The flat distance firestore.rules computes (it has no trigonometry); used so the phone never passes what the rules refuse. */
export function rulesDistanceM(p: { lat: number; lon: number }, dest: { lat: number; lon: number; mlon: number }): number {
  const dy = (p.lat - dest.lat) * 110574, dx = (p.lon - dest.lon) * dest.mlon;
  return Math.sqrt(dx * dx + dy * dy);
}

export function validFix(f: Partial<Fix> | null | undefined): f is Fix {
  return !!f && [f.lat, f.lon, f.acc_m, f.fix_at].every((v) => typeof v === 'number' && Number.isFinite(v))
    && f.lat! >= -90 && f.lat! <= 90 && f.lon! >= -180 && f.lon! <= 180 && !(f.lat === 0 && f.lon === 0) && f.acc_m! >= 0 && f.fix_at! > 0;
}

export type CheckInput = {
  accountActive: boolean;
  assigned: boolean; // the stop and its trip are given to this driver
  tripActive: boolean; // trip started, not cancelled or finished; stop on its way
  dest: { lat: number | null; lon: number | null; mlon: number | null };
  policy: Policy;
  permission: 'granted' | 'denied' | 'prompt';
  fixes: Fix[]; // readings in the order they came, oldest first
  now: number; // ms
};

/** Where the driver stands for this stop. The outcome is ARRIVAL_VERIFIED only when every condition holds. */
export function checkArrival(x: CheckInput): Check {
  const need = x.policy.readings;
  const out = (outcome: Outcome, distance_m: number | null = null, good = 0, fix: Fix | null = null): Check => ({ outcome, distance_m, good, need, fix });
  if (!x.accountActive) return out('ACCOUNT_NOT_ACTIVE');
  if (!x.assigned) return out('TRIP_NOT_ASSIGNED');
  if (!x.tripActive) return out('TRIP_NOT_ACTIVE');
  const { lat, lon, mlon } = x.dest;
  if (typeof lat !== 'number' || typeof lon !== 'number' || typeof mlon !== 'number' || !validFix({ lat, lon, acc_m: 0, fix_at: 1 })) return out('DESTINATION_NOT_CONFIGURED');
  const dest = { lat, lon, mlon };
  if (x.permission !== 'granted') return out('GPS_PERMISSION_REQUIRED');
  if (!x.fixes.length) return out('LOCATION_UNAVAILABLE');
  const newest = x.fixes[x.fixes.length - 1];
  if (!validFix(newest)) return out('INVALID_LOCATION');
  const dist = (f: Fix) => Math.max(distanceM(f, dest), rulesDistanceM(f, dest));
  const d = dist(newest);
  if (x.now - newest.fix_at > x.policy.max_age_s * 1000 || newest.fix_at > x.now + 60_000) return out('LOCATION_TOO_OLD', d, 0, newest);
  if (newest.acc_m > x.policy.max_accuracy_m) return out('GPS_ACCURACY_TOO_LOW', d, 0, newest);
  if (d > x.policy.radius_m) return out('OUTSIDE_DESTINATION_RADIUS', d, 0, newest);
  // count consecutive good readings back from the newest; repeats of the same reading count once
  let good = 0;
  let last = Infinity;
  const window = Math.max(60, x.policy.max_age_s * need * 2) * 1000; // old readings do not count, however good
  for (let k = x.fixes.length - 1; k >= 0; k--) {
    const f = x.fixes[k];
    if (f.fix_at >= last) continue; // same or out-of-order reading
    if (!validFix(f) || f.acc_m > x.policy.max_accuracy_m || dist(f) > x.policy.radius_m || x.now - f.fix_at > window) break;
    good++;
    last = f.fix_at;
    if (good >= need) break;
  }
  return out(good >= need ? 'ARRIVAL_VERIFIED' : 'ARRIVAL_CHECKING', d, good, newest);
}

/** Everyday words for each outcome (driver screen). */
export const OUTCOME_TEXT: Record<Outcome, string> = {
  ACCOUNT_NOT_ACTIVE: 'Your account is paused. Contact your admin.',
  TRIP_NOT_ASSIGNED: 'This trip is no longer yours.',
  TRIP_NOT_ACTIVE: 'This delivery is not on its way. Start it first.',
  DESTINATION_NOT_CONFIGURED: 'The delivery point for this town has not been set. Ask your admin to set it.',
  GPS_PERMISSION_REQUIRED: 'Allow location for ARIA so it can confirm you have arrived.',
  LOCATION_UNAVAILABLE: 'Waiting for your location... Turn on location (GPS) if it is off.',
  INVALID_LOCATION: 'The phone gave a location that cannot be right. Trying again...',
  LOCATION_TOO_OLD: 'Your location is not up to date. Waiting for a new reading...',
  GPS_ACCURACY_TOO_LOW: 'Location is not precise enough yet. Move to open sky or wait a moment.',
  OUTSIDE_DESTINATION_RADIUS: 'Not at the delivery location yet.',
  ARRIVAL_CHECKING: 'You look close. Checking your location once more...',
  ARRIVAL_VERIFIED: 'Location check passed.',
};
