"""Baseline (a): the deterministic rule-based greedy of PRD Appendix C (FR-P0-07, A7).

for each product k (ascending id):
  for each town s by (descending point forecast, ascending id):
    need = min(round(point + 1.65·σ), Q_top) − on-hand at s        # capped at top modelled quantile
    for each godown w with an active route to s, by (ascending freight/unit, ascending id):
      for each lot l at w of k, by (ascending remaining life, ascending id):
        if eligible(l, s): q = min(need, lot_left, cap_left); ship q
"""
from __future__ import annotations

from aria.engine import eligibility, values
from aria.forecast.segments import segments_from_quantiles
from aria.hashing import scenario_hash
from aria.schemas import Allocation, Plan, Scenario

Z = 1.65


def solve(sc: Scenario) -> Plan:
    pol = sc.policy
    towns = {t.town_id: t for t in sc.towns}
    on_hand: dict[tuple[str, str], int] = {}
    for s in sc.town_stock:
        if s.remaining_life_days > 0 and s.qty_units > 0:
            on_hand[(s.town_id, s.product_id)] = on_hand.get((s.town_id, s.product_id), 0) + s.qty_units
    lot_left = {lot.lot_id: lot.qty_units for lot in sc.lots}
    cap_left = {g.godown_id: g.dispatch_capacity_units for g in sc.godowns}  # None = unlimited

    allocs: list[Allocation] = []
    for p in sorted(sc.products, key=lambda x: x.product_id):
        h = values.holding(p, pol)
        dem = sorted((d for d in sc.demand if d.product_id == p.product_id), key=lambda d: (-d.point, d.town_id))
        lots_k = sorted((x for x in sc.lots if x.product_id == p.product_id), key=lambda x: (x.remaining_life_days, x.lot_id))
        for d in dem:
            s = d.town_id
            q_top = sum(segments_from_quantiles(d.quantiles))
            need = max(0, min(round(d.point + Z * d.sigma), q_top) - on_hand.get((s, p.product_id), 0))
            legs = [r for r in sc.routes if r.town_id == s and r.active]
            legs.sort(key=lambda r: (values.freight_per_unit(p, r, pol), r.godown_id))
            for r in legs:
                f = values.freight_per_unit(p, r, pol)
                for lot in lots_k:
                    if need <= 0:
                        break
                    if lot.godown_id != r.godown_id or not eligibility.eligible(lot, r, p):
                        continue
                    cap = cap_left[r.godown_id]
                    q = min(need, lot_left[lot.lot_id], cap if cap is not None else need)
                    if q <= 0:
                        continue
                    need -= q
                    lot_left[lot.lot_id] -= q
                    if cap is not None:
                        cap_left[r.godown_id] = cap - q
                    allocs.append(Allocation(
                        godown_id=r.godown_id, town_id=s, product_id=p.product_id, lot_id=lot.lot_id,
                        units=q, freight_per_unit_paise=f, freight_paise=q * f,
                        life_at_dispatch=lot.remaining_life_days,
                        life_on_arrival=lot.remaining_life_days - r.transit_days,
                        tau_star=values.tau_star(values.lost_margin(p, towns[s], pol), h, f)[0],
                        segment_from=0, segment_to=0,
                        at_risk=eligibility.at_risk(lot, p, sc.routes),
                    ))

    plan = Plan(plan_id=f"baseline_a-{scenario_hash(sc)[:12]}", policy="baseline_a", allocations=allocs,
                label="baseline (a): rule-based")
    plan.shortfalls = _shortfalls(sc, plan)
    from aria.metrics import plan_metrics
    from aria.verify.verifier import verify

    plan.metrics = plan_metrics(sc, plan)
    plan.objective_paise = plan.metrics["expected_value_paise"]
    plan.verifier = verify(sc, plan)
    return plan


def _shortfalls(sc: Scenario, plan: Plan) -> list:
    """Shortfall rows with reason codes from A's reasons module, when it exists."""
    try:
        from aria.engine import reasons
    except ImportError:
        return []
    fn = getattr(reasons, "shortfalls", None) or getattr(reasons, "classify", None)
    return list(fn(sc, plan)) if fn else []
