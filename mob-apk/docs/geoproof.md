# GeoProof deliveries

Decision D-045. This document is for the team: how GeoProof works, what each part proves and what it does not, how to set it up, and what a stronger version would need.

## What it does

- A driver can hand in a delivery only after the phone shows they are at the shop and the shop gives them its delivery code.
- The admin then confirms the delivery.
- Every step is recorded, in order, with who did it and when.

## Data

GeoProof extends the existing trip. It is not a second shipment system.

| Path | What | Who writes it |
|---|---|---|
| `orgs/{org}/trips/{trip}` | The depot load, as before: `stops[]` holds what to hand over. `status` is `assigned → loaded → done`, or `cancelled`. | The admin. The driver can only change `assigned → loaded`. Drivers can no longer edit `stops[]`, which used to let a driver tick a stop delivered by hand. |
| `…/trips/{trip}/stops/{i}` | One delivery stop: town, **approved delivery point** (`lat`, `lon`), `mlon` (metres per degree of longitude), arrival `policy`, `state`, `seq`, `codeGen`, plus `arrival`, `claim`, `review` and `failReason` as they happen. | The admin creates it with the trip. After that, changes follow the state machine below. |
| `…/stops/{i}/events/{seq}` | History, one entry per change: kind, state, who (uid, name, role) and the server time. | Written in the same batch as the change; never edited. |
| `…/stops/{i}/code/{gen}` | The recipient code's **salted SHA-256 hash**, salt and expiry. No code in plain text is stored anywhere. | The admin. Only the admin can read it. |
| `…/stops/{i}/tries/{gen}_{n}` | The driver's code tries, n = 1…5 in order. | The driver. Only the admin can read it. |
| `…/trips/{trip}/live/{uid}` | The driver's latest position: one document, overwritten, deleted when tracking ends. | The driver, only while the trip is loaded. Only that driver and the admin can read it. |
| `orgs/{org}.geo` | The team's arrival rules: radius, accuracy, age and number of readings. | The admin. Values are checked to sensible ranges. |

**Where delivery points come from.** At send time, each stop copies its town's `lat`/`lon` from the data CSV (the `towns` table). Nothing is ever guessed from a town name. A town with no coordinates gives a stop with no delivery point; that stop can never pass the arrival check until the admin sets a point (Team → Deliveries → stop → Delivery point). The admin can change the point only before the driver sets off.

## States

```
assigned ──driver: Go──► in_transit ──driver: arrival check──► arrived ──driver: name + shop code──► submitted
    ▲                       │    │                                │                                    │
    └──driver: try again── rejected ◄──────────admin: not accepted (reason)───────────────────────────┤
                            │    └──driver: could not deliver (reason)──► failed                       │
any open state ──admin: cancel (reason)──► cancelled                       admin: confirm ──► delivered
```

Each change increments `seq` and must create `events/{seq}` in the same write batch; `firestore.rules` checks both. A second, duplicate submission therefore finds `seq` already used and is refused. When the admin confirms the last open stop, the trip becomes `done`.

## Who may do what (`firestore.rules`)

- **Driver:**
  - Only on stops of a trip whose `driverUid` is them, while their account is active and the trip is `loaded`.
  - `assigned`/`rejected` → `in_transit`.
  - `in_transit` → `arrived`, only with an `arrival` that passes the checks below.
  - `arrived` → `submitted`, only with a claim whose code try matches the stored hash.
  - `in_transit`/`arrived` → `failed`, with a reason.
  - A driver can never write `delivered`, never change the delivery point, the rules or the driver, and never read the code or the tries.
- **Admin of the team:**
  - `submitted` → `delivered`, or → `rejected` with a reason.
  - Any open state → `cancelled`, with a reason.
  - Set the delivery point (only while `assigned`), make a new code, and hand the stop to the trip's new driver.
