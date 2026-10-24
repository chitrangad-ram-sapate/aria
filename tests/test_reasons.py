import glob
import os

import pytest

from aria.engine import optimizer, reasons
from aria.engine.pipeline import run_policy
from aria.schemas import Scenario
from tests.fixtures import tiny_scenario
from tests.test_optimizer import variant

CODES = {"NO_STOCK_ANYWHERE", "NO_ELIGIBLE_STOCK", "STOCK_BLOCKED", "SUPPLY_USED", "UNCLASSIFIED"}


def codes(sc):
    plan = run_policy(sc, "aria")
    rows = plan.shortfalls
    keys = [(s.town_id, s.product_id) for s in rows]
    assert len(keys) == len(set(keys))  # exactly one code per row
    for s in rows:
        assert s.reason in CODES
        assert s.shortfall_units == s.target_units - s.on_hand_units - s.shipped_units > 0
    return plan, {(s.town_id, s.product_id): (s.reason, s.sub_reason, s.facts) for s in rows}


def bundled():
    here = os.path.join(os.path.dirname(__file__), "..", "data", "scenarios", "*.json")
    out = []
    for path in sorted(glob.glob(here)):
        try:
            with open(path, encoding="utf-8") as f:
                out.append(Scenario.model_validate_json(f.read()))
        except Exception:
            continue
    return out


@pytest.mark.parametrize("seed", [None] + list(range(30)))
def test_no_unclassified(seed):
    sc = tiny_scenario() if seed is None else variant(seed)
    _, rows = codes(sc)
    assert all(r[0] != "UNCLASSIFIED" for r in rows.values()), rows


def test_no_unclassified_bundled():
    scs = bundled()
    if not scs:
        pytest.skip("no bundled scenarios in data/scenarios yet")
    for sc in scs:
        _, rows = codes(sc)
        assert all(r[0] != "UNCLASSIFIED" for r in rows.values()), (sc.scenario_id, rows)


def test_no_stock_anywhere():
    sc = tiny_scenario()
    sc = sc.model_copy(update={"lots": [l for l in sc.lots if l.product_id != "P2"]})
    _, rows = codes(sc)
    assert rows[("A", "P2")][0] == "NO_STOCK_ANYWHERE"
    assert rows[("B", "P2")][0] == "NO_STOCK_ANYWHERE"


def test_no_active_route():
    sc = tiny_scenario().model_copy(deep=True)
    for r in sc.routes:
        if r.town_id == "B":
            r.active = False
    _, rows = codes(sc)
    assert rows[("B", "P1")][:2] == ("NO_ELIGIBLE_STOCK", "NO_ACTIVE_ROUTE")


def test_shelf_life_at_receipt():
    sc = tiny_scenario().model_copy(deep=True)
    sc.products[1].min_days_at_receipt = 10  # P2 lots have 3 and 6 days of life
    _, rows = codes(sc)
    assert rows[("A", "P2")][:2] == ("NO_ELIGIBLE_STOCK", "SHELF_LIFE_AT_RECEIPT")


def test_capacity_bound():
    sc = tiny_scenario().model_copy(deep=True)
    sc.godowns[0].dispatch_capacity_units = 2
    sc.lots = [l for l in sc.lots if l.godown_id == "G1"]
    _, rows = codes(sc)
    assert any(r[:2] == ("STOCK_BLOCKED", "CAPACITY_BOUND") for r in rows.values()), rows


def test_supply_used_allocated_elsewhere():
    sc = tiny_scenario().model_copy(deep=True)
    sc.lots = [l for l in sc.lots if l.product_id == "P2"] + [
        l.model_copy(update={"qty_units": 4}) for l in sc.lots if l.lot_id == "L1"]
    plan, rows = codes(sc)
    r = rows[("B", "P1")]
    assert r[:2] == ("SUPPLY_USED", "ALLOCATED_ELSEWHERE")
    rec = r[2]["recipients"]
    to_a = sum(a.units for a in plan.allocations if a.town_id == "A" and a.product_id == "P1")
    assert [x["town_id"] for x in rec] == ["A"] and rec[0]["units"] == to_a > 0
    assert rec[0]["last_unit_net_paise"] > 0


def test_uneconomic():
    """Cheap lane's stock runs out; what remains sits behind a lane whose freight exceeds c_u."""
    sc = tiny_scenario().model_copy(deep=True)
    sc.lots = [l.model_copy(update={"qty_units": 2}) if l.lot_id == "L1" else l
               for l in sc.lots if l.lot_id in ("L1", "L3")]
    for r in sc.routes:
        if (r.godown_id, r.town_id) == ("G2", "A"):
            r.road_km, r.vehicle_class = 2000, "road_avg"
    _, rows = codes(sc)
    assert rows[("A", "P1")][:2] == ("STOCK_BLOCKED", "UNECONOMIC"), rows


def test_explain_card():
    sc = tiny_scenario()
    plan = run_policy(sc, "aria")
    a = plan.allocations[0]
    card = reasons.explain(sc, plan, a.town_id, a.product_id)
    for k in ("segments", "tau_star", "freight_per_unit_paise", "life_on_arrival", "lot_shadow_price_paise", "reason", "params"):
        assert k in card
    shipped = sum(x.units for x in plan.allocations if (x.town_id, x.product_id) == (a.town_id, a.product_id))
    assert sum(s["filled"] for s in card["segments"]) == shipped
    assert all({"name", "value", "source"} <= set(p) for p in card["params"])
    lots = {(x["lot_id"], x["life_on_arrival"]) for x in card["life_on_arrival"]}
    assert (a.lot_id, a.life_on_arrival) in lots
    with pytest.raises(KeyError):
        reasons.explain(sc, plan, "nope", "P1")


def test_target_uses_cheapest_route():
    sc = tiny_scenario()
    t = reasons.target_units(sc, "B", "P1")
    taus = {(x.godown_id, x.town_id, x.product_id): x.tau_star for x in optimizer.tau_star_table(sc)}
    d = next(d for d in sc.demand if (d.town_id, d.product_id) == ("B", "P1"))
    assert t == reasons.quantile(d.quantiles, taus[("G1", "B", "P1")]) or t == reasons.quantile(d.quantiles, taus[("G2", "B", "P1")])


@pytest.mark.parametrize("seed", range(40))
def test_no_unclassified_random(seed):
    gen = pytest.importorskip("aria.data.scenarios")
    _, rows = codes(gen.random_scenario(seed))
    assert all(r[0] != "UNCLASSIFIED" for r in rows.values()), rows
