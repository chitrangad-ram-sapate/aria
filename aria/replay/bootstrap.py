"""Moving-block bootstrap on daily paired series (decision D-016): 7-day blocks, 1,000 resamples,
95% percentile CI. Each window is resampled on its own; all series share the same day indices
(pairing), and window totals are added."""
from __future__ import annotations

from typing import Callable

import numpy as np

BLOCK = 7
N_BOOT = 1000
SEED = 20261024


def block_indices(n: int, rng: np.random.Generator, block: int = BLOCK) -> np.ndarray:
    """n day indices made of contiguous blocks with uniform random starts."""
    starts = rng.integers(0, n - block + 1, size=-(-n // block))
    return np.concatenate([np.arange(s, s + block) for s in starts])[:n]


def ci(series: dict[str, list[np.ndarray]], stat: Callable[[dict[str, float]], float],
       n_boot: int = N_BOOT, block: int = BLOCK, seed: int = SEED, alpha: float = 0.05) -> dict:
    """series: name -> one daily array per window. stat maps {name: total over windows} to a number.
    Returns {value, ci_low, ci_high} (value on the observed days)."""
    names = sorted(series)
    n_win = len(series[names[0]])
    observed = stat({k: float(sum(np.sum(w) for w in series[k])) for k in names})
    rng = np.random.default_rng(seed)
    draws = np.empty(n_boot)
    for b in range(n_boot):
        idx = [block_indices(len(series[names[0]][w]), rng, block) for w in range(n_win)]
        draws[b] = stat({k: float(sum(np.sum(series[k][w][idx[w]]) for w in range(n_win))) for k in names})
    lo, hi = np.percentile(draws, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return {"value": observed, "ci_low": float(lo), "ci_high": float(hi)}
