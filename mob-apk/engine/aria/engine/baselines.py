"""Optimizer-based baselines b′, b″ and hindsight (c) (FR-P0-07, implementation.md §4.6)."""
from __future__ import annotations

from statistics import NormalDist

from aria.engine import optimizer, values
from aria.engine.eligibility import eligible_arcs
from aria.forecast.segments import segments_from_quantiles
from aria.schemas import QUANTILE_LEVELS, TAU_GRID, Plan, Scenario

B_DPRIME_TAU_MAX = 0.95


def gaussian_quantiles(point: float, sigma: float) -> list[float]:
    if sigma <= 0:
        return [max(0.0, point)] * len(QUANTILE_LEVELS)
    nd = NormalDist(point, sigma)
    return [max(0.0, nd.inv_cdf(t)) for t in QUANTILE_LEVELS]


def b_prime(sc: Scenario) -> Plan:
    """Same optimizer and values; segments from Gaussian quantiles of (point, σ)."""
    segs = {
        (d.town_id, d.product_id): list(zip(segments_from_quantiles(gaussian_quantiles(d.point, d.sigma)), TAU_GRID))
        for d in sc.demand
    }
    return optimizer.solve(sc, "b_prime", segments=segs)


def r_g(sc: Scenario) -> int:
    """Constant bonus R_g = (max freight/unit over eligible active arcs) + 1 paise."""
    products = {p.product_id: p for p in sc.products}
    f = [values.freight_per_unit(products[lot.product_id], r, sc.policy) for lot, r in eligible_arcs(sc)]
    return max(f, default=0) + 1


def b_dprime(sc: Scenario) -> Plan:
    """ARIA values + R_g on τ ≤ 0.95 segments; τ > 0.95 segments closed."""
    return optimizer.solve(sc, "b_dprime", bonus_paise=r_g(sc), bonus_tau_max=B_DPRIME_TAU_MAX)


def hindsight(sc: Scenario, realised: dict[tuple[str, str], int]) -> Plan:
    """One segment per (town, product) = realised demand, value c_u (τ = 0). Reference only."""
    keys = {(d.town_id, d.product_id) for d in sc.demand} | set(realised)
    segs = {k: [(int(realised.get(k, 0)), 0.0)] for k in keys}
    return optimizer.solve(sc, "hindsight", segments=segs)
