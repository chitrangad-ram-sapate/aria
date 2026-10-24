"""Plan verifier V1–V8 (PRD Appendix B, FR-P0-08).

Independent of the solver (rule R-4): imports only the shared value, eligibility and segment
helpers, never aria.engine.optimizer / network_model / pipeline / baselines.

V1 integer, non-negative quantities      V5 dispatch capacity respected
V2 lot stock respected                    V6 shortfall = T − (on-hand + shipped)
V3 every shipment on an eligible arc      V7 all IDs exist
V4 on-hand + shipped ≤ Q_top = Σ b_j      V8 segments within width; no unfilled segment strictly
                                             higher-valued than a filled one

Segment widths depend on the policy: ARIA / (a) use the calibrated quantiles, b′ uses Gaussian
quantiles from (point, σ), b″ closes segments with τ > 0.95. For the hindsight reference (c) the
segments are the realised demand, which the Scenario does not carry, so V4 and V8 are skipped.
Baseline (a) is a rule, not value-optimal, and carries no segment rows, so V8 does not apply.
"""
from __future__ import annotations

from statistics import NormalDist

from aria.engine import eligibility, values
from aria.forecast.segments import net_of_stock, segments_from_quantiles
from aria.schemas import QUANTILE_LEVELS, TAU_GRID, Plan, Scenario, VerifierResult, Violation

B_DPRIME_TOP_TAU = 0.95


def gaussian_quantiles(point: float, sigma: float) -> list[float]:
    """9 Gaussian quantiles from (point, σ), floored at 0 (baseline b′). Re-derived here rather than
    imported from aria.engine.baselines, which imports the optimizer (R-4)."""
    if sigma <= 0:
        return [max(0.0, point)] * len(QUANTILE_LEVELS)
    nd = NormalDist(point, sigma)
    return [max(0.0, nd.inv_cdf(t)) for t in QUANTILE_LEVELS]


def policy_widths(sc: Scenario, policy: str) -> dict[tuple[str, str], list[int]]:
    """Segment widths b_j per (town, product) as the given policy models them (before town stock)."""
    out = {}
    for d in sc.demand:
        if policy == "b_prime":
            b = segments_from_quantiles(gaussian_quantiles(d.point, d.sigma))
        else:
            b = segments_from_quantiles(d.quantiles)
        if policy == "b_dprime":
            b = [w if t <= B_DPRIME_TOP_TAU else 0 for w, t in zip(b, TAU_GRID)]
        out[(d.town_id, d.product_id)] = b
    return out


def on_hand(sc: Scenario) -> dict[tuple[str, str], int]:
    """Unexpired town stock per (town, product)."""
    out: dict[tuple[str, str], int] = {}
    for s in sc.town_stock:
        if s.remaining_life_days > 0 and s.qty_units > 0:
            out[(s.town_id, s.product_id)] = out.get((s.town_id, s.product_id), 0) + s.qty_units
    return out


