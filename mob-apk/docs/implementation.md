# ARIA — Implementation Plan

_Source of truth: `cyberpunk.pdf` (ARIA PRD v2.2 final, Team Cyberpunk, TRIWIZATHON 2026, Problem Statement 2, dated 24 Oct 2026)._
_This plan turns the PRD into an ordered build. Any change to it gets logged in `decision.md`. Session state lives in `handoff.md`._

---

## 0. How to use this document

- **§1–§3**: what we're building, the rules every module follows, and the repo layout. Read these first.
- **§4**: the math, written precisely enough to code from. Every formula cites its PRD section.
- **§5**: the build phases, in order, each with tasks, owner, PRD requirement IDs and an exit check.
- **§6–§9**: per-module specs (API, UI, tests, replay).
- **§10–§12**: gates, cut order, risks, traceability matrix, definition of done.

Status markers: ⏳ not started · 🟡 in progress · ✅ done · ❌ blocked.

Shorthand (from the PRD glossary):
- **τ** is a demand quantile level. **τ\*** is the service level up to which shipping a unit is worth it.
- **V\*** is the optimal expected net value of a plan.
- **FEFO** means first-expiry-first-out.
- **(a), b′, b″, (c)** are the baselines (FR-P0-07).
- **Hn** means hour n of the 18-hour build (H0 = build start).
- Owners: **A** optimizer & explanations · **B** data & forecasting · **C** baselines, verifier & replay · **D** validation, API, UI & demo.

---

## 1. What we are building (one paragraph)

ARIA is a Python web app for one super-stockist in Kolhapur. The super-stockist has 3 godowns (Shiroli, Gokul Shirgaon, Kagal MIDC) serving 6 towns (Kolhapur, Ichalkaranji, Jaysingpur, Kagal, Gadhinglaj, Ratnagiri), which gives 18 routes. Each planning day ARIA:

1. **Forecasts** demand per (town, product) as 9 calibrated quantiles, using LightGBM, mlforecast and conformal calibration.
2. **Prices** every unit with a freight-aware value, so every (route, product) gets its own service level τ\* = (c_u − f)/(c_u + h).
3. **Allocates** lot by lot with two min-cost-flow LPs in HiGHS. Stage 1 maximises value. Stage 2 is an exact FEFO tie-break that loses no value.
4. **Verifies** every plan with independent code (V1–V8) and gives every shortfall exactly one reason code.
5. **Re-routes** under shocks in the Disruption Lab. The live demo is the Amba Ghat 6-ton restriction, which takes Ratnagiri τ\* from 0.856 to 0.588 and must re-plan in ≤ 10 s.

ARIA is proven by a **fair replay**: one full-cost ₹ bill on realised M5 demand, compared against baselines (a), b′, b″ and (c), with bootstrap CIs. **Headline KPI-1:** the upper 95% CI of (ARIA − b″) total bill must be < 0.

---

## 2. Non-negotiable engineering rules (apply to every module)

| # | Rule | PRD basis |
|---|---|---|
| R-1 | **Money is integer paise; quantities are integer units.** Floats are allowed only inside forecasting and statistics. Values are converted to int at the boundary. | §7.5, §FR-P0-05 |
| R-2 | **The engine is pure functions.** Same input gives the same output. No globals, no I/O inside `aria/engine/*`. | §7.2 FIG 10 |
| R-3 | **The UI only formats numbers returned by the API.** No computation in Streamlit. | §4 |
| R-4 | **The verifier is code separate from the solver.** `aria/verify/` must not import `aria/engine/optimizer*`. | App. B, FR-P0-08 |
| R-5 | **One metrics function** is used by the plan view, the replay and the KPIs. | FR-P0-08, FR-P0-09 |
| R-6 | **No unlabelled or unverified plan ever reaches the screen.** Failure paths follow §7.8. | §7.8 FIG 16 |
| R-7 | **The interactive path never trains a model.** Forecasts are batch jobs read from Parquet. | §7.2 |
| R-8 | **Fully offline at demo time.** Bind to 127.0.0.1. Zero outbound connections (KPI-9). | §7.7, KPI-9 |
| R-9 | **Every parameter has a source and status** in the parameter registry (`data/params.yaml`). | FR-P0-01, App. D |
| R-10 | **Pass rules in §9 are pre-registered.** Never change a KPI rule after seeing replay results. | §9 |
| R-11 | **Deterministic ordering everywhere:** sort by ID for ties. Relabelling IDs must not change V\* (P5). | P5, App. C |
| R-12 | **Never cut:** FR-P0-04, -06, -08, -10 and the `ROUTE_RESTRICTION` shock. | §5, §8 |

---

## 3. Repository layout

