# ARIA mobile and web app

One TypeScript + Vite codebase, wrapped with Capacitor for Android and iOS and also deployed as a website
on Firebase Hosting. The Python engine runs on the device in Pyodide inside a Web Worker, using SciPy's HiGHS
(`ARIA_SOLVER=scipy`). No backend, no account, works offline after install.

| Path | What |
|---|---|
| `src/` | UI (plain TS + CSS) and `worker.ts` (Pyodide) |
| `engine/aria/` | The engine modules the app runs (copied from the full ARIA tree) |
| `engine/data/` | Bundled scenarios, networks, `params.yaml`, `replay_*.json` |
| `engine/bridge.py` | Glue the worker calls (plus impact and excess figures from engine functions) |
| `engine/dataset_csv.py` | The data CSV (one file, several tables) to and from a scenario, with line-numbered errors: see `docs/csv-format.md` |
| `engine/analysis.py` | Dashboard figures for a plan, and the scenarios Ask ARIA builds from model inputs |
| `engine/device_forecast.py` | On-device forecast for the CSV's sales table: scikit-learn quantile boosting with split-conformal calibration, or empirical quantiles (labelled fallback) |
| `engine/tests/` | The engine's pure tests (`ARIA_SOLVER=scipy`) |
| `engine/app_tests/` | Tests of the data CSV, dashboard and scenario code |
| `scripts/prepare.mjs` | Copies the Pyodide runtime + wheels into `public/pyodide/` and zips `engine/` into `public/aria-bundle.zip` |
| `scripts/sync-engine.mjs` | `npm run sync-engine`: refreshes `engine/` from `../aria`, `../data`, `../tests` when they exist |
| `scripts/make-icons.py` | Builds every app icon and splash screen from `assets/logo-source.png` (`python scripts/make-icons.py`) |
| `src/dock.ts` | Glass dock motion: sliding active pill, page slide-and-fade, per-tab scroll memory, tap the open tab to go to the top |
| `scripts/smoke.mjs` | Headless Chrome end-to-end check of the built app |
| `android/`, `ios/` | Capacitor native projects |

Views:
- **Home:** load your data CSV (or a sample), plan, network diagram, shortages, pick lists, editable stock with Save, `.svcr`.
- **GeoProof deliveries:** drivers start a trip and open each town; Delivered unlocks only when the phone's location is at the shop, then the shop's delivery code and the admin's confirmation complete it. Admins follow every stop under Team → Deliveries, with a map. See `docs/geoproof.md`.
- **Scan labels (Home):** scan a product or lot label (QR or barcode) with the camera or type its code; ARIA checks it, asks for anything missing, refuses what cannot be right, then updates the stock, plans again and shows the new plan against the old one.
- **Ask ARIA:** a chat. Questions in plain words ("what if demand rises 20% in Pune and the longest route closes?") become scenarios, planned again on the phone and compared with tonight. Follow-ups ("also...", "what about 30%?"), ranges step by step, "which is best?", tonight's shortages, and how-to answers for the app. It runs on the phone with word rules and the names in the data: no internet, no AI service, nothing leaves the phone.
- **Results:** dashboard with KPIs, network, charts, scenario comparison and, for samples, the historical replay.
- **Files:** open `.svcr` plan files.

All data enters through one CSV file (`docs/csv-format.md`).

**Accounts and roles** (Firebase Auth + Firestore, free Spark plan; `src/cloud.ts`, `firestore.rules`):
- **Admin** creates a team, gets a 6-letter team code and has full control: data, planning, Ask ARIA, Results, plan files and the **Team** screen. The Team screen shows every driver (active or paused, last seen), sends tonight's trips (one per depot), tracks deliveries and lists drivers' problem reports.
- **Driver** joins with the team code and sees only **My trips** (load, deliver stop by stop, share the pick list), **Plans** (plan files from the admin), **Report a problem** and **Account**. Drivers never load the planner.
- The admin can send the `.svcr` plan file straight to drivers (Home → Share plan). Drivers open it under **Plans**: the app checks nothing was changed, shows what goes where, and can run the full safety check on their phone.
- The admin can pause a driver, which locks them out at once. The rules stop anyone from changing their own role, team or paused state, and keep each team's data apart.

Planning still runs on the phone. Only people, trips and reports go to Firestore, which also works offline and syncs later.

## Develop

Node 22+.

```bash
npm install
npm run dev          # http://localhost:5173 (first run downloads the Pyodide wheels into .cache/)
```

## Build and test

```bash
npm run build        # dist/  (web bundle, about 44 MB, mostly Pyodide, SciPy and scikit-learn)
npm run smoke        # headless Chrome at phone size, with the emulators running: admin sign-up, CSV uploads, plan, network,
                     # Results charts, stock Save, Ask ARIA, .svcr export, reload; a driver joins, gets, loads and
                     # delivers a trip, reports a problem and is paused; sign out and back in
cd engine && pip install -r requirements.txt && ARIA_SOLVER=scipy python -m pytest tests app_tests -q
npm run screenshots  # with the emulators running: the README screenshots, admin and driver, into ../docs/screenshots/
npm run emulators    # local sign-in and database for testing (needs Java 11+); smoke uses them via ?emulators=1
npm run assistant-test # how Ask ARIA reads 50+ questions, against the names in two samples
npm run rules-test   # tries what a careless or curious user might: other teams' data, own role, paused access
npm run deploy:rules # publish firestore.rules and indexes to the live project
```

## Android

JDK 17 and the Android SDK (platform 34).

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

## iOS

Needs a Mac with Xcode: `npm run build && npx cap sync ios && npx cap open ios`. Without a Mac, run the
`Mobile` workflow (`.github/workflows/mobile.yml`, manual trigger): it uploads the debug APK, the web bundle
and an unsigned iOS simulator build.

## Web (Firebase Hosting)

`firebase.json` and `.firebaserc` (project `aria-triwiz`) are in this folder. `npm run build`, then
`firebase deploy --only hosting` from here.

## Opening .svcr files

Plan files shared from the app are locked to the team (D-043): only someone signed in to the same team can open them. Opened in a text editor they show one header line and unreadable bytes.

A `.svcr` (Scenario-Verified Consignment Record) carries a plan and the exact inputs it was solved on. The
Plan view exports the current verified plan with **Share .svcr** (disabled while results are STALE). Opening a
file checks its digest and `scenario_hash` and re-runs the verifier on the device: the Records view then shows
a VERIFIED badge and the pick list per godown, or a red REJECTED panel with the error.

- **Any platform:** Records → **Open .svcr**.
- **Android:** "Open with ARIA" from a file manager or a download, or share a `.svcr` to ARIA
  (intent filters for `*.svcr` and `application/vnd.aria.svcr+json`).
- **iOS:** the app exports the `app.aria.svcr` type (extension `svcr`), so Files and share sheets offer ARIA.
- **Installed web app (Chrome):** registered as a `.svcr` file handler.
