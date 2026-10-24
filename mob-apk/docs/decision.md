# ARIA — Decision Log

_Every important decision taken while building ARIA, with its reason and the alternatives rejected. Append-only: when you reverse a decision, mark the old one **Superseded by D-xxx**. Do not delete it._

**Status values:**
- **PRD**: fixed by `cyberpunk.pdf` v2.2. Don't change it without team agreement.
- **Accepted**: our choice during planning or build.
- **Proposed**: our default. Go ahead with it unless the team objects.
- **Open**: needs an answer before the dependent task.
- **Superseded**: replaced by a later decision.

**Format:** `D-xxx · title · status · date`, then Context / Decision / Why / Alternatives rejected / Consequences.

---

## Index

| ID | Decision | Status | Date |
|---|---|---|---|
| D-001 | PRD v2.2 is the single source of truth; three living docs | Accepted | 2026-10-24 |
| D-002 | Tech stack exactly as PRD §7.1 | PRD | 2026-10-24 |
| D-003 | Use a Python 3.11.9 venv, not the machine's 3.13.15 | Accepted | 2026-10-24 |
| D-004 | Integer paise and integer units everywhere outside forecasting | PRD | 2026-10-24 |
| D-005 | Repo layout: `aria/` package, verifier isolated from solver | Accepted | 2026-10-24 |
| D-006 | Unit cost = price × (1 − margin) | Accepted | 2026-10-24 |
| D-007 | Quantile → segment interpolation: linear in τ, anchor Q(0)=0, round then cumulative max | Accepted | 2026-10-24 |
| D-008 | All capacities are column bounds; rows are flow conservation only | Accepted | 2026-10-24 |
| D-009 | One LP across all products (not one per product) | Accepted | 2026-10-24 |
| D-010 | Build HiGHS model from NumPy arrays directly, no modelling layer | Accepted | 2026-10-24 |
| D-011 | Reduced costs classified by `rint` with an integrality assert | Accepted | 2026-10-24 |
| D-012 | Hindsight policy (c) = same optimizer with a one-segment realised demand | Proposed | 2026-10-24 |
| D-013 | Converting M5 USD prices to INR paise | Accepted (see D-013) | 2026-10-24 |
| D-014 | Source of the road distances | Accepted (see D-014) | 2026-10-24 |
| D-015 | kg/unit and shelf-life class for anonymous M5 items | Accepted (see D-015) | 2026-10-24 |
| D-016 | Bootstrap on daily paired policy differences | Proposed | 2026-10-24 |
| D-017 | Replay sells from town stock FEFO | Proposed | 2026-10-24 |
| D-018 | Property tests use a seeded random scenario generator | Proposed | 2026-10-24 |
| D-019 | Initialise git in Phase 0 | Accepted | 2026-10-24 |
| D-020 | Region-agnostic engine; networks are data; Kolhapur is one bundled network | Accepted | 2026-10-24 |
| D-021 | Demand quantiles embedded in the Scenario | Accepted | 2026-10-24 |
| D-022 | Repo governance: private repo, org-ready admin model | Accepted | 2026-10-24 |
| D-023 | Deployment: Docker Compose (API + UI) and CI on GitHub Actions | Superseded by D-025/D-027 (Docker kept optional) | 2026-10-24 |
| D-024 | At-risk uses the shortest leg over all routes | Accepted | 2026-10-24 |
| D-025 | Mobile and web: Capacitor + TypeScript, engine on device via Pyodide | Accepted | 2026-10-24 |
| D-026 | `.svcr` file format: Scenario-Verified Consignment Record | Accepted | 2026-10-24 |
| D-027 | Hosting: Firebase Hosting, free Spark plan, no backend | Accepted | 2026-10-24 |
| D-028 | SciPy HiGHS as the solver fallback where highspy is unavailable | Accepted | 2026-10-24 |

---

## D-001 · PRD v2.2 is the single source of truth; three living docs · Accepted · 2026-10-24
**Context:** The project folder `E:\Triwiz` contained only `cyberpunk.pdf` (26 pages, ARIA PRD v2.2 final). Nothing has been built yet. The PRD's own last line says "Nothing has been built yet".
**Decision:** Build exactly what the PRD specifies. Keep three documents up to date:
- `implementation.md`: the plan.
- `decision.md`: this log.
- `handoff.md`: the session baton pass.

**Why:** The PRD pre-registers its KPIs (§9). Drifting from it would break the "fair test" story judges will check.
**Alternatives rejected:** Re-scoping the product. Rejected because the PRD is final and the KPIs are pre-registered.
**Consequences:** Every deviation from the PRD needs an entry here.

## D-002 · Tech stack exactly as PRD §7.1 · PRD · 2026-10-24
**Decision:**
- UI: Streamlit.
- API: FastAPI + Pydantic v2.
- Forecasting: mlforecast 1.1.0 + LightGBM 4.7.0.
- Optimization: highspy 1.15.1 (HiGHS simplex).
- Storage: Parquet + embedded DuckDB + scenario JSON.
- Hosting: local only on 127.0.0.1.