def _is_count(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x >= 0


def _assign_segments(rows, width: list[int]):
    """Place each row's units inside its declared [segment_from, segment_to] (earliest-deadline greedy,
    optimal for interval-capacity matching). Returns (filled[row] -> {j: units}, residual, ok)."""
    residual = list(width)
    left = {i: r.units for i, r in rows}
    filled = {i: {} for i, _ in rows}
    for j in range(1, len(width) + 1):
        live = sorted((r.segment_to, i) for i, r in rows if r.segment_from <= j <= r.segment_to and left[i] > 0)
        for _, i in live:
            q = min(left[i], residual[j - 1])
            if q:
                filled[i][j] = q
                left[i] -= q
                residual[j - 1] -= q
    return filled, residual, all(v == 0 for v in left.values())


def verify(sc: Scenario, plan: Plan) -> VerifierResult:
    vs: list[Violation] = []

    def bad(code: str, msg: str, path: str = "") -> None:
        vs.append(Violation(code=code, message=msg, path=path))

    products = {p.product_id: p for p in sc.products}
    godowns = {g.godown_id: g for g in sc.godowns}
    towns = {t.town_id: t for t in sc.towns}
    lots = {lot.lot_id: lot for lot in sc.lots}
    routes = {(r.godown_id, r.town_id): r for r in sc.routes}

    # V7 / V1 first; rows failing either are excluded from the arithmetic checks below.
    good = []
    for i, a in enumerate(plan.allocations):
        path = f"allocations[{i}]"
        ok = True
        for field, ids in (("godown_id", godowns), ("town_id", towns), ("product_id", products), ("lot_id", lots)):
            if getattr(a, field) not in ids:
                bad("V7", f"unknown {field} {getattr(a, field)!r}", f"{path}.{field}")
                ok = False
        if a.lot_id in lots and (lots[a.lot_id].godown_id != a.godown_id or lots[a.lot_id].product_id != a.product_id):
            bad("V7", f"lot {a.lot_id} is not ({a.godown_id}, {a.product_id})", path)
            ok = False
        for field in ("units", "freight_paise", "freight_per_unit_paise"):
            if not _is_count(getattr(a, field)):
                bad("V1", f"{field}={getattr(a, field)!r} is not a non-negative integer", f"{path}.{field}")
                ok = False
        if ok:
            good.append((i, a))
    for i, s in enumerate(plan.shortfalls):
        for field, ids in (("town_id", towns), ("product_id", products)):
            if getattr(s, field) not in ids:
                bad("V7", f"unknown {field} {getattr(s, field)!r}", f"shortfalls[{i}].{field}")
        for field in ("target_units", "on_hand_units", "shipped_units", "shortfall_units"):
            if not _is_count(getattr(s, field)):
                bad("V1", f"{field}={getattr(s, field)!r} is not a non-negative integer", f"shortfalls[{i}].{field}")

    # V2 lot stock
    used: dict[str, int] = {}
    for _, a in good:
        used[a.lot_id] = used.get(a.lot_id, 0) + a.units
    for lid, u in sorted(used.items()):
        if u > max(lots[lid].qty_units, 0):
            bad("V2", f"lot {lid} ships {u} > stock {lots[lid].qty_units}", f"lots[{lid}]")

    # V3 eligibility
    for i, a in good:
        r = routes.get((a.godown_id, a.town_id))
        if a.units > 0 and (r is None or not eligibility.eligible(lots[a.lot_id], r, products[a.product_id])):
            bad("V3", f"lot {a.lot_id} → {a.town_id} is not an eligible arc", f"allocations[{i}]")

    # V5 dispatch capacity
    disp: dict[str, int] = {}
    for _, a in good:
        disp[a.godown_id] = disp.get(a.godown_id, 0) + a.units
    for gid, u in sorted(disp.items()):
        cap = godowns[gid].dispatch_capacity_units
        if cap is not None and u > cap:
            bad("V5", f"godown {gid} dispatches {u} > capacity {cap}", f"godowns[{gid}]")

    shipped: dict[tuple[str, str], int] = {}
    for _, a in good:
        shipped[(a.town_id, a.product_id)] = shipped.get((a.town_id, a.product_id), 0) + a.units
    oh = on_hand(sc)

    # V6 shortfall arithmetic, against recomputed on-hand and shipped
    for i, s in enumerate(plan.shortfalls):
        key = (s.town_id, s.product_id)
        if s.on_hand_units != oh.get(key, 0) or s.shipped_units != shipped.get(key, 0):
            bad("V6", f"shortfall {key}: on-hand/shipped {s.on_hand_units}/{s.shipped_units} "
                      f"≠ {oh.get(key, 0)}/{shipped.get(key, 0)}", f"shortfalls[{i}]")
        elif s.shortfall_units != s.target_units - (s.on_hand_units + s.shipped_units) or s.shortfall_units <= 0:
            bad("V6", f"shortfall {key}: {s.shortfall_units} ≠ {s.target_units} − ({s.on_hand_units} + {s.shipped_units})",
                f"shortfalls[{i}]")

    if plan.policy == "hindsight":
        return VerifierResult(passed=not vs, violations=vs)

    # V4 Q_top
    widths = policy_widths(sc, plan.policy)
    for key, u in sorted(shipped.items()):
        qtop = sum(widths.get(key, []))
        if u > 0 and u > max(0, qtop - oh.get(key, 0)):
            bad("V4", f"{key}: on-hand {oh.get(key, 0)} + shipped {u} > Q_top {qtop}", f"demand[{key}]")

    # V8 segments within width; no unfilled segment strictly higher-valued than a filled one.
    # Per row the unit's net value in segment j is v_j (+ E_k(1−τ_j) if at-risk) − f; the freight
    # term is common to every segment the row could fill, so it cancels in the comparison.
    if plan.policy != "baseline_a":
        pol = sc.policy
        by_key: dict[tuple[str, str], list] = {}
        for i, a in good:
            if a.units > 0:
                by_key.setdefault((a.town_id, a.product_id), []).append((i, a))
        for key, rows in sorted(by_key.items()):
            width = net_of_stock(widths.get(key, [0] * len(TAU_GRID)), oh.get(key, 0))
            n = len(width)
            if any(not (1 <= a.segment_from <= a.segment_to <= n) for _, a in rows):
                bad("V8", f"{key}: segment range outside 1..{n}", f"allocations[{rows[0][0]}]")
                continue
            filled, residual, ok = _assign_segments(rows, width)
            if not ok:
                bad("V8", f"{key}: shipped units exceed the widths of their declared segments", f"demand[{key}]")
                continue
            p, t = products[key[1]], towns[key[0]]
            v = values.segment_values(values.lost_margin(p, t, pol), values.holding(p, pol))
            c = values.risk_credits(values.writeoff_base(p, pol))
            for i, a in rows:
                risky = eligibility.at_risk(lots[a.lot_id], p, sc.routes)
                val = [v[j] + (c[j] if risky else 0) for j in range(n)]
                lo = min((val[j - 1] for j in filled[i]), default=None)
                hi = max((val[j] for j in range(n) if residual[j] > 0), default=None)
                if lo is not None and hi is not None and hi > lo:
                    bad("V8", f"{key}: unfilled segment worth {hi} > filled segment worth {lo} (lot {a.lot_id})",
                        f"allocations[{i}]")
                    break

    return VerifierResult(passed=not vs, violations=vs)
