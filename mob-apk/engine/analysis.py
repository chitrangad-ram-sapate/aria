"""Dashboard numbers and what-if scenarios for the app. Aggregates engine output; plans come from pipeline.plan.

summarize(): KPI values, depot->town flows, depot utilisation, town totals, shortage units by reason and a
shelf-life-on-arrival histogram for one plan result.
apply(): a scenario variant from model inputs only (demand, depot capacity, freight rates, stock, margin,
route closures and truck restrictions). Shock types reuse aria.engine.shocks so their rules stay in one place.
"""
from __future__ import annotations

from itertools import pairwise

from aria.engine.shocks import apply as apply_shocks
from aria.schemas import Plan, Scenario, Shock

REASONS = {  # (reason, sub_reason or None) -> plain group, as the app words them
    "NO_STOCK_ANYWHERE": "Out of stock everywhere",
    "NO_ELIGIBLE_STOCK": "Stock too old or no route",
    "STOCK_BLOCKED": "Freight or capacity limit",
    "SUPPLY_USED": "Stock sent where worth more",
}
KPI_KEYS = ("units_shipped", "freight_paise", "expected_fill_rate", "expected_lost_units", "expected_lost_margin_paise",
            "at_risk_units_left", "at_risk_writeoff_paise", "shortfall_units", "capacity_utilisation")
LOWER_IS_BETTER = {"freight_paise", "expected_lost_units", "expected_lost_margin_paise", "at_risk_units_left",
                   "at_risk_writeoff_paise", "shortfall_units"}


def _flows(p: Plan) -> list[dict]:
    agg: dict[tuple[str, str], dict] = {}
    for a in p.allocations:
        f = agg.setdefault((a.godown_id, a.town_id), {"godown_id": a.godown_id, "town_id": a.town_id, "units": 0,
                                                       "freight_paise": 0, "products": set()})
        f["units"] += a.units
        f["freight_paise"] += a.freight_paise
        f["products"].add(a.product_id)
    return [{**f, "products": len(f["products"])} for f in sorted(agg.values(), key=lambda f: -f["units"])]


def _histogram(p: Plan) -> list[dict]:
    """Units by days of shelf life left on arrival; bins of 1 day up to 14, then wider."""
    edges = list(range(15)) + [21, 31, 61, 10**9]
    bins = [{"from": a, "to": b - 1, "units": 0} for a, b in pairwise(edges)]
    for a in p.allocations:
        for b in bins:
            if b["from"] <= a.life_on_arrival <= b["to"]:
                b["units"] += a.units
                break
    while bins and bins[-1]["units"] == 0:
        bins.pop()
    for b in bins:
        b["label"] = str(b["from"]) if b["from"] == b["to"] else (f"{b['from']}+" if b["to"] > 10**8 else f"{b['from']}–{b['to']}")
    return bins


def summarize(sc: Scenario, p: Plan | None, impact: dict | None) -> dict | None:
    if p is None:
        return None
    flows = _flows(p)
    shipped = {}
    for f in flows:
        shipped[f["godown_id"]] = shipped.get(f["godown_id"], 0) + f["units"]
    stock = {}
    for lot in sc.lots:
        stock[lot.godown_id] = stock.get(lot.godown_id, 0) + max(0, lot.qty_units)
    depots = []
    for g in sc.godowns:
        cap = g.dispatch_capacity_units
        depots.append({"godown_id": g.godown_id, "name": g.name or g.godown_id, "shipped": shipped.get(g.godown_id, 0),
                       "stock": stock.get(g.godown_id, 0), "capacity": cap,
                       "utilisation": None if not cap else shipped.get(g.godown_id, 0) / cap,
                       "stock_used": None if not stock.get(g.godown_id) else shipped.get(g.godown_id, 0) / stock[g.godown_id]})
    received, short = {}, {}
    for f in flows:
        received[f["town_id"]] = received.get(f["town_id"], 0) + f["units"]
    for s in p.shortfalls:
        short[s.town_id] = short.get(s.town_id, 0) + s.shortfall_units
    demand = {}
    for d in sc.demand:
        demand[d.town_id] = demand.get(d.town_id, 0.0) + d.quantiles[4]
    towns = [{"town_id": t.town_id, "name": t.name or t.town_id, "received": received.get(t.town_id, 0),
              "short": short.get(t.town_id, 0), "median_demand": round(demand.get(t.town_id, 0.0), 1)} for t in sc.towns]
    by_reason: dict[str, int] = {}
    for s in p.shortfalls:
        k = REASONS.get(s.reason, "Not classified")
        by_reason[k] = by_reason.get(k, 0) + s.shortfall_units
    caps = [d for d in depots if d["capacity"]]
    kpis = {**(impact or {}), "shortfall_units": sum(s.shortfall_units for s in p.shortfalls), "shortfall_rows": len(p.shortfalls),
            "capacity_utilisation": (sum(d["shipped"] for d in caps) / sum(d["capacity"] for d in caps)) if caps else None,
            "verified": p.verifier.passed}
    routes = [{"godown_id": r.godown_id, "town_id": r.town_id, "road_km": r.road_km, "transit_days": r.transit_days,
               "vehicle_class": r.vehicle_class, "active": r.active} for r in sc.routes]
    return {"kpis": kpis, "flows": flows, "depots": depots, "towns": towns, "routes": routes,
            "shortfall_by_reason": [{"reason": k, "units": v} for k, v in sorted(by_reason.items(), key=lambda kv: -kv[1])],
            "life_on_arrival": _histogram(p),
            "pipeline": {"products": len(sc.products), "lots": len(sc.lots), "routes": len(sc.routes),
                         "active_routes": sum(r.active for r in sc.routes), "demand_pairs": len(sc.demand),
                         "stage1": p.stage1_status, "stage2": p.stage2_status, "rows": len(p.allocations),
                         "verified": p.verifier.passed, "violations": len(p.verifier.violations)}}


