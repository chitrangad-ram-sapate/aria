import random

import pytest

from aria.engine import diff, optimizer, shocks
from aria.engine.eligibility import at_risk
from aria.engine.pipeline import run_policy
from aria.schemas import Lot, Shock
from tests.fixtures import tiny_scenario
from tests.test_optimizer import variant


def taus(plan):
    return {(t.godown_id, t.town_id, t.product_id): t.tau_star for t in plan.tau_stars}


def test_route_restriction_lowers_tau_on_long_leg():
    sc = tiny_scenario()
    sc2 = shocks.apply(sc, [Shock(type="ROUTE_RESTRICTION", godown_id="G1", town_id="B", max_vehicle="6t")])
    before, after = optimizer.solve(sc), optimizer.solve(sc2)
    k = ("G1", "B", "P1")
    assert abs(taus(before)[k] - 0.856) < 0.001
    # PRD §6.1 gives 0.588 with unrounded f = ₹1.434; f rounded once to 143 paise gives 0.589.
    assert abs(taus(after)[k] - 0.588) < 0.002
    ch = diff.tau_changes(before, after)
    assert any((c["godown_id"], c["town_id"], c["product_id"]) == k and c["after"] < c["before"] for c in ch)
    assert all(c["town_id"] == "B" and c["godown_id"] == "G1" for c in ch)


def test_restriction_never_cheapens():
    sc = tiny_scenario()  # G1→A already 6t: unchanged
    sc2 = shocks.apply(sc, [Shock(type="ROUTE_RESTRICTION", godown_id="G1", town_id="A", max_vehicle="55t")])
    assert sc2.routes == sc.routes


def test_inventory_loss_zero_is_empty_diff():
    sc = tiny_scenario()
    sc2 = shocks.apply(sc, [Shock(type="INVENTORY_LOSS", godown_id="G1", product_id="*", pct=0)])
    b, a = run_policy(sc, "aria"), run_policy(sc2, "aria")
    d = diff.diff(b, a, sc, sc2)
    assert d["changed_rows"] == [] and d["delta_freight_paise"] == 0 and d["delta_lost_margin_paise"] == 0
    assert d["new_reason_codes"] == []
    assert diff.tau_changes(b, a) == []


def test_inventory_loss_floors():
    sc = tiny_scenario()
    sc2 = shocks.apply(sc, [Shock(type="INVENTORY_LOSS", godown_id="G1", product_id="P1", pct=50)])
    q = {l.lot_id: l.qty_units for l in sc2.lots}
    assert q["L1"] == 12 and q["L2"] == 5 and q["L3"] == 15 and q["L5"] == 8


def test_route_closure_removes_rows():
    sc = tiny_scenario()
    b = run_policy(sc, "aria")
    used = sorted({(a.godown_id, a.town_id) for a in b.allocations})
    assert used
    g, t = used[0]
    sc2 = shocks.apply(sc, [Shock(type="ROUTE_CLOSURE", godown_id=g, town_id=t)])
    a = run_policy(sc2, "aria")
    assert not any((x.godown_id, x.town_id) == (g, t) for x in a.allocations)
    d = diff.diff(b, a, sc, sc2)
    assert any(r["godown_id"] == g and r["town_id"] == t and r["after_units"] == 0 for r in d["changed_rows"])


def test_festival_spike_labelled():
    sc = tiny_scenario()
    sc2 = shocks.apply(sc, [Shock(type="FESTIVAL_SPIKE", town_id="A", product_id="P1", pct=50)])
    d = {(x.town_id, x.product_id): x for x in sc2.demand}
    assert d[("A", "P1")].quantiles[-1] == pytest.approx(33)
    assert d[("B", "P1")].quantiles == next(x for x in sc.demand if (x.town_id, x.product_id) == ("B", "P1")).quantiles
    assert "FESTIVAL_SPIKE" in sc2.scenario_id


def test_bad_shock_reports_index():
    with pytest.raises(ValueError, match=r"shock\[1\]"):
        shocks.apply(tiny_scenario(), [Shock(type="INVENTORY_LOSS", pct=0),
                                       Shock(type="ROUTE_CLOSURE", godown_id="G9", town_id="A")])


def risk_set(sc):
    products = {p.product_id: p for p in sc.products}
    return {l.lot_id for l in sc.lots if at_risk(l, products[l.product_id], sc.routes)}


def v_star(sc):
    return optimizer.solve(sc).objective_paise


@pytest.mark.parametrize("seed", range(10))
def test_p4_monotonicity(seed):
    rng = random.Random(seed)
    sc = variant(seed)
    v0 = v_star(sc)
    g, t = rng.choice([(r.godown_id, r.town_id) for r in sc.routes])
    assert v_star(shocks.apply(sc, [Shock(type="INVENTORY_LOSS", godown_id=g, pct=rng.choice([10, 50, 100]))])) <= v0
    closed = shocks.apply(sc, [Shock(type="ROUTE_CLOSURE", godown_id=g, town_id=t)])
    assert risk_set(closed) == risk_set(sc)  # D-024: closures never change the at-risk set
    assert v_star(closed) <= v0
    assert v_star(shocks.apply(sc, [Shock(type="ROUTE_RESTRICTION", godown_id=g, town_id=t)])) <= v0
    more = sc.model_copy(update={"lots": sc.lots + [Lot(lot_id="Z", godown_id=g, product_id="P1", qty_units=20, remaining_life_days=15)]})
    assert v_star(more) >= v0


def test_pipeline_whatif():
    pytest.importorskip("aria.engine.baseline_a")
    pytest.importorskip("aria.verify.verifier")
    pytest.importorskip("aria.metrics")
    from aria.engine import pipeline

    sc = tiny_scenario()
    out = pipeline.whatif(sc, [Shock(type="ROUTE_RESTRICTION", godown_id="G1", town_id="B")])
    assert set(out) == {"before", "after", "diff", "tau_changes"}
    assert out["before"]["recommended"] in ("aria", "baseline_a")
    assert any(c["town_id"] == "B" for c in out["tau_changes"])