**Why (PRD):** All four members can edit Python-only code. Pydantic gives typed validation and OpenAPI. HiGHS returns duals and solved a 530k-column LP in 3.3 s (M1). No server is needed and everything works offline.
**Alternatives rejected (PRD):**
- React + Vite: adds a second language and a build step.
- OR-Tools SCIP: not needed once both stages are LPs.
- A database server: out of scope (§5.4).

## D-003 · Use a Python 3.11.9 venv, not the machine's 3.13.15 · Accepted · 2026-10-24
**Context:** `python --version` on this machine shows **3.13.15** (`D:\python files\python.exe`). `py -0` lists 3.13 and 3.7. The PRD pins **3.11.9** because "3.11 wheels installed cleanly" (M1).
**Decision:** Install Python 3.11.9 and create `.venv` with `py -3.11 -m venv .venv`.
**Why:** The feasibility spike (M1) measured all timings and wheel installs on 3.11.9. Wheel availability for LightGBM, mlforecast and highspy on 3.13 is unverified, and the venue Wi-Fi (~25 kB/s) leaves no room for build-from-source surprises.
**Alternatives rejected:**
- 3.13.15: wheels unverified.
- 3.7: far too old for Pydantic v2 and FastAPI.

**Consequences:** Phase 0 step 1 must install 3.11.9 before anything else.

## D-004 · Integer paise and integer units everywhere outside forecasting · PRD · 2026-10-24
**Decision:** All money is `int` paise and all quantities are `int` units. Values are rounded once, when the LP arrays are built.
**Why:** Integer costs plus a totally unimodular matrix give integral duals. That makes the stage-2 reduced-cost classification exact. It also lets the metrics fixture be "exact to the paisa".
**Consequences:** Rounding creates ties. V8 and P3 therefore use *strictly* higher-valued comparisons.

## D-005 · Repo layout: `aria/` package, verifier isolated from solver · Accepted · 2026-10-24
**Decision:** The layout in implementation.md §3:
- `aria/engine/*`: pure functions.
- `aria/verify/verifier.py`: must not import the optimizer.
- `aria/metrics.py`: the one metrics function.
- `api/` and `ui/`: separate, with the UI formatting only.

**Why:** The PRD requires the verifier to be separate code (App. B) and requires one metrics function (FR-P0-08). Pure functions make property tests and the 10 s path predictable.
**Alternatives rejected:** A flat script layout. It makes the verifier/solver independence impossible to enforce.

## D-006 · Unit cost = price × (1 − margin) · Accepted · 2026-10-24
**Context:** The PRD defines h = unit cost × repo / 365 and E_k = unit cost × (1 − salvage) but never defines "unit cost".
**Decision:** unit cost = price × (1 − distributor margin).
**Why:** It reproduces every number in the PRD's §6.1 worked example. Example product: 1 kg, ₹100, c_u = ₹3.50, h = 96.5 × 0.055/365 = ₹0.01454.
- No freight: τ\* = 3.5/3.51454 = **0.996** ✓
- Ichalkaranji, 30 km at 6t, f = ₹0.331: τ\* = **0.902** ✓
- Ratnagiri, 130 km at road avg, f = ₹0.491: τ\* = **0.856** ✓
- Ratnagiri under the Amba Ghat ban at 6t, f = ₹1.434: τ\* = **0.588** ✓
- At 5% margin (unit cost 95): the ban gives **0.711** ✓

**Alternatives rejected:** unit cost = price. It also gives about the same values because h is tiny, but it is not what "cost" means to a distributor.
**Consequences:** `tests/test_values.py` asserts this table.

## D-007 · Quantile → segment interpolation · Accepted · 2026-10-24
**Context:** The PRD fixes the grid (β = 0, 0.01 … 0.99, 0.995 → 100 segments), Q(0)=0, "round to units" and Σb_j = Q(0.995). It does not specify the interpolation method.
**Decision:**
- Interpolate linearly in τ between the anchor points (0, 0) and the 9 calibrated quantiles at 0.005, 0.025, 0.165, 0.25, 0.5, 0.75, 0.835, 0.975, 0.995.
- Round each Q(β_j) to an integer, then apply a cumulative max.
- Set b_j = ΔQ.

**Why:** Simple and monotone, and it satisfies Σb_j = Q_top by construction.
**Alternatives rejected:**
- Spline or parametric fit: risk of non-monotonicity, and more code for no demo benefit.

## D-008 · All capacities are column bounds; rows are flow conservation only · Accepted · 2026-10-24
**Context:** Stage 2 keeps only zero-reduced-cost arcs and fixes all others at their bound. Complementary slackness also requires that every *row* with a nonzero dual stays tight.
**Decision:** Model these as upper bounds on dedicated arcs:
- C1 (lot qty q_l): godown→lot arc.
- C3 (segment capacity b): SEG→sink arc.
- C5 (godown capacity cap_w): src→godown arc.

