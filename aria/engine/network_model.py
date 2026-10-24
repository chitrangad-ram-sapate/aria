"""Min-cost-flow arrays for the allocation LP (FR-P0-06, PRD §7.4 FIG 12).

Decision D-008: every capacity is a column bound on an arc; rows are flow conservation only.

    src ─[0..cap_w]─▶ godown ─[0..q_l]─▶ lot ─[x: −f, eligible only]─▶ ENTRY(s,k) | RISK(s,k)
    ENTRY(s,k) ─[y: v_j]─▶ SEG(s,k,j)        RISK(s,k) ─[y: v_j + E_k(1−τ_j)]─▶ SEG(s,k,j)
    SEG(s,k,j) ─[0..b_j net of town stock]─▶ sink

src and sink carry no row, so each column has at most one +1 and one −1 (a network matrix).
Costs are integer paise for a MAXIMISE objective, rounded once here.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from aria.engine import values
from aria.engine.eligibility import at_risk, eligible_arcs
from aria.forecast.segments import net_of_stock, segments_from_quantiles
from aria.schemas import TAU_GRID, Lot, Route, Scenario

INF = float("inf")
E_SIZE = 300_000  # column guard (PRD §7.4)

Pair = tuple[str, str]  # (town_id, product_id)


@dataclass
class PairSegments:
    taus: list[float]
    widths: list[int]  # net of town stock
    values: list[int]  # v_j (+ bonus), paise
    credits: list[int]  # E_k(1 − τ_j), paise
    on_hand: int


@dataclass
class ShipArc:
    col: int
    lot: Lot
    route: Route
    freight: int  # paise per unit
    risk: bool


@dataclass
class SegArc:
    col: int
    pair: Pair
    j: int  # 0-based segment index
    risk: bool


@dataclass
class Network:
    num_row: int
    cost: np.ndarray  # int64, maximise
    lower: np.ndarray
    upper: np.ndarray
    start: np.ndarray
    index: np.ndarray
    value: np.ndarray
    ship: list[ShipArc] = field(default_factory=list)
    seg: list[SegArc] = field(default_factory=list)
    lot_col: dict[str, int] = field(default_factory=dict)  # godown→lot arc per lot
    godown_col: dict[str, int] = field(default_factory=dict)  # src→godown arc per godown
    pairs: dict[Pair, PairSegments] = field(default_factory=dict)

    @property
    def num_col(self) -> int:
        return len(self.cost)


def on_hand(sc: Scenario) -> dict[Pair, int]:
    out: dict[Pair, int] = {}
    for ts in sc.town_stock:
        if ts.remaining_life_days > 0 and ts.qty_units > 0:
            key = (ts.town_id, ts.product_id)
            out[key] = out.get(key, 0) + ts.qty_units
    return out


def default_segments(sc: Scenario) -> dict[Pair, list[tuple[int, float]]]:
    """Calibrated quantiles → 100 (width, τ) segments per (town, product), gross of town stock."""
    return {
        (d.town_id, d.product_id): list(zip(segments_from_quantiles(d.quantiles), TAU_GRID))
        for d in sc.demand
    }


def pair_segments(
    sc: Scenario,
    segments: dict[Pair, list[tuple[int, float]]] | None = None,
    bonus_paise: int = 0,
    bonus_tau_max: float | None = None,
) -> dict[Pair, PairSegments]:
    """Segment widths/values per (town, product). With bonus_tau_max set, segments with
    τ ≤ bonus_tau_max gain bonus_paise and segments above it are closed (baseline b″)."""
    products = {p.product_id: p for p in sc.products}
    towns = {t.town_id: t for t in sc.towns}
    pol = sc.policy
    stock = on_hand(sc)
    spec = default_segments(sc)
    if segments is not None:
        spec.update(segments)
    out: dict[Pair, PairSegments] = {}
    for pair in sorted(spec):
        town_id, product_id = pair
        if town_id not in towns or product_id not in products:
            continue
        p, t = products[product_id], towns[town_id]
        cu, h, e = values.lost_margin(p, t, pol), values.holding(p, pol), values.writeoff_base(p, pol)
        taus = [tau for _, tau in spec[pair]]
        widths = [max(0, int(w)) for w, _ in spec[pair]]
        vals = [round(cu * (1 - tau) - h * tau) for tau in taus]
        if bonus_tau_max is not None:
            for j, tau in enumerate(taus):
                if tau <= bonus_tau_max + 1e-9:
                    vals[j] += bonus_paise
                else:
                    widths[j] = 0
        oh = stock.get(pair, 0)
        out[pair] = PairSegments(
            taus=taus,
            widths=net_of_stock(widths, oh),
            values=vals,
            credits=[round(e * (1 - tau)) for tau in taus],
            on_hand=oh,
        )
    return out


def build(
    sc: Scenario,
    segments: dict[Pair, list[tuple[int, float]]] | None = None,
    bonus_paise: int = 0,
    bonus_tau_max: float | None = None,
) -> Network:
    products = {p.product_id: p for p in sc.products}
    caps = {g.godown_id: g.dispatch_capacity_units for g in sc.godowns}
    pairs = pair_segments(sc, segments, bonus_paise, bonus_tau_max)

    # Shipment arcs into pairs that have demand segments.
    arcs = []
    for lot, route in eligible_arcs(sc):
        if (route.town_id, lot.product_id) not in pairs:
            continue
        p = products[lot.product_id]
        risk = at_risk(lot, p, sc.routes)
        arcs.append((lot, route, values.freight_per_unit(p, route, sc.policy), risk))

    rows: dict[tuple, int] = {}

    def row(key: tuple) -> int:
        if key not in rows:
            rows[key] = len(rows)
        return rows[key]

    cost: list[int] = []
    lower: list[float] = []
    upper: list[float] = []
    start: list[int] = [0]
    index: list[int] = []
    value: list[float] = []

    def col(c: int, ub: float, entries: list[tuple[int, float]]) -> int:
        cost.append(c)
        lower.append(0.0)
        upper.append(ub)
        for r, v in entries:
            index.append(r)
            value.append(v)
        start.append(len(index))
        return len(cost) - 1

    net = Network(0, None, None, None, None, None, None, pairs=pairs)

    # src → godown (C5), godown → lot (C1).
    lots = {lot.lot_id: lot for lot, _, _, _ in arcs}
    for g in sorted({lot.godown_id for lot in lots.values()}):
        cap = caps.get(g)
        net.godown_col[g] = col(0, INF if cap is None else float(cap), [(row(("G", g)), 1.0)])
    for lot_id in sorted(lots):
        lot = lots[lot_id]
        net.lot_col[lot_id] = col(
            0, float(lot.qty_units), [(row(("G", lot.godown_id)), -1.0), (row(("L", lot_id)), 1.0)]
        )

    # lot → ENTRY/RISK(s,k), cost −f.
    for lot, route, f, risk in arcs:
        node = ("R" if risk else "E", route.town_id, lot.product_id)
        c = col(-f, INF, [(row(("L", lot.lot_id)), -1.0), (row(node), 1.0)])
        net.ship.append(ShipArc(c, lot, route, f, risk))

    # ENTRY/RISK → SEG (gain), SEG → sink (bound b).
    for pair in sorted(pairs):
        ps = pairs[pair]
        nodes = [k for k in (("E",) + pair, ("R",) + pair) if k in rows]
        if not nodes:
            continue
        for j, w in enumerate(ps.widths):
            if w <= 0:
                continue
            seg_row = row(("S",) + pair + (j,))
            for node in nodes:
                risk = node[0] == "R"
                gain = ps.values[j] + (ps.credits[j] if risk else 0)
                c = col(gain, INF, [(rows[node], -1.0), (seg_row, 1.0)])
                net.seg.append(SegArc(c, pair, j, risk))
            col(0, float(w), [(seg_row, -1.0)])

    net.num_row = len(rows)
    net.cost = np.asarray(cost, dtype=np.int64)
    net.lower = np.asarray(lower, dtype=float)
    net.upper = np.asarray(upper, dtype=float)
    net.start = np.asarray(start, dtype=np.int32)
    net.index = np.asarray(index, dtype=np.int32)
    net.value = np.asarray(value, dtype=float)
    return net
