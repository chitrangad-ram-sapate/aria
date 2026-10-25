// Checks the arrival rules in src/geofence.ts: inside/outside the radius, poor accuracy, old and broken readings,
// missing delivery point, consecutive readings, and that repeats of one reading do not count twice.
// Usage: node scripts/geofence-test.mjs   (Node 22.6+ reads the TypeScript file directly)
import { readFileSync } from 'node:fs';
import { POLICY_LIMITS, SHOP_CODE, today } from '../src/config.ts';
import { checkArrival, distanceM, rulesDistanceM } from '../src/geofence.ts';

let failed = 0;
const check = (what, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (got ${got}, want ${want})`}`);
};

const dest = { lat: 16.705, lon: 74.2433, mlon: 111320 * Math.cos((16.705 * Math.PI) / 180) };
const policy = { radius_m: 100, max_accuracy_m: 50, max_age_s: 15, readings: 2 };
const now = 1_800_000_000_000;
const north = (m) => dest.lat + m / 110574; // a point m metres north of the delivery point
const fix = (m, ageS, acc = 10) => ({ lat: north(m), lon: dest.lon, acc_m: acc, fix_at: now - ageS * 1000 });
const base = { accountActive: true, assigned: true, tripActive: true, dest, policy, permission: 'granted', fixes: [], now };
const run = (over) => checkArrival({ ...base, ...over });

check('distance: 1 degree of latitude is about 111 km', Math.round(distanceM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) / 1000), 111);
check('rules distance agrees with the great-circle distance within 1 m at 100 m', Math.abs(rulesDistanceM({ lat: north(100), lon: dest.lon }, dest) - distanceM({ lat: north(100), lon: dest.lon }, dest)) < 1, true);
check('two good readings inside the radius pass', run({ fixes: [fix(20, 8), fix(15, 2)] }).outcome, 'ARRIVAL_VERIFIED');
check('one good reading is not enough', run({ fixes: [fix(15, 2)] }).outcome, 'ARRIVAL_CHECKING');
check('the same reading twice counts once', run({ fixes: [fix(15, 2), fix(15, 2)] }).outcome, 'ARRIVAL_CHECKING');
check('outside the radius does not pass', run({ fixes: [fix(150, 8), fix(140, 2)] }).outcome, 'OUTSIDE_DESTINATION_RADIUS');
check('distance to go is reported (within 2 m)', Math.abs(run({ fixes: [fix(140, 2)] }).distance_m - 140) < 2, true);
check('a far reading breaks the run', run({ fixes: [fix(10, 12), fix(500, 6), fix(10, 2)] }).outcome, 'ARRIVAL_CHECKING');
check('inaccurate reading is refused', run({ fixes: [fix(10, 8), fix(10, 2, 80)] }).outcome, 'GPS_ACCURACY_TOO_LOW');
check('stale reading is refused', run({ fixes: [fix(10, 40), fix(10, 30)] }).outcome, 'LOCATION_TOO_OLD');
check('a reading from the future is refused', run({ fixes: [fix(10, -120)] }).outcome, 'LOCATION_TOO_OLD');
check('impossible coordinates are refused', run({ fixes: [{ lat: 95, lon: 74, acc_m: 5, fix_at: now }] }).outcome, 'INVALID_LOCATION');
check('0,0 is refused', run({ fixes: [{ lat: 0, lon: 0, acc_m: 5, fix_at: now }] }).outcome, 'INVALID_LOCATION');
check('no delivery point: never passes', run({ dest: { lat: null, lon: null, mlon: null }, fixes: [fix(0, 2), fix(0, 1)] }).outcome, 'DESTINATION_NOT_CONFIGURED');
check('no readings yet', run({ fixes: [] }).outcome, 'LOCATION_UNAVAILABLE');
check('no location permission', run({ permission: 'denied', fixes: [fix(0, 2), fix(0, 1)] }).outcome, 'GPS_PERMISSION_REQUIRED');
check('paused account', run({ accountActive: false, fixes: [fix(0, 2), fix(0, 1)] }).outcome, 'ACCOUNT_NOT_ACTIVE');
check('trip given to someone else', run({ assigned: false, fixes: [fix(0, 2), fix(0, 1)] }).outcome, 'TRIP_NOT_ASSIGNED');
check('trip not started or cancelled', run({ tripActive: false, fixes: [fix(0, 2), fix(0, 1)] }).outcome, 'TRIP_NOT_ACTIVE');
check('three readings asked for, two given', run({ policy: { ...policy, readings: 3 }, fixes: [fix(5, 8), fix(5, 2)] }).outcome, 'ARRIVAL_CHECKING');
check('just inside the edge passes', run({ fixes: [fix(95, 8), fix(98, 2)] }).outcome, 'ARRIVAL_VERIFIED');

// the app's limits (src/config.ts) and the database's (firestore.rules) must agree: neither file can import the other
const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
for (const [k, [lo, hi]] of Object.entries(POLICY_LIMITS)) {
  const m = new RegExp(`g\\.${k} is \\w+ && g\\.${k} >= (\\d+) && g\\.${k} <= (\\d+)`).exec(rules);
  check(`arrival limit ${k} is ${lo}-${hi} in the app and the rules`, m ? `${m[1]}-${m[2]}` : 'missing', `${lo}-${hi}`);
}
check('shop code tries match the rules', /request\.resource\.data\.n <= (\d+)/.exec(rules)?.[1], String(SHOP_CODE.maxTries));
check('shop code digits match the rules', /code\.matches\('\[0-9\]\{(\d+)\}'\)/.exec(rules)?.[1], String(SHOP_CODE.digits));
// "today" is the phone's date, not UTC: 1 am in India is still the same day there
check('today() uses local time', today(new Date(2026, 9, 26, 1, 0)), '2026-10-26');

console.log(failed ? `\n${failed} geofence check(s) FAILED` : '\nall geofence checks passed');
process.exit(failed ? 1 : 0);
