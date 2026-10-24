"""Shortfall reason codes (FR-P0-10, PRD §7.6 FIG 15) and explain-card facts.

A shortfall row is a (town, product) with on-hand + shipped < T, where T = Q(τ*) on the
cheapest eligible route, or Q(0.5) if none. Codes are tested in order; first match wins.
"""
from __future__ import annotations

import numpy as np

from aria.engine import values
from aria.engine.eligibility import at_risk, eligible
from aria.engine.network_model import on_hand, pair_segments
from aria.schemas import QUANTILE_LEVELS, Plan, Scenario, Shortfall

PARAM_SOURCES = {
    "margin": "R6",
    "repo_rate": "R14",
    "salvage_share": "App. D",
    "freight_paise_per_tkm": "R1 (NCAER)",
}


def quantile(quantiles: list[float], tau: float) -> int:
    """Q(τ): linear in τ between (0, 0) and the 9 uncrossed quantiles, rounded (as in D-007)."""
    q = np.sort(np.maximum(np.asarray(quantiles, dtype=float), 0.0))
    return int(np.rint(np.interp(tau, np.concatenate([[0.0], QUANTILE_LEVELS]), np.concatenate([[0.0], q]))))


class _Ctx:
    """Lookups shared by every row of one plan."""

    def __init__(self, sc: Scenario, plan: Plan):
        self.sc = sc
        self.products = {p.product_id: p for p in sc.products}
        self.towns = {t.town_id: t for t in sc.towns}
        self.godowns = {g.godown_id: g for g in sc.godowns}
        self.routes = {(r.godown_id, r.town_id): r for r in sc.routes}
        self.demand = {(d.town_id, d.product_id): d for d in sc.demand}
        self.on_hand = on_hand(sc)
        self.segs = pair_segments(sc)
        self.used_lot: dict[str, int] = {}
        self.used_godown: dict[str, int] = {}
        self.shipped: dict[tuple[str, str], int] = {}
        for a in plan.allocations:
            self.used_lot[a.lot_id] = self.used_lot.get(a.lot_id, 0) + a.units
            self.used_godown[a.godown_id] = self.used_godown.get(a.godown_id, 0) + a.units
            k = (a.town_id, a.product_id)
            self.shipped[k] = self.shipped.get(k, 0) + a.units
        self.plan = plan

    def stock(self, product_id: str):
        return sorted((l for l in self.sc.lots if l.product_id == product_id and l.qty_units > 0
                       and l.remaining_life_days > 0), key=lambda l: l.lot_id)

    def freight(self, product_id: str, route) -> int:
        return values.freight_per_unit(self.products[product_id], route, self.sc.policy)

    def cheapest_route(self, town_id: str, product_id: str):
        p = self.products[product_id]
        best = None
        for lot in self.stock(product_id):
            r = self.routes.get((lot.godown_id, town_id))
            if r is not None and eligible(lot, r, p):
                key = (self.freight(product_id, r), r.godown_id)
                if best is None or key < best[0]:
                    best = (key, r)
        return None if best is None else best[1]

    def target(self, town_id: str, product_id: str) -> tuple[int, float | None, object]:
        d = self.demand[(town_id, product_id)]
        r = self.cheapest_route(town_id, product_id)
        if r is None:
            return quantile(d.quantiles, 0.5), None, None
        p = self.products[product_id]
        t, _ = values.tau_star(values.lost_margin(p, self.towns[town_id], self.sc.policy),
                               values.holding(p, self.sc.policy), self.freight(product_id, r))
        return quantile(d.quantiles, t), t, r

    def next_value(self, pair, shipped: int, risk: bool) -> int | None:
        """Segment value of the next unit this town would receive (before freight)."""
        ps = self.segs.get(pair)
        if ps is None:
            return None
        cum = 0
        for j, w in enumerate(ps.widths):
            cum += w
            if cum > shipped:
                return ps.values[j] + (ps.credits[j] if risk else 0)
        return None

    def seg_value(self, pair, seg_1based: int, risk: bool) -> int | None:
        ps = self.segs.get(pair)
        if ps is None or not 1 <= seg_1based <= len(ps.values):
            return None
        j = seg_1based - 1
        return ps.values[j] + (ps.credits[j] if risk else 0)


def target_units(sc: Scenario, town_id: str, product_id: str) -> int:
    return _Ctx(sc, Plan(plan_id="", policy="aria")).target(town_id, product_id)[0]