```
E:\Triwiz\
├── cyberpunk.pdf                 # PRD (source of truth)
├── implementation.md             # this file
├── decision.md                   # decision log
├── handoff.md                    # session baton pass
├── README.md                     # run instructions (created in Phase 0)
├── demo.md                       # demo script (FR-P0-12, Phase 7)
├── pyproject.toml                # pinned deps, Python 3.11.9
├── requirements.lock             # exact pins for the USB wheelhouse
├── Makefile / tasks.ps1          # `make data`, `make forecast`, `make replay`, `make test`, `make run`
├── data/
│   ├── raw/                      # M5, Census, FoodKeeper, OFF, OSM extracts (git-ignored, from USB)
│   ├── params.yaml               # Appendix D parameter registry (value, status, source)
│   ├── mapping.yaml              # town → M5 store, item → kg category, shelf-life class
│   ├── network.yaml              # 3 godowns, 6 towns, 18 routes: road_km, transit_days, vehicle_class
│   ├── scenarios/                # normal_week.json, monsoon_squeeze.json, edge_cases.json
│   └── aria.duckdb + *.parquet   # built artefacts: quantiles, lots, replay_results, data_hashes
├── aria/
│   ├── __init__.py
│   ├── schemas.py                # Pydantic v2 models: Scenario, Product, Godown, Town, Lot, TownStock, Route, Policy, Plan, Shock
│   ├── validate.py               # cross-record rules → E_* / W_* codes with JSON paths (App. A)
│   ├── hashing.py                # canonical JSON + SHA-256 scenario_hash
│   ├── params.py                 # loads params.yaml; exposes registry for explain cards
│   ├── data/
│   │   ├── build.py              # B1: raw → Parquet/DuckDB (`make data`)
│   │   ├── m5.py                 # FOODS_3 top-100, store→town rescale by Census share
│   │   ├── csv_import.py         # distributor CSV (date,item,outlet/town,qty,price) → same schema
│   │   ├── lots.py               # synthetic lots + shelf-life classes (FoodKeeper ranges)
│   │   ├── network.py            # road km / transit / vehicle class → routes
│   │   └── scenarios.py          # generates the 3 bundled scenarios + random scenario generator (tests)
│   ├── forecast/
│   │   ├── train.py              # B2/B3: mlforecast + LightGBM, 9 quantiles, conformal
│   │   ├── segments.py           # 9 quantiles → 100 integer demand segments (FIG 6)
│   │   └── gaussian.py           # point + σ → Gaussian quantiles (baseline b′)
│   ├── engine/
│   │   ├── eligibility.py        # FR-P0-04 (+ at-risk classification)
│   │   ├── values.py             # FR-P0-05: c_u, h, f, v_j, write-off credit, τ*
│   │   ├── network_model.py      # builds the min-cost-flow arrays (nodes, arcs, bounds, costs)
│   │   ├── optimizer.py          # FR-P0-06: stage 1, RC classification, stage 2, integer V check, duals
│   │   ├── baseline_a.py         # App. C deterministic greedy
│   │   ├── baselines.py          # b′, b″, (c) — reuse optimizer with modified values/segments
│   │   ├── reasons.py            # FR-P0-10 / §7.6 reason codes + explain facts
│   │   ├── shocks.py             # FR-P0-11: INVENTORY_LOSS, ROUTE_CLOSURE, ROUTE_RESTRICTION (+ FESTIVAL_SPIKE P1)
│   │   ├── diff.py               # before/after plan diff + τ* changes
│   │   └── pipeline.py           # plan(scenario) → {aria, baseline_a}: the §7.3 sequence
│   ├── verify/
│   │   └── verifier.py           # V1–V8 (no solver imports)
│   ├── metrics.py                # THE one metrics function
│   └── replay/
│       ├── simulate.py           # day loop: inflow, plan, sell, age, write-off, conservation
│       ├── bootstrap.py          # moving-block bootstrap (7-day blocks, 1,000 resamples)
│       └── run.py                # B4/B5: all policies × 2 windows × 3 freight points → replay_results
├── api/
│   └── main.py                   # FastAPI: /health /scenarios /import /validate /plan /whatif /explain /replay
├── ui/
│   ├── app.py                    # Streamlit entry
│   └── pages/ plan_compare.py · proof.py · disruption_lab.py
└── tests/
    ├── fixtures/                 # hand-computed 2×2, FEFO fixture, metrics fixture, one fixture per validation rule
    ├── test_validate.py  test_eligibility.py  test_values.py  test_optimizer.py
    ├── test_baseline_a.py  test_verifier_mutations.py  test_reasons.py  test_shocks.py
    ├── test_properties.py        # P1–P7 on ≥ 200 random scenarios (hypothesis or seeded RNG)
    ├── test_replay.py            # conservation (zero tolerance), no leakage
    └── test_api_contract.py      # every displayed KPI == API value
```

---

## 4. The math, exactly as we will code it

### 4.1 Forecast → demand segments (FR-P0-03, FIG 6)

