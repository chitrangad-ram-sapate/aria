"""Public entry points for the API and replay (PRD §7.3, failure behaviour §7.8)."""
from __future__ import annotations

import time

from aria.engine import baselines, diff as diff_mod, optimizer, reasons, shocks as shocks_mod
from aria.engine.reasons import explain  # noqa: F401  (re-exported)
from aria.hashing import scenario_hash
from aria.schemas import Plan, PolicyName, Scenario, Shock

FALLBACK_LABEL = "fallback: baseline (a)"
_BEFORE_CACHE: dict[str, dict] = {}
_CACHE_SIZE = 16


def run_policy(sc: Scenario, policy: PolicyName, realised: dict[tuple[str, str], int] | None = None) -> Plan:
    """One policy's plan, with shortfall rows and reason codes attached."""
    if policy == "aria":
        p = optimizer.solve(sc, "aria")
    elif policy == "b_prime":
        p = baselines.b_prime(sc)
    elif policy == "b_dprime":
        p = baselines.b_dprime(sc)
    elif policy == "hindsight":
        if realised is None:
            raise ValueError("hindsight needs realised demand")
        p = baselines.hindsight(sc, realised)
    elif policy == "baseline_a":
        from aria.engine.baseline_a import solve as solve_a

        p = solve_a(sc)
    else:
        raise ValueError(f"unknown policy {policy!r}")
    if p.objective_paise is None and policy != "baseline_a":
        return p
    if not p.shortfalls:
        p = p.model_copy(update={"shortfalls": reasons.shortfalls(sc, p)})
    return p


def _finish(sc: Scenario, p: Plan) -> Plan:
    """Verify and attach metrics (owner C modules)."""
    from aria.metrics import plan_metrics
    from aria.verify.verifier import verify

    p = p.model_copy(update={"verifier": verify(sc, p)})
    return p.model_copy(update={"metrics": plan_metrics(sc, p)})


def plan(sc: Scenario) -> dict:
    """ARIA next to baseline (a). ARIA is withheld (aria=None) when it has no solution or fails
    the verifier; baseline (a) is then recommended and labelled."""
    t0 = time.perf_counter()
    withheld = None
    aria: Plan | None
    try:
        aria = run_policy(sc, "aria")
        if aria.objective_paise is None:
            withheld = f"no solution ({aria.stage1_status})"
            aria = None
        else:
            aria = _finish(sc, aria)
            if not aria.verifier.passed:
                withheld = "verifier failed: " + ", ".join(v.code for v in aria.verifier.violations)
                aria = None
    except ImportError:
        raise
    except Exception as e:  # §7.8: never show an unverified plan
        withheld = f"error: {type(e).__name__}: {e}"
        aria = None
    base = _finish(sc, run_policy(sc, "baseline_a"))
    if aria is None:
        base = base.model_copy(update={"label": FALLBACK_LABEL})
    return {
        "scenario_hash": scenario_hash(sc),
        "solve_ms": round((time.perf_counter() - t0) * 1000),
        "recommended": "aria" if aria is not None else "baseline_a",
        "aria": aria,
        "baseline_a": base,
        "aria_withheld": withheld,
    }


def _cached_plan(sc: Scenario) -> dict:
    key = scenario_hash(sc)
    if key not in _BEFORE_CACHE:
        if len(_BEFORE_CACHE) >= _CACHE_SIZE:
            _BEFORE_CACHE.pop(next(iter(_BEFORE_CACHE)))
        _BEFORE_CACHE[key] = plan(sc)
    return _BEFORE_CACHE[key]


def whatif(sc: Scenario, shocks: list[Shock], before: dict | None = None) -> dict:
    """Re-plan under shocks; the 'before' result is reused from cache by scenario_hash."""
    before = before or _cached_plan(sc)
    sc2 = shocks_mod.apply(sc, shocks)
    after = plan(sc2)
    d = {}
    for k in ("aria", "baseline_a"):
        b, a = before[k], after[k]
        d[k] = None if b is None or a is None else diff_mod.diff(b, a, sc, sc2)
    tb = before["aria"] or Plan(plan_id="", policy="aria", tau_stars=optimizer.tau_star_table(sc))
    ta = after["aria"] or Plan(plan_id="", policy="aria", tau_stars=optimizer.tau_star_table(sc2))
    return {"before": before, "after": after, "diff": d, "tau_changes": diff_mod.tau_changes(tb, ta)}
