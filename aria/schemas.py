"""Shared data contract (PRD §7.5, §7.7). Money is integer paise, quantities integer units.

Region-agnostic: a Scenario carries its own network (godowns, towns, routes), so any
distributor network runs through the same engine. Kolhapur is one bundled network.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# M5 uncertainty levels (R11): the 9 quantiles every forecast must provide.
QUANTILE_LEVELS: tuple[float, ...] = (0.005, 0.025, 0.165, 0.25, 0.5, 0.75, 0.835, 0.975, 0.995)
# Segment grid β (FR-P0-03): β_0 = 0, then 0.01 … 0.99, then 0.995 → 100 segments, τ_j = β_j.
TAU_GRID: tuple[float, ...] = tuple(round(0.01 * j, 2) for j in range(1, 100)) + (0.995,)

VehicleClass = Literal["55t", "road_avg", "6t"]
PolicyName = Literal["aria", "baseline_a", "b_prime", "b_dprime", "hindsight"]
ShockType = Literal["INVENTORY_LOSS", "ROUTE_CLOSURE", "ROUTE_RESTRICTION", "FESTIVAL_SPIKE"]


class Product(BaseModel):
    product_id: str
    category: str
    kg_per_unit: float = Field(gt=0)
    shelf_life_days: int = Field(ge=1)
    min_days_at_receipt: int = Field(ge=0)
    price_paise: int = Field(ge=0)


class Godown(BaseModel):
    godown_id: str
    name: str = ""
    lat: float | None = None
    lon: float | None = None
    dispatch_capacity_units: int | None = Field(default=None, ge=0)


class Town(BaseModel):
    town_id: str
    name: str = ""
    population_2011: int = Field(ge=0)
    priority: float = 1.0
    lat: float | None = None
    lon: float | None = None


class Lot(BaseModel):
    lot_id: str
    godown_id: str
    product_id: str
    qty_units: int
    remaining_life_days: int


class TownStock(BaseModel):
    town_id: str
    product_id: str
    qty_units: int
    remaining_life_days: int


class Route(BaseModel):
    godown_id: str
    town_id: str
    road_km: float = Field(ge=0)
    transit_days: int = Field(ge=0)
    vehicle_class: VehicleClass = "road_avg"
    active: bool = True


class Policy(BaseModel):
    margin: float = 0.035  # R6 base; 0.05 sensitivity
    salvage_share: float = 0.0
    repo_rate: float = 0.055  # R14, holding lower bound
    # NCAER R1, paise per tonne-km by vehicle class
    freight_paise_per_tkm: dict[str, int] = {"55t": 151, "road_avg": 378, "6t": 1103}


class Demand(BaseModel):
    """Calibrated forecast for one (town, product) on the planning day."""
    town_id: str
    product_id: str
    quantiles: list[float]  # len 9, aligned with QUANTILE_LEVELS, non-crossing
    point: float  # point forecast (baseline a, b′)
    sigma: float  # forecast std (baseline a, b′)


class Scenario(BaseModel):
    scenario_id: str
    network_id: str = "kolhapur"
    day: str = ""
    policy: Policy = Policy()
    products: list[Product]
    godowns: list[Godown]
    towns: list[Town]
    lots: list[Lot]
    town_stock: list[TownStock] = []
    routes: list[Route]
    demand: list[Demand]


class Shock(BaseModel):
    type: ShockType
    godown_id: str | None = None
    town_id: str | None = None
    product_id: str = "*"
    pct: float = 0.0
    max_vehicle: VehicleClass = "6t"


# ---------- outputs ----------

class Allocation(BaseModel):
    godown_id: str
    town_id: str
    product_id: str
    lot_id: str
    units: int
    freight_per_unit_paise: int
    freight_paise: int
    life_at_dispatch: int
    life_on_arrival: int
    tau_star: float
    segment_from: int  # 1-based first segment filled by this row (0 for baseline a)
    segment_to: int
    at_risk: bool = False


class Shortfall(BaseModel):
    town_id: str
    product_id: str
    target_units: int
    on_hand_units: int
    shipped_units: int
    shortfall_units: int
    reason: str  # NO_STOCK_ANYWHERE | NO_ELIGIBLE_STOCK | STOCK_BLOCKED | SUPPLY_USED | UNCLASSIFIED
    sub_reason: str | None = None
    facts: dict = {}


class Violation(BaseModel):
    code: str  # V1..V8
    message: str
    path: str = ""


class VerifierResult(BaseModel):
    passed: bool
    violations: list[Violation] = []


class TauStar(BaseModel):
    godown_id: str
    town_id: str
    product_id: str
    tau_star: float
    capped: bool
    freight_per_unit_paise: int


class Plan(BaseModel):
    plan_id: str
    policy: PolicyName
    stage1_status: str = "n/a"
    stage2_status: str = "n/a"
    stage1_only: bool = False
    objective_paise: int | None = None  # V under the forecast
    allocations: list[Allocation] = []
    shortfalls: list[Shortfall] = []
    metrics: dict = {}
    verifier: VerifierResult = VerifierResult(passed=False)
    tau_stars: list[TauStar] = []
    lot_shadow_price_paise: dict[str, int] = {}
    label: str = ""  # e.g. "not FEFO-tie-broken", "fallback: baseline (a)"