- Quantile levels (M5, R11): `L = [0.005, 0.025, 0.165, 0.25, 0.5, 0.75, 0.835, 0.975, 0.995]`.
- Pipeline: mlforecast + LightGBM (one quantile objective per level), then conformal calibration on data before the forecast origin (R13), then uncross (sort quantiles so they are monotone), then interpolate to segments.
- Segment grid β = `[0, 0.01, 0.02, …, 0.99, 0.995]`, so **100 segments**: j = 1..99 have τ_j = 0.01·j, and j = 100 has τ = 0.995.
- Q(0) = 0. Interpolate Q(β) linearly in τ between the anchor points {(0,0)} ∪ {(ℓ, Q(ℓ))}, round to integer units, then force monotonicity with a cumulative max.
- b_j = Q(β_j) − Q(β_{j−1}) ≥ 0, so Σ_j b_j = Q(0.995) = Q_top.
- Segment j covers (Q(β_{j−1}), Q(β_j)] with level τ_j = β_j.
- **Town stock** (on-hand, unexpired) fills the lowest segments first: subtract on-hand from b_1, b_2, … before building capacities (C3).
- Store a coverage table (nominal / raw / conformal) per level. This is an acceptance item for P0-03 and feeds KPI-2.

### 4.2 Unit economics (FR-P0-05, §6.1, App. D) — all in integer paise

| Symbol | Definition | Notes |
|---|---|---|
| price | `price_paise` per unit | from M5 sell_prices → INR (see decision D-013, **open**) |
| margin | 0.035 base; 0.05 sensitivity | R6 |
| unit cost | price × (1 − margin) | **inferred**; reproduces every §6.1 number (decision D-006) |
| c_u | price × margin × town priority (default 1.0) | lost margin per unit of unmet demand |
| h | unit cost × 0.055 / 365 | repo rate 5.50% (R14); a lower bound |
| f_{l,s} | rate(vehicle_class) ₹/t-km × kg_per_unit / 1000 × road_km | rates: 55t ₹1.51, road avg ₹3.78, 6t ₹11.03 (R1) |
| E_k | unit cost × (1 − salvage_share) | write-off credit base; salvage swept 0–1 |
| v_j | c_u·(1 − τ_j) − h·τ_j | segment value **before** freight; freight sits on the arc |
| risk credit | E_k·(1 − τ_j) | only on segments filled by **at-risk** lots |
| τ\* | (c_u − f)/(c_u + h), capped at 0.995 and flagged | per (route, product) |

All values are rounded to integer paise **once**, when the arrays are built. Rounding can create ties between adjacent segments, so V8 and P3 only require that no unfilled segment is *strictly* higher-valued than a filled one.

**Sanity check (must be a unit test).** Product: 1 kg, ₹100, margin 3.5%, so c_u = ₹3.50 and h = 96.5 × 0.055/365 = ₹0.01454.

| Leg | f | τ\* (3.5%) | τ\* (5%) |
|---|---|---|---|
| no freight | 0 | 0.996 → capped 0.995 | 0.997 → capped |
| Kolhapur→Ichalkaranji ~30 km, 6t | ₹0.331 | 0.902 | 0.931 |
| Kolhapur→Ratnagiri ~130 km, road avg | ₹0.491 | **0.856** | 0.899 |
| Kolhapur→Ratnagiri, Amba Ghat 6t | ₹1.434 | **0.588** | 0.711 |

I reproduced all of these by hand while writing this plan. They hold only if unit cost = price × (1 − margin).

### 4.3 Eligibility & at-risk lots (FR-P0-04, §7.4)

Lot l (at godown w, product k) may serve town s **iff** all of these hold:
1. route (w, s) is `active`;
2. `remaining_life(l) − transit_days(w,s) ≥ min_days_at_receipt(k)` (equality is eligible; one day short is not);
3. `qty(l) > 0` and `remaining_life(l) > 0`.

**At-risk lot (L_risk):** let t_l be the shortest **active** transit from the lot's godown and m_k = min_days_at_receipt(k). The lot is at risk iff `r_l − t_l ≥ m_k` **and** `r_l − 1 − t_l < m_k`, i.e. `r_l − t_l == m_k`. It is shippable today and dead tomorrow. At-risk lots flow into the town's **RISK** entry node and earn the credit E_k(1 − τ_j).

### 4.4 Network-flow model (FR-P0-06, §7.4 FIG 12)

All products share one LP, because godown capacity C5 couples them. The model is still a single-commodity network because lot, entry and segment nodes are product-specific.

```
src ──[0..cap_w]──▶ godown w ──[0..q_l]──▶ lot l ──[x_{l,s}: cost f_{l,s}, eligible only]──▶ ENTRY(s,k) or RISK(s,k)
ENTRY(s,k) ──[y_{s,k,j}: gain v_j]──▶ SEG(s,k,j)
RISK(s,k)  ──[y^risk_{s,k,j}: gain v_j + E_k(1−τ_j)]──▶ SEG(s,k,j)
SEG(s,k,j) ──[0..b_{s,k,j} net of town stock]──▶ sink
```

