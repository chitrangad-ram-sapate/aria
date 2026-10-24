"""Fair replay CLI (FR-P0-09, implementation.md §4.10, PRD §9 KPIs).

    python -m aria.replay.run --network kolhapur [--products 50] [--points own,road_avg,6t,55t] [--workers N]

Every policy × held-out window × freight point is replayed from the same starting stock, the same
seasonal-naive godown inflow (A3) and the same realised M5 demand path. Writes
data/built/replay_{network}.json. Pass rules are the pre-registered ones (PRD §9); never edit them here.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from aria.replay.bootstrap import ci
from aria.replay.simulate import no_leakage, run_window, seasonal_naive_inflow
from aria.schemas import Lot, TownStock

ROOT = Path(__file__).resolve().parents[2]
BUILT = ROOT / "data" / "built"
POLICIES = ("baseline_a", "b_prime", "b_dprime", "aria", "hindsight")
# Freight points: route's own vehicle class (headline) or every route forced to one class.
POINTS = {"own": None, "road_avg": "road_avg", "6t": "6t", "55t": "55t"}
START_SEED = 7


@lru_cache(maxsize=4)
def load(network: str, n_products: int | None) -> dict:
    """Shared inputs for one network: template scenario, per-day forecasts, realised demand, windows."""
    from aria.data.network import load_network
    from aria.data.scenarios import build_scenario, demand_from_rows, load_products

    products = load_products(network, BUILT)
    if n_products:
        rank = pd.read_parquet(BUILT / f"{network}_products.parquet").set_index("product_id")["volume_rank"]
        products = sorted(products, key=lambda p: (rank[p.product_id], p.product_id))[:n_products]
    pids = {p.product_id for p in products}
    fc = pd.read_parquet(BUILT / f"{network}_forecasts.parquet")
    fc = fc[fc["product_id"].isin(pids)]
    dd = pd.read_parquet(BUILT / f"{network}_demand_daily.parquet")
    dd = dd[dd["product_id"].isin(pids)]
    realised: dict[str, dict] = {}
    for r in dd.itertuples(index=False):
        realised.setdefault(str(pd.Timestamp(r.day).date()), {})[(r.town_id, r.product_id)] = int(r.qty)
    windows, forecasts = {}, {}
    for (w, day), rows in fc.groupby(["window", "day"], sort=True):
        d = str(pd.Timestamp(day).date())
        windows.setdefault(int(w), []).append(d)
        forecasts[d] = demand_from_rows(rows)
    template = build_scenario(load_network(network), "", [], products, [], [], scenario_id=f"replay_{network}")
    meta_path = BUILT / "forecast_meta.json"
    origins = json.loads(meta_path.read_text()).get("origins", []) if meta_path.exists() else []
    return {"template": template, "forecasts": forecasts, "realised": realised,
            "windows": {w: sorted(v) for w, v in sorted(windows.items())}, "origins": origins}


def start_state(inp: dict, days: list[str]) -> tuple[list[Lot], list[TownStock]]:
    """Shared opening stock for a window: godowns hold the network's realised demand of the 7 days
    before the window (split equally, seeded lot lives); each town holds the previous day's demand."""
    from aria.data.lots import generate_lots

    sc = inp["template"]
    gids = sorted(g.godown_id for g in sc.godowns)
    first = date.fromisoformat(days[0])
    week = [(first - timedelta(days=k)).isoformat() for k in range(1, 8)]
    net: dict[str, int] = {}
    for d in week:
        for (_, k), q in inp["realised"].get(d, {}).items():
            net[k] = net.get(k, 0) + q
    supply = {}
    for k, q in net.items():
        base, extra = divmod(q, len(gids))
        for i, g in enumerate(gids):
            supply[(g, k)] = base + (1 if i < extra else 0)
    lots = generate_lots(sc.products, supply, START_SEED)
    shelf = {p.product_id: p.shelf_life_days for p in sc.products}
    stock = [TownStock(town_id=s, product_id=k, qty_units=q, remaining_life_days=max(1, shelf[k] // 2))
             for (s, k), q in sorted(inp["realised"].get(week[0], {}).items()) if q > 0 and k in shelf]
    return lots, stock


def job(args: tuple) -> dict:
    network, n_products, point, policy, window = args
    inp = load(network, n_products)
    t0 = time.perf_counter()
    sc = inp["template"]
    if POINTS[point] is not None:
        sc = sc.model_copy(update={"routes": [r.model_copy(update={"vehicle_class": POINTS[point]}) for r in sc.routes]})
    days = inp["windows"][window]
    lots, stock = start_state(inp, days)
    inflow = seasonal_naive_inflow(inp["realised"], days, [g.godown_id for g in sc.godowns],
                                   {p.product_id: p.shelf_life_days for p in sc.products})
    r = run_window(sc, days, inp["forecasts"], inp["realised"], inflow, lots, stock, policy)
    r.update(point=point, policy=policy, window=window, seconds=round(time.perf_counter() - t0, 1))
    return r


def _series(results: list[dict], policy: str, field: str, windows: list[int]) -> list[np.ndarray]:
    by_w = {r["window"]: r for r in results if r["policy"] == policy}
    return [np.array([d[field] for d in by_w[w]["days"]], dtype=float) for w in windows]


def summarise(results: list[dict], point: str, windows: list[int]) -> dict:
    per = {}
    for pol in POLICIES:
        rs = [r for r in results if r["policy"] == pol]
        days = [d for r in rs for d in r["days"]]
        tot = {k: sum(d[k] for d in days) for k in ("bill_paise", "freight", "holding", "writeoff", "lost_margin",
                                                     "lost_units", "sold_units", "demand_units", "writeoff_units",
                                                     "shipped_units")}
        tot["fill_rate"] = tot["sold_units"] / tot["demand_units"] if tot["demand_units"] else 1.0
        tot["verifier_failures"] = sum(r["verifier_failures"] for r in rs)
        tot["conservation_ok"] = all(r["conservation_ok"] for r in rs)
        per[pol] = tot

    def s(pol, field):
        return _series(results, pol, field, windows)

    def diff_kpi(other: str, field: str = "bill_paise", strict: bool = True) -> dict:
        r = ci({"x": s("aria", field), "y": s(other, field)}, lambda t: t["x"] - t["y"])
        return {"diff_paise" if field == "bill_paise" else "diff": r["value"], "ci_low": r["ci_low"],
                "ci_high": r["ci_high"], "pass": r["ci_high"] < 0 if strict else r["ci_high"] <= 0}

    # KPI-3: (freight + holding + write-off) per unit sold, ARIA − (a); upper CI ≤ 0.
    cost3 = {pol: [f + h + w for f, h, w in zip(s(pol, "freight"), s(pol, "holding"), s(pol, "writeoff"))]
             for pol in ("aria", "baseline_a")}
    k3 = ci({"ca": cost3["aria"], "sa": s("aria", "sold_units"), "cb": cost3["baseline_a"], "sb": s("baseline_a", "sold_units")},
            lambda t: t["ca"] / t["sa"] - t["cb"] / t["sb"])
    # Display-only share of the (a)-to-(c) gap closed by ARIA; n/a when the gap's CI includes 0.
    gap = ci({"a": s("baseline_a", "bill_paise"), "c": s("hindsight", "bill_paise")}, lambda t: t["a"] - t["c"])
    closed = ci({"a": s("baseline_a", "bill_paise"), "x": s("aria", "bill_paise"), "c": s("hindsight", "bill_paise")},
                lambda t: (t["a"] - t["x"]) / (t["a"] - t["c"]) if t["a"] != t["c"] else float("nan"))
    gap_na = gap["ci_low"] <= 0 <= gap["ci_high"]
    # Exposé: lost-units-only ranking vs full-cost ranking (the M3 trap).
    by_lost = sorted(POLICIES, key=lambda p: (per[p]["lost_units"], p))
    by_bill = sorted(POLICIES, key=lambda p: (per[p]["bill_paise"], p))
    flips = [(a, b) for a in POLICIES for b in POLICIES
             if per[a]["lost_units"] < per[b]["lost_units"] and per[a]["bill_paise"] > per[b]["bill_paise"]]
    return {
        "freight_point": point,
        "conservation_ok": all(per[p]["conservation_ok"] for p in POLICIES),
        "per_policy": per,
        "kpi1": diff_kpi("b_dprime"),
        "kpi1b": diff_kpi("b_prime"),
        "kpi1c": diff_kpi("baseline_a"),
        "kpi3": {"diff_paise_per_unit": k3["value"], "ci_low": k3["ci_low"], "ci_high": k3["ci_high"],
                 "pass": k3["ci_high"] <= 0},
        "kpi4": diff_kpi("baseline_a", "writeoff_units", strict=False),
        "gap_closed": {"value": None if gap_na else closed["value"], "ci_low": closed["ci_low"],
                       "ci_high": closed["ci_high"], "gap_paise": gap["value"], "gap_ci": [gap["ci_low"], gap["ci_high"]],
                       "display": "n/a" if gap_na else f"{100 * closed['value']:.0f}%"},
        "expose": {
            "rank_by_lost_units": by_lost,
            "rank_by_full_cost": by_bill,
            "lost_units": {p: per[p]["lost_units"] for p in POLICIES},
            "bill_paise": {p: per[p]["bill_paise"] for p in POLICIES},
            "fewer_lost_units_but_dearer": [{"policy": a, "than": b} for a, b in flips],
            "message": ("Ranking by lost units alone differs from ranking by the full bill: "
                        "fewer lost sales were bought with cost." if by_lost != by_bill else
                        "Lost-units ranking and full-cost ranking agree: no policy over-stocks on this replay."),
        },
    }


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", default="kolhapur")
    ap.add_argument("--products", type=int, default=None, help="top-N products by volume (runtime fallback)")
    ap.add_argument("--points", default="own,road_avg,6t,55t")
    ap.add_argument("--windows", default=None, help="comma list, default all")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    a = ap.parse_args(argv)
    t0 = time.perf_counter()
    inp = load(a.network, a.products)
    windows = [int(w) for w in a.windows.split(",")] if a.windows else list(inp["windows"])
    points = a.points.split(",")
    leak = {}
    for i, w in enumerate(windows):
        days = inp["windows"][w]
        origin = inp["origins"][w - 1] if len(inp["origins"]) >= w else days[0]
        cutoff = (date.fromisoformat(origin) - timedelta(days=1)).isoformat()
        leak[w] = {"train_max_day": cutoff, "test_min_day": days[0], "ok": no_leakage(cutoff, days)}
    jobs = [(a.network, a.products, pt, pol, w) for pt in points for w in windows for pol in POLICIES]
    print(f"{a.network}: {len(inp['template'].products)} products, windows {windows}, "
          f"{len(jobs)} jobs on {a.workers} workers")
    results = []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for r in ex.map(job, jobs):
            print(f"  {r['point']:>8} w{r['window']} {r['policy']:>10}: {r['seconds']:6.1f} s  "
                  f"bill {sum(d['bill_paise'] for d in r['days']) / 100:,.0f} INR  conservation {r['conservation_ok']}")
            results.append(r)
    out = {"network": a.network, "products": len(inp["template"].products), "windows": windows,
           "window_days": {w: [inp["windows"][w][0], inp["windows"][w][-1]] for w in windows},
           "leakage": leak, "leakage_ok": all(v["ok"] for v in leak.values()), "points": {}}
    for pt in points:
        summ = summarise([r for r in results if r["point"] == pt], pt, windows)
        summ["conservation_ok"] = summ["conservation_ok"] and out["leakage_ok"]
        out["points"][pt] = summ
    if "road_avg" in out["points"] and "6t" in out["points"]:
        out["kpi10"] = {"pass": out["points"]["road_avg"]["kpi1"]["pass"] and out["points"]["6t"]["kpi1"]["pass"],
                        "road_avg": out["points"]["road_avg"]["kpi1"]["pass"], "6t": out["points"]["6t"]["kpi1"]["pass"],
                        "55t_reported": out["points"].get("55t", {}).get("kpi1")}
    out["runtime_s"] = round(time.perf_counter() - t0, 1)
    out["job_seconds"] = {f"{r['point']}/w{r['window']}/{r['policy']}": r["seconds"] for r in results}
    path = BUILT / f"replay_{a.network}.json"
    path.write_text(json.dumps(out, indent=1, default=float), encoding="utf-8")
    print(f"wrote {path} in {out['runtime_s']} s")


if __name__ == "__main__":
    main()
