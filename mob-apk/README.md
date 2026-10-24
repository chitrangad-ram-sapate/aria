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
| `engine/device_forecast.py` | On-device forecast for an imported sales CSV: scikit-learn quantile boosting with split-conformal calibration, or empirical quantiles (labelled fallback) |
| `engine/assumptions.yaml` | A1-A9, limitations and data sources for the Assumptions tab |
| `engine/tests/` | The engine's pure tests (`ARIA_SOLVER=scipy`) |
| `scripts/prepare.mjs` | Copies the Pyodide runtime + wheels into `public/pyodide/` and zips `engine/` into `public/aria-bundle.zip` |
| `scripts/sync-engine.mjs` | `npm run sync-engine`: refreshes `engine/` from `../aria`, `../data`, `../tests` when they exist |
| `scripts/smoke.mjs` | Headless Chrome smoke check of the built app |
| `android/`, `ios/` | Capacitor native projects |

Views: Plan (scenario, CSV import, editable stock, impact vs baseline (a), allocations, shortfalls, excess, forecasts, explain, `.svcr` and pick lists), Proof, Disruption Lab, Records, Assumptions.

## Develop

Node 22+.

```bash
npm install
npm run dev          # http://localhost:5173 (first run downloads the Pyodide wheels into .cache/)
```

## Build and test

```bash
npm run build        # dist/  (web bundle, about 44 MB, mostly Pyodide, SciPy and scikit-learn)
npm run smoke        # headless Chrome: boot, plan, impact, STALE, .svcr export/open/tamper, disruption, CSV import, assumptions, proof
cd engine && pip install -r requirements.txt && ARIA_SOLVER=scipy python -m pytest -q
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

A `.svcr` (Scenario-Verified Consignment Record) carries a plan and the exact inputs it was solved on. The
Plan view exports the current verified plan with **Share .svcr** (disabled while results are STALE). Opening a
file checks its digest and `scenario_hash` and re-runs the verifier on the device: the Records view then shows
a VERIFIED badge and the pick list per godown, or a red REJECTED panel with the error.

- **Any platform:** Records → **Open .svcr**.
- **Android:** "Open with ARIA" from a file manager or a download, or share a `.svcr` to ARIA
  (intent filters for `*.svcr` and `application/vnd.aria.svcr+json`).
- **iOS:** the app exports the `app.aria.svcr` type (extension `svcr`), so Files and share sheets offer ARIA.
- **Installed web app (Chrome):** registered as a `.svcr` file handler.