The only rows are flow-conservation equalities. Segments are nodes, so y and y^risk can share capacity b via the SEG→sink arc.
**Why:** With only equality rows, fixing nonzero-RC columns at their bound is sufficient for V(stage 2) = V\*. The exact integer check then only ever acts as a safety net. The model also stays a pure network matrix, so total unimodularity holds.
**Alternatives rejected:** Capacities as inequality rows. That needs extra logic to keep tight rows tight in stage 2, which is easy to get wrong.

## D-009 · One LP across all products · Accepted · 2026-10-24
**Decision:** Build one network covering all products.
**Why:** Godown dispatch capacity C5 (Σ z_l at w ≤ cap_w) couples products. The model is still single-commodity, because lot, entry and segment nodes are product-specific and all flow ends at one sink. Size is 65k–125k columns, under the `E_SIZE` 300,000 guard.
**Alternatives rejected:** One LP per product. It is wrong whenever capacity binds.

## D-010 · Build HiGHS model from NumPy arrays directly · Accepted · 2026-10-24
**Decision:** Build CSC arrays and call highspy (`passModel` / `addCols` + `addRows`). Do not use pyomo, PuLP or highspy's expression API for the main model.
**Why:** The latency budget is 0.5 s for eligibility + values and 2.5 s per LP. M1 measured 3.81 s *with build* versus 3.3 s solve on a much larger LP, so build overhead matters.
**Alternatives rejected:** Modelling layers, because of build overhead and an extra dependency in the offline wheelhouse.

## D-011 · Reduced costs classified by `rint` with an integrality assert · Accepted · 2026-10-24
**Decision:** After stage 1, set `rc_int = np.rint(rc)` and assert `max|rc − rc_int| < 1e-6`. If the assert fails, log it and fall back to the stage-1 plan labelled "not FEFO-tie-broken".
**Why:** The PRD claims integral duals (integer costs + unimodular basis). The assert turns that claim into a checked fact, so no solver-tolerance guess is needed.

## D-012 · Hindsight policy (c) · Proposed · 2026-10-24
**Decision:** (c) = the same optimizer and eligibility, where each (town, product) has a single segment with b = realised demand and value c_u. It is a reference only, not a bound (PRD FIG 7).
**Why:** It reuses tested code, and "knows realised demand per day" is all the PRD asks.

## D-013 · Converting M5 USD prices to INR paise · **Open** · 2026-10-24
**Context:** M5 `sell_prices` are in USD. The PRD uses `price_paise` but never says how to convert. τ\* depends on c_u versus f, so the price level directly changes which legs are uneconomic.
**Options:**
- (a) Fixed FX rate × USD price, entered in `params.yaml` as "Design choice".
- (b) Map each item to an Indian price band, e.g. from Open Food Facts India or mandi data (P1-06).
- (c) Fix a ₹/kg price level so the §6.1 illustrative product (₹100/kg) is the median.

**Proposed default (pending team):** (a). It is simplest and keeps M5's relative price structure. Record the rate and its source in the registry.
**Blocks:** `aria/data/m5.py` price column (Phase 3).

## D-014 · Source of the 18 road distances · **Open** · 2026-10-24
**Context:** The PRD says road km are "precomputed once from OpenStreetMap (R19)" and "measured at H3". Its approximate figures are Kolhapur→Ichalkaranji ~30 km and Kolhapur→Ratnagiri ~130 km. Offline routing over the Geofabrik extract needs a routing engine (OSRM, or osmnx + networkx), which is heavy to install offline.
**Proposed:** Measure the 18 godown→town distances once with an OSM-based router while online, before the demo. Store them in `data/network.yaml` with the source and date. Fall back to the PRD's approximate km, labelled "approximate".
**Blocks:** f values for real routes (Phase 3). Fixtures can use the PRD's illustrative km until then.

## D-015 · kg/unit and shelf-life class for anonymous M5 items · **Open** · 2026-10-24
**Context:** M5 FOODS_3 item IDs (e.g. `FOODS_3_090`) carry no product category. The PRD wants kg/unit from the Open Food Facts India category median and shelf-life classes from USDA FoodKeeper ranges.
**Proposed:** Assign each of the top-100 items deterministically (seeded, by id) to one of a small set of food categories. Each category has an OFF-India median kg/unit and a FoodKeeper shelf-life range. Store the mapping in `data/mapping.yaml` and label it "Synthetic" in the registry (consistent with A8).
**Blocks:** `aria/data/lots.py`, f values.

## D-016 · Bootstrap on daily paired policy differences · Proposed · 2026-10-24
**Decision:** For each window, compute the daily bill difference series d_t = bill_ARIA,t − bill_b″,t (summed over towns and products). Apply a moving-block bootstrap with 7-day blocks and 1,000 resamples, then take the 95% percentile CI of the summed difference. Pool the 2 windows by concatenating block resamples within each window.
**Why:** Pairing on the same demand path removes the common noise, which is the point of a fair replay. 7-day blocks keep weekly seasonality (PRD).

## D-017 · Replay sells from town stock FEFO · Proposed · 2026-10-24
**Decision:** In the replay, realised demand at a town draws from town stock shortest-remaining-life first.
**Why:** It matches the FEFO intent and is the same for every policy, so it stays fair. The PRD doesn't state the sell order.

