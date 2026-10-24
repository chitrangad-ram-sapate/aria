"""Freight-aware unit economics (FR-P0-05, PRD §6.1). Inputs/outputs in paise.

unit cost = price × (1 − margin)   (decision D-006: reproduces every §6.1 τ* figure)
"""
from __future__ import annotations

from aria.schemas import TAU_GRID, Policy, Product, Route, Town

TAU_TOP = TAU_GRID[-1]


def unit_cost(p: Product, pol: Policy) -> float:
    return p.price_paise * (1 - pol.margin)


def lost_margin(p: Product, town: Town, pol: Policy) -> float:
    """c_u: margin lost per unit of unmet demand."""
    return p.price_paise * pol.margin * town.priority


def holding(p: Product, pol: Policy) -> float:
    """h per unit-night: unit cost × repo / 365 (lower bound, R14)."""
    return unit_cost(p, pol) * pol.repo_rate / 365


def writeoff_base(p: Product, pol: Policy) -> float:
    """E_k = unit cost × (1 − salvage share)."""
    return unit_cost(p, pol) * (1 - pol.salvage_share)


def freight_per_unit(p: Product, route: Route, pol: Policy, vehicle_class: str | None = None) -> int:
    rate = pol.freight_paise_per_tkm[vehicle_class or route.vehicle_class]
    return round(rate * p.kg_per_unit / 1000 * route.road_km)


def tau_star(cu: float, h: float, f: float) -> tuple[float, bool]:
    """τ* = (c_u − f)/(c_u + h), clamped to [0, 0.995]; returns (τ*, capped_at_top)."""
    t = (cu - f) / (cu + h) if cu + h > 0 else 0.0
    return max(0.0, min(t, TAU_TOP)), t > TAU_TOP


def segment_values(cu: float, h: float) -> list[int]:
    """v_j = c_u(1 − τ_j) − h τ_j per segment, before freight (charged on the arc)."""
    return [round(cu * (1 - t) - h * t) for t in TAU_GRID]


def risk_credits(e: float) -> list[int]:
    """Write-off credit E_k(1 − τ_j) earned by an at-risk unit filling segment j."""
    return [round(e * (1 - t)) for t in TAU_GRID]


if __name__ == "__main__":
    # PRD §6.1 worked example: 1 kg, ₹100, 3.5% margin.
    p = Product(product_id="x", category="c", kg_per_unit=1, shelf_life_days=30, min_days_at_receipt=1, price_paise=10000)
    pol, town = Policy(), Town(town_id="t", population_2011=1)
    cu, h = lost_margin(p, town, pol), holding(p, pol)
    for km, vc, want in [(0, "road_avg", 0.995), (30, "6t", 0.902), (130, "road_avg", 0.856), (130, "6t", 0.588)]:
        f = pol.freight_paise_per_tkm[vc] * km / 1000  # unrounded, as in the PRD table
        got = tau_star(cu, h, f)[0]
        assert abs(got - want) < 0.001, (km, vc, got, want)
    print("ok")