def _classify(c: _Ctx, town_id: str, product_id: str, shipped: int) -> tuple[str, str | None, dict]:
    p = c.products[product_id]
    stock = c.stock(product_id)
    if not stock:
        return "NO_STOCK_ANYWHERE", None, {}

    elig, no_route, short_life = [], 0, 0
    for lot in stock:
        r = c.routes.get((lot.godown_id, town_id))
        if r is None or not r.active:
            no_route += lot.qty_units
        elif not eligible(lot, r, p):
            short_life += lot.qty_units
        else:
            elig.append((lot, r))
    if not elig:
        sub = "NO_ACTIVE_ROUTE" if no_route >= short_life else "SHELF_LIFE_AT_RECEIPT"
        return "NO_ELIGIBLE_STOCK", sub, {"units_no_active_route": no_route, "units_short_life_at_receipt": short_life}

    remaining = [(lot, r, lot.qty_units - c.used_lot.get(lot.lot_id, 0)) for lot, r in elig]
    remaining = [t for t in remaining if t[2] > 0]
    if remaining:
        capped, uneconomic, open_units = 0, 0, 0
        for lot, r, left in remaining:
            cap = c.godowns[lot.godown_id].dispatch_capacity_units if lot.godown_id in c.godowns else None
            if cap is not None and c.used_godown.get(lot.godown_id, 0) >= cap:
                capped += left
                continue
            v = c.next_value((town_id, product_id), shipped, at_risk(lot, p, c.sc.routes))
            if v is None or v - c.freight(product_id, r) <= 0:
                uneconomic += left
            else:
                open_units += left
        if open_units == 0:
            sub = "CAPACITY_BOUND" if capped else "UNECONOMIC"
            return "STOCK_BLOCKED", sub, {"units_capacity_bound": capped, "units_uneconomic": uneconomic}
        return "UNCLASSIFIED", None, {"eligible_units_remaining": open_units,
                                      "units_capacity_bound": capped, "units_uneconomic": uneconomic}

    lot_ids = {lot.lot_id for lot, _ in elig}
    rows = [a for a in c.plan.allocations if a.lot_id in lot_ids]
    elsewhere = [a for a in rows if a.town_id != town_id]
    if not elsewhere:
        return "SUPPLY_USED", "SUPPLY_EXHAUSTED", {"eligible_units": sum(l.qty_units for l, _ in elig)}
    recipients = []
    for t in sorted({a.town_id for a in elsewhere}):
        mine = [a for a in elsewhere if a.town_id == t]
        last = max(mine, key=lambda a: (a.segment_to, -a.freight_per_unit_paise, a.lot_id))
        v = c.seg_value((t, product_id), last.segment_to, last.at_risk)
        recipients.append({
            "town_id": t,
            "units": sum(a.units for a in mine),
            "last_unit_net_paise": None if v is None else v - last.freight_per_unit_paise,
        })
    return "SUPPLY_USED", "ALLOCATED_ELSEWHERE", {"recipients": recipients}


def shortfalls(sc: Scenario, plan: Plan) -> list:
    """One Shortfall per (town, product) below target, each with exactly one reason code."""
    c = _Ctx(sc, plan)
    out = []
    for pair in sorted(c.demand):
        town_id, product_id = pair
        if town_id not in c.towns or product_id not in c.products:
            continue
        target, tau, route = c.target(town_id, product_id)
        oh, shipped = c.on_hand.get(pair, 0), c.shipped.get(pair, 0)
        if oh + shipped >= target:
            continue
        reason, sub, facts = _classify(c, town_id, product_id, shipped)
        facts = {"tau_star": None if tau is None else round(tau, 4),
                 "target_route_godown_id": None if route is None else route.godown_id, **facts}
        out.append(Shortfall(town_id=town_id, product_id=product_id, target_units=target, on_hand_units=oh,
                             shipped_units=shipped, shortfall_units=target - oh - shipped,
                             reason=reason, sub_reason=sub, facts=facts))
    return out


def explain(sc: Scenario, plan: Plan, town_id: str, product_id: str) -> dict:
    """Explain-card facts for one (town, product); every primal fact comes from the plan or scenario."""
    c = _Ctx(sc, plan)
    pair = (town_id, product_id)
    if pair not in c.demand or product_id not in c.products or town_id not in c.towns:
        raise KeyError(f"no demand for town={town_id} product={product_id}")
    p, t, pol = c.products[product_id], c.towns[town_id], sc.policy
    ps = c.segs[pair]
    shipped = c.shipped.get(pair, 0)
    segments, left = [], shipped
    for j, (tau, w, v) in enumerate(zip(ps.taus, ps.widths, ps.values)):
        f = min(w, left)
        left -= f
        segments.append({"j": j + 1, "tau": tau, "width": w, "value_paise": v, "filled": f})
    rows = [a for a in plan.allocations if a.town_id == town_id and a.product_id == product_id]
    _, tau, route = c.target(town_id, product_id)
    if rows:
        freight = rows[0].freight_per_unit_paise
        tau_val = rows[0].tau_star
    else:
        freight = None if route is None else c.freight(product_id, route)
        tau_val = None if tau is None else round(tau, 4)
    reason = next((s.model_dump() for s in plan.shortfalls if s.town_id == town_id and s.product_id == product_id), None)
    vc = route.vehicle_class if route is not None else (c.routes[(rows[0].godown_id, town_id)].vehicle_class if rows else None)
    params = [
        {"name": "margin", "value": pol.margin, "source": PARAM_SOURCES["margin"]},
        {"name": "repo_rate", "value": pol.repo_rate, "source": PARAM_SOURCES["repo_rate"]},
        {"name": "salvage_share", "value": pol.salvage_share, "source": PARAM_SOURCES["salvage_share"]},
        {"name": "price_paise", "value": p.price_paise, "source": "scenario"},
        {"name": "town_priority", "value": t.priority, "source": "scenario"},
        {"name": "c_u_paise", "value": round(values.lost_margin(p, t, pol)), "source": "derived: price × margin × priority"},
        {"name": "h_paise", "value": round(values.holding(p, pol), 4), "source": "derived: unit cost × repo / 365"},
    ]
    if vc is not None:
        params.append({"name": f"freight_paise_per_tkm[{vc}]", "value": pol.freight_paise_per_tkm[vc],
                       "source": PARAM_SOURCES["freight_paise_per_tkm"]})
    return {
        "town_id": town_id,
        "product_id": product_id,
        "on_hand_units": ps.on_hand,
        "shipped_units": shipped,
        "segments": segments,
        "tau_star": tau_val,
        "freight_per_unit_paise": freight,
        "life_on_arrival": [{"lot_id": a.lot_id, "godown_id": a.godown_id, "units": a.units,
                             "life_on_arrival": a.life_on_arrival} for a in rows],
        "lot_shadow_price_paise": {a.lot_id: plan.lot_shadow_price_paise.get(a.lot_id, 0) for a in rows},
        "lot_shadow_price_note": "indicative (duals are non-unique)",
        "reason": reason,
        "params": params,
    }
