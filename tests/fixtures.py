"""Small hand-checkable scenarios shared by every test module."""
from aria.schemas import Demand, Godown, Lot, Product, Route, Scenario, Town, TownStock


def tiny_scenario(**overrides) -> Scenario:
    """2 godowns × 2 towns × 2 products; town B is the long leg (like Ratnagiri)."""
    q = [1, 2, 6, 7, 10, 13, 14, 18, 22]
    sc = Scenario(
        scenario_id="tiny",
        network_id="fixture",
        day="d1",
        products=[
            Product(product_id="P1", category="staples", kg_per_unit=1.0, shelf_life_days=30, min_days_at_receipt=3, price_paise=10000),
            Product(product_id="P2", category="dairy", kg_per_unit=0.5, shelf_life_days=7, min_days_at_receipt=2, price_paise=6000),
        ],
        godowns=[Godown(godown_id="G1", dispatch_capacity_units=60), Godown(godown_id="G2")],
        towns=[Town(town_id="A", population_2011=500000), Town(town_id="B", population_2011=80000)],
        lots=[
            Lot(lot_id="L1", godown_id="G1", product_id="P1", qty_units=25, remaining_life_days=20),
            Lot(lot_id="L2", godown_id="G1", product_id="P1", qty_units=10, remaining_life_days=5),
            Lot(lot_id="L3", godown_id="G2", product_id="P1", qty_units=15, remaining_life_days=12),
            Lot(lot_id="L4", godown_id="G2", product_id="P2", qty_units=30, remaining_life_days=3),
            Lot(lot_id="L5", godown_id="G1", product_id="P2", qty_units=8, remaining_life_days=6),
        ],
        town_stock=[TownStock(town_id="A", product_id="P1", qty_units=3, remaining_life_days=10)],
        routes=[
            Route(godown_id="G1", town_id="A", road_km=15, transit_days=1, vehicle_class="6t"),
            Route(godown_id="G1", town_id="B", road_km=130, transit_days=1, vehicle_class="road_avg"),
            Route(godown_id="G2", town_id="A", road_km=25, transit_days=1, vehicle_class="6t"),
            Route(godown_id="G2", town_id="B", road_km=140, transit_days=2, vehicle_class="road_avg"),
        ],
        demand=[
            Demand(town_id=t, product_id=p, quantiles=[x * s for x in q], point=10 * s, sigma=6 * s)
            for t, s in (("A", 1.0), ("B", 0.5))
            for p in ("P1", "P2")
        ],
    )
    return sc.model_copy(update=overrides)
