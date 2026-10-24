"""Two-stage HiGHS solve (FR-P0-06, PRD FIG 13, implementation.md §4.5).

Stage 1 maximises V. Columns with a non-zero (integral) reduced cost are fixed at their
bound; stage 2 then minimises Σ remaining_life·x (FEFO) over the optimal face. V is
recomputed in Python ints; stage 2 is returned only if it reproduces V* exactly.
"""
from __future__ import annotations

import logging
import os

import numpy as np

try:
    import highspy
except ImportError:  # Pyodide (D-025): SciPy's bundled HiGHS is used instead
    highspy = None

from aria.engine import network_model, values
from aria.engine.network_model import Network, Pair
from aria.hashing import scenario_hash
from aria.schemas import Allocation, Plan, PolicyName, Scenario, TauStar

log = logging.getLogger(__name__)

TIME_LIMIT_S = 2.5
NOT_FEFO = "not FEFO-tie-broken"


def tau_star_table(sc: Scenario) -> list[TauStar]:
    """τ* per active (route, product) with demand at the route's town."""
    products = {p.product_id: p for p in sc.products}
    towns = {t.town_id: t for t in sc.towns}
    demand = {(d.town_id, d.product_id) for d in sc.demand}
    pol = sc.policy
    out = []
    for r in sorted(sc.routes, key=lambda r: (r.godown_id, r.town_id)):
        if not r.active or r.town_id not in towns:
            continue
        for k in sorted(products):
            if (r.town_id, k) not in demand:
                continue
            p = products[k]
            f = values.freight_per_unit(p, r, pol)
            t, capped = values.tau_star(values.lost_margin(p, towns[r.town_id], pol), values.holding(p, pol), f)
            out.append(TauStar(godown_id=r.godown_id, town_id=r.town_id, product_id=k,
                               tau_star=round(t, 4), capped=capped, freight_per_unit_paise=f))
    return out


def backend() -> str:
    """'highspy' when importable, else 'scipy'; env ARIA_SOLVER=scipy forces SciPy (Pyodide, D-025)."""
    if highspy is None or os.environ.get("ARIA_SOLVER", "").lower() == "scipy":
        return "scipy"
    return "highspy"


def _lp_highspy(net: Network, cost: np.ndarray, lower: np.ndarray, upper: np.ndarray, maximise: bool,
                time_limit: float):
    """One LP with highspy. Returns (status, x, reduced costs in the problem's own sense) or (status, None, None)."""
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    h.setOptionValue("solver", "simplex")
    h.setOptionValue("time_limit", float(time_limit))
    lp = highspy.HighsLp()
    lp.num_col_ = net.num_col
    lp.num_row_ = net.num_row
    lp.col_cost_ = cost.astype(float)
    lp.col_lower_ = lower
    lp.col_upper_ = np.where(np.isinf(upper), highspy.kHighsInf, upper)
    lp.row_lower_ = np.zeros(net.num_row)
    lp.row_upper_ = np.zeros(net.num_row)
    lp.sense_ = highspy.ObjSense.kMaximize if maximise else highspy.ObjSense.kMinimize
    lp.a_matrix_.format_ = highspy.MatrixFormat.kColwise
    lp.a_matrix_.num_col_ = net.num_col
    lp.a_matrix_.num_row_ = net.num_row
    lp.a_matrix_.start_ = net.start
    lp.a_matrix_.index_ = net.index
    lp.a_matrix_.value_ = net.value
    h.passModel(lp)
    h.run()
    status = h.modelStatusToString(h.getModelStatus())
    if h.getModelStatus() != highspy.HighsModelStatus.kOptimal:
        return status, None, None
    sol = h.getSolution()
    return "Optimal", np.asarray(sol.col_value), np.asarray(sol.col_dual)