## D-018 · Property tests use a seeded random scenario generator · Proposed · 2026-10-24
**Decision:** `aria/data/scenarios.py::random_scenario(seed)` generates ≥ 200 small scenarios (2–3 godowns, 2–6 towns, 1–10 products, random lots, lives, routes, capacities). Seeds are fixed so failures can be reproduced. Hypothesis is optional on top.
**Why:** The suite must stay under 60 s, and failures must be reproducible during a hackathon.

## D-019 · Initialise git in Phase 0 · Proposed · 2026-10-24
**Context:** `E:\Triwiz` is not a git repository yet.
**Decision:** Run `git init` with `.gitignore` for `data/raw`, `.venv`, `wheelhouse`, `*.duckdb` and `*.parquet` as the first build step.
**Why:** Four owners work in parallel, and stage-by-stage rollback matters near the gates.

---

## Resolutions (2026-10-24, build start)

### D-013 resolved · USD → INR · Accepted
**Decision:** `price_paise = round(usd_price × FX × 100)`. FX is one constant in `data/params.yaml`, with its value, source and fetch date recorded. The build script fetches it once (public reference-rate API) and falls back to the stored value when offline.
**Why:** Keeps M5's relative price structure, takes one line, and is fully auditable in the parameter registry. The alternatives (OFF-India price bands, mandi prices) need item semantics that M5 does not have.

### D-014 resolved · Road distances · Accepted
**Decision:** Route `road_km` comes from the public OSRM routing service (`table` endpoint, OpenStreetMap data, R19). It is fetched once by `aria/data/network.py` from godown/town coordinates and stored in `data/networks/<network>.yaml` with source and date. Offline fallback: haversine × 1.25 detour factor, labelled `approximate`.
**Vehicle class (when a network does not set it):** ≤ 100 km → `6t` (intra-district legs, A6), otherwise `road_avg`. This reproduces the PRD's Kolhapur assignment: Gadhinglaj 6t, Ratnagiri road average.
**Transit days:** `max(1, ceil(road_km / 400))`.

### D-015 resolved · Item category, kg/unit, shelf life · Accepted
**Decision:** Each M5 FOODS_3 item is assigned deterministically (seeded by item id) to one of a small set of food categories. Each category carries an Open Food Facts India median kg/unit and a USDA FoodKeeper shelf-life range. `min_days_at_receipt` is a fixed share of shelf life. All stored in `data/mapping.yaml` with status `Synthetic` (A8).

### D-020 · Region-agnostic engine · Accepted
**Context:** Requested mid-build: the product must not be Kolhapur-specific and should have a wider scope.
**Decision:**
- The engine, API and UI take any network of N godowns × M towns × routes from the Scenario. Nothing in code names a city.
- Networks are YAML files in `data/networks/`. Bundled networks:
  - `kolhapur`: the PRD network, 3 × 6. It keeps the Amba Ghat / Ratnagiri demo (J4).
  - `maharashtra`: a wider multi-district network with depots in several regions serving the major cities.
- Any region can be added by dropping in a YAML file with coordinates and populations, or by CSV import (FR-P0-01).
- M5 stores are mapped to towns round-robin and rescaled by population share, so networks with more than 10 towns work.

**Why:** The method (freight-aware τ\*, lot-level LP, verifier, fair replay) has nothing Kolhapur-specific in it. Keeping the network as data costs no extra code.
**Consequences:**
- The model grows with towns × products × 100 segments. The `E_SIZE` guard (300,000 columns) bounds the interactive path, so large networks plan on a product subset.
- PRD KPI pass rules are unchanged and are evaluated on the `kolhapur` network as pre-registered. Other networks are reported, not gated.

### D-021 · Demand embedded in the Scenario · Accepted
**Decision:** `Scenario.demand[]` carries the 9 calibrated quantiles, point forecast and σ per (town, product), instead of a `forecast_ref` pointer.
**Why:** The engine stays a pure function of one JSON document. `scenario_hash` then covers the forecast too, and the replay can build daily scenarios in memory. Size is small (towns × products × 11 floats).

### D-022 · Repository governance · Accepted
**Context:** The repo is private at `github.com/chitrangad-ram-sapate/aria`. GitHub does not allow admin roles for collaborators on a personal-account repo, and organizations can only be created from the GitHub web UI.
**Decision:**
- Now: the owner `chitrangad-ram-sapate` has master control. `ruturajnalbalwar-arch`, `thevipulbangar` and `Physics0070` are write collaborators.
- `CODEOWNERS` maps each module to its PRD owner (A–D).
- `main` is protected through pull requests when the plan allows it.
- When an organization is created, the repo is transferred to it. The four members become org owners or a `maintainers` team with admin. Each member can link their own organization through forks or outside-collaborator access.

**Steps:** in `GOVERNANCE.md`.

### D-023 · Deployment · Accepted
**Decision:**
- One `Dockerfile` (Python 3.11.9-slim, pinned `requirements.txt`).
- `docker-compose.yml` runs `api` (uvicorn :8000) and `ui` (streamlit :8501). Ports are published on `127.0.0.1` only, keeping the PRD's local-only stance.
- A non-Docker path is provided: `scripts/run.ps1` / `make run`.
- GitHub Actions CI runs `pytest` on every push and PR.

