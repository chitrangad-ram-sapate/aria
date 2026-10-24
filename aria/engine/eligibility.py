"""Lot eligibility on arrival (FR-P0-04) and at-risk classification (PRD §7.4)."""
from __future__ import annotations

from aria.schemas import Lot, Product, Route, Scenario


def eligible(lot: Lot, route: Route, product: Product) -> bool:
    """Active route, qty > 0, life > 0, and life on arrival ≥ min days at receipt (equality eligible)."""
    return (
        route.active
        and lot.qty_units > 0
        and lot.remaining_life_days > 0
        and lot.remaining_life_days - route.transit_days >= product.min_days_at_receipt
    )


def shortest_transit(godown_id: str, routes: list[Route]) -> int | None:
    days = [r.transit_days for r in routes if r.godown_id == godown_id and r.active]
    return min(days) if days else None


def at_risk(lot: Lot, product: Product, routes: list[Route]) -> bool:
    """Shippable today on the shortest active leg but below the minimum one day later."""
    t = shortest_transit(lot.godown_id, routes)
    if t is None:
        return False
    m, r = product.min_days_at_receipt, lot.remaining_life_days
    return r - t >= m and r - 1 - t < m


def eligible_arcs(sc: Scenario) -> list[tuple[Lot, Route]]:
    """All (lot, route) pairs that may ship, in deterministic (lot_id, town_id) order."""
    products = {p.product_id: p for p in sc.products}
    by_godown: dict[str, list[Route]] = {}
    for r in sc.routes:
        by_godown.setdefault(r.godown_id, []).append(r)
    arcs = [
        (lot, r)
        for lot in sorted(sc.lots, key=lambda x: x.lot_id)
        for r in sorted(by_godown.get(lot.godown_id, []), key=lambda x: x.town_id)
        if eligible(lot, r, products[lot.product_id])
    ]
    return arcs