def _lp_scipy(net: Network, cost: np.ndarray, lower: np.ndarray, upper: np.ndarray, maximise: bool,
              time_limit: float):
    """Same LP through scipy.optimize.linprog(method='highs-ds'), which always minimises."""
    from scipy.optimize import linprog
    from scipy.sparse import csc_matrix

    a = csc_matrix((net.value, net.index, net.start), shape=(net.num_row, net.num_col))
    c = -cost.astype(float) if maximise else cost.astype(float)
    bounds = np.column_stack([lower, upper])
    res = linprog(c, A_eq=a, b_eq=np.zeros(net.num_row), bounds=bounds, method="highs-ds",
                  options={"time_limit": float(time_limit)})
    if res.status != 0:
        return f"{res.status}: {res.message}", None, None
    rc = np.asarray(res.lower.marginals) + np.asarray(res.upper.marginals)  # d(min obj)/d(bound)
    return "Optimal", np.asarray(res.x), (-rc if maximise else rc)


def _lp(net: Network, cost: np.ndarray, lower: np.ndarray, upper: np.ndarray, maximise: bool,
        time_limit: float):
    fn = _lp_scipy if backend() == "scipy" else _lp_highspy
    return fn(net, cost, lower, upper, maximise, time_limit)


def _value(net: Network, x: np.ndarray) -> int:
    """V in Python ints from an integer primal."""
    nz = np.flatnonzero(x)
    return sum(int(net.cost[i]) * int(x[i]) for i in nz)


def _integral(a: np.ndarray, what: str) -> tuple[np.ndarray, bool]:
    r = np.rint(a)
    err = float(np.max(np.abs(a - r))) if len(a) else 0.0
    if err >= 1e-6:
        log.warning("%s not integral: max |a - rint(a)| = %g", what, err)
    return r, err < 1e-6


def _allocations(sc: Scenario, net: Network, x: np.ndarray) -> list[Allocation]:
    """Ship flows → lot rows; each row is attributed to the segments its town filled
    (lowest segment first, lots in (remaining life, id) order) to report segment_from/to."""
    products = {p.product_id: p for p in sc.products}
    towns = {t.town_id: t for t in sc.towns}
    pol = sc.policy
    # Filled units per (pair, risk) as a list of (j, units), ascending j.
    filled: dict[tuple[Pair, bool], list[list[int]]] = {}
    for a in net.seg:
        u = int(x[a.col])
        if u > 0:
            filled.setdefault((a.pair, a.risk), []).append([a.j, u])
    for v in filled.values():
        v.sort()
    flows: dict[tuple[Pair, bool], list] = {}
    for a in net.ship:
        u = int(x[a.col])
        if u > 0:
            flows.setdefault(((a.route.town_id, a.lot.product_id), a.risk), []).append((a, u))
    out = []
    for key in sorted(flows):
        segs = filled.get(key, [])
        pos = 0
        for a, u in sorted(flows[key], key=lambda t: (t[0].lot.remaining_life_days, t[0].lot.lot_id)):
            seg_from = seg_to = 0
            need = u
            while need > 0 and pos < len(segs):
                if seg_from == 0:
                    seg_from = segs[pos][0] + 1
                take = min(need, segs[pos][1])
                segs[pos][1] -= take
                need -= take
                seg_to = segs[pos][0] + 1
                if segs[pos][1] == 0:
                    pos += 1
            p = products[a.lot.product_id]
            t, _ = values.tau_star(values.lost_margin(p, towns[a.route.town_id], pol), values.holding(p, pol), a.freight)
            out.append(Allocation(
                godown_id=a.lot.godown_id, town_id=a.route.town_id, product_id=a.lot.product_id,
                lot_id=a.lot.lot_id, units=u, freight_per_unit_paise=a.freight, freight_paise=u * a.freight,
                life_at_dispatch=a.lot.remaining_life_days,
                life_on_arrival=a.lot.remaining_life_days - a.route.transit_days,
                tau_star=round(t, 4), segment_from=seg_from, segment_to=seg_to, at_risk=a.risk,
            ))
    out.sort(key=lambda r: (r.godown_id, r.town_id, r.product_id, r.lot_id))
    return out


def _shadow_prices(net: Network, x: np.ndarray, rc: np.ndarray) -> dict[str, int]:
    """Indicative value of one more unit in each lot: |rc| of its godown→lot arc when at its bound."""
    out = {}
    for lot_id, c in sorted(net.lot_col.items()):
        at_ub = x[c] >= net.upper[c] - 0.5
        out[lot_id] = abs(int(rc[c])) if at_ub else 0
    return out