def vehicle_options(sc: Scenario, godown_id: str, town_id: str) -> list[str]:
    """Truck classes a restriction can force on this route: only dearer per tonne-km than the route's own
    class (shocks.apply ignores the others, so offering them would change nothing)."""
    rates = sc.policy.freight_paise_per_tkm
    r = next((r for r in sc.routes if r.godown_id == godown_id and r.town_id == town_id), None)
    if r is None or r.vehicle_class not in rates:
        return []
    return sorted((k for k, v in rates.items() if v > rates[r.vehicle_class]), key=lambda k: rates[k])


def _ids(sel) -> list[str] | None:
    """A product/town/depot choice: '*' or missing = all (None), one id, or a list of ids (from the chat)."""
    if sel is None or sel == "*" or sel == ["*"]:
        return None
    return [sel] if isinstance(sel, str) else list(sel)


def apply(sc: Scenario, params: dict, base_shipped: dict[str, int] | None = None) -> Scenario:
    """params (all optional): demand_pct (−90…+300, product, town), capacity_pct (+ depot), freight_pct,
    stock_loss_pct (+ depot, product), margin, closures [[depot, town]], restrictions [[depot, town, class]].
    Each product/town/depot choice is '*' (all), one id or a list of ids."""
    shocks = []
    for g, t in params.get("closures") or []:
        shocks.append(Shock(type="ROUTE_CLOSURE", godown_id=g, town_id=t))
    for g, t, v in params.get("restrictions") or []:
        shocks.append(Shock(type="ROUTE_RESTRICTION", godown_id=g, town_id=t, max_vehicle=v))
    loss = float(params.get("stock_loss_pct") or 0)
    if loss:
        for dep in _ids(params.get("stock_depot")) or [None]:
            for prod in _ids(params.get("stock_product")) or ["*"]:
                shocks.append(Shock(type="INVENTORY_LOSS", godown_id=dep, product_id=prod, pct=loss))
    out = apply_shocks(sc, shocks) if shocks else sc.model_copy(deep=True)
    pct = float(params.get("demand_pct") or 0)
    if pct:
        if pct < -100:
            raise ValueError("demand change cannot be below −100%")
        k = 1 + pct / 100  # same scaling as the FESTIVAL_SPIKE shock, allowing decreases too
        prods, towns = _ids(params.get("demand_product")), _ids(params.get("demand_town"))
        for d in out.demand:
            if (prods is None or d.product_id in prods) and (towns is None or d.town_id in towns):
                d.quantiles = [q * k for q in d.quantiles]
                d.point *= k
                d.sigma *= k
    cap = params.get("capacity_pct")
    if cap is not None and float(cap) != 100:
        deps = _ids(params.get("capacity_depot"))
        for g in out.godowns:
            if deps is not None and g.godown_id not in deps:
                continue
            ref = g.dispatch_capacity_units if g.dispatch_capacity_units is not None else (base_shipped or {}).get(g.godown_id)
            if ref is not None:  # no capacity and nothing shipped in the baseline: nothing to scale
                g.dispatch_capacity_units = max(0, int(ref * float(cap) / 100))
    fr = float(params.get("freight_pct") or 0)
    if fr:
        out.policy.freight_paise_per_tkm = {k: max(1, round(v * (1 + fr / 100))) for k, v in out.policy.freight_paise_per_tkm.items()}
    if params.get("margin") is not None:
        out.policy.margin = float(params["margin"])
    return out


def compare_row(name: str, kpis: dict, base: dict | None) -> dict:
    """KPI values with absolute and % differences from the baseline scenario; better/worse per KPI direction."""
    diffs = {}
    for k in KPI_KEYS:
        v, b = kpis.get(k), (base or {}).get(k)
        if v is None or b is None or base is None:
            continue
        d = v - b
        better = None if abs(d) < 1e-9 else ((d < 0) == (k in LOWER_IS_BETTER))
        diffs[k] = {"abs": d, "pct": (d / abs(b) * 100) if b else None, "better": better}
    return {"name": name, "kpis": {k: kpis.get(k) for k in KPI_KEYS}, "diff": diffs}
