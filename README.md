# ARIA

**ARIA is a region-agnostic distribution intelligence and inventory optimisation engine** for distributors who move perishable stock from godowns (warehouses) to towns. Each planning day it decides, lot by lot, what to ship where, and it prices every unit against the freight needed to move it.

- **Forecasts** demand per (town, product) as 9 calibrated quantiles.
- **Prices** each unit with a freight-aware value, so every (route, product) gets its own service level τ\* = (c_u − f)/(c_u + h).
- **Allocates** lots with two min-cost-flow LPs in HiGHS: stage 1 maximises value, stage 2 is an exact first-expiry-first-out tie-break that loses no value.
- **Verifies** every plan with independent code and gives every shortfall exactly one reason code.
- **Re-plans** under shocks (route restriction, route closure, inventory loss, festival spike) in the Disruption Lab.
- **Proves** itself with a fair replay: one full-cost ₹ bill on realised demand against rule-based and optimizer baselines, with bootstrap confidence intervals.

Networks are data. Any set of godowns, towns and routes runs through the same engine. Two networks are bundled:

| Network | What it is |
|---|---|
| `kolhapur` | The demo network: one super-stockist with 3 godowns serving 6 towns. Includes the Ratnagiri leg over Amba Ghat used for the live disruption demo. |
| `maharashtra` | A wider multi-district network: regional depots serving the state's major cities. |

Money is integer paise and quantities are integer units everywhere outside forecasting. The app runs fully offline and binds to `127.0.0.1`.

## Architecture

```
data/networks/*.yaml ─┐
data/scenarios/*.json ├─> aria/ (pure engine) ──> api/main.py (FastAPI) ──HTTP──> ui/app.py (Streamlit)
CSV import ───────────┘        │
                               └─> aria/replay ──> data/built/replay_<network>.json ──> /api/replay
```

| Path | Role |
|---|---|
| `aria/schemas.py` | Pydantic v2 data contract (Scenario, Plan, Shock, ...) |
| `aria/validate.py` | Input validation: `E_*` errors and `W_*` warnings, each with a JSON path |
| `aria/hashing.py` | `scenario_hash` = SHA-256 of the canonical scenario JSON |
| `aria/data/` | Networks, lots, scenarios, CSV import |
| `aria/forecast/` | Quantile forecasting and demand segments |
| `aria/engine/` | Eligibility, unit values, LP model, optimizer, baselines, reason codes, shocks, diffs, pipeline |
| `aria/verify/` | Plan verifier, separate code from the solver |
| `aria/replay/` | Fair replay and bootstrap |
| `api/main.py` | HTTP API |
| `ui/app.py` | Streamlit UI: Plan & Compare, Proof, Disruption Lab. It only formats numbers returned by the API. |

## Quickstart (local)

Requires Python 3.11.9.

```bash
python -m venv .venv
# Windows
.venv\Scripts\python.exe -m pip install -r requirements.txt
# macOS / Linux
.venv/bin/python -m pip install -r requirements.txt
```

Start the API and UI:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\run.ps1
```

```bash
# macOS / Linux (or Windows with make)
make run
```

Then open <http://127.0.0.1:8501>. The API is at <http://127.0.0.1:8000> (interactive docs at `/docs`).

To run the pieces separately:

```bash
python -m uvicorn api.main:app --host 127.0.0.1 --port 8000
ARIA_API_URL=http://127.0.0.1:8000 python -m streamlit run ui/app.py
```

| Variable | Default | Used by |
|---|---|---|
| `ARIA_HOST` | `127.0.0.1` | API bind address (`python -m api.main`, `scripts/run.ps1`) |
| `ARIA_PORT` | `8000` | API port |
| `ARIA_API_URL` | `http://127.0.0.1:8000` | UI → API base URL |

Data pipeline targets:

```bash
make data       # raw → bundled scenarios and built artefacts
make forecast   # refit the batch quantile forecasts (aria.data.build --refit)
make replay     # fair replay → data/built/replay_<network>.json (NETWORK=kolhapur by default)
make test       # pytest
```

## Quickstart (Docker)

```bash
docker compose up --build
```

This builds one image (`python:3.11.9-slim`) and starts two services:

| Service | Port | Command |
|---|---|---|
| `api` | `127.0.0.1:8000` | uvicorn on `0.0.0.0:8000` inside the container |
| `ui` | `127.0.0.1:8501` | streamlit, talking to `http://api:8000` |

Ports are published on `127.0.0.1` only. `./data` is mounted into the API container, so rebuilt scenarios and replay results are picked up without rebuilding the image.

## API

JSON bodies; money in integer paise. Requests that compute something carry a `request_id`, which the response echoes.

