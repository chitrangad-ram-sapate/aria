"""One mutation per verifier code V1–V8: corrupt a valid plan (or its scenario), expect exactly that code."""
import subprocess
import sys

import pytest

from aria.engine.baseline_a import solve as baseline_a
from aria.schemas import Shortfall, TownStock
from aria.verify.verifier import verify
from tests.fixtures import tiny_scenario


def codes(sc, plan):
    return {v.code for v in verify(sc, plan).violations}


def row(plan, town, product):
    return next(i for i, a in enumerate(plan.allocations) if a.town_id == town and a.product_id == product)


@pytest.fixture
def base():
    sc = tiny_scenario()
    plan = baseline_a(sc)
    assert verify(sc, plan).passed, verify(sc, plan).violations
    return sc, plan


def test_v1_negative_quantity(base):
    sc, plan = base
    plan.allocations[row(plan, "B", "P1")].units = -1  # (B, P1) has a single row and no shortfall row
    assert codes(sc, plan) == {"V1"}


def test_v1_non_integer(base):
    sc, plan = base
    plan.allocations[row(plan, "B", "P1")].units = 2.5
    assert codes(sc, plan) == {"V1"}


def test_v2_lot_stock(base):
    sc, plan = base
    used = sum(a.units for a in plan.allocations if a.lot_id == "L1")
    next(l for l in sc.lots if l.lot_id == "L1").qty_units = used - 1
    assert codes(sc, plan) == {"V2"}


def test_v3_ineligible_arc(base):
    sc, plan = base
    next(r for r in sc.routes if (r.godown_id, r.town_id) == ("G1", "B")).active = False
    assert codes(sc, plan) == {"V3"}


def test_v4_above_qtop(base):
    sc, plan = base
    # (A, P2) ships 20 of Q_top 22; 5 more on hand makes 25 > 22.
    sc.town_stock.append(TownStock(town_id="A", product_id="P2", qty_units=5, remaining_life_days=4))
    assert codes(sc, plan) == {"V4"}


def test_v5_dispatch_capacity(base):
    sc, plan = base
    used = sum(a.units for a in plan.allocations if a.godown_id == "G1")
    sc.godowns[0].dispatch_capacity_units = used - 1
    assert codes(sc, plan) == {"V5"}


def test_v6_shortfall_arithmetic(base):
    sc, plan = base
    if not plan.shortfalls:  # reasons module absent: add a correct row first, then corrupt it
        plan.shortfalls.append(Shortfall(town_id="B", product_id="P2", target_units=5, on_hand_units=0,
                                         shipped_units=0, shortfall_units=5, reason="SUPPLY_USED"))
        assert verify(sc, plan).passed
    plan.shortfalls[0].shortfall_units += 1
    assert codes(sc, plan) == {"V6"}


def test_v7_unknown_id(base):
    sc, plan = base
    plan.allocations[row(plan, "B", "P1")].lot_id = "NOPE"
    assert codes(sc, plan) == {"V7"}


def test_v8_segment_skipped():
    pytest.importorskip("highspy")
    from aria.engine import optimizer

    sc = tiny_scenario()
    plan = optimizer.solve(sc, "aria")
    assert plan.allocations and verify(sc, plan).passed, verify(sc, plan).violations
    a = max(plan.allocations, key=lambda x: x.units)
    a.segment_from = a.segment_to = 100  # leaves lower, higher-valued segments empty
    assert codes(sc, plan) == {"V8"}


def test_v8_width_exceeded():
    pytest.importorskip("highspy")
    from aria.engine import optimizer

    sc = tiny_scenario()
    plan = optimizer.solve(sc, "aria")
    a = max(plan.allocations, key=lambda x: x.units)
    a.segment_to = a.segment_from  # all its units squeezed into one segment
    assert a.units > 1 and codes(sc, plan) == {"V8"}


def test_verifier_does_not_load_solver():
    code = ("import sys, aria.verify.verifier; "
            "bad = [m for m in sys.modules if m.split('.')[-1] in ('optimizer', 'network_model', 'pipeline', 'baselines')]; "
            "print(bad); sys.exit(1 if bad else 0)")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
