"""Metrics fixture, exact to the paisa (FR-P0-08). Every number below is hand-computed."""
from aria.metrics import bill, plan_metrics
from aria.schemas import Allocation, Demand, Godown, Lot, Plan, Product, Route, Scenario, Town, TownStock

# Product: ₹200, 2 kg, margin 3.5% → c_u = 700 paise, unit cost 19,300, h = 19,300 × 0.055 / 365 = 2.9082 paise,
# E_k = 19,300 (salvage 0). Route 10 km at 6t: f = 1103 × 2 × 10 / 1000 = 22.06 → 22 paise/unit.
# Quantiles all 3 → b_1 = 3 (τ = 0.01), every other b_j = 0. One unit on hand → net width 2.
# v_1 = round(700 × 0.99 − 2.9082 × 0.01) = round(692.97) = 693; credit_1 = round(19,300 × 0.99) = 19,107.
# L-RISK: life 5, shortest transit 1, min 4 → 5 − 1 = 4 = m → at risk.  L-OK: life 20.


def scenario() -> Scenario:
    return Scenario(
        scenario_id="metrics", network_id="fixture",
        products=[Product(product_id="P", category="c", kg_per_unit=2.0, shelf_life_days=30,
                          min_days_at_receipt=4, price_paise=20000)],
        godowns=[Godown(godown_id="G")],
        towns=[Town(town_id="T", population_2011=1)],
        lots=[Lot(lot_id="L-OK", godown_id="G", product_id="P", qty_units=10, remaining_life_days=20),
              Lot(lot_id="L-RISK", godown_id="G", product_id="P", qty_units=10, remaining_life_days=5)],
        town_stock=[TownStock(town_id="T", product_id="P", qty_units=1, remaining_life_days=9)],
        routes=[Route(godown_id="G", town_id="T", road_km=10, transit_days=1, vehicle_class="6t")],
        demand=[Demand(town_id="T", product_id="P", quantiles=[3] * 9, point=3, sigma=1)],
    )


def alloc(lot_id: str, units: int, risk: bool) -> Allocation:
    return Allocation(godown_id="G", town_id="T", product_id="P", lot_id=lot_id, units=units,
                      freight_per_unit_paise=22, freight_paise=22 * units, life_at_dispatch=0, life_on_arrival=0,
                      tau_star=0.0, segment_from=1, segment_to=1, at_risk=risk)


def test_plan_metrics_exact():
    plan = Plan(plan_id="m", policy="aria", allocations=[alloc("L-OK", 1, False), alloc("L-RISK", 1, True)])
    m = plan_metrics(scenario(), plan)
    # Two units fill the 2 free units of segment 1; the at-risk one earns the credit.
    # V = (693 + 19,107) + 693 − 2 × 22 = 20,449.
    assert m == {"units_shipped": 2, "freight_paise": 44, "expected_value_paise": 20449,
                 "shortfall_units": 0, "at_risk_units": 1, "rows": 2}


def test_plan_metrics_beyond_qtop_earns_nothing():
    plan = Plan(plan_id="m", policy="baseline_a", allocations=[alloc("L-OK", 4, False)])
    # 2 units fill segment 1 (2 × 693), the other 2 earn nothing; freight 4 × 22 = 88. V = 1,386 − 88 = 1,298.
    assert plan_metrics(scenario(), plan)["expected_value_paise"] == 1298


def test_bill_exact():
    b = bill(scenario(), freight_paise=44, demand={("T", "P"): 10}, sold={("T", "P"): 7},
             held={("T", "P"): 5}, written_off={"P": 2})
    # holding round(2.9082 × 5) = 15; write-off 2 × 19,300 = 38,600; lost 3 × 700 = 2,100.
    assert b == {"bill_paise": 44 + 15 + 38600 + 2100, "freight": 44, "holding": 15, "writeoff": 38600,
                 "lost_margin": 2100, "sold_units": 7, "demand_units": 10, "lost_units": 3, "writeoff_units": 2,
                 "fill_rate": 0.7}
