"""Fair replay day loop (FR-P0-09, implementation.md §4.10, decision D-017).

Every policy starts from the same godown lots and town stock, receives the same daily godown
inflow and faces the same realised demand. Per day:
  1 add inflow  2 plan  3 ship (arrives with life − transit)  4 sell realised demand from town
  stock FEFO  5 unmet = lost sale  6 holding h per unit-night on unsold town units
  7 age everything 1 day; life ≤ 0 → written off  8 carry over.
The bill comes from aria.metrics (the one metrics function). Conservation, zero tolerance:
opening + received = sold + written off + closing.
"""
from __future__ import annotations

from typing import Callable

from aria.metrics import bill, plan_metrics
from aria.schemas import Demand, Lot, Plan, Scenario, TownStock
from aria.verify.verifier import verify

Key = tuple[str, str]
Planner = Callable[[Scenario, str, dict | None], Plan]


def default_planner(sc: Scenario, policy: str, realised: dict | None) -> Plan:
    from aria.engine.pipeline import run_policy

    return run_policy(sc, policy, realised if policy == "hindsight" else None)


def run_window(
    template: Scenario,
    days: list[str],
    forecasts: dict[str, list[Demand]],
    realised: dict[str, dict[Key, int]],
    inflow: dict[str, list[Lot]],
    start_lots: list[Lot],
    start_town_stock: list[TownStock],
    policy: str,
    planner: Planner = default_planner,
) -> dict:
    """Replay one window for one policy. Returns {days: [bill dict per day], conservation_ok, stock, verifier_failures}."""
    lots = {l.lot_id: [l.godown_id, l.product_id, l.qty_units, l.remaining_life_days] for l in start_lots}
    town: dict[Key, dict[int, int]] = {}  # (town, product) -> {remaining life: units}
    for s in start_town_stock:
        by_life = town.setdefault((s.town_id, s.product_id), {})
        by_life[s.remaining_life_days] = by_life.get(s.remaining_life_days, 0) + s.qty_units
    opening = sum(v[2] for v in lots.values()) + _units(town)
    received = sold_total = written_total = 0
    ok = True
    fails = 0
    routes = {(r.godown_id, r.town_id): r for r in template.routes}
    out = []

    for day in days:
        # 1 inflow
        for l in inflow.get(day, []):
            if l.lot_id in lots:
                lots[l.lot_id][2] += l.qty_units
            else:
                lots[l.lot_id] = [l.godown_id, l.product_id, l.qty_units, l.remaining_life_days]
            received += l.qty_units

        # 2 plan on today's state and forecast
        sc = template.model_copy(update={
            "day": day,
            "lots": [Lot(lot_id=i, godown_id=g, product_id=k, qty_units=q, remaining_life_days=r)
                     for i, (g, k, q, r) in sorted(lots.items()) if q > 0 and r > 0],
            "town_stock": [TownStock(town_id=s, product_id=k, qty_units=q, remaining_life_days=r)
                           for (s, k), by_life in sorted(town.items()) for r, q in sorted(by_life.items()) if q > 0],
            "demand": forecasts[day],
        })
        dem = realised.get(day, {})
        plan = planner(sc, policy, dem)
        if not verify(sc, plan).passed:
            fails += 1

        # 3 ship
        for a in plan.allocations:
            lot = lots[a.lot_id]
            lot[2] -= a.units
            if lot[2] < 0 or a.units < 0:
                ok = False
            life = lot[3] - routes[(a.godown_id, a.town_id)].transit_days
            by_life = town.setdefault((a.town_id, a.product_id), {})
            by_life[life] = by_life.get(life, 0) + a.units
        freight = plan_metrics(sc, plan)["freight_paise"]

        # 4–5 sell FEFO from town stock; unmet demand is lost
        sold: dict[Key, int] = {}
        for (s, k), want in sorted(dem.items()):
            by_life = town.get((s, k), {})
            for r in sorted(by_life):
                if want <= 0:
                    break
                if r <= 0 or by_life[r] <= 0:
                    continue
                q = min(want, by_life[r])
                by_life[r] -= q
                want -= q
                sold[(s, k)] = sold.get((s, k), 0) + q

        # 6 holding on unsold town stock overnight
        held = {key: n for key, by_life in town.items() if (n := sum(by_life.values())) > 0}

        # 7 age 1 day; expired → write-off (godown and town)
        written: dict[str, int] = {}
        for i in list(lots):
            g, k, q, r = lots[i]
            if r - 1 <= 0:
                if q > 0:
                    written[k] = written.get(k, 0) + q
                del lots[i]
            else:
                lots[i][3] = r - 1
        for (s, k), by_life in town.items():
            for r, q in list(by_life.items()):
                if q > 0 and r - 1 <= 0:
                    written[k] = written.get(k, 0) + q
            town[(s, k)] = {r - 1: q for r, q in by_life.items() if q > 0 and r - 1 > 0}

        b = bill(sc, freight, dem, sold, held, written)
        b["day"] = day
        b["shipped_units"] = sum(a.units for a in plan.allocations)
        out.append(b)
        sold_total += b["sold_units"]
        written_total += b["writeoff_units"]

    closing = sum(v[2] for v in lots.values()) + _units(town)
    ok = ok and opening + received == sold_total + written_total + closing
    return {
        "days": out,
        "conservation_ok": ok,
        "stock": {"opening": opening, "received": received, "sold": sold_total, "written_off": written_total,
                  "closing": closing},
        "verifier_failures": fails,
    }


def _units(town: dict[Key, dict[int, int]]) -> int:
    return sum(q for by_life in town.values() for q in by_life.values())


def no_leakage(train_max_day, window_days: list) -> bool:
    """train.max(day) < test.min(day)."""
    return train_max_day < min(window_days)


def seasonal_naive_inflow(history: dict[str, dict[Key, int]], days: list[str], godown_ids: list[str],
                          products: dict[str, int]) -> dict[str, list[Lot]]:
    """Shared godown inflow (A3): day t receives the network's realised demand of day t − 7 per product
    (seasonal naive), split equally across godowns (remainder to the lowest ids), at full shelf life.
    products: product_id -> shelf_life_days. Reads only days strictly before t (no leakage)."""
    from datetime import date, timedelta

    gs = sorted(godown_ids)
    out: dict[str, list[Lot]] = {}
    for day in days:
        src = (date.fromisoformat(day) - timedelta(days=7)).isoformat()
        assert src < day
        net: dict[str, int] = {}
        for (_, k), q in history.get(src, {}).items():
            if k in products:
                net[k] = net.get(k, 0) + q
        lots = []
        for k in sorted(net):
            base, extra = divmod(net[k], len(gs))
            for i, g in enumerate(gs):
                q = base + (1 if i < extra else 0)
                if q > 0:
                    lots.append(Lot(lot_id=f"IN-{day}-{g}-{k}", godown_id=g, product_id=k, qty_units=q,
                                    remaining_life_days=products[k]))
        out[day] = lots
    return out
