"""What-if shocks (FR-P0-11, implementation.md §4.9). apply() returns a new Scenario."""
from __future__ import annotations

import math

from aria.schemas import Scenario, Shock


def _check(sc: Scenario, i: int, s: Shock, need_town: bool) -> None:
    godowns = {g.godown_id for g in sc.godowns}
    towns = {t.town_id for t in sc.towns}
    if s.godown_id is not None and s.godown_id not in godowns:
        raise ValueError(f"shock[{i}]: unknown godown_id {s.godown_id!r}")
    if need_town:
        if s.godown_id is None or s.town_id is None:
            raise ValueError(f"shock[{i}]: {s.type} needs godown_id and town_id")
        if s.town_id not in towns:
            raise ValueError(f"shock[{i}]: unknown town_id {s.town_id!r}")
        if not any(r.godown_id == s.godown_id and r.town_id == s.town_id for r in sc.routes):
            raise ValueError(f"shock[{i}]: no route {s.godown_id}->{s.town_id}")
    if s.product_id != "*" and s.product_id not in {p.product_id for p in sc.products}:
        raise ValueError(f"shock[{i}]: unknown product_id {s.product_id!r}")
    if not 0 <= s.pct <= 100 and s.type == "INVENTORY_LOSS":
        raise ValueError(f"shock[{i}]: pct must be in [0, 100]")


def _match(value: str | None, want: str | None) -> bool:
    return want is None or want == "*" or value == want


def apply(sc: Scenario, shocks: list[Shock]) -> Scenario:
    sc = sc.model_copy(deep=True)
    rates = sc.policy.freight_paise_per_tkm
    labels = []
    for i, s in enumerate(shocks):
        if s.type == "INVENTORY_LOSS":
            _check(sc, i, s, need_town=False)
            for lot in sc.lots:
                if _match(lot.godown_id, s.godown_id) and _match(lot.product_id, s.product_id):
                    lot.qty_units = math.floor(lot.qty_units * (100 - s.pct) / 100 + 1e-9)
        elif s.type == "ROUTE_CLOSURE":
            _check(sc, i, s, need_town=True)
            for r in sc.routes:
                if r.godown_id == s.godown_id and r.town_id == s.town_id:
                    r.active = False
        elif s.type == "ROUTE_RESTRICTION":
            _check(sc, i, s, need_town=True)
            for r in sc.routes:
                if r.godown_id == s.godown_id and r.town_id == s.town_id and rates[s.max_vehicle] > rates[r.vehicle_class]:
                    r.vehicle_class = s.max_vehicle
        elif s.type == "FESTIVAL_SPIKE":
            _check(sc, i, s, need_town=False)
            k = 1 + s.pct / 100
            for d in sc.demand:
                if _match(d.town_id, s.town_id) and _match(d.product_id, s.product_id):
                    d.quantiles = [q * k for q in d.quantiles]
                    d.point *= k
                    d.sigma *= k
            labels.append(f"FESTIVAL_SPIKE(town={s.town_id or '*'},product={s.product_id},+{s.pct:g}%)")
        else:
            raise ValueError(f"shock[{i}]: unknown type {s.type}")
    if labels:
        sc.scenario_id = sc.scenario_id + " | " + "; ".join(labels)
    return sc