**Why:** It runs the same on any laptop, starts with one command, and uses no cloud data (out of scope §5.4).

### D-024 · At-risk uses the shortest leg over all routes, active or not · Accepted
**Context:** PRD §7.4 defines t_l as the "shortest active transit". Closing a godown's shortest route could then turn its lots at-risk and add write-off credit, so V\* *rose* under `ROUTE_CLOSURE`. That violates property P4 (closures never increase V\*). It was found by the property tests on random seeds.
**Decision:** t_l = the shortest transit from the lot's godown over all routes, ignoring `active`. At-risk is then a property of the lot, unchanged by disruptions. Eligibility itself still requires an active route.
**Why:** It restores P4 without touching the LP. The credit is meant to price expiry, not to reward a closure.

### D-025 · Mobile and web: Capacitor + TypeScript, engine on device via Pyodide · Accepted
**Context:** ARIA must ship as an Android and iOS app (and on Firebase) at zero cost, with no billing account.
**Decision:**
- One TypeScript + Vite mobile-first web app in `mobile/`. Capacitor packages it as native Android and iOS apps, and the same build is the Firebase Hosting website.
- The existing Python engine runs **on the device** in Pyodide inside a Web Worker. The optimizer, verifier, reason codes and `.svcr` are the same code that the tests cover.
- The desktop FastAPI + Streamlit path stays for the offline judged demo (PRD J1–J4, KPI-9).

**Why:**
- No server means no billing, no cold starts, and planning works offline, matching PRD persona U1 ("intermittent 4G").
- One engine codebase means the verified guarantees (P1–P7, V1–V8) hold on the phone too, instead of being re-implemented in another language.

**Alternatives rejected:**
- React Native or Flutter: a full UI rewrite, and the engine would still need a server.
- Native app + Cloud Functions API: needs the Blaze plan (billing).
- Hugging Face Spaces / Render: not Firebase, and they sleep when idle.

**Costs:**
- The first load downloads the Python runtime (about 15–20 MB, bundled inside the native apps).
- Solves are slower than native.
- iOS builds need macOS: a Mac with Xcode, or the `mobile.yml` macOS CI job.

### D-026 · `.svcr` — Scenario-Verified Consignment Record · Accepted
**What it is:** ARIA's own file extension (`.svcr`, MIME `application/vnd.aria.svcr+json`). One UTF-8 file contains:
- a header line `SVCR/1 sha256=<digest>`;
- canonical JSON holding the **verified dispatch plan together with the exact scenario it was solved on** (stock, lots, routes, forecasts, policy) and its `scenario_hash`.

Implemented in `aria/svcr.py`, tested in `tests/test_svcr.py`.

**The specific problem it solves:**
1. The plan is made by U1 (the planner) at night, but it is executed at 6 am by U2 at the godown. U2 works on a shared desktop or phone with intermittent 4G (PRD §3).
2. ARIA has no server, database or user accounts by design (§5.4). So the plan has to travel as a file, over WhatsApp, Bluetooth or USB.
3. A CSV pick list loses everything that makes the plan trustworthy. It doesn't show which inputs it came from, or whether it passed V1–V8. Anyone can edit a quantity, and the dispatcher can't tell.
4. That would break two PRD rules: "no unverified plan ever reaches the screen" (§7.8) and "every result labelled with scenario_hash" (§4).

**How `.svcr` keeps those rules across devices:** the receiving app checks three things offline, on the device, before showing a single row:
- (a) the digest, which catches corruption or hand edits;
- (b) `scenario_hash`, which proves the plan is bound to these exact inputs;
- (c) a full **re-run of the independent verifier** on the embedded scenario, which proves the plan is feasible: lot stock, shelf life on arrival, capacity, value order.

If any check fails, the file is rejected with the reason. So a dispatcher never trusts the sender, only the maths.

**Other uses:**
- Disruption Lab results (J4) can be shared as `.svcr`.
- Auditors (U3) can replay any past plan exactly, because the full inputs are inside the file.
- A plain JSON file would not be recognised by the OS or opened by the app on tap. A registered extension makes "tap file → ARIA opens → verified pick list" work on Android and iOS.

**Limits (stated plainly):** the SHA-256 digest proves integrity, not authorship, because anyone can recompute it. The verifier re-run is the real guarantee. Ed25519 signing can be added if senders ever need authenticating, but user accounts are out of scope today.

### D-027 · Hosting: Firebase Hosting, free Spark plan · Accepted
**Decision:** Firebase project `aria-triwiz` (Spark plan, no billing account). Hosting serves `mobile/dist`. There are no Cloud Functions: the engine runs in the browser (D-025).
**Why:** Python Cloud Functions require the Blaze plan, which needs a billing account. Static hosting plus on-device compute is completely free and never sleeps.

