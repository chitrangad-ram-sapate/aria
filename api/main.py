"""ARIA HTTP API (PRD §7.7, implementation.md §6). JSON bodies; money in integer paise.

Run: uvicorn api.main:app --host $ARIA_HOST --port $ARIA_PORT  (defaults 127.0.0.1:8000)
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import time
import uuid
from collections import OrderedDict
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import yaml
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from aria.schemas import Scenario, Shock
from aria.validate import validate, validate_shocks

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MAX_PLANS = 200

app = FastAPI(title="ARIA API", version="1.0")

PLANS: OrderedDict[str, tuple[Scenario, object]] = OrderedDict()  # plan_id -> (scenario, plan)
JOBS: dict[str, dict] = {}  # forecast_job_id -> status


def _pipeline():
    try:
        from aria.engine import pipeline
    except ImportError as exc:
        raise HTTPException(503, f"engine pipeline not available: {exc}")
    return pipeline


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _get(obj, key):
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)


def _remember(sc: Scenario, *plans) -> None:
    for p in plans:
        pid = _get(p, "plan_id")
        if pid:
            PLANS[pid] = (sc, p)
            PLANS.move_to_end(pid)
    while len(PLANS) > MAX_PLANS:
        PLANS.popitem(last=False)


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(400, "request body must be JSON")
    if not isinstance(body, dict) or "scenario" not in body:
        raise HTTPException(400, "body must be {request_id, scenario, ...}")
    return body


def _invalid(request_id, report: dict) -> JSONResponse:
    return JSONResponse(status_code=422, content={"request_id": request_id, **report})


# ---------- read-only ----------

@app.get("/api/health")
def health():
    try:
        solver = f"highspy {version('highspy')}"
    except PackageNotFoundError:
        solver = "highspy not installed"
    files = [DATA / "params.yaml", *sorted((DATA / "scenarios").glob("*.json")),
             *sorted((DATA / "networks").glob("*.yaml")), *sorted((DATA / "built").glob("*.json"))]
    hashes = {f.relative_to(ROOT).as_posix(): _sha256(f) for f in files if f.is_file()}
    return {"status": "ok", "solver_version": solver, "data_hashes": hashes}


def _scenario_files() -> dict[str, Path]:
    paths = [*sorted((DATA / "scenarios").glob("*.json")), *sorted((DATA / "built" / "imports").glob("*.json"))]
    return {p.stem: p for p in paths}


@app.get("/api/scenarios")
def list_scenarios():
    out = []
    for sid, path in _scenario_files().items():
        doc = json.loads(path.read_text(encoding="utf-8"))
        out.append({"scenario_id": sid, "network_id": doc.get("network_id"), "day": doc.get("day"), })
    return out


@app.get("/api/scenarios/{scenario_id}")
def get_scenario(scenario_id: str):
    path = _scenario_files().get(scenario_id)
    if path is None:
        raise HTTPException(404, f"scenario {scenario_id!r} not found")
    return json.loads(path.read_text(encoding="utf-8"))


def _demo_route(doc: dict) -> dict | None:
    """Default disruption leg: the longest leg into a town/route carrying a `via` marker (e.g. a ghat crossing),
    else the longest leg of the network."""
    routes = [r for r in doc.get("routes") or [] if isinstance(r, dict)]
    via = {t.get("town_id"): t.get("via") for t in doc.get("towns") or [] if isinstance(t, dict) and t.get("via")}
    marked = [r for r in routes if r.get("via") or r.get("town_id") in via]
    pool = marked or routes
    if not pool:
        town = next(iter(via), None)  # routes not built yet: still name the marked town
        return {"godown_id": None, "town_id": town, "road_km": None, "via": via.get(town)} if town else None
    pick = max(pool, key=lambda r: (float(r.get("road_km") or 0), str(r.get("godown_id"))))
    return {"godown_id": pick.get("godown_id"), "town_id": pick.get("town_id"), "road_km": pick.get("road_km"),
            "via": pick.get("via") or via.get(pick.get("town_id"))}


@app.get("/api/networks")
def list_networks():
    out = []
    for path in sorted((DATA / "networks").glob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        routes = doc.get("routes") or []
        out.append({
            "network_id": doc.get("network_id", path.stem),
            "name": doc.get("name", path.stem),
            "godowns": len(doc.get("godowns") or []),
            "towns": len(doc.get("towns") or []),
            "routes": len(routes),
            "demo_route": _demo_route(doc),
        })
    return out


# ---------- import ----------

def _forecast_import(job: str, csv_path: Path, network_id: str) -> None:
    """Batch job: imported history → calibrated forecast → plannable scenario (listed by /api/scenarios)."""
    from aria.data.csv_import import scenario_from_import

    JOBS[job]["status"] = "running"
    try:
        sc = scenario_from_import(csv_path, network_id)
        csv_path.with_suffix(".json").write_text(sc.model_dump_json(), encoding="utf-8")
        JOBS[job].update(status="done", scenario_id=csv_path.stem, plannable_scenario_id=sc.scenario_id)
    except Exception as exc:  # report, never crash the server
        JOBS[job].update(status="failed", error=f"{type(exc).__name__}: {exc}")


@app.post("/api/import", status_code=202)
async def import_csv(background: BackgroundTasks, file: UploadFile = File(...), network_id: str = "kolhapur"):
    """Distributor CSV (date,item,outlet/town,qty,price) → normalised daily demand saved under data/built/imports,
    then forecast into a plannable scenario by a background job (R-7: never on the interactive path)."""
    try:
        from aria.data.csv_import import read_distributor_csv
    except ImportError as exc:
        raise HTTPException(503, f"CSV import not available: {exc}")
    try:
        raw = await file.read()
        df = read_distributor_csv(io.BytesIO(raw))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    sid = f"import-{uuid.uuid4().hex[:8]}"
    out = DATA / "built" / "imports"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{sid}.csv").write_bytes(raw)
    known = set()
    for path in (DATA / "networks").glob("*.yaml"):
        for t in (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("towns") or []:
            known |= {str(t.get("town_id", "")).lower(), str(t.get("name", "")).lower()}
    warnings = [{"code": "W_UNKNOWN_TOWN", "path": "$.outlet/town", "message": f"town {t!r} is not in any bundled network"}
                for t in sorted(df["town_id"].unique()) if t.lower() not in known]
    job = uuid.uuid4().hex
    JOBS[job] = {"status": "queued", "scenario_id": sid, "file": f"data/built/imports/{sid}.csv"}
    background.add_task(_forecast_import, job, out / f"{sid}.csv", network_id)
    return {"scenario_id": sid, "rows": int(len(df)), "warnings": warnings, "forecast_job_id": job}


@app.get("/api/import/{job_id}")
def import_status(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(404, f"job {job_id!r} not found")
    return JOBS[job_id]


# ---------- compute ----------

@app.post("/api/validate")
async def api_validate(request: Request):
    body = await _body(request)
    return {"request_id": body.get("request_id"), **validate(body["scenario"])}


@app.post("/api/plan")
async def api_plan(request: Request):
    body = await _body(request)
    rid = body.get("request_id")
    report = validate(body["scenario"])
    if not report["valid"]:
        return _invalid(rid, report)
    sc = Scenario.model_validate(body["scenario"])
    pipeline = _pipeline()
    try:
        result = pipeline.plan(sc)
    except Exception as exc:  # §7.8: solver error must surface, never a silent plan
        raise HTTPException(500, f"planning failed: {type(exc).__name__}: {exc}")
    _remember(sc, result.get("aria"), result.get("baseline_a"))
    return {"request_id": rid, "warnings": report["warnings"], **jsonable_encoder(result)}


@app.post("/api/whatif")
async def api_whatif(request: Request):
    body = await _body(request)
    rid = body.get("request_id")
    report = validate(body["scenario"], shocks=body.get("shocks", []))
    if not report["valid"]:
        return _invalid(rid, report)
    sc = Scenario.model_validate(body["scenario"])
    shocks = [Shock.model_validate(s) for s in body.get("shocks", [])]
    pipeline = _pipeline()
    t0 = time.perf_counter()
    try:
        result = pipeline.whatif(sc, shocks)
    except Exception as exc:
        raise HTTPException(500, f"what-if failed: {type(exc).__name__}: {exc}")
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    from aria.engine.shocks import apply as apply_shocks

    sc_after = apply_shocks(sc, shocks)  # explain cards for "after" plans need the shocked scenario
    for side, scen in (("before", sc), ("after", sc_after)):
        part = result.get(side) or {}
        _remember(scen, _get(part, "aria"), _get(part, "baseline_a"))
    return {"request_id": rid, "elapsed_ms": elapsed_ms, **jsonable_encoder(result)}


@app.get("/api/explain/{plan_id}")
def api_explain(plan_id: str, town: str, product: str):
    if plan_id not in PLANS:
        raise HTTPException(404, f"plan {plan_id!r} not found (plans are kept in memory; re-run the plan)")
    sc, plan = PLANS[plan_id]
    if town not in {t.town_id for t in sc.towns} or product not in {p.product_id for p in sc.products}:
        raise HTTPException(404, f"no (town, product) = ({town}, {product}) in this plan's scenario")
    try:
        return jsonable_encoder(_pipeline().explain(sc, plan, town, product))
    except KeyError as exc:
        raise HTTPException(404, str(exc))


@app.get("/api/replay/{network}")
def api_replay(network: str, freight_point: str | None = None):
    path = DATA / "built" / f"replay_{network}.json"
    if not path.is_file():
        raise HTTPException(404, f"no replay results for network {network!r}; run `make replay`")
    doc = json.loads(path.read_text(encoding="utf-8"))
    points = doc.get("points") if isinstance(doc, dict) else None
    if not isinstance(points, dict) or not points:
        return doc
    key = freight_point or ("own" if "own" in points else next(iter(points)))
    if key not in points:
        raise HTTPException(404, f"freight point {key!r} not in replay (have {list(points)})")
    context = {k: doc[k] for k in ("network", "products", "windows", "window_days", "leakage_ok", "kpi10") if k in doc}
    return {**context, "available_freight_points": list(points), **points[key]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("ARIA_HOST", "127.0.0.1"), port=int(os.environ.get("ARIA_PORT", "8000")))