- **Design rule (decision D-008):** every capacity (C1 q_l, C3 b, C5 cap_w) is a **column bound on an arc**, never a row. Rows are flow-conservation equalities only. Stage-2 exactness then depends only on column reduced costs (see 4.5).
- Integer capacities plus a network matrix make the problem totally unimodular, so HiGHS simplex returns an integral vertex (R23). No MIP.
- Expected size: ~100 products × 6 towns × 100 segments (doubled where risk stock exists) + ~5,400 shipment arcs, i.e. **65k–125k columns**. Guard: `E_SIZE` at > 300,000 columns.
- Build with `highspy` directly from NumPy CSC arrays (`passModel` / `addCols`), not a modelling layer, to protect the 2.5 s solve budget.

### 4.5 Two-stage solve (FR-P0-06, FIG 13)

1. **Stage 1:** maximise V = Σ v_j(y + y^risk) + Σ E_k(1−τ_j)·y^risk − Σ f·x. Use HiGHS simplex (dual or primal), `time_limit = 2.5`. Record `V*`, the primal values, the row duals and the column reduced costs.
2. **Classify arcs exactly:** costs are integers and the basis is unimodular, so duals and reduced costs are integral. Round them with `np.rint` and assert `|rc − rint(rc)| < 1e-6` (log it if not). Arcs with rc = 0 stay free. Every other arc is fixed at the bound it currently sits at (lower or upper).
3. **Stage 2:** minimise Σ r_l·x_{l,s} (shorter-life lots first) on the restricted model, `time_limit = 2.5`.
4. **Exact check:** recompute V from the stage-2 integer solution in Python integers. If `V(stage2) == V*`, return the stage-2 plan. Otherwise (or on timeout) return the stage-1 plan labelled **"not FEFO-tie-broken"** with `stage1_only = true`.
5. Return the duals. The lot shadow price is shown as "indicative" in explain cards because duals are non-unique.

### 4.6 Baselines (FR-P0-07, FIG 7, App. C)

| Policy | Implementation | Isolates |
|---|---|---|
| **(a) rule-based** | App. C greedy, verbatim. Products ascending by id. Towns by (desc point forecast, asc id). need = min(round(point + 1.65σ), Q_top). Godowns by (asc freight/unit, asc id). Lots by (asc remaining life, asc id). Same eligibility. | current practice (A7) |
| **b′** | Same optimizer and values, but segments come from **Gaussian** quantiles (point forecast + σ) | value of calibrated forecasting (KPI-1b) |
| **b″** | Same optimizer, calibrated quantiles, ARIA's own values incl. write-off credit, **+ constant R_g = (max freight/unit over active arcs) + 1 paise** on segments with τ ≤ 0.95. Segments with τ > 0.95 are **closed** (b = 0). | THE idea (KPI-1 headline) |
| **ARIA** | per-route τ\*, stage 1 + stage 2 | — |
| **(c) hindsight** | Same optimizer with a single degenerate segment = realised demand per day | reference only, not a bound |

### 4.7 Reason codes (FR-P0-10, §7.6 FIG 15) — first match wins

A **shortfall row** is a (town, product) where on-hand + shipped < T. T = Q(τ\*) on its cheapest eligible route, or Q(0.5) if no eligible route exists.

