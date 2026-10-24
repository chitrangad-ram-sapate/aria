"""THE one metrics function family (rule R-5): plan view, replay and KPIs all call these.

plan_metrics: what a plan does under the forecast (expected value with ARIA's own values).
bill:         one day's realised full-cost bill (freight + holding + write-off + lost margin).
All money is integer paise.
"""
from __future__ import annotations

from aria.engine import eligibility, values
from aria.forecast.segments import net_of_stock, segments_from_quantiles
from aria.schemas import Plan, Scenario


def _on_hand(sc: Scenario) -> dict[tuple[str, str], int]:
    out: dict[tuple[str, str], int] = {}
    for s in sc.town_stock:
        if s.remaining_life_days > 0 and s.qty_units > 0:
            out[(s.town_id, s.product_id)] = out.get((s.town_id, s.product_id), 0) + s.qty_units
    return out


def plan_metrics(sc: Scenario, plan: Plan) -> dict:
    """Expected value under the forecast, the same way for every policy.

    Shipments are mapped lowest-segment-first after town stock, at-risk units first (they earn
    E_k(1−τ_j), which falls with τ, so this is the best mapping: it equals the LP's own V for an
    optimal plan and is a feasible LP point for baseline (a) — property P2).
    """
    pol = sc.policy
    products = {p.product_id: p for p in sc.products}
    towns = {t.town_id: t for t in sc.towns}
    routes = {(r.godown_id, r.town_id): r for r in sc.routes}
    lots = {lot.lot_id: lot for lot in sc.lots}
    demand = {(d.town_id, d.product_id): d for d in sc.demand}
    oh = _on_hand(sc)

    freight = units = risk_units = 0
    ship: dict[tuple[str, str], list[int]] = {}  # key -> [at-risk units, other units]
    for a in plan.allocations:
        p = products[a.product_id]
        freight += a.units * values.freight_per_unit(p, routes[(a.godown_id, a.town_id)], pol)
        units += a.units
        risky = eligibility.at_risk(lots[a.lot_id], p, sc.routes)
        risk_units += a.units if risky else 0
        ship.setdefault((a.town_id, a.product_id), [0, 0])[0 if risky else 1] += a.units

    gain = 0
    for key, (n_risk, n_other) in sorted(ship.items()):
        d = demand.get(key)
        if d is None:
            continue
        p, t = products[key[1]], towns[key[0]]
        v = values.segment_values(values.lost_margin(p, t, pol), values.holding(p, pol))
        c = values.risk_credits(values.writeoff_base(p, pol))
        width = net_of_stock(segments_from_quantiles(d.quantiles), oh.get(key, 0))
        for j, w in enumerate(width):
            r = min(w, n_risk)
            o = min(w - r, n_other)
            n_risk -= r
            n_other -= o
            gain += r * (v[j] + c[j]) + o * v[j]

    return {
        "units_shipped": units,
        "freight_paise": freight,
        "expected_value_paise": gain - freight,
        "shortfall_units": sum(s.shortfall_units for s in plan.shortfalls),
        "at_risk_units": risk_units,
        "rows": len(plan.allocations),
    }


def bill(sc: Scenario, freight_paise: int, demand: dict, sold: dict, held: dict, written_off: dict) -> dict:
    """One day's realised bill.

    demand, sold: {(town, product): units}; held: {(town, product): unit-nights of unsold town stock};
    written_off: {product: expired units, anywhere}. Each component is rounded to paise once per key.
    """
    pol = sc.policy
    products = {p.product_id: p for p in sc.products}
    towns = {t.town_id: t for t in sc.towns}
    holding = sum(round(values.holding(products[k], pol) * n) for (_, k), n in sorted(held.items()))
    writeoff = sum(round(values.writeoff_base(products[k], pol) * n) for k, n in sorted(written_off.items()))
    lost_units = 0
    lost_margin = 0
    for (s, k), dem in sorted(demand.items()):
        lost = dem - sold.get((s, k), 0)
        lost_units += lost
        lost_margin += round(values.lost_margin(products[k], towns[s], pol) * lost)
    total_demand = sum(demand.values())
    total_sold = sum(sold.values())
    return {
        "bill_paise": freight_paise + holding + writeoff + lost_margin,
        "freight": freight_paise,
        "holding": holding,
        "writeoff": writeoff,
        "lost_margin": lost_margin,
        "sold_units": total_sold,
        "demand_units": total_demand,
        "lost_units": lost_units,
        "writeoff_units": sum(written_off.values()),
        "fill_rate": total_sold / total_demand if total_demand else 1.0,
    }
