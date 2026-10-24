import random

import numpy as np
import pytest

from aria.engine import baselines, optimizer, values
from aria.engine.network_model import build
from aria.forecast.segments import segments_from_quantiles
from aria.schemas import TAU_GRID, Demand, Godown, Lot, Policy, Product, Route, Scenario, Town
from tests.fixtures import tiny_scenario


def variant(seed: int) -> Scenario:
    rng = random.Random(seed)
    sc = tiny_scenario().model_copy(deep=True)
    for lot in sc.lots:
        lot.qty_units = rng.randint(0, 40)
        lot.remaining_life_days = rng.randint(1, 25)
    for d in sc.demand:
        k = rng.uniform(0.3, 3.0)
        d.quantiles = [q * k for q in d.quantiles]
    sc.godowns[0].dispatch_capacity_units = rng.choice([None, 10, 30, 60])
    return sc


def check_plan(sc, plan):
    lots = {l.lot_id: l for l in sc.lots}
    used, by_godown = {}, {}
    for a in plan.allocations:
        assert isinstance(a.units, int) and a.units > 0
        used[a.lot_id] = used.get(a.lot_id, 0) + a.units
        by_godown[a.godown_id] = by_godown.get(a.godown_id, 0) + a.units
        assert a.life_on_arrival == lots[a.lot_id].remaining_life_days - next(
            r.transit_days for r in sc.routes if r.godown_id == a.godown_id and r.town_id == a.town_id)
    for lot_id, u in used.items():
        assert u <= lots[lot_id].qty_units
    for g in sc.godowns:
        if g.dispatch_capacity_units is not None:
            assert by_godown.get(g.godown_id, 0) <= g.dispatch_capacity_units


@pytest.mark.parametrize("seed", [None] + list(range(15)))
def test_integral_and_stage2_equals_vstar(seed):
    sc = tiny_scenario() if seed is None else variant(seed)
    res = optimizer.solve_stages(sc)
    plan = res["plan"]
    assert plan.stage1_status == "Optimal"
    for x in (res["x1"], res["x2"]):
        assert np.all(x >= 0) and np.array_equal(x, np.rint(x))  # V1
    assert res["v2"] == res["v_star"] == plan.objective_paise
    assert not plan.stage1_only and plan.stage2_status == "Optimal"
    check_plan(sc, plan)


def test_tiny_ships_something_and_tau_table():
    sc = tiny_scenario()
    plan = optimizer.solve(sc)
    assert plan.objective_paise > 0 and plan.allocations
    t = {(x.godown_id, x.town_id, x.product_id): x for x in plan.tau_stars}
    # PRD §6.1: 1 kg, ₹100, 130 km at road avg → 0.856.
    assert abs(t[("G1", "B", "P1")].tau_star - 0.856) < 0.001
    assert all(a.segment_from >= 1 and a.segment_to >= a.segment_from for a in plan.allocations)


def fefo_scenario() -> Scenario:
    return Scenario(
        scenario_id="fefo",
        products=[Product(product_id="P", category="c", kg_per_unit=1, shelf_life_days=30, min_days_at_receipt=1, price_paise=10000)],
        godowns=[Godown(godown_id="G")],
        towns=[Town(town_id="T", population_2011=1)],
        lots=[
            Lot(lot_id="A_long", godown_id="G", product_id="P", qty_units=50, remaining_life_days=25),
            Lot(lot_id="B_short", godown_id="G", product_id="P", qty_units=50, remaining_life_days=8),
        ],
        routes=[Route(godown_id="G", town_id="T", road_km=10, transit_days=1, vehicle_class="road_avg")],
        demand=[Demand(town_id="T", product_id="P", quantiles=[5, 10, 20, 22, 25, 28, 30, 35, 40], point=25, sigma=6)],
    )


def test_fefo_stage2_differs_from_stage1():
    sc = fefo_scenario()
    res = optimizer.solve_stages(sc)
    s1 = optimizer.ship_units(res["net"], res["x1"])
    s2 = optimizer.ship_units(res["net"], res["x2"])
    assert res["v2"] == res["v_star"]
    assert sum(s1.values()) == sum(s2.values()) > 0
    assert s2 == {("B_short", "T"): sum(s2.values())}  # shortest life first
    assert s1 != s2
    plan = res["plan"]
    assert [a.lot_id for a in plan.allocations] == ["B_short"]