1. `NO_STOCK_ANYWHERE`: no unexpired stock of the product anywhere.
2. `NO_ELIGIBLE_STOCK`: stock exists but no eligible arc. Sub-codes `NO_ACTIVE_ROUTE` / `SHELF_LIFE_AT_RECEIPT`, with unit counts.
3. `STOCK_BLOCKED`: eligible stock remains but the godown is at capacity or net value ≤ 0. Sub-codes `CAPACITY_BOUND` / `UNECONOMIC`.
4. `SUPPLY_USED`: no eligible stock remains. Sub-codes `SUPPLY_EXHAUSTED` (all went here) / `ALLOCATED_ELSEWHERE` (list the recipient towns + net ₹ of each one's last unit after its own freight).
5. `UNCLASSIFIED`: must be 0 for optimal plans (P6). If it happens, show the raw numbers.

In baseline (a), lower-value recipients are flagged.

### 4.8 Verifier (App. B) — separate code, runs on every plan

V1 integer, non-negative quantities · V2 lot stock respected · V3 every shipment on an eligible arc · V4 on-hand + shipped ≤ Q_top = Σ b_j · V5 dispatch capacity respected · V6 shortfall = T − (on-hand + shipped) · V7 all IDs exist · V8 segments within width, and no unfilled segment strictly higher-valued than a filled one.

A failing plan is **withheld and counted** (KPI-5). `aria = null`, and baseline (a) is shown, labelled.

### 4.9 Shocks (FR-P0-11)

- `INVENTORY_LOSS {godown, product|*, pct}`: scale lot qty down by pct (floor). `pct = 0` must produce an empty diff.
- `ROUTE_CLOSURE {godown, town}`: set the route inactive. Rows on a used lane disappear.
- `ROUTE_RESTRICTION {godown, town, max_vehicle:"6t"}`: re-price the arc at max(current rate, ₹11.03/t-km). This is the demo shock (Amba Ghat, R8).
- `FESTIVAL_SPIKE` (P1-02 only): uplift learned from M5 event days, placed on a Maharashtra festival date, labelled.
- Property P4: loss and closure never increase V\*, restriction never increases V\*, and adding stock never decreases V\*.

### 4.10 Fair replay (FR-P0-09, FIG 8)

- **Windows:** 2 held-out 28-day windows. No leakage: `train.max(day) < test.min(day)`.
- **Shared across policies:** daily godown inflow (A3: seasonal-naive network forecast, split equally across godowns), starting stock, lots, and the realised demand path.
- **Daily loop for each policy:**
  1. Add inflow.
  2. Plan.
  3. Ship.
  4. Sell realised demand from town stock (FEFO at the town).
  5. Unmet demand is a lost sale (A5).
  6. Holding h per unit-night on shipped-but-unsold units at a town.
  7. Age all stock 1 day; expired units are written off.
  8. Town stock carries over.
- **Bill** = freight + holding + write-off + lost margin, computed by the one metrics function. Godown stock carries no holding cost in any policy.
- **Conservation check (zero tolerance):** opening + received = sold + written off + closing. If `conservation_ok = false`, show nothing.
- **Statistics:** moving-block bootstrap on daily paired differences, 7-day blocks, 1,000 resamples, 95% CI.
- **Freight points:** each route's own vehicle class (headline), all routes ₹3.78, all routes ₹11.03, all routes ₹1.51 (reported only).
- **Exposé ("Is the headline real?"):** the same replay scored by lost units only vs full cost (the M3 trap).

---

## 5. Build phases

The PRD Gantt (FIG 17) maps to hours H0–H18 with four owners. Phases run in dependency order (FIG 5). **A builds 04/05/06 on fixture quantiles first and switches to real forecasts at H7.**

### Phase 0 — Environment & offline kit (H0–H1) · all owners ⏳
1. Install **Python 3.11.9**. This machine has 3.13.15 and 3.7 today, and the PRD pins 3.11.9 (M1). Create `.venv` with `py -3.11 -m venv .venv`.
2. Write `pyproject.toml` / `requirements.lock` with the pins: `fastapi`, `pydantic>=2`, `uvicorn`, `streamlit`, `mlforecast==1.1.0`, `lightgbm==4.7.0`, `highspy==1.15.1`, `duckdb`, `pyarrow`, `pandas`, `numpy`, `pyyaml`, `pytest`, `hypothesis`, `utilsforecast`, `httpx` (tests).
3. `pip download -r requirements.lock -d wheelhouse/` builds the USB wheelhouse (online install took 459 s, M1). Offline install: `pip install --no-index --find-links wheelhouse -r requirements.lock`.
4. Download datasets to `data/raw/`:
   - M5 from Zenodo (R10)
   - Census 2011 town populations (R16)
   - USDA FoodKeeper (R18)
   - Open Food Facts India extract (R18)
   - OSM Western Zone (R19), only if computing km. See D-014.
5. `git init`, `.gitignore` (`data/raw`, `.venv`, `wheelhouse`, `*.duckdb`, `*.parquet`), and a README skeleton.
6. **Exit check:** `python -c "import highspy, lightgbm, mlforecast, fastapi, streamlit, duckdb"` passes **with Wi-Fi off**.

### Phase 1 — Schemas, validation, fixtures (H1–H4) · D + A ⏳
1. `aria/schemas.py`: Pydantic v2 models per §7.5 FIG 14. Use int paise and int units everywhere. `Policy{margin, salvage_share}`. `Route{godown_id, town_id, road_km, transit_days, vehicle_class, active}`.
2. `aria/validate.py`: the App. A codes:
   - Errors: `E_REQUIRED`, `E_TYPE`, `E_RANGE`, `E_DUPLICATE_ID`, `E_BAD_REF`, `E_SIZE` (> 300,000 cols).
   - `E_RANGE` covers: negative qty/cost, remaining life > shelf life, min days > shelf life, priority ∉ [0.1, 10], salvage ∉ [0, 1], shock % ∉ [0, 100].
   - Warnings: `W_NO_ELIGIBLE_SUPPLY`, `W_EXPIRED_STOCK`, `W_INACTIVE_ROUTE`.
   - Every issue carries a JSON path. **All** errors are returned, not just the first.
3. `aria/hashing.py`: canonical JSON (sorted keys, no whitespace, ints) → SHA-256 = `scenario_hash`.
4. `tests/fixtures/`: one fixture per validation rule, a hand-computed 2×2 (2 godowns × 2 towns) scenario, a FEFO fixture, a metrics fixture, and **fixture quantiles** so A is unblocked.
5. **Exit check:** `pytest tests/test_validate.py` green (P0-02).

### Phase 2 — Engine core: eligibility, values, LP stage 1 (H1–H4) · A ⏳
1. `eligibility.py` (P0-04): boundary tests. Equality is eligible, one day short is not. At-risk classification.
2. `values.py` (P0-05):
   - c_u, h, f, v_j, risk credit and τ\*, all in int paise.
   - Unit test: **1 godown, 1 town, f = 0, ample stock** → filled level is the newsvendor quantile c_u/(c_u+h) within one segment (R12).
   - Unit test: §6.1 table numbers (4.2 above).
3. `network_model.py`: arrays for nodes, arcs, bounds and costs, with an index map back to (lot, town) / (town, product, j).
4. `optimizer.py` stage 1 with HiGHS and duals.
5. **Exit check (H4–7 in PRD):** stage 1 OPTIMAL on `normal_week`.

### Phase 3 — Data & forecasting (H1–H10) · B ⏳
1. `data/m5.py`: FOODS_3 top 100 products by volume.
   - Map 6 of the 10 M5 stores to towns in `mapping.yaml`.
   - Rescale each to the town's Census 2011 population share: Kolhapur 549,236; Ichalkaranji 287,353; Jaysingpur 48,510; Kagal 34,106; Gadhinglaj 27,185; Ratnagiri to be fetched at H1.
   - Keep M5's own event calendar.
2. `data/lots.py`: synthetic lots, shelf-life classes within FoodKeeper ranges, `min_days_at_receipt` per product (A4, A8).
3. `data/network.py` → `network.yaml`:
   - 18 routes with road_km, transit_days and vehicle_class.
   - Intra-district legs are 6t (A6). Ratnagiri legs run at road average normally.
4. `data/scenarios.py`:
   - `normal_week`
   - `monsoon_squeeze`: scarcity, near-expiry lots at far godowns. Must trigger codes 3 and 4 incl. `SUPPLY_EXHAUSTED`.
   - `edge_cases`: must trigger codes 1–3.
   - A random scenario generator for property tests.
5. `data/csv_import.py`: CSV columns `date,item,outlet/town,qty,price` map into the same schema. A fixture CSV must run forecast → plan → replay with no code change.
6. `forecast/train.py` (P0-03):
   - mlforecast + LightGBM, 9 quantiles, conformal calibration on data before the origin.
   - Uncross and store the coverage table. Time the full fit at H7. Fallback: top-50 products, labelled.
7. `forecast/segments.py` (4.1). `forecast/gaussian.py`: σ for b′ and (a).
8. `make data` / `make forecast` run end to end offline (P0-01).
9. **Exit check:** 9 non-crossing quantiles per (town, product, day). Coverage table stored. A switches from fixture quantiles to real ones at **H7**.

### Phase 4 — Verifier, metrics, baselines (H1–H10) · C ⏳
1. `verify/verifier.py` V1–V8, plus **one mutation test per V-code** (corrupt a valid plan, expect exactly that code).
2. `metrics.py`, the one function. The metrics fixture must be exact to the paisa.
3. `engine/baseline_a.py` (App. C): identical over 10 runs, and matches the hand-computed 2×2 fixture.
4. `engine/baselines.py`: b′, b″ and (c). b′ and b″ must pass the verifier.
5. `tests/test_properties.py`: P1–P7 on ≥ 200 random scenarios. The full suite must run in **< 60 s**.

### Phase 5 — Stage 2, reasons, pipeline, shocks (H4–H13) · A ⏳
1. Stage 2 + exact RC classification + integer V check (4.5). The FEFO fixture must show stage 2 ≠ stage 1. Both stages OPTIMAL on the bundled scenarios and 200 random ones.
2. `reasons.py` (4.7) + explain facts:
   - Explain facts: segments, τ\*, freight/unit, life on arrival, indicative lot shadow price, parameter sources.
   - Every primal fact must equal the plan or scenario value.
3. `pipeline.py`: validate → eligibility → values → stage 1 → stage 2 → verifier → metrics → reasons, with baseline (a) alongside. Implement the failure behaviour from §7.8.
4. `shocks.py` + `diff.py`:
   - Changed rows, Δ freight, Δ lost margin, new reason codes, and τ\* changes per (route, product).
   - `/whatif` reuses the cached "before" plan keyed by `scenario_hash`.
5. **Exit check:** J1 and J2 run end to end (H7–10). The `ROUTE_RESTRICTION` shock on Kolhapur→Ratnagiri shows the τ\* drop.

### Phase 6 — API & UI (H4–H15) · D ⏳
- API stubs first (H1–4) so the UI can be built against them. Wire up `/plan` at H7–10 and record hop timings.
- See §6 and §7 for the specs.

### Phase 7 — Replay & proof (H7–H15) · C + B ⏳
1. `replay/simulate.py` + `bootstrap.py` + `run.py`: window 1 first, then bootstrap CIs, then window 2.
2. KPI table: B owns the KPI-2 numbers, C owns KPI-1/1b/1c/3/4/10.
3. Cached results go to `replay_results` and are read by `/api/replay/{id}` and the Proof tab.

### Phase 8 — Gates, P1, demo (H13–H18) · all ⏳
- **H13:** early warning. **H15:** P0 gate. **H17:** no new P1. Record a screen capture at H17 as the fallback demo.
- P1 work starts only after a green H15: P1-01 Scarcity Value Map, then P1-05 ablations, then the others.
- `demo.md` + 2 rehearsals. Run KPI-8 (30 calls) and KPI-9 (`netstat` with Wi-Fi off).

---

## 6. API spec (FR-P0-12, §7.7)

JSON bodies; money in integer paise. Requests that compute something carry `request_id`, and responses echo it. Bind to **127.0.0.1**, no auth. Client timeout 15 s; server budget 10 s.

| Method | Path | Request → Response | Errors |
|---|---|---|---|
| GET | `/api/health` | → `{status, solver_version, data_hashes}` | — |
| GET | `/api/scenarios`, `/api/scenarios/{id}` | → list · Scenario | 404 |
| POST | `/api/import` | CSV → 202 `{scenario_id, rows, warnings[], forecast_job_id}` (starts batch forecast; not on the 10 s path) | 422 missing columns |
| POST | `/api/validate` | `{request_id, scenario}` → `{valid, errors[], warnings[], scenario_hash}` | 400 |
| POST | `/api/plan` | `{request_id, scenario}` → `{request_id, scenario_hash, solve_ms, recommended, aria: Plan, baseline_a: Plan}` | 422, 500 |
| POST | `/api/whatif` | `{request_id, scenario, shocks[]}` → `{request_id, before, after, diff:{aria, baseline_a}, tau_changes[]}` | 422 (shock index) |
| GET | `/api/explain/{plan_id}?town=&product=` | → `{segments[], tau_star, freight_per_unit_paise, life_on_arrival, lot_shadow_price_paise, reason, params:[{name,value,source}]}` | 404 |
| GET | `/api/replay/{id}` | → `{per_policy:{bill_paise, freight, holding, writeoff, lost_margin, fill_rate}, kpi1:{diff_paise, ci_low, ci_high}, freight_point, conservation_ok}` | 404; nothing shown if `conservation_ok=false` |

`Plan = {stage1_status, stage2_status, stage1_only, allocations[], shortfalls[], metrics, verifier:{passed, violations[]}}`. `aria` is `null` when there is no solution or the verifier fails.

**Latency budget (FIG 11):** request/validate/read 1.5 s · eligibility + values 0.5 s · 2 LPs 5.0 s (2.5 s each) · baseline + verifier + metrics + reasons 1.0 s · render 2.0 s = **10.0 s**. Replace these with measured p95 at H10.

---

## 7. UI spec (Streamlit, §4)

Three views. The UI only formats API numbers.

1. **Plan & Compare (J1, J2):**
   - Controls: pick scenario + day, or import CSV. Editable godown stock table (calls `/validate` on edit). **Plan tonight** button.
   - Output: lot table (godown → town → product → lot → units, freight ₹, life on arrival) and KPIs next to baseline (a). Pick-list CSV download per godown.
   - Clicking a row opens the explain card.
   - Shortfall rows show their reason code + facts.
2. **Proof (J3):**
   - Total ₹ bill per policy with 95% CIs, and a freight-point selector (₹1.51 / ₹3.78 / ₹11.03).
   - "Is the headline real?" panel: lost-units-only vs full-cost scoring.
   - Display-only "% of (a)-to-(c) gap closed". Shows "n/a" when its CI includes 0.
3. **Disruption Lab (J4, Judge Mode):**
   - Pick a shock and re-plan. Shows a side-by-side diff (changed rows, Δ freight, Δ lost margin, new reason codes).
   - **τ\* slider graphic** for the Ratnagiri leg, before vs after.

**Result integrity:**
- The client keeps an increasing `request_id` and shows only the latest response.
- Any input edit greys results as **STALE** and disables export.
- Every result is labelled with `scenario_hash`.
- On a network error, retry and mark the previous result stale.

---

## 8. Testing strategy (KPI-5/6/7)

| Layer | What | Pass |
|---|---|---|
| Unit | eligibility boundaries, values / τ\* table, segments sum, validation codes | exact |
| Fixtures | hand 2×2 for (a); FEFO stage2≠stage1; metrics to the paisa | exact |
| Mutation | one per V1–V8 | each mutation caught by its code |
| Property | P1–P7 on ≥ 200 seeded random scenarios | 100% |
| Replay | conservation (zero tolerance), no leakage | exact |
| Contract | every KPI displayed == API value | exact |
| Latency | 30 calls of /plan and /whatif, click → rendered | p95 and max ≤ 10 s |
| Offline | `netstat` during demo, Wi-Fi off | 0 outbound |

Full `pytest` suite: **< 60 s**.

---

## 9. Success metrics (pre-registered, §9 — do not edit after replay)

KPI-1 (ARIA − b″ bill, upper CI < 0) · KPI-1b (ARIA − b′) · KPI-1c (ARIA − (a)) · KPI-2 (scaled pinball ÷ seasonal-naive, upper CI < 1.0; conformal coverage closer to nominal than raw at every level) · KPI-3 ((freight+holding+write-off)/unit sold vs (a), upper CI ≤ 0) · KPI-4 (write-off units vs (a), upper CI ≤ 0) · KPI-5 (100% verified, withheld = 0) · KPI-6 (P1–P7 100%) · KPI-7 (UNCLASSIFIED = 0; 100% fact match) · KPI-8 (p95 & max ≤ 10 s, 30 calls) · KPI-9 (0 outbound) · KPI-10 (KPI-1 holds at all-₹3.78 and all-₹11.03; ₹1.51 reported).

Demo hypotheses H1–H3 are reported whatever the outcome. If a KPI fails, report it as measured and use the P1-05 ablations to explain.

---

## 10. Gates, cut order, risks

**Exit checks:**
- H0–1: Wi-Fi not needed.
- H1–4: unit tests green.
- H4–7: stage 1 OPTIMAL on `normal_week`.
- H7–10: J1 + J2 end to end.
- H13 warning · H15 P0 gate · H17 P1 freeze.

**Cut order if H15 is red:** (1) replay window 2 → (2) the exposé panel (keep the KPI-1 card) → (3) freight points down to ₹3.78 and ₹11.03. **Never cut** R-12.

**Risks:**

| Risk | Mitigation | Fallback |
|---|---|---|
| Install/downloads fail (459 s online; ~25 kB/s Wi-Fi) | Python 3.11 wheelhouse + datasets on USB | One machine runs the backend |
| "Why US data?" | No open Indian daily sales data (R27); Indian costs, roads, populations; CSV import in P0 | Present as method evidence |
| Formulation bug | Verifier, P1–P7, hand fixtures | Withhold plan, show (a) |
| Replay rewards over-stocking (M3) | One bill, three baselines, conservation test | Report honestly |
| Full forecast fit slow | Time at H7 | Top-50 products, labelled |
| KPI-1 fails | Pre-registered response | Ablations (P1-05) |

---

## 11. Traceability (requirement → module → test)

| Req | Module(s) | Test / evidence | Owner | h |
|---|---|---|---|---|
| P0-01 | `aria/data/*`, `params.yaml` | `make data` offline; fixture CSV end to end | B | 4 |
| P0-02 | `schemas.py`, `validate.py` | one fixture per rule (code + JSON path) | D | 1.5 |
| P0-03 | `forecast/*` | 9 non-crossing quantiles; coverage table | B | 3 |
| P0-04 | `engine/eligibility.py` | boundary tests; V3 | A | 1 |
| P0-05 | `engine/values.py` | newsvendor unit test; §6.1 table | A | 1.5 |
| P0-06 | `engine/network_model.py`, `optimizer.py` | OPTIMAL ×200; V1; V(s2)=V\*; FEFO fixture | A | 3.5 |
| P0-07 | `baseline_a.py`, `baselines.py` | 10-run determinism; 2×2 hand fixture | C | 3 |
| P0-08 | `verify/verifier.py`, `metrics.py`, `test_properties.py` | mutation per V; metrics to paisa; < 60 s | C | 3.5 |
| P0-09 | `replay/*` | conservation; no leakage; CIs stored | C | 3.5 |
| P0-10 | `engine/reasons.py` | UNCLASSIFIED = 0 (P6); fact fidelity | A | 2.5 |
| P0-11 | `shocks.py`, `diff.py`, Disruption Lab | INVENTORY_LOSS 0 → empty diff; closure removes rows; P4 | D+A | 4 |
| P0-12 | `api/main.py`, `ui/*`, `demo.md` | J1–J4 with Wi-Fi off; contract test | D | 5 |

Total effort: 36 person-hours (A 9.5, B 7, C 10, D 9.5) against 60 productive hours.

---

## 12. Definition of done (P0)

- [ ] J1–J4 complete end to end **with Wi-Fi off**.
- [ ] Every plan shown is verified, or is a labelled fallback. KPI-5 = 100%.
- [ ] P1–P7 green on ≥ 200 random scenarios. Suite < 60 s.
- [ ] Replay results cached for the 3 freight points. Conservation OK. KPI table filled with measured values, not edited rules.
- [ ] `ROUTE_RESTRICTION` on Amba Ghat re-plans in ≤ 10 s and shows the τ\* diff.
- [ ] `demo.md` rehearsed twice. Screen recording made as a fallback.
- [ ] `decision.md` and `handoff.md` up to date.
