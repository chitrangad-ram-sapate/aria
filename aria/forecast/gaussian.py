"""Gaussian quantiles from a point forecast and σ (baseline b′, FR-P0-07)."""
from __future__ import annotations

from statistics import NormalDist

from aria.schemas import QUANTILE_LEVELS

_Z = [NormalDist().inv_cdf(a) for a in QUANTILE_LEVELS]


def gaussian_quantiles(point: float, sigma: float) -> list[float]:
    """Q(τ) = max(0, point + z_τ · σ) at the 9 QUANTILE_LEVELS (monotone since σ ≥ 0)."""
    s = max(0.0, sigma)
    return [max(0.0, point + z * s) for z in _Z]