### D-028 · SciPy HiGHS fallback · Accepted
**Decision:** `aria/engine/optimizer.py` uses highspy when it is available (desktop, CI). Otherwise, or when `ARIA_SOLVER=scipy`, it uses `scipy.optimize.linprog(method="highs-ds")`, which is the same HiGHS dual simplex. Reduced costs come from the bound marginals. Both backends are tested to give an identical V\*.
**Why:** highspy has no Pyodide build, while SciPy does. Keeping one solver family keeps the duals, integrality and stage-2 logic identical.

### R-001 · Replay results, kolhapur (measured, not tuned) · 2026-10-24
Setup: 100 products, 2 × 28-day held-out windows (2016-03-28..04-24 and 04-25..05-22). Conservation held everywhere, no leakage, 0 verifier failures, 95 s runtime.

| KPI | Result |
|---|---|
| KPI-1 (ARIA − b″) at own vehicle class | −₹16.99 lakh, CI [−39.7 lakh, −₹0.04 lakh]: **PASS** |
| KPI-1 at all-₹3.78 | **PASS** |
| KPI-1 at all-₹11.03 | CI upper bound +₹11.6k: **FAIL** |
| KPI-1b, KPI-1c, KPI-3, KPI-4 (all freight points) | **PASS** |
| KPI-10 | **FAIL**: KPI-1 does not hold at all-6t |

Bills at the headline point, in ₹ lakh: (a) 284.6 · b′ 216.6 · b″ 213.1 · ARIA 196.1 · hindsight 223.6.

**Caveats:**
- Write-off is about 98% of every bill. It comes from the synthetic 5–10-day shelf-life classes (D-015, A8), so the CIs are wide.
- "% gap closed" is above 100% because hindsight (c) plans day by day and is not a bound (PRD FIG 7).

**Response, as pre-registered in PRD §9:** report as measured and use the P1-05 ablations to explain. No pass rule and no data parameter was changed after seeing these results.
The `maharashtra` network (40 products) is reported only (D-020). KPI-1 fails there at own / 3.78 / 6t and passes at 55t. KPI-1c, KPI-3 and KPI-4 pass.

### D-029 · Real-world simulation and human-like testing, worldwide · Accepted
**Context:** The app must be tested the way people actually use it, under realistic and unbiased conditions, and for any region, not only Kolhapur.
**Decision:**
- **World generator (`aria/sim/world.py`):** builds a distributor network anywhere from the GeoNames `cities15000` open dataset (CC BY 4.0). Regions are sampled uniformly over countries first, so populous countries do not dominate. Any user can generate a network for their own region from the CLI.
- **Real-life conditions (`aria/sim/conditions.py`):** a stratified, seeded catalogue of disruptions and messy inputs (monsoon closures, truck bans, losses, festivals, expiry gluts, Excel/Unicode CSV quirks, invalid entries). Every class gets equal coverage.
- **Virtual users (`aria/sim/users.py`):** personas from PRD §3 plus a novice and a fat-finger user. They drive the real API and the real Streamlit UI, including double-submits, edits mid-solve, tampered `.svcr` files and monkey sequences.
- **Invariants:** pre-registered in `aria/sim/INVARIANTS.md` before the first run and never changed after seeing results.
- **Report:** `reports/sim_report.md` gives a reproducer (seed + steps) for every failure. A fast subset runs in CI.

**Why:** Unit and property tests prove the maths. They do not prove that a tired dispatcher with a bad CSV and 2G connectivity gets a truthful screen. Sampling regions and conditions with fixed seeds and pre-registered invariants keeps the testing honest.

### D-030 · Problem-statement compliance features in the app · Accepted
**Context:** A check of the official Problem Statement 2 text against the app found 5 gaps. The engine covered every requirement, but the app did not *show* them all.
**Decision:** The mobile app adds:
1. an **Assumptions** screen (A1–A9, the parameter registry with sources, data sources, limitations), because the statement requires that "All assumptions should be clearly stated";
2. **visible demand forecasts**, and on-device forecasting for imported CSVs (scikit-learn quantile gradient boosting + split conformal in Pyodide, or labelled empirical quantiles as a fallback; LightGBM stays the batch model);
3. an **Impact card** on the statement's three goals (stockouts, transportation cost, wastage) versus the rule-based baseline;
4. an **excess-stock list** next to the shortfall list ("stockouts here, excess there");
5. **bundled replay results**, so the efficiency proof works offline.

**Why:** These are the statement's own evaluation words. Each one must be visible in the product, not only in the docs.

### D-031 · Ownership and contribution flow · Accepted
**Owners:**

| Area | Owner |
|---|---|
| A: optimizer | `chitrangad-ram-sapate` |
| B: data & forecasting | `ruturajnalbalwar-arch` |
| C: verifier & replay | `thevipulbangar` |
| D: mobile app, Firebase, demo | `Physics0070` |

Encoded in `.github/CODEOWNERS`.

**Flow:** work for an area goes to an `owner/<area>-<topic>` branch. Its PR is assigned to that area's owner, who reviews it. Each commit's author and committer are both the owner of the area it touches (GitHub noreply address), as agreed by the team. Owners can also commit directly from their own logins (see `GOVERNANCE.md`).

