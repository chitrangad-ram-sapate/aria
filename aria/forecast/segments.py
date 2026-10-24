"""9 calibrated quantiles → 100 integer demand segments (FR-P0-03, FIG 6; decision D-007)."""
from __future__ import annotations

import numpy as np

from aria.schemas import QUANTILE_LEVELS, TAU_GRID


def segments_from_quantiles(quantiles: list[float]) -> list[int]:
    """b_j widths: linear interpolation in τ anchored at Q(0)=0, rounded, monotone; Σb = Q(0.995)."""
    q = np.sort(np.maximum(np.asarray(quantiles, dtype=float), 0.0))  # uncross
    xs = np.concatenate([[0.0], QUANTILE_LEVELS])
    ys = np.concatenate([[0.0], q])
    cum = np.maximum.accumulate(np.rint(np.interp(TAU_GRID, xs, ys)).astype(int))
    return np.diff(np.concatenate([[0], cum])).tolist()


def net_of_stock(b: list[int], on_hand: int) -> list[int]:
    """Town stock fills the lowest segments first (C3)."""
    out = []
    for w in b:
        used = min(w, on_hand)
        on_hand -= used
        out.append(w - used)
    return out


if __name__ == "__main__":
    b = segments_from_quantiles([1, 2, 5, 6, 10, 14, 16, 22, 30])
    assert len(b) == 100 and sum(b) == 30 and min(b) >= 0
    assert sum(net_of_stock(b, 7)) == 23 and net_of_stock([3, 3], 4) == [0, 2]
    print("ok")
