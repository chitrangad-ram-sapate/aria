"""Baseline (a), PRD Appendix C: 10-run determinism and a hand-computed 2×2 fixture."""
from aria.engine.baseline_a import solve
from aria.verify.verifier import verify
from tests.fixtures import tiny_scenario


def rows(plan):
    return [(a.godown_id, a.town_id, a.product_id, a.lot_id, a.units, a.freight_per_unit_paise, a.at_risk)
            for a in plan.allocations]


def test_deterministic_over_10_runs():
    sc = tiny_scenario()
    first = solve(sc).model_dump()
    for _ in range(9):
        assert solve(sc).model_dump() == first


def test_hand_computed_2x2():
    # Q_top: A = 22, B = 11. need: A = min(round(10 + 1.65·6) = 20, 22); B = min(round(5 + 1.65·3) = 10, 11).
    # P1 at A: need 20 − 3 on hand = 17.  Freight/unit P1 (1 kg): G1→A 1103·15/1000 = 16.5 → 17,
    #   G2→A 27.6 → 28, G1→B 378·130/1000 = 49.1 → 49, G2→B 52.9 → 53.  P2 (0.5 kg): G1→A 8, G2→A 14,
    #   G1→B 25, G2→B 26.
    # P1: A ← G1 lots by life: L2 (5d) 10, L1 (20d) 7.  B ← G1: L2 empty, L1 10.
    # P2: A ← G1 L5 8, then G2 L4 12 (3d − 1 transit = 2 ≥ min 2).  B: L5 empty; L4 → B is 3 − 2 = 1 < 2,
    #   ineligible, so B gets nothing.  L4 is at-risk: r − t_min = 3 − 1 = 2 = m.
    want = [
        ("G1", "A", "P1", "L2", 10, 17, False),
        ("G1", "A", "P1", "L1", 7, 17, False),
        ("G1", "B", "P1", "L1", 10, 49, False),
        ("G1", "A", "P2", "L5", 8, 8, False),
        ("G2", "A", "P2", "L4", 12, 14, True),
    ]
    plan = solve(tiny_scenario())
    assert rows(plan) == want
    assert sum(a.freight_paise for a in plan.allocations) == 170 + 119 + 490 + 64 + 168
    assert all(a.segment_from == 0 == a.segment_to for a in plan.allocations)
    assert plan.policy == "baseline_a"
    assert verify(tiny_scenario(), plan).passed


def test_dispatch_capacity_binds():
    sc = tiny_scenario()
    sc.godowns[0].dispatch_capacity_units = 12
    plan = solve(sc)
    assert sum(a.units for a in plan.allocations if a.godown_id == "G1") == 12
    assert verify(sc, plan).passed