### D-032 · App UI: light card design, plain language, pill navigation · Accepted
**Context:** The team supplied reference screens: a light inventory app with white cards, big numbers, green status chips, one orange call to action, location lists, and a floating pill nav with a raised blue centre action. The app must be simple for every user, not only analysts.
**Decision:**
- **Light theme only.** Background `#f3f4f6`, white cards, text `#111827`, muted `#555c68` (≥ 4.5:1 on both surfaces).
- **One orange primary action per screen** (`#d9480f`, bold 18.7 px white text: WCAG AA large text). Outlined secondary buttons.
- **Chips:** green `#15803d`/`#dcfce7` (4.57:1), amber, red.
- **Navigation:** floating pill with Home · What if · **blue raised centre "Plan tonight"** · Results · Files. "How ARIA decides" (assumptions) sits behind the header help button.
- **Home:** a "To ship tonight" hero (big units number, Verified chip, depots → towns), freight and shortages, then Pick lists / Share plan / Edit stock tiles.
- **"Compared with the usual method":** plain "N% lower/higher" chips for the statement's goals.
- **Lists:** shipments by depot, shortages with plain-language reasons (codes kept in the detail sheet), extra stock.
- **Technical details** (hashes, solver stages, metrics, τ\*) stay one tap away, never removed.
- **Default scenario:** the app opens on a typical day ("normal week"), not a stress test.

**Why:** Distributors and dispatchers need the answer (what to load, from where, and is it trustworthy) before the method. The verifier badge, the scenario hash and the comparison against the usual method stay visible, so simplicity costs no transparency.
**Alternatives rejected:**
- Dark theme by default: the reference is light, and outdoor godown use favours light.
- Data tables as the main view: too dense for non-technical users.

### D-033 · Data enters through one CSV file · Accepted
**Context:** Every number the app planned on came from bundled JSON scenarios; users could only import sales history. Teams need to run their own network, stock and demand without code changes.
**Decision:**
- **One data CSV** with sections (`# settings`, `# products`, `# depots`, `# towns`, `# routes`, `# stock`, optional `# town_stock`, then `# demand` or `# sales`). The format is in `docs/csv-format.md`; the parser is `engine/dataset_csv.py`.
- **Errors carry table and line numbers.** A rejected file changes nothing. Model-level rules (shelf life, routes, references) are then checked by the existing validator.
- **A partial file** (for example only `# stock`) updates those tables and keeps the rest; the app says which were kept.
- **Samples load through the same reader**, converted to CSV first, so there is one data path. The round trip is exact: all 4 samples keep their `scenario_hash`.
- **The app opens empty** until a CSV or a sample is loaded. The last dataset is stored on the device as CSV (including saved stock edits) and restored on the next start.
- **Defaults** for empty optional cells come from the engine schema (for example `vehicle_class` road_avg, `min_days_at_receipt` 0) and are listed in the in-app format sheet.

**Why:** The engine is network-agnostic (D-020); the data entry must be too. A spreadsheet is what distributors already keep.

### D-034 · Assumptions screen removed from the app · Accepted
**Context:** The team asked to drop the separate Assumptions section.
**Decision:** The screen, its header help button and the engine call are gone. No calculation read it: it only displayed `assumptions.yaml`, which moves to `docs/assumptions.yaml` so the assumptions stay documented. The parameters themselves are unchanged and still used by the engine.

### D-035 · What-if: scenarios from model inputs, compared with the baseline · Accepted
**Context:** The old screen applied one shock at a time. Its truck-restriction list had a single entry, "6t", which read as "six turns, one option".
**Decision:**
- **"6t" is the 6-tonne truck class, not a turn limit.** A restriction can only force a class that is dearer per tonne-km than the route's own class; `shocks.apply` ignores any other. Most sample routes already use 6t, the dearest class, so the list could never offer more. The list is now built from the route's data (`analysis.vehicle_options`); when it is empty the app explains why.
- **Scenarios** (up to 8 plus the baseline) combine:
  - demand change (−90 % to +200 %, by product and town);
  - depot loading capacity (% of capacity, or of baseline shipments when a depot has no limit);
  - freight rate change, stock lost by depot and product, and trade margin;
  - any number of route closures and truck restrictions.

  Closures, restrictions and stock loss reuse the existing shocks. Demand scaling is the FESTIVAL_SPIKE rule, allowing decreases.
- **`compare`** plans the baseline and every scenario with the unchanged pipeline (ARIA, else the labelled usual method). It returns KPIs with absolute and % differences, and flows and depot loads per scenario. Plans are cached by `scenario_hash`, so editing one scenario re-solves only that one.
- **Step sweep:** one input over a user-chosen range and number of steps (2-12), drawn as line charts.

**Why:** "What if demand rises?" or "what if a depot loads less?" is answered by changing the model's real inputs and re-planning, never by invented formulas.

