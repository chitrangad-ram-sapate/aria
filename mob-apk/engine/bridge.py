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
from aria.engine import values
from aria.engine.diff import expected_lost_margin
from aria.engine.eligibility import at_risk
from aria.engine.network_model import default_segments, on_hand
from aria.engine.reasons import _Ctx
from aria.engine.shocks import apply as apply_shocks
from aria.hashing import scenario_hash
from aria.schemas import QUANTILE_LEVELS, Plan, Scenario, Shock
from aria.validate import validate as _validate

ROOT = Path(__file__).resolve().parent  # engine/ here, the unpacked bundle in the Pyodide FS
DATA = ROOT / "data"
BUNDLED_FORECAST = "LightGBM quantile forecast, conformal-calibrated"
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
    impact = {"aria": _impact(sc, result["aria"]), "baseline_a": _impact(sc, result["baseline_a"])}
    return _out({"valid": True, "warnings": report["warnings"], **result, "impact": impact, "excess": _excess(sc)})


def _impact(sc: Scenario, p: Plan | None) -> dict | None:
    """Tonight's plan against the statement's three goals, under the forecast.

    Stockouts: expected demand Σ w_j(1 − τ_j) over each (town, product)'s segments; town stock plus
    shipped units fill segments lowest first, the rest is expected lost. Wastage: at-risk lot units
    (they cannot ship tomorrow) left unshipped tonight."""
    if p is None:
        return None
    shipped: dict[tuple[str, str], int] = {}
    by_lot: dict[str, int] = {}
    for a in p.allocations:
        shipped[(a.town_id, a.product_id)] = shipped.get((a.town_id, a.product_id), 0) + a.units
        by_lot[a.lot_id] = by_lot.get(a.lot_id, 0) + a.units
    stock = on_hand(sc)
    demand = served = 0.0
    for pair, segs in default_segments(sc).items():
        left = stock.get(pair, 0) + shipped.get(pair, 0)
        for w, tau in segs:
            f = min(w, left)
            left -= f
            demand += w * (1 - tau)
            served += f * (1 - tau)
    products = {k.product_id: k for k in sc.products}
    wo_units = wo_paise = 0
    for lot in sc.lots:
        if lot.product_id in products and at_risk(lot, products[lot.product_id], sc.routes):
            left = max(0, lot.qty_units - by_lot.get(lot.lot_id, 0))
            wo_units += left
            wo_paise += round(values.writeoff_base(products[lot.product_id], sc.policy) * left)
    return {
        "expected_demand_units": round(demand),
        "expected_lost_units": round(demand - served),
        "expected_fill_rate": served / demand if demand else 1.0,
        "expected_lost_margin_paise": expected_lost_margin(sc, p),
        "freight_paise": p.metrics.get("freight_paise"),
        "units_shipped": p.metrics.get("units_shipped"),
        "at_risk_units_shipped": p.metrics.get("at_risk_units"),
        "at_risk_units_left": wo_units,
        "at_risk_writeoff_paise": wo_paise,
    }


def _excess(sc: Scenario) -> list[dict]:
    """(town, product) pairs whose town stock already exceeds the target T (reasons.target_units)."""
    ctx = _Ctx(sc, Plan(plan_id="", policy="aria"))
    out = []
    for pair, oh in sorted(on_hand(sc).items()):
        if pair not in ctx.demand or pair[0] not in ctx.towns or pair[1] not in ctx.products:
            continue
        target, tau, _ = ctx.target(*pair)
        if oh > target:
            out.append({"town_id": pair[0], "product_id": pair[1], "on_hand_units": oh, "target_units": target,
                        "excess_units": oh - target, "tau_star": None if tau is None else round(tau, 4)})
    return sorted(out, key=lambda r: -r["excess_units"])


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
    card = pipeline.explain(sc, p, town, product)
    d = next((d for d in sc.demand if d.town_id == town and d.product_id == product), None)
    card["forecast"] = None if d is None else {"levels": list(QUANTILE_LEVELS), "quantiles": d.quantiles, "point": d.point}
    return _out(card)


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


def assumptions() -> str:
    """Assumptions A1-A9, limitations, data sources and the full parameter registry."""
    doc = yaml.safe_load((ROOT / "assumptions.yaml").read_text(encoding="utf-8"))
    params = (yaml.safe_load((DATA / "params.yaml").read_text(encoding="utf-8")) or {}).get("parameters", {})
    registry = [{"name": k, "value": v.get("value"), "status": v.get("status"), "source": v.get("source")}
                for k, v in params.items()]
    fx = params.get("usd_inr_fx") or {}
    sources = doc["data_sources"] + [{"name": f"USD to INR rate {fx.get('value')} (fetched {fx.get('fetched')})",
                                      "ref": "D-013", "use": fx.get("source")}]
    return _out({**doc, "data_sources": sources, "parameters": registry, "bundled_forecast": BUNDLED_FORECAST})


def import_csv(text: str, scenario_json: str, use_ml: bool) -> str:
    """Forecast an imported sales CSV on the device and put the result into the scenario's demand."""
    import device_forecast

    payload = json.loads(scenario_json)
    try:
        fc = device_forecast.forecast(text, payload, bool(use_ml))
    except (ValueError, KeyError) as exc:
        return _out({"ok": False, "error": str(exc)})
    new = {(d["town_id"], d["product_id"]): d for d in fc.pop("demand")}
    payload["demand"] = [d for d in payload.get("demand", []) if (d["town_id"], d["product_id"]) not in new] + list(new.values())
    payload["scenario_id"] = f"{payload.get('scenario_id', 'scenario')} + CSV import"
    return _out({"ok": True, "scenario": payload, "pairs": len(new), **fc})
