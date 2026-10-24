# ARIA — Adaptive Routing and Inventory Allocation (mobile app)

ARIA is a distribution-intelligence app for distributors and super-stockists, available for Android, iOS and the web. Each evening it plans which godown ships which product to which town:

- It forecasts demand as calibrated quantiles.
- It prices freight into every route's service level.
- It allocates stock lot by lot, so nothing arrives below the store's minimum shelf life.
- An independent verifier checks every plan before it is shown.

Planning runs **on the device**, so it works offline and needs no server.

| Path | What |
|---|---|
| [`mob-apk/`](mob-apk/) | The mobile application project (Capacitor + TypeScript UI, on-device Python engine) |
| [`mob-apk/engine/`](mob-apk/engine/) | The planning engine the app runs, plus its tests |
| [`mob-apk/docs/`](mob-apk/docs/) | Product requirements, implementation plan and decision log |

Build and run instructions: [`mob-apk/README.md`](mob-apk/README.md).

**Plan files.** Plans are shared between devices as `.svcr` files (Scenario-Verified Consignment Record). The app re-verifies every opened file before showing a single row. See [`mob-apk/docs/decision.md`](mob-apk/docs/decision.md), D-026.

**Team:** ruturajnalbalwar-arch · thevipulbangar · chitrangad-ram-sapate · Physics0070 — Team Cyberpunk, TRIWIZATHON 2026.