### D-036 · Results dashboard · Accepted
**Context:** Results showed only the bundled replay table.
**Decision:** Results is built from tonight's plan (`analysis.summarize`). It shows:
- KPI cards, each compared with the other method;
- the network diagram;
- donuts for units by depot and short units by reason;
- a % bar chart of ARIA against the usual method;
- bars of units sent against median demand per town;
- a histogram of shelf life left on arrival;
- a flowchart of how the plan was made, with real counts;
- the sales-history line chart (when the CSV has sales);
- the What-if comparison and sweep;
- a depot and route table.

Badges mark data, calculated output and projections. The bundled replay appears only for samples, labelled as a historical test. Charts are dependency-free SVG (`src/charts.ts`) with a fixed colour order, tap tooltips and a "Show as table" view on every chart.
**Network diagram:** depots on the left, towns on the right, ordered by barycentre to reduce crossings. Rows have fixed height, so nodes and labels never overlap. Arrow width shows units. Tapping a node or arrow shows its numbers. Unused and closed routes appear on request. With more than 25 towns, towns that get nothing are folded.

### D-037 · Stock edits are saved explicitly · Accepted
**Context:** Edits in "Edit depot stock" applied on every keystroke, with no way to cancel.
**Decision:** The sheet edits a draft. **Save stock** applies it, re-validates the inputs and stores the dataset on the device; **Cancel** discards it. Save is disabled while any value is not a whole number of 0 or more.

### D-038 · Everyday wording in the app · Accepted
**Context:** The app showed the words its developers use: sample names like "kolhapur edge cases", input problems as `E_RANGE $.lots[3].remaining_life_days`, "τ*", "stage 1 Optimal", "baseline", "shadow price", "VERIFIED / REJECTED".
**Decision:**
- Samples have plain names ("Kolhapur: small example").
- Input problems name the thing and say what is wrong ("Stock of MILK at North depot has more days left than the product's whole shelf life"). Notes are grouped ("6 routes are closed").
- What if compares with "today", not "the baseline".
- The flowchart, the explain sheet, plan files and the past-weeks results use everyday words.
- Hashes, solver stages and codes are no longer shown.

Engine names, CSV column names and the decision log are unchanged.

### D-039 · Admin and driver accounts · Accepted
**Context:** The team asked for a login step and two roles: an admin with full control who sees every driver under them, and drivers with minimal control.
**Decision:**
- **Firebase Auth** (email and password) and **Firestore**, both on the free Spark plan, in the existing `aria-triwiz` project. Planning stays on the phone (D-025); only people, trips and problem reports are shared. Firestore's offline cache lets drivers mark deliveries without signal; changes sync later.
- **Admin:** signing up creates a team and a 6-letter code (no 0/O or 1/I/L). The admin keeps everything the app had and gains a **Team** screen:
  - drivers with their status and when they were last seen;
  - pause or allow each driver;
  - send tonight's plan as one trip per depot (a depot already sent for this plan shows who has it, so nothing is sent twice);
  - follow deliveries and read drivers' reports.
- **Driver:** joins with the code and sees only My trips, Report a problem and Account. The planner is never loaded on a driver's phone.
- **Rules (`firestore.rules`):**
  - teams are kept apart;
  - nobody can change their own role, team or paused state;
  - a driver reads and updates only their own trips (status and stops);
  - a paused driver loses access immediately;
  - only an admin creates or removes trips, and only for drivers in their team.

  `scripts/rules-test.mjs` checks 26 cases against the emulators.
- Live listeners restart after an error. A brand-new account is not on the server for a moment, and Firestore otherwise ends a listener on its first error.

**Alternatives rejected:** accounts stored only on the phone (an admin could not see drivers on other phones); a separate server (not free, and against D-027).

### D-040 · Plan files sent to drivers inside the app · Accepted
**Context:** The admin should share the `.svcr` plan file directly with drivers, and drivers should view it in the app.
**Decision:**
- **Sending:** Home → **Share plan** offers "Send to drivers in the app" (tick one or more drivers) next to the existing "Share to WhatsApp, email...".
- **Storage:**
  - A plan file is about 1 MB because it carries the whole dataset. It is gzipped (about 115 KB) and stored in Firestore under `orgs/{org}/files/{id}`, in 700 KB pieces under the 1 MiB document limit.
  - Firebase Storage was not used: new projects need the paid plan for it (D-027).
  - Each driver gets their own copy, so access is simply "the driver it was sent to".
- **Driver's Plans tab:** files sent to them, marked New until opened. Opening one:
  - checks the file's fingerprint (sha256, as in `aria/svcr.py`) in the browser, with no planner needed;
  - shows units, depots and towns, a pick list per depot and town, and the shortages in plain words.

  **Run the full safety check** loads the planner on demand and runs the same check as the admin's Files screen (fingerprint of the data plus all 8 safety rules). Drivers can also open a `.svcr` that reached them another way (WhatsApp, email).
- **Admin's Team screen** lists sent plan files with "Opened" or "Not opened yet", and each can be removed.
- **Rules:** only an admin of the team sends or removes files, and only to a driver in the team. A driver reads only their own files and can only mark them opened. A paused driver loses access. These cases are added to `scripts/rules-test.mjs` (35 checks).