- **Paused drivers** can do none of this, and cannot read trips or share location.
- **Reassigning** a trip moves every open stop to the new driver; the old driver's writes then fail.
- **Another team** can read nothing.
- `scripts/rules-test.mjs` runs 121 checks against the emulator, about 80 of them for GeoProof and accounts.

## The arrival check

- **Defaults:** 100 m radius, 50 m accuracy, 15 s age, 2 readings. The admin changes them under Team → Deliveries → Arrival rules; they apply to trips sent afterwards.
- **On the phone** (`src/geofence.ts`, tested by `scripts/geofence-test.mjs`):
  - The newest reading must be:
    - valid;
    - no older than the age limit and not from the future;
    - within the accuracy limit;
    - inside the radius, by great-circle distance and by the flat distance the rules use, whichever is larger.
  - The required number of readings must be good in a row, each with a different time; a repeated reading counts once.
  - The result is one outcome code (`ARRIVAL_VERIFIED`, `OUTSIDE_DESTINATION_RADIUS`, `GPS_ACCURACY_TOO_LOW`, …), shown in plain words.
  - "Delivered" is disabled for every outcome except `ARRIVAL_VERIFIED`, and it is checked again at the moment of tapping. A failed request, a missing map or an error never unlocks it.
- **In the database rules**, on the `arrival` sent:
  - the coordinates are in range;
  - accuracy ≤ the limit and readings ≥ the number required;
  - the reading's time is within the age limit plus 60 s of the server's time (allowing for phone clock drift);
  - the point is inside the radius.

  So a claim queued offline and sent much later is refused, and the driver must check again.

### What this does not prove

GPS comes from the driver's phone. Firebase Authentication proves who the driver is; nothing in this design proves where the phone really is. A rooted phone or a "mock location" app can report any position, and the rules only check that the reported numbers are consistent.

So on this deployment (Firebase Spark, no server code) the driver's step is a **claim**. The admin confirms it, and the screens say so: "awaiting confirmation" for the driver, and "the position itself comes from the phone" for the admin.

Also, 100 m and 50 m accuracy show the driver was near the shop, not at its door. In towns, GPS can be off by more than that between tall buildings.

## Recipient code

**Where the code is checked.** The check runs in the database rules, on Google's servers, so it holds even against a modified app:

1. **Admin:** Team → Deliveries → stop → **Make delivery code**. The admin's phone makes a random 6-digit code (`crypto.getRandomValues`) and a random salt. It stores only `sha256(salt:code)` and a 24-hour expiry, then shows the code **once**, with "Send to the shop" (WhatsApp, SMS or any app). ARIA does not send SMS itself; no SMS provider is configured.
2. **Driver:** at the shop, the driver asks for the code and types it with the recipient's name.
   - The driver's phone first records the try (`tries/{gen}_{n}`; the rules allow n = 1…5, in order, one write each), then asks to move the stop to `submitted`.
   - The rules hash the try with the stored salt and compare it with the hash. They also check the expiry and that the try belongs to this driver and the current code.
   - A wrong code is refused, and the try is still counted. After 5 tries the admin must make a new code.
3. The plain code is never stored, logged or put in a history entry. Drivers cannot read the hash, the salt or the tries.

## Tracking

- **What it uses:** `@capacitor/geolocation` 6.1.1 (Capacitor 6), `src/geo.ts`.
- **Permission:** asked only after a plain explanation, when the driver starts a trip or a stop. Android asks for fine and coarse location, iOS for "when in use". **No background location is requested.**
- **When it runs:** only while one of the driver's stops is on its way or at the shop, and while ARIA is open.
- **When it stops** (and the shared position is deleted): the proof is handed in, the stop fails, the trip is cancelled or given to someone else, the driver signs out or is paused.
- **What the admin sees:** the latest position, sent at most every 30 s or every 50 m moved.
- **Old positions:** a reading older than 60 s is shown as "last known position … not live" (grey on the map), never as live. The admin's list warns about drivers on the road without a recent position.
- **Background tracking (not built).** Android and iOS stop updates when the app is in the background. Reliable background tracking needs:
  - on Android, a foreground service with `ACCESS_BACKGROUND_LOCATION` and a persistent notification;
  - on iOS, the "location updates" background mode and "Always" permission;
  - a plugin such as `@capacitor-community/background-geolocation`, tested on both platforms;
  - an updated disclosure, and Play Store review of the background-location declaration.