def test_newsvendor_fill_level():
    """1 godown, 1 town, f = 0, ample stock → fill at τ = c_u/(c_u + h) within one segment."""
    pol = Policy(margin=0.1, repo_rate=18.25)  # c_u = 1000, h = 450 → τ ≈ 0.69
    p = Product(product_id="P", category="c", kg_per_unit=1, shelf_life_days=30, min_days_at_receipt=1, price_paise=10000)
    q = [400, 600, 800, 830, 1000, 1170, 1200, 1400, 1600]
    sc = Scenario(
        scenario_id="nv", policy=pol, products=[p], godowns=[Godown(godown_id="G")],
        towns=[Town(town_id="T", population_2011=1)],
        lots=[Lot(lot_id="L", godown_id="G", product_id="P", qty_units=10_000, remaining_life_days=20)],
        routes=[Route(godown_id="G", town_id="T", road_km=0, transit_days=1)],
        demand=[Demand(town_id="T", product_id="P", quantiles=q, point=1000, sigma=300)],
    )
    t = Town(town_id="T", population_2011=1)
    cu, h = values.lost_margin(p, t, pol), values.holding(p, pol)
    tau_nv = cu / (cu + h)
    plan = optimizer.solve(sc)
    shipped = sum(a.units for a in plan.allocations)
    b = segments_from_quantiles(q)
    cum = np.cumsum(b)
    last = int(np.searchsorted(cum, shipped))  # 0-based index of last filled segment
    assert cum[last] == shipped
    assert abs(TAU_GRID[last] - tau_nv) <= 0.01 + 1e-9


def test_baselines_run():
    sc = tiny_scenario()
    for plan in (baselines.b_prime(sc), baselines.b_dprime(sc),
                 baselines.hindsight(sc, {("A", "P1"): 9, ("B", "P2"): 4})):
        assert plan.stage1_status == "Optimal"
        check_plan(sc, plan)
    bd = baselines.b_dprime(sc)
    assert all(a.segment_to <= 95 for a in bd.allocations)  # τ > 0.95 closed
    hs = baselines.hindsight(sc, {("A", "P1"): 9})
    assert sum(a.units for a in hs.allocations if (a.town_id, a.product_id) == ("A", "P1")) == 9 - 3  # net of on-hand
    assert sum(a.units for a in hs.allocations if (a.town_id, a.product_id) != ("A", "P1")) == 0


def test_model_shape_d008():
    net = build(tiny_scenario())
    nnz_per_col = np.diff(net.start)
    assert nnz_per_col.max() <= 2
    for c in range(net.num_col):
        vals = net.value[net.start[c]:net.start[c + 1]]
        assert sorted(vals.tolist()) in ([1.0], [-1.0], [-1.0, 1.0])


def _backend_cases():
    from aria.data.scenarios import random_scenario

    return [("tiny", tiny_scenario())] + [(f"random_{s}", random_scenario(s)) for s in range(30)]


@pytest.mark.parametrize("backend", ["highspy", "scipy"])
def test_backend_switch(monkeypatch, backend):
    pytest.importorskip("scipy")
    if backend == "highspy":
        pytest.importorskip("highspy")
        monkeypatch.delenv("ARIA_SOLVER", raising=False)
    else:
        monkeypatch.setenv("ARIA_SOLVER", "scipy")
    assert optimizer.backend() == backend


def test_backends_agree(monkeypatch):
    """Same V*, integral x and V(stage 2) == V* under highspy and SciPy's HiGHS (D-025)."""
    pytest.importorskip("scipy")
    pytest.importorskip("highspy")
    pytest.importorskip("aria.data.scenarios")
    for name, sc in _backend_cases():
        out = {}
        for backend in ("highspy", "scipy"):
            if backend == "scipy":
                monkeypatch.setenv("ARIA_SOLVER", "scipy")
            else:
                monkeypatch.delenv("ARIA_SOLVER", raising=False)
            res = optimizer.solve_stages(sc)
            plan = res["plan"]
            assert plan.stage1_status == "Optimal", (name, backend, plan.stage1_status)
            assert not plan.stage1_only, (name, backend, plan.label)
            for x in (res["x1"], res["x2"]):
                assert np.all(x >= 0) and np.array_equal(x, np.rint(x)), (name, backend)
            assert res["v2"] == res["v_star"] == plan.objective_paise, (name, backend)
            out[backend] = res["v_star"]
        assert out["highspy"] == out["scipy"], (name, out)
