"""Glue between the mobile/web UI (Pyodide worker) and the aria engine. No engine logic here.

Every function takes and returns JSON-friendly values (strings, dicts, bytes) so the worker can
pass them across the Pyodide boundary. Mirrors api/main.py.
"""
from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path

import yaml
from pydantic import BaseModel

from aria import svcr
from aria.engine import pipeline
from aria.engine.shocks import apply as apply_shocks
from aria.hashing import scenario_hash
from aria.schemas import Plan, Scenario, Shock
from aria.validate import validate as _validate

ROOT = Path(__file__).resolve().parent  # engine/ here, the unpacked bundle in the Pyodide FS
DATA = ROOT / "data"
MAX_PLANS = 200
PLANS: OrderedDict[str, tuple[Scenario, Plan]] = OrderedDict()
LAST_PLAN: dict[str, dict] = {}  # scenario_hash -> plan() result, reused as what-if "before"


def _j(o):
    if isinstance(o, BaseModel):
        return o.model_dump(mode="json")
    if isinstance(o, dict):
        return {k: _j(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_j(v) for v in o]
    return o


def _out(o) -> str:
    return json.dumps(_j(o))


def _remember(sc: Scenario, *plans) -> None:
    for p in plans:
        if p is not None and p.plan_id:
            PLANS[p.plan_id] = (sc, p)
            PLANS.move_to_end(p.plan_id)
    while len(PLANS) > MAX_PLANS:
        PLANS.popitem(last=False)


def _demo_route(doc: dict) -> dict | None:
    """Same rule as api/main.py: longest `via`-marked leg, else the network's longest leg."""
    routes = [r for r in doc.get("routes") or [] if isinstance(r, dict)]
    via = {t.get("town_id"): t.get("via") for t in doc.get("towns") or [] if isinstance(t, dict) and t.get("via")}
    pool = [r for r in routes if r.get("via") or r.get("town_id") in via] or routes
    if not pool:
        return None
    pick = max(pool, key=lambda r: (float(r.get("road_km") or 0), str(r.get("godown_id"))))
    return {"godown_id": pick.get("godown_id"), "town_id": pick.get("town_id"), "road_km": pick.get("road_km"),
            "via": pick.get("via") or via.get(pick.get("town_id"))}


def list_networks() -> str:
    out = []
    for path in sorted((DATA / "networks").glob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        out.append({"network_id": doc.get("network_id", path.stem), "name": doc.get("name", path.stem),
                    "godowns": len(doc.get("godowns") or []), "towns": len(doc.get("towns") or []),
                    "routes": len(doc.get("routes") or []), "demo_route": _demo_route(doc)})
    return _out(out)


def list_scenarios() -> str:
    out = []
    for path in sorted((DATA / "scenarios").glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        out.append({"scenario_id": path.stem, "network_id": doc.get("network_id"), "day": doc.get("day")})
    return _out(out)


def get_scenario(scenario_id: str) -> str:
    path = DATA / "scenarios" / f"{Path(scenario_id).name}.json"
    if not path.is_file():
        raise KeyError(f"scenario {scenario_id!r} not found")
    return path.read_text(encoding="utf-8")


def validate(scenario_json: str) -> str:
    return _out(_validate(json.loads(scenario_json)))


def plan(scenario_json: str) -> str:
    """→ {valid: false, errors, warnings} or {valid: true, warnings, scenario_hash, solve_ms, recommended, aria, baseline_a, aria_withheld}."""
    payload = json.loads(scenario_json)
    report = _validate(payload)
    if not report["valid"]:
        return _out(report)
    sc = Scenario.model_validate(payload)
    result = pipeline.plan(sc)
    _remember(sc, result["aria"], result["baseline_a"])
    LAST_PLAN.clear()
    LAST_PLAN[result["scenario_hash"]] = result
    return _out({"valid": True, "warnings": report["warnings"], **result})


def whatif(scenario_json: str, shocks_json: str) -> str:
    payload, shocks_raw = json.loads(scenario_json), json.loads(shocks_json)
    report = _validate(payload, shocks=shocks_raw)
    if not report["valid"]:
        return _out(report)
    sc = Scenario.model_validate(payload)
    shocks = [Shock.model_validate(s) for s in shocks_raw]
    result = pipeline.whatif(sc, shocks, before=LAST_PLAN.get(scenario_hash(sc)))
    sc_after = apply_shocks(sc, shocks)
    for side, scen in (("before", sc), ("after", sc_after)):
        _remember(scen, result[side]["aria"], result[side]["baseline_a"])
    return _out({"valid": True, "scenario_hash": scenario_hash(sc), **result})


def explain(plan_id: str, town: str, product: str) -> str:
    if plan_id not in PLANS:
        raise KeyError(f"plan {plan_id!r} not found; re-run the plan")
    sc, p = PLANS[plan_id]
    return _out(pipeline.explain(sc, p, town, product))


def export_svcr(plan_id: str) -> bytes:
    if plan_id not in PLANS:
        raise KeyError(f"plan {plan_id!r} not found; re-run the plan")
    sc, p = PLANS[plan_id]
    return svcr.dumps(sc, p)


def open_svcr(data) -> str:
    """→ {ok: true, scenario_hash, created_at, network_id, scenario_id, day, plan} or {ok: false, error}."""
    try:
        sc, p, payload = svcr.loads(bytes(data))
    except Exception as exc:  # malformed JSON, schema errors and SvcrError are all rejections
        return _out({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
    _remember(sc, p)
    return _out({"ok": True, "scenario_hash": payload["scenario_hash"], "created_at": payload.get("created_at"),
                 "network_id": sc.network_id, "scenario_id": sc.scenario_id, "day": sc.day, "plan": p})


def replay(network: str, freight_point: str | None = None) -> str:
    """Same shape as GET /api/replay/{network}; {missing: true} when no replay is bundled."""
    path = DATA / "built" / f"replay_{Path(network).name}.json"
    if not path.is_file():
        return _out({"missing": True})
    doc = json.loads(path.read_text(encoding="utf-8"))
    points = doc.get("points") if isinstance(doc, dict) else None
    if not isinstance(points, dict) or not points:
        return _out(doc)
    key = freight_point or ("own" if "own" in points else next(iter(points)))
    if key not in points:
        raise KeyError(f"freight point {key!r} not in replay (have {list(points)})")
    context = {k: doc[k] for k in ("network", "products", "windows", "window_days", "leakage_ok", "kpi10") if k in doc}
    return _out({**context, "available_freight_points": list(points), **points[key]})