def ship_units(net: Network, x: np.ndarray) -> dict[tuple[str, str], int]:
    return {(a.lot.lot_id, a.route.town_id): int(x[a.col]) for a in net.ship if int(x[a.col]) > 0}


def solve_stages(
    sc: Scenario,
    policy: PolicyName = "aria",
    segments: dict[Pair, list[tuple[int, float]]] | None = None,
    bonus_paise: int = 0,
    bonus_tau_max: float | None = None,
    time_limit: float = TIME_LIMIT_S,
) -> dict:
    """Full two-stage result: {plan, net, x1, x2, v_star, v2}. `segments` overrides
    (width, τ) per (town, product); bonus/threshold implement baseline b″."""
    plan_id = f"{policy}-{scenario_hash(sc)[:12]}"
    taus = tau_star_table(sc)
    net = network_model.build(sc, segments, bonus_paise, bonus_tau_max)
    res = {"net": net, "x1": None, "x2": None, "v_star": None, "v2": None}
    if net.num_col > network_model.E_SIZE:
        res["plan"] = Plan(plan_id=plan_id, policy=policy, stage1_status="E_SIZE", tau_stars=taus,
                           label=f"model too large: {net.num_col} columns > {network_model.E_SIZE}")
        return res
    if net.num_col == 0:
        res["plan"] = Plan(plan_id=plan_id, policy=policy, stage1_status="Optimal", stage2_status="Optimal",
                           objective_paise=0, tau_stars=taus)
        res["x1"] = res["x2"] = np.zeros(0)
        res["v_star"] = res["v2"] = 0
        return res

    # Stage 1: maximise V.
    s1, x, rc = _lp(net, net.cost, net.lower, net.upper, True, time_limit)
    if x is None:
        res["plan"] = Plan(plan_id=plan_id, policy=policy, stage1_status=s1, tau_stars=taus, label="no solution")
        return res
    x1, ok_x = _integral(x, "stage-1 primal")
    rc, ok_rc = _integral(rc, "stage-1 reduced costs")
    v_star = _value(net, x1)
    res.update(x1=x1, v_star=v_star)
    shadow = _shadow_prices(net, x1, rc)

    def stage1_plan(s2: str, label: str) -> Plan:
        return Plan(plan_id=plan_id, policy=policy, stage1_status=s1, stage2_status=s2, stage1_only=True,
                    objective_paise=v_star, allocations=_allocations(sc, net, x1), tau_stars=taus,
                    lot_shadow_price_paise=shadow, label=label)

    if not (ok_x and ok_rc):
        res["plan"] = stage1_plan("skipped", NOT_FEFO)
        return res

    # Stage 2: fix non-zero-RC columns at their current bound, minimise Σ r_l·x (FEFO).
    fix = rc != 0
    lower2 = np.where(fix, x1, net.lower)
    upper2 = np.where(fix, x1, net.upper)
    cost2 = np.zeros(net.num_col, dtype=np.int64)
    for a in net.ship:
        cost2[a.col] = a.lot.remaining_life_days
    s2, x, _ = _lp(net, cost2, lower2, upper2, False, time_limit)
    if x is None:
        res["plan"] = stage1_plan(s2, NOT_FEFO)
        return res
    x2, ok2 = _integral(x, "stage-2 primal")
    v2 = _value(net, x2)
    res.update(x2=x2, v2=v2)
    if not ok2 or v2 != v_star:
        log.warning("stage 2 V %s != V* %s; returning stage-1 plan", v2, v_star)
        res["plan"] = stage1_plan(s2, NOT_FEFO)
        return res
    res["plan"] = Plan(plan_id=plan_id, policy=policy, stage1_status=s1, stage2_status=s2,
                       objective_paise=v2, allocations=_allocations(sc, net, x2), tau_stars=taus,
                       lot_shadow_price_paise=shadow)
    return res


def solve(
    sc: Scenario,
    policy: PolicyName = "aria",
    segments: dict[Pair, list[tuple[int, float]]] | None = None,
    bonus_paise: int = 0,
    bonus_tau_max: float | None = None,
    time_limit: float = TIME_LIMIT_S,
) -> Plan:
    return solve_stages(sc, policy, segments, bonus_paise, bonus_tau_max, time_limit)["plan"]
