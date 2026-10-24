"""Scenario construction (FR-P0-01, decisions D-018, D-021).

* build_scenario: network + demand rows + products + lots + town stock + policy → Scenario.
* daily_scenario: reads the built parquet files for one network/day/window (used by the replay).
* bundled_scenarios: normal_week, monsoon_squeeze, edge_cases (and a normal week for any network).
* random_scenario: small seeded scenarios for property tests.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd

from aria.data.lots import generate_lots
from aria.data.network import build_network, load_network
from aria.forecast.train import QCOLS
from aria.schemas import Demand, Godown, Lot, Policy, Product, Route, Scenario, Town, TownStock

ROOT = Path(__file__).resolve().parents[2]
BUILT_DIR = ROOT / "data" / "built"
SCENARIO_DIR = ROOT / "data" / "scenarios"


def demand_from_rows(rows: pd.DataFrame) -> list[Demand]:
    """rows: town_id, product_id, q0..q8, point, sigma (one row per town × product)."""
    rows = rows.sort_values(["town_id", "product_id"], kind="stable")
    return [Demand(town_id=r.town_id, product_id=r.product_id, quantiles=[float(getattr(r, c)) for c in QCOLS],
                   point=float(r.point), sigma=float(r.sigma)) for r in rows.itertuples()]


def build_scenario(network: dict, day: str, demand: pd.DataFrame | list[Demand], products: list[Product],
                   lots: list[Lot], town_stock: list[TownStock] = (), policy: Policy | None = None,
                   scenario_id: str | None = None, godown_capacity: dict[str, int] | None = None,
                   inactive_routes: set[tuple[str, str]] = frozenset()) -> Scenario:
    godowns, towns, routes = build_network(network)
    for g in godowns:
        if godown_capacity and g.godown_id in godown_capacity:
            g.dispatch_capacity_units = godown_capacity[g.godown_id]
    for r in routes:
        if (r.godown_id, r.town_id) in inactive_routes:
            r.active = False
    pids = {p.product_id for p in products}
    dem = demand if isinstance(demand, list) else demand_from_rows(demand)
    return Scenario(scenario_id=scenario_id or f"{network['network_id']}_{day}", network_id=network["network_id"],
                    day=str(day), policy=policy or Policy(), products=sorted(products, key=lambda p: p.product_id),
                    godowns=godowns, towns=towns, lots=list(lots), town_stock=list(town_stock), routes=routes,
                    demand=[d for d in dem if d.product_id in pids])


def load_products(network_id: str, built_dir: Path = BUILT_DIR) -> list[Product]:
    df = pd.read_parquet(Path(built_dir) / f"{network_id}_products.parquet")
    fields = list(Product.model_fields)
    return [Product(**{k: r[k] for k in fields}) for r in df.to_dict("records")]


def forecast_rows(network_id: str, day: str, window: int, built_dir: Path = BUILT_DIR) -> pd.DataFrame:
    fc = pd.read_parquet(Path(built_dir) / f"{network_id}_forecasts.parquet")
    return fc[(fc["window"] == window) & (fc["day"] == pd.Timestamp(day))]


def daily_scenario(network_id: str, day: str, window: int, lots: list[Lot], town_stock: list[TownStock] = (),
                   policy: Policy | None = None, products: list[Product] | None = None,
                   built_dir: Path = BUILT_DIR, **kw) -> Scenario:
    """Scenario for one planning day of a held-out window, with the calibrated forecast for that day."""
    products = products or load_products(network_id, built_dir)
    return build_scenario(load_network(network_id), day, forecast_rows(network_id, day, window, built_dir), products,
                          lots, town_stock, policy, scenario_id=f"{network_id}_w{window}_{day}", **kw)


# ---------- bundled scenarios ----------

def _network_demand(rows: pd.DataFrame) -> dict[str, float]:
    return rows.groupby("product_id")["q4"].sum().to_dict()  # Σ town medians per product


def _split(units: int, godowns: list[str], weights: list[float]) -> dict[str, int]:
    w = np.asarray(weights, float) / sum(weights)
    out = np.floor(units * w).astype(int)
    out[0] += units - out.sum()
    return dict(zip(godowns, out.tolist()))


def _town_stock(rows: pd.DataFrame, products: list[Product], share: float, seed: int) -> list[TownStock]:
    rng = np.random.default_rng(seed)
    prod = {p.product_id: p for p in products}
    out = []
    for r in rows.sort_values(["town_id", "product_id"]).itertuples():
        q = int(math.floor(share * r.point))
        if q > 0 and r.product_id in prod:
            life = prod[r.product_id].shelf_life_days
            out.append(TownStock(town_id=r.town_id, product_id=r.product_id, qty_units=q,
                                 remaining_life_days=int(rng.integers(max(1, life // 3), life + 1))))
    return out


def _far_godown(net: dict) -> str:
    km = {}
    for r in net["routes"]:
        km.setdefault(r["godown_id"], []).append(r["road_km"])
    return max(sorted(km), key=lambda g: sum(km[g]) / len(km[g]))


def normal_week(net: dict, day: str, rows: pd.DataFrame, products: list[Product], seed: int = 1) -> Scenario:
    """Ample supply (2.5 × Σ town medians) split equally over all godowns; some town stock."""
    gids = [g["godown_id"] for g in net["godowns"]]
    dem = _network_demand(rows)
    supply = {}
    for p in products:
        for g, u in _split(int(math.ceil(2.5 * dem.get(p.product_id, 0))), gids, [1] * len(gids)).items():
            supply[(g, p.product_id)] = u
    lots = generate_lots(products, supply, seed, life_frac=(0.4, 1.0))
    return build_scenario(net, day, rows, products, lots, _town_stock(rows, products, 0.3, seed), Policy(),
                          scenario_id=f"{net['network_id']}_normal_week")


def monsoon_squeeze(net: dict, day: str, rows: pd.DataFrame, products: list[Product], seed: int = 2) -> Scenario:
    """Scarcity + near-expiry lots at the far godown (PRD FR-P0-01).

    Products cycle through three groups by sorted id:
      0 scarce   – near godowns only, 0.3 × Σ medians (every second one: a 1-unit trickle) → SUPPLY_USED
      1 blocked  – 1.5 × Σ medians at the far godown, whose dispatch capacity binds → STOCK_BLOCKED
      2 normal   – 1.2 × Σ medians at near godowns, plus near-expiry lots at the far godown.
    """
    far = _far_godown(net)
    near = [g["godown_id"] for g in net["godowns"] if g["godown_id"] != far]
    dem = _network_demand(rows)
    supply, near_expiry = {}, {}
    far_units = 0
    for i, p in enumerate(sorted(products, key=lambda p: p.product_id)):
        d = dem.get(p.product_id, 0)
        grp = i % 3
        if grp == 0:
            units = 1 if (i // 3) % 2 else max(2, int(math.floor(0.3 * d)))
            supply.update({(g, p.product_id): u for g, u in _split(units, near, [1] * len(near)).items()})
        elif grp == 1:
            supply[(far, p.product_id)] = int(math.ceil(1.5 * d))
            far_units += supply[(far, p.product_id)]
        else:
            supply.update({(g, p.product_id): u for g, u in _split(int(math.ceil(1.2 * d)), near, [1] * len(near)).items()})
            near_expiry[(far, p.product_id)] = max(1, int(0.3 * d))
            far_units += near_expiry[(far, p.product_id)]
    lots = generate_lots(products, supply, seed, life_frac=(0.5, 1.0))
    prod = {p.product_id: p for p in products}
    for (g, pid), q in sorted(near_expiry.items()):  # shippable today (transit 1 day), dead tomorrow → at risk
        lots.append(Lot(lot_id=f"L-{g}-{pid}-NX", godown_id=g, product_id=pid, qty_units=q,
                        remaining_life_days=min(prod[pid].shelf_life_days, prod[pid].min_days_at_receipt + 1)))
    return build_scenario(net, day, rows, products, lots, [], Policy(), scenario_id=f"{net['network_id']}_monsoon_squeeze",
                          godown_capacity={far: max(1, far_units // 4)})


def edge_cases(net: dict, day: str, rows: pd.DataFrame, products: list[Product], seed: int = 3) -> Scenario:
    """Six products, one per edge (reason codes 1-4):
      P0 no stock anywhere (1)              P1 lots too short-lived for any route (2, SHELF_LIFE_AT_RECEIPT)
      P2 stock only at a godown whose route to one town is closed (2, NO_ACTIVE_ROUTE for that town)
      P3 stock only at a capacity-bound godown (3, CAPACITY_BOUND)
      P4 ample normal stock                 P5 a 1-unit trickle (4, SUPPLY_USED)
    """
    prods = sorted(products, key=lambda p: p.product_id)[:6]
    gids = [g["godown_id"] for g in net["godowns"]]
    far = _far_godown(net)
    g_route = gids[0] if gids[0] != far else gids[1]
    closed_town = max((r for r in net["routes"] if r["godown_id"] == g_route), key=lambda r: r["road_km"])["town_id"]
    dem = _network_demand(rows)
    d = [dem.get(p.product_id, 0) for p in prods]
    lots = []
    p1 = prods[1]
    lots.append(Lot(lot_id=f"L-{gids[0]}-{p1.product_id}-SHORT", godown_id=gids[0], product_id=p1.product_id,
                    qty_units=int(math.ceil(d[1])) + 1, remaining_life_days=max(1, p1.min_days_at_receipt)))
    lots += generate_lots([prods[2]], {(g_route, prods[2].product_id): int(math.ceil(2 * d[2])) + 1}, seed)
    lots += generate_lots([prods[3]], {(far, prods[3].product_id): int(math.ceil(2 * d[3])) + 10}, seed + 1)
    lots += generate_lots([prods[4]], {(g, prods[4].product_id): u for g, u in
                                       _split(int(math.ceil(2 * d[4])) + 1, gids, [1] * len(gids)).items()}, seed + 2)
    lots.append(Lot(lot_id=f"L-{gids[0]}-{prods[5].product_id}-1", godown_id=gids[0], product_id=prods[5].product_id,
                    qty_units=1, remaining_life_days=prods[5].shelf_life_days))
    far_cap = max(1, int(0.2 * sum(l.qty_units for l in lots if l.godown_id == far)))
    return build_scenario(net, day, rows, prods, lots, [], Policy(), scenario_id=f"{net['network_id']}_edge_cases",
                          godown_capacity={far: far_cap}, inactive_routes={(g_route, closed_town)})


# ---------- random scenarios for property tests (D-018) ----------

def random_scenario(seed: int) -> Scenario:
    """2-3 godowns, 2-6 towns, 1-8 products; random lots, lives, routes, capacities and demand."""
    rng = np.random.default_rng(seed)
    ng, nt, npr = int(rng.integers(2, 4)), int(rng.integers(2, 7)), int(rng.integers(1, 9))
    products = []
    for k in range(npr):
        shelf = int(rng.integers(3, 61))
        products.append(Product(product_id=f"P{k}", category="synthetic", kg_per_unit=float(rng.choice([0.2, 0.5, 1.0, 2.0])),
                                shelf_life_days=shelf, min_days_at_receipt=int(rng.integers(0, min(shelf, 10) + 1)),
                                price_paise=int(rng.integers(1000, 50001))))
    godowns = [Godown(godown_id=f"G{i}", dispatch_capacity_units=int(rng.integers(5, 200)) if rng.random() < 0.3 else None)
               for i in range(ng)]
    towns = [Town(town_id=f"T{j}", population_2011=int(rng.integers(10_000, 600_000)),
                  priority=float(rng.choice([1.0, 1.0, 0.5, 2.0]))) for j in range(nt)]
    routes = []
    for g in godowns:
        for t in towns:
            if rng.random() < 0.85:
                km = float(round(rng.uniform(5, 500), 1))
                routes.append(Route(godown_id=g.godown_id, town_id=t.town_id, road_km=km, transit_days=int(rng.integers(0, 3)),
                                    vehicle_class=str(rng.choice(["55t", "road_avg", "6t"])), active=bool(rng.random() < 0.9)))
    lots, n = [], 0
    for g in godowns:
        for p in products:
            for _ in range(int(rng.integers(0, 3))):
                lots.append(Lot(lot_id=f"L{n}", godown_id=g.godown_id, product_id=p.product_id,
                                qty_units=int(rng.integers(1, 60)), remaining_life_days=int(rng.integers(1, p.shelf_life_days + 1))))
                n += 1
    stock, demand = [], []
    for t in towns:
        for p in products:
            if rng.random() < 0.3:
                stock.append(TownStock(town_id=t.town_id, product_id=p.product_id, qty_units=int(rng.integers(1, 15)),
                                       remaining_life_days=int(rng.integers(1, p.shelf_life_days + 1))))
            q = np.sort(rng.gamma(2.0, rng.uniform(1, 15), size=9))
            demand.append(Demand(town_id=t.town_id, product_id=p.product_id, quantiles=q.round(3).tolist(),
                                 point=float(q[4]), sigma=float((q[6] - q[2]) / 2)))
    policy = Policy(margin=float(rng.choice([0.035, 0.05])), salvage_share=float(rng.choice([0.0, 0.5, 1.0])))
    return Scenario(scenario_id=f"random_{seed}", network_id="random", day=f"r{seed}", policy=policy, products=products,
                    godowns=godowns, towns=towns, lots=lots, town_stock=stock, routes=routes, demand=demand)
