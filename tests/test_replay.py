"""Replay guards (FR-P0-09): conservation with zero tolerance on a tiny 3-day replay; no leakage."""
import importlib.util

import pytest

from aria.engine.baseline_a import solve as baseline_a
from aria.replay.bootstrap import block_indices, ci
from aria.replay.simulate import default_planner, no_leakage, run_window, seasonal_naive_inflow
from tests.fixtures import tiny_scenario

DAYS = ["2016-04-01", "2016-04-02", "2016-04-03"]
HISTORY = {
    "2016-03-25": {("A", "P1"): 9, ("B", "P1"): 4, ("A", "P2"): 12, ("B", "P2"): 5},
    "2016-03-26": {("A", "P1"): 11, ("B", "P1"): 6, ("A", "P2"): 7, ("B", "P2"): 3},
    "2016-03-27": {("A", "P1"): 10, ("B", "P1"): 5, ("A", "P2"): 9, ("B", "P2"): 1},
}
REALISED = {
    "2016-04-01": {("A", "P1"): 14, ("B", "P1"): 3, ("A", "P2"): 25, ("B", "P2"): 6},
    "2016-04-02": {("A", "P1"): 8, ("B", "P1"): 7, ("A", "P2"): 10, ("B", "P2"): 0},
    "2016-04-03": {("A", "P1"): 30, ("B", "P1"): 2, ("A", "P2"): 4, ("B", "P2"): 9},
}


def replay(policy, planner):
    sc = tiny_scenario()
    inflow = seasonal_naive_inflow(HISTORY, DAYS, [g.godown_id for g in sc.godowns],
                                   {p.product_id: p.shelf_life_days for p in sc.products})
    return run_window(sc, DAYS, {d: sc.demand for d in DAYS}, REALISED, inflow, sc.lots, sc.town_stock,
                      policy, planner)


def test_conservation_baseline_a():
    r = replay("baseline_a", lambda sc, pol, dem: baseline_a(sc))
    s = r["stock"]
    assert r["conservation_ok"]
    assert s["opening"] + s["received"] == s["sold"] + s["written_off"] + s["closing"]
    # opening: lots 25+10+15+30+8 = 88 plus 3 on hand; received = network demand of t − 7 for the 3 days.
    assert s["opening"] == 91 and s["received"] == 30 + 27 + 25
    assert r["verifier_failures"] == 0
    for b in r["days"]:
        assert b["bill_paise"] == b["freight"] + b["holding"] + b["writeoff"] + b["lost_margin"]
        assert all(isinstance(b[k], int) for k in ("bill_paise", "freight", "holding", "writeoff", "lost_margin"))
    # P2 lot L4 (3 days of life) cannot all sell: part of it is written off.
    assert sum(b["writeoff_units"] for b in r["days"]) > 0


@pytest.mark.skipif(importlib.util.find_spec("highspy") is None, reason="highspy not installed")
@pytest.mark.parametrize("policy", ["aria", "b_prime", "b_dprime", "hindsight", "baseline_a"])
def test_conservation_every_policy(policy):
    pytest.importorskip("aria.engine.pipeline")
    r = replay(policy, default_planner)
    assert r["conservation_ok"], r["stock"]
    assert r["verifier_failures"] == 0


def test_overshipping_breaks_conservation():
    def bad(sc, pol, dem):
        plan = baseline_a(sc)
        plan.allocations[0].units += 1000
        return plan

    assert not replay("baseline_a", bad)["conservation_ok"]


def test_no_leakage():
    assert no_leakage("2016-03-31", DAYS)
    assert not no_leakage("2016-04-01", DAYS)


def test_inflow_reads_only_the_past():
    seen = []

    class Spy(dict):
        def get(self, k, default=None):
            seen.append(k)
            return super().get(k, default)

    inflow = seasonal_naive_inflow(Spy(HISTORY), DAYS, ["G2", "G1"], {"P1": 30, "P2": 7})
    assert seen and all(k < min(DAYS) for k in seen)
    # 2016-04-01 ← 2016-03-25: P1 13 → G1 7, G2 6; P2 17 → G1 9, G2 8.
    assert [(l.godown_id, l.product_id, l.qty_units) for l in inflow["2016-04-01"]] == [
        ("G1", "P1", 7), ("G2", "P1", 6), ("G1", "P2", 9), ("G2", "P2", 8)]


def test_bootstrap_blocks_and_ci():
    import numpy as np

    rng = np.random.default_rng(0)
    idx = block_indices(28, rng)
    assert len(idx) == 28
    assert all(idx[b + i + 1] - idx[b + i] == 1 for b in range(0, 28, 7) for i in range(6))
    d = [np.full(28, -5.0), np.full(28, -3.0)]
    r = ci({"d": d}, lambda t: t["d"])
    assert r["value"] == -224 and r["ci_low"] == r["ci_high"] == -224
