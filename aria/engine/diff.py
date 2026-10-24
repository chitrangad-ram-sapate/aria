"""Before/after plan diff and τ* changes for the Disruption Lab (FR-P0-11)."""
from __future__ import annotations

from aria.engine import values
from aria.engine.network_model import pair_segments
from aria.schemas import Plan, Scenario


def expected_lost_margin(sc: Scenario, plan: Plan) -> int:
    """Expected lost margin under the forecast: Σ unfilled segment width × (1 − τ_j) × c_u, paise.
    Segments are filled lowest first by on-hand then shipped units."""
    products = {p.product_id: p for p in sc.products}
    towns = {t.town_id: t for t in sc.towns}
    shipped: dict[tuple[str, str], int] = {}
    for a in plan.allocations:
        k = (a.town_id, a.product_id)
        shipped[k] = shipped.get(k, 0) + a.units
    total = 0.0
    for pair, ps in pair_segments(sc).items():
        cu = values.lost_margin(products[pair[1]], towns[pair[0]], sc.policy)
        left = shipped.get(pair, 0)
        for tau, w in zip(ps.taus, ps.widths):
            f = min(w, left)
            left -= f
            total += (w - f) * (1 - tau) * cu
    return round(total)


def _rows(plan: Plan) -> dict[tuple, int]:
    out: dict[tuple, int] = {}
    for a in plan.allocations:
        k = (a.godown_id, a.town_id, a.product_id, a.lot_id)
        out[k] = out.get(k, 0) + a.units
    return out


def _lost_margin(sc: Scenario | None, plan: Plan) -> int | None:
    if sc is not None:
        return expected_lost_margin(sc, plan)
    v = plan.metrics.get("lost_margin_paise")
    return int(v) if v is not None else None


def diff(before: Plan, after: Plan, sc_before: Scenario | None = None, sc_after: Scenario | None = None) -> dict:
    rb, ra = _rows(before), _rows(after)
    changed = [
        {"godown_id": k[0], "town_id": k[1], "product_id": k[2], "lot_id": k[3],
         "before_units": rb.get(k, 0), "after_units": ra.get(k, 0)}
        for k in sorted(set(rb) | set(ra))
        if rb.get(k, 0) != ra.get(k, 0)
    ]
    lm_b, lm_a = _lost_margin(sc_before, before), _lost_margin(sc_after, after)
    codes_b = {(s.town_id, s.product_id, s.reason, s.sub_reason) for s in before.shortfalls}
    new_codes = [
        {"town_id": s.town_id, "product_id": s.product_id, "reason": s.reason, "sub_reason": s.sub_reason}
        for s in after.shortfalls
        if (s.town_id, s.product_id, s.reason, s.sub_reason) not in codes_b
    ]
    return {
        "changed_rows": changed,
        "delta_units": sum(ra.values()) - sum(rb.values()),
        "delta_freight_paise": sum(a.freight_paise for a in after.allocations) - sum(a.freight_paise for a in before.allocations),
        "delta_lost_margin_paise": None if lm_b is None or lm_a is None else lm_a - lm_b,
        "delta_objective_paise": None if before.objective_paise is None or after.objective_paise is None
        else after.objective_paise - before.objective_paise,
        "new_reason_codes": new_codes,
    }


def tau_changes(before_plan: Plan, after_plan: Plan) -> list[dict]:
    """τ* changes per (route, product); a route that disappears has after = None."""
    b = {(t.godown_id, t.town_id, t.product_id): t for t in before_plan.tau_stars}
    a = {(t.godown_id, t.town_id, t.product_id): t for t in after_plan.tau_stars}
    out = []
    for k in sorted(set(a) | set(b)):
        tb, ta = b.get(k), a.get(k)
        if tb is not None and ta is not None and tb.tau_star == ta.tau_star and tb.freight_per_unit_paise == ta.freight_per_unit_paise:
            continue
        out.append({
            "godown_id": k[0], "town_id": k[1], "product_id": k[2],
            "before": None if tb is None else tb.tau_star, "after": None if ta is None else ta.tau_star,
            "freight_before_paise": None if tb is None else tb.freight_per_unit_paise,
            "freight_after_paise": None if ta is None else ta.freight_per_unit_paise,
        })
    return out
