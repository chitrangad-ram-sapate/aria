"""Item → category attributes and synthetic lots (decision D-015, assumptions A4, A8).

kg/unit and shelf-life classes are Synthetic: each anonymous M5 item is assigned a food
category deterministically from its id; lots are drawn with a seeded RNG.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path

import numpy as np
import yaml

from aria.schemas import Lot, Product

MAPPING_PATH = Path(__file__).resolve().parents[2] / "data" / "mapping.yaml"


def load_mapping(path: str | Path = MAPPING_PATH) -> dict:
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _h(text: str) -> int:
    return int(hashlib.sha256(text.encode()).hexdigest()[:12], 16)


def item_attributes(item_id: str, mapping: dict) -> dict:
    """Deterministic category, kg/unit, shelf life and min days at receipt for one item."""
    cats = list(mapping["categories"].items())
    weights = np.array([c["weight"] for _, c in cats], dtype=float)
    u = (_h(item_id) % 10**6) / 10**6
    name, cat = cats[int(np.searchsorted(np.cumsum(weights / weights.sum()), u, side="right"))]
    lo, hi = cat["shelf_life_days"]
    shelf = lo + _h("shelf:" + item_id) % (hi - lo + 1)
    return {"category": name, "kg_per_unit": float(cat["kg_per_unit"]), "shelf_life_days": int(shelf),
            "min_days_at_receipt": int(math.ceil(mapping["min_days_share"] * shelf))}


def make_products(price_paise: dict[str, int], mapping: dict | None = None) -> list[Product]:
    """One Product per item id (sorted), with D-015 attributes and the given price."""
    mapping = mapping or load_mapping()
    return [Product(product_id=i, price_paise=int(p), **item_attributes(i, mapping)) for i, p in sorted(price_paise.items())]


def generate_lots(products: list[Product], supply: dict[tuple[str, str], int], seed: int,
                  life_frac: tuple[float, float] = (0.4, 1.0), max_lots: int = 3) -> list[Lot]:
    """Split supply[(godown_id, product_id)] units into 1..max_lots lots.

    Remaining life is uniform in [life_frac[0], life_frac[1]] × shelf life (at least 1 day).
    """
    rng = np.random.default_rng(seed)
    prod = {p.product_id: p for p in products}
    lots = []
    for (g, pid), units in sorted(supply.items()):
        if units <= 0:
            continue
        p = prod[pid]
        n = int(min(max_lots, units, rng.integers(1, max_lots + 1)))
        cuts = np.sort(rng.choice(np.arange(1, units), size=n - 1, replace=False)) if n > 1 else np.array([], int)
        sizes = np.diff(np.concatenate([[0], cuts, [units]])).astype(int)
        lo = max(1, int(round(life_frac[0] * p.shelf_life_days)))
        hi = max(lo, int(round(life_frac[1] * p.shelf_life_days)))
        for k, q in enumerate(sizes):
            lots.append(Lot(lot_id=f"L-{g}-{pid}-{k + 1}", godown_id=g, product_id=pid, qty_units=int(q),
                            remaining_life_days=int(rng.integers(lo, hi + 1))))
    return lots