| Method | Path | Request → Response | Errors |
|---|---|---|---|
| GET | `/api/health` | → `{status, solver_version, data_hashes}` | |
| GET | `/api/networks` | → bundled networks with sizes and the default disruption leg | |
| GET | `/api/scenarios` | → list of bundled scenarios | |
| GET | `/api/scenarios/{id}` | → Scenario | 404 |
| POST | `/api/import` | CSV file → 202 `{scenario_id, rows, warnings[], forecast_job_id}` | 422 missing columns |
| GET | `/api/import/{job_id}` | → batch forecast job status | 404 |
| POST | `/api/validate` | `{request_id, scenario}` → `{request_id, valid, errors[], warnings[], scenario_hash}` | 400 |
| POST | `/api/plan` | `{request_id, scenario}` → `{request_id, scenario_hash, solve_ms, recommended, aria, baseline_a}` | 422 (all errors), 500 |
| POST | `/api/whatif` | `{request_id, scenario, shocks[]}` → `{request_id, before, after, diff:{aria, baseline_a}, tau_changes[]}` | 422 (with shock index), 500 |
| GET | `/api/explain/{plan_id}?town=&product=` | → explain card: segments, τ\*, freight/unit, lots and life on arrival, indicative shadow prices, reason, parameter sources | 404 |
| GET | `/api/replay/{network}?freight_point=` | → per-policy bills, KPI-1 CI, freight point, `conservation_ok` | 404 |

`aria` is `null` when the optimizer has no solution or its plan fails the verifier; baseline (a) is then returned, labelled. Plans are kept in memory (most recent 200) for `/api/explain`.

Validation codes (each issue is `{code, path, message}`, and all issues are returned at once):

| Code | Meaning |
|---|---|
| `E_REQUIRED` | missing field |
| `E_TYPE` | wrong type or unknown enum value |
| `E_RANGE` | negative quantity or cost; remaining life above shelf life; minimum days at receipt above shelf life; priority outside 0.1–10; salvage outside 0–1; shock % outside 0–100; malformed quantiles |
| `E_DUPLICATE_ID` | repeated product, godown, town, lot, route or demand key |
| `E_BAD_REF` | reference to an unknown product, godown or town |
| `E_SIZE` | model would exceed 300,000 columns (towns × products × 100 segments, doubled when at-risk lots exist, plus eligible arcs) |
| `W_NO_ELIGIBLE_SUPPLY` | a (town, product) with demand that no lot can reach |
| `W_EXPIRED_STOCK` | stock with no remaining life |
| `W_INACTIVE_ROUTE` | a route marked inactive |

## Add your own network

1. Copy `data/networks/kolhapur.yaml` to `data/networks/<your_network>.yaml`.
2. Set `network_id` and `name`, then list your `godowns` (`godown_id`, `name`, `lat`, `lon`, optional `dispatch_capacity_units`) and `towns` (`town_id`, `name`, `population_2011`, `lat`, `lon`, optional `priority`).
3. Leave `routes` empty to have road distances, transit days and vehicle classes derived by `aria/data/network.py`, or list them yourself (`godown_id`, `town_id`, `road_km`, `transit_days`, `vehicle_class` of `55t` / `road_avg` / `6t`, `active`).
4. Optionally mark a leg with `via:` (for example a mountain pass). The Disruption Lab uses the longest marked leg, or else the network's longest leg, as its default disruption.
5. Run `make data` to build scenarios for the network, then `make replay NETWORK=<your_network>` for its proof.

Large networks grow with towns × products × 100 segments; `E_SIZE` stops the interactive path above 300,000 model columns, so plan on a product subset.

## Import your own sales CSV

In the UI sidebar, use **Import distributor CSV**, or:

```bash
curl -F "file=@sales.csv" http://127.0.0.1:8000/api/import
```

Columns: `date, item, outlet/town, qty, price` (`outlet` or `town` also accepted). A missing column returns 422 with the list of missing columns. The response is 202 with a `scenario_id`, the row count, warnings (for example towns not in any bundled network) and a `forecast_job_id`. The normalised daily demand is saved under `data/built/imports/`; forecasting it into a plannable scenario runs as a batch job (`make forecast`), never on the interactive path. Job status: `GET /api/import/{forecast_job_id}`.

## Testing

```bash
python -m pytest -q
```

- `tests/test_validate.py`: one case per validation rule, checking the code and JSON path.
- `tests/test_api_contract.py`: health, validate, plan and what-if over HTTP; every KPI in the API response equals the engine's value.
- Engine, verifier, property and replay tests live alongside them.

CI (`.github/workflows/ci.yml`) runs the suite on every push and pull request.

## Project documents

- `implementation.md`: the build plan, math and module specs.
- `decision.md`: the decision log.
- `demo.md`: the judge demo script.
- `GOVERNANCE.md`: repository ownership, teams and branch protection.

## Team

Team Cyberpunk, TRIWIZATHON 2026:

- [@chitrangad-ram-sapate](https://github.com/chitrangad-ram-sapate)
- [@ruturajnalbalwar-arch](https://github.com/ruturajnalbalwar-arch)
- [@thevipulbangar](https://github.com/thevipulbangar)
- [@Physics0070](https://github.com/Physics0070)
