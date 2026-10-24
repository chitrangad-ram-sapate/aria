"""Properties P1–P7 (PRD p.18) on ≥ 200 seeded random scenarios (decision D-018)."""
import importlib.util

import pytest

if importlib.util.find_spec("highspy") is None:
    pytest.skip("highspy not installed", allow_module_level=True)
try:
    from aria.data.scenarios import random_scenario
    from aria.engine import optimizer, shocks
    from aria.engine.pipeline import run_policy
except ImportError as e:  # owner A's / B's modules not built yet
    pytest.skip(f"engine or random scenario generator missing: {e}", allow_module_level=True)

from aria.engine.eligibility import eligible
from aria.metrics import plan_metrics
from aria.schemas import Allocation, Lot, Shock
from aria.verify.verifier import verify

SEEDS = range(200)
REASONS = {"NO_STOCK_ANYWHERE", "NO_ELIGIBLE_STOCK", "STOCK_BLOCKED", "SUPPLY_USED"}


def v_star(sc) -> int:
    p = optimizer.solve(sc, "aria")
    assert p.objective_paise is not None, p.stage1_status
    return p.objective_paise


def integral(plan) -> bool:
    return all(isinstance(a.units, int) and a.units >= 0 for a in plan.allocations)


def move_one(sc, plan, i: int, town_id: str):
    """plan with one unit of allocation i moved to town_id over the same lot."""
    a = plan.allocations[i]
    rows = [r.model_copy() for r in plan.allocations]
    rows[i].units -= 1
    rows.append(Allocation(**{**a.model_dump(), "town_id": town_id, "units": 1}))
    return plan.model_copy(update={"allocations": [r for r in rows if r.units > 0]})


def relabel(sc):
    """Rename every id so that the sort order is reversed."""
    def mapper(ids, prefix):
        ids = sorted(set(ids))
        return {x: f"{prefix}{len(ids) - n:05d}" for n, x in enumerate(ids)}

    gm = mapper([g.godown_id for g in sc.godowns], "g")
    tm = mapper([t.town_id for t in sc.towns], "t")
    pm = mapper([p.product_id for p in sc.products], "p")
    lm = mapper([l.lot_id for l in sc.lots], "l")
    d = sc.model_dump()
    for g in d["godowns"]:
        g["godown_id"] = gm[g["godown_id"]]
    for t in d["towns"]:
        t["town_id"] = tm[t["town_id"]]
    for p in d["products"]:
        p["product_id"] = pm[p["product_id"]]
    for l in d["lots"]:
        l.update(lot_id=lm[l["lot_id"]], godown_id=gm[l["godown_id"]], product_id=pm[l["product_id"]])
    for s in d["town_stock"]:
        s.update(town_id=tm[s["town_id"]], product_id=pm[s["product_id"]])
    for r in d["routes"]:
        r.update(godown_id=gm[r["godown_id"]], town_id=tm[r["town_id"]])
    for x in d["demand"]:
        x.update(town_id=tm[x["town_id"]], product_id=pm[x["product_id"]])
    for k in ("godowns", "towns", "products", "lots", "town_stock", "routes", "demand"):
        d[k].reverse()
    return type(sc).model_validate(d)


@pytest.mark.parametrize("seed", SEEDS)
def test_properties(seed):
    sc = random_scenario(seed)
    aria = run_policy(sc, "aria")
    base = run_policy(sc, "baseline_a")
    assert aria.objective_paise is not None, aria.stage1_status
    vstar = aria.objective_paise

    # P1 every plan passes V1–V8 (b′ / b″ on every 4th seed to keep the suite under 60 s)
    plans = [aria, base] + ([run_policy(sc, "b_prime"), run_policy(sc, "b_dprime")] if seed % 4 == 0 else [])
    for p in plans:
        r = verify(sc, p)
        assert r.passed, (p.policy, r.violations)

    # P7 both plans integral
    assert integral(aria) and integral(base)

    # P2 V*(ARIA) ≥ V(baseline a) under the forecast; the one metrics function reproduces V*
    assert plan_metrics(sc, aria)["expected_value_paise"] == vstar
    assert vstar >= plan_metrics(sc, base)["expected_value_paise"]

    # P3 no single-unit move of a shipped lot unit to another eligible town raises V
    products = {p.product_id: p for p in sc.products}
    lots = {l.lot_id: l for l in sc.lots}
    demand_towns = {(d.town_id, d.product_id) for d in sc.demand}
    for i, a in enumerate(aria.allocations):
        for r in sc.routes:
            if (r.godown_id == a.godown_id and r.town_id != a.town_id and (r.town_id, a.product_id) in demand_towns
                    and eligible(lots[a.lot_id], r, products[a.product_id])):
                moved = plan_metrics(sc, move_one(sc, aria, i, r.town_id))["expected_value_paise"]
                assert moved <= vstar, (a.lot_id, a.town_id, r.town_id, moved, vstar)

    # P4 shocks: loss / closure / restriction never raise V*; adding stock never lowers it
    g = sc.godowns[seed % len(sc.godowns)].godown_id
    route = sc.routes[seed % len(sc.routes)]
    assert v_star(shocks.apply(sc, [Shock(type="INVENTORY_LOSS", godown_id=g, pct=50)])) <= vstar
    assert v_star(shocks.apply(sc, [Shock(type="ROUTE_RESTRICTION", godown_id=route.godown_id,
                                          town_id=route.town_id, max_vehicle="6t")])) <= vstar
    if sc.lots:
        extra = sc.lots[seed % len(sc.lots)]
        more = sc.model_copy(update={"lots": sc.lots + [Lot(**{**extra.model_dump(), "lot_id": "EXTRA", "qty_units": 7})]})
        assert v_star(more) >= vstar

    # P5 relabelling every id leaves V* unchanged
    assert v_star(relabel(sc)) == vstar

    # P6 exactly one reason code per shortfall row; UNCLASSIFIED = 0
    keys = [(s.town_id, s.product_id) for s in aria.shortfalls]
    assert len(keys) == len(set(keys))
    assert all(s.reason in REASONS for s in aria.shortfalls), [s.reason for s in aria.shortfalls]


# P4 ROUTE_CLOSURE: closures never raise V* (D-024: at-risk uses the shortest transit over all routes).
@pytest.mark.parametrize("seed", SEEDS)
def test_p4_route_closure(seed):
    sc = random_scenario(seed)
    route = sc.routes[seed % len(sc.routes)]
    closed = shocks.apply(sc, [Shock(type="ROUTE_CLOSURE", godown_id=route.godown_id, town_id=route.town_id)])
    assert v_star(closed) <= v_star(sc)