## Map

`src/map.ts` puts both providers behind one small interface. The driver and admin code never touch a provider directly.

| `VITE_MAP_PROVIDER` | Needs | Notes |
|---|---|---|
| `osm` (default) | Internet | OpenStreetMap tiles through Leaflet 1.9.4; no key. Heavy commercial use should move to a paid tile host (OSM tile policy). |
| `google` | `VITE_GOOGLE_MAPS_KEY` | Google Maps JavaScript API. The key must be restricted to the app, and the Google Cloud project must have billing enabled. This path is written but **has not been run**, because no key exists in this project. |
| `none` | – | No map; everything else works. |

**Setting it up:** copy `.env.example` to `.env.local` (git-ignored), set the values, then `npm run build`. Keys are never committed.

**What the map shows:**
- delivery points, numbered;
- the arrival circle;
- the driver's latest position with an accuracy ring, blue when live and grey when old;
- buttons for "Me", "Delivery point" and "All stops".

There is no routing service, so **no road route is drawn**; a straight line would not be a road. If the map cannot load (no internet), the page says so, and the location check and status list work without it.

## Offline

- Firestore keeps writes on the phone while offline. The stop then shows "Saved on this phone · waiting to upload", and the app does not report it as handed in.
- When the phone reconnects, the rules check the change again with the server's time. An arrival older than the age limit plus 60 s is refused, and the stop goes back to its last confirmed state.
- Code tries need the internet; the driver is told nothing was handed in.
- A duplicate tap is refused by the `seq` check.

## Stronger version: trusted server (not built)

This needs Firebase **Blaze** (pay as you go) for Cloud Functions. The project is on Spark; nothing was upgraded or deployed.

**What it would add:**
- A callable `completeDelivery` function that re-reads the stop, the trip, the driver's account and the code inside a transaction. It would check freshness against server time and the geofence, and could move the stop straight to `delivered`.
- SMS of the code to the shop through a provider (MSG91, Twilio).
- Optional Play Integrity / App Attest so that only the real app can call it.

Even with a server, GPS is still reported by the phone. Play Integrity raises the bar, but does not prove the position.

**Cost:** Cloud Functions is free up to 2 million calls a month on Blaze, but Blaze needs a billing account; SMS is paid per message.

## Not done

- Marathi/Hindi labels. The app has no translation layer yet; driver texts are short, plain English strings in `src/views/deliver.ts` and `src/geofence.ts`, ready to move into one.
- Photo proof.
- Retention clean-up of old history. History stays with the trip until the admin removes the trip; the live position is already deleted as soon as tracking ends.

## Demo

1. Admin (`admin@aria.app`): Home → load `aria-demo-pune.csv` (its towns carry real coordinates) → **Plan tonight** → Team → send a depot's trip to `driver@aria.app`.
2. To demo indoors, open Team → Deliveries → **Not started** → the first stop → **Delivery point** → **Use this phone's location** → **Save point**. That stop's point is now where you stand.
3. Driver phone: My trips → **Start delivery** → allow location → open that stop → **Go to this stop**. If the driver isn't standing at the point, the status shows "Not at delivery location yet" and how far.
4. At the point: two good readings → **Location check passed · Confirm recipient**.
5. Admin: Deliveries → **On the way** → the stop shows the phone's location check and the driver's live position → **Make delivery code** → send it.
6. Driver: type the recipient's name and the code. A wrong code is refused; the right code → "Delivery submitted · awaiting confirmation".
7. Admin: Deliveries → **To confirm** → **Confirm delivered**. The driver sees "Delivered and confirmed", and the History lists every step.
