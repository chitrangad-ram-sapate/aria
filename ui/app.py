"""ARIA Streamlit UI. Three views: Plan & Compare (J1/J2), Proof (J3), Disruption Lab (J4).

Rule R-3: this file only formats numbers returned by the API. All computation happens server-side.
Run: streamlit run ui/app.py   (API base URL from ARIA_API_URL, default http://127.0.0.1:8000)
"""
from __future__ import annotations

import math
import os

import altair as alt
import httpx
import pandas as pd
import streamlit as st

API = os.environ.get("ARIA_API_URL", "http://127.0.0.1:8000").rstrip("/")
TIMEOUT = 15.0  # client timeout above the 10 s server budget (PRD §7.7)
SHOCKS = ["ROUTE_RESTRICTION", "ROUTE_CLOSURE", "INVENTORY_LOSS", "FESTIVAL_SPIKE"]
FREIGHT_POINT_LABELS = {"own": "each route's own class", "road_avg": "₹3.78 / t-km", "6t": "₹11.03 / t-km", "55t": "₹1.51 / t-km"}
POLICY_LABELS = {"aria": "ARIA", "baseline_a": "(a) rule-based", "b_prime": "b′", "b_dprime": "b″", "hindsight": "(c) hindsight"}
MONEY_KEYS = {"freight", "holding", "writeoff", "lost_margin", "ci_low", "ci_high"}

st.set_page_config(page_title="ARIA", layout="wide")
st.markdown(
    """
    <style>
      .block-container {padding-top: 1.6rem;}
      .aria-tag {display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.78rem;
                 font-family: ui-monospace, monospace; background:#eef1f5; color:#33415c; margin-right:6px;}
      .aria-stale {background:#fde8e8; color:#9b1c1c; font-weight:600;}
      .aria-ok {background:#e6f4ea; color:#1e6b34;}
      .aria-warn {background:#fff4e0; color:#8a5300;}
      div[data-testid="stMetricValue"] {font-size: 1.35rem;}
    </style>
    """,
    unsafe_allow_html=True,
)

ss = st.session_state
ss.setdefault("rid", 0)
ss.setdefault("scenario", None)
ss.setdefault("scenario_id", None)
ss.setdefault("report", None)  # last /api/validate response for the current inputs
ss.setdefault("plan", None)  # latest /api/plan response
ss.setdefault("plan_rid", None)
ss.setdefault("whatif", None)
ss.setdefault("whatif_rid", None)
ss.setdefault("whatif_key", None)
ss.setdefault("net_error", None)


# ---------- helpers (formatting and HTTP only) ----------

def next_rid() -> int:
    ss.rid += 1
    return ss.rid


def call(method: str, path: str, **kw):
    """→ (status_code, json). Retries once on a network error; on failure marks shown results stale."""
    for attempt in (1, 2):
        try:
            r = httpx.request(method, API + path, timeout=TIMEOUT, **kw)
            ss.net_error = None
            try:
                return r.status_code, r.json()
            except ValueError:
                return r.status_code, {"detail": r.text}
        except httpx.HTTPError as exc:
            err = f"{type(exc).__name__}: {exc}"
    ss.net_error = err
    return None, {"detail": f"API unreachable at {API} ({err})"}


def rupees(paise) -> str:
    if paise is None:
        return "-"
    return f"₹{paise / 100:,.2f}"


def fmt_value(key: str, v):
    if isinstance(v, bool) or v is None:
        return str(v)
    if isinstance(v, (int, float)) and "paise" in key:
        return rupees(v)
    if isinstance(v, float):
        return f"{v:,.4f}" if abs(v) < 10 else f"{v:,.2f}"
    if isinstance(v, int):
        return f"{v:,}"
    return str(v)


def tag(text: str, kind: str = "") -> str:
    return f'<span class="aria-tag {kind}">{text}</span>'


def result_header(resp: dict, stale: bool, extra: list[str] | None = None):
    bits = [tag(f"scenario_hash {str(resp.get('scenario_hash') or '')[:12]}"), tag(f"request_id {resp.get('request_id')}")]
    bits += [tag(x) for x in (extra or [])]
    bits.append(tag("STALE - inputs changed; re-run", "aria-stale") if stale else tag("current", "aria-ok"))
    st.markdown(" ".join(bits), unsafe_allow_html=True)


def show_issues(report: dict | None):
    if not report:
        return
    errs, warns = report.get("errors") or [], report.get("warnings") or []
    if errs:
        st.error(f"{len(errs)} validation error(s) - no plan can be produced until they are fixed.")
        st.dataframe(pd.DataFrame(errs), hide_index=True, use_container_width=True)
    if warns:
        with st.expander(f"{len(warns)} warning(s)"):
            st.dataframe(pd.DataFrame(warns), hide_index=True, use_container_width=True)


def clean_records(df: pd.DataFrame) -> list[dict]:
    """Data-editor rows back to JSON: NaN -> missing, whole floats -> int (type coercion only)."""
    out = []
    for row in df.to_dict("records"):
        rec = {}
        for k, v in row.items():
            if isinstance(v, float) and math.isnan(v):
                continue
            if isinstance(v, float) and v.is_integer():
                v = int(v)
            rec[k] = v
        out.append(rec)
    return out


def revalidate():
    code, body = call("POST", "/api/validate", json={"request_id": next_rid(), "scenario": ss.scenario})
    ss.report = body if code == 200 else {"errors": [{"code": "HTTP", "path": "$", "message": str(body.get("detail"))}], "warnings": [], "scenario_hash": None}


def current_hash():
    return (ss.report or {}).get("scenario_hash")


def is_stale(resp: dict | None) -> bool:
    return resp is None or ss.net_error is not None or resp.get("scenario_hash") != current_hash()


def metrics_table(plans: dict[str, dict | None]) -> pd.DataFrame:
    keys = []
    for p in plans.values():
        for k in ((p or {}).get("metrics") or {}):
            if k not in keys:
                keys.append(k)
    rows = [{"metric": k, **{name: fmt_value(k, ((p or {}).get("metrics") or {}).get(k)) for name, p in plans.items()}} for k in keys]
    return pd.DataFrame(rows)


def plan_label(p: dict | None, name: str) -> str:
    if p is None:
        return f"{name}: withheld"
    bits = [f"stage 1 {p.get('stage1_status')}", f"stage 2 {p.get('stage2_status')}"]
    v = p.get("verifier") or {}
    bits.append("verified" if v.get("passed") else f"verifier FAILED ({len(v.get('violations') or [])})")
    if p.get("label"):
        bits.append(p["label"])
    return f"{name}: " + " | ".join(bits)


def alloc_frame(p: dict) -> pd.DataFrame:
    df = pd.DataFrame(p.get("allocations") or [])
    if df.empty:
        return df
    cols = ["godown_id", "town_id", "product_id", "lot_id", "units", "freight_per_unit_paise", "freight_paise",
            "life_at_dispatch", "life_on_arrival", "tau_star", "segment_from", "segment_to", "at_risk"]
    df = df[[c for c in cols if c in df.columns]].copy()
    for c in ("freight_per_unit_paise", "freight_paise"):
        if c in df:
            df[c] = df[c].map(rupees)
    return df.rename(columns={"freight_per_unit_paise": "freight / unit", "freight_paise": "freight"})


def shortfall_frame(p: dict) -> pd.DataFrame:
    rows = []
    for s in p.get("shortfalls") or []:
        rows.append({k: s.get(k) for k in ("town_id", "product_id", "target_units", "on_hand_units", "shipped_units",
                                           "shortfall_units", "reason", "sub_reason")}
                    | {"facts": "; ".join(f"{k}={fmt_value(k, v)}" for k, v in (s.get("facts") or {}).items())})
    return pd.DataFrame(rows)


# ---------- sidebar: network + scenario ----------

st.sidebar.markdown("## ARIA")
st.sidebar.caption("Distribution intelligence and inventory optimisation")
code, health = call("GET", "/api/health")
if code == 200:
    st.sidebar.markdown(tag("API online", "aria-ok") + tag(health.get("solver_version", "")), unsafe_allow_html=True)
else:
    st.sidebar.markdown(tag("API offline", "aria-stale"), unsafe_allow_html=True)
    st.sidebar.caption(health.get("detail", ""))

view = st.sidebar.radio("View", ["Plan & Compare", "Proof", "Disruption Lab"])

_, networks = call("GET", "/api/networks")
networks = networks if isinstance(networks, list) else []
net_ids = [n["network_id"] for n in networks]
network = st.sidebar.selectbox("Network", net_ids or ["(none bundled)"])
net_info = next((n for n in networks if n["network_id"] == network), {})

_, scenarios = call("GET", "/api/scenarios")
scenarios = scenarios if isinstance(scenarios, list) else []
sc_ids = [s["scenario_id"] for s in scenarios if s.get("network_id") in (network, None)] or [s["scenario_id"] for s in scenarios]
chosen = st.sidebar.selectbox("Scenario", sc_ids or ["(none)"])
if sc_ids and chosen != ss.scenario_id:
    c, doc = call("GET", f"/api/scenarios/{chosen}")
    if c == 200:
        ss.scenario, ss.scenario_id = doc, chosen
        ss.plan = ss.whatif = None
        revalidate()

with st.sidebar.expander("Import distributor CSV"):
    st.caption("Columns: date, item, outlet/town, qty, price")
    up = st.file_uploader("CSV file", type=["csv"], label_visibility="collapsed")
    if up is not None and st.button("Import"):
        c, body = call("POST", "/api/import", files={"file": (up.name, up.getvalue(), "text/csv")})
        if c == 202:
            st.success(f"Imported {body.get('rows')} rows as {body.get('scenario_id')}; forecast job {body.get('forecast_job_id')}")
            for w in body.get("warnings") or []:
                st.caption(str(w))
        else:
            st.error(str(body.get("detail")))

if ss.net_error:
    st.warning(f"Network error talking to the API - results below are marked STALE. {ss.net_error}")


# ---------- view 1: Plan & Compare ----------

def view_plan():
    st.title("Plan & Compare")
    if ss.scenario is None:
        st.info("Pick a scenario in the sidebar.")
        return
    sc = ss.scenario
    st.caption(f"Scenario {sc.get('scenario_id')} | network {sc.get('network_id')} | day {sc.get('day')} | "
               f"{len(sc.get('godowns', []))} godowns, {len(sc.get('towns', []))} towns, {len(sc.get('products', []))} products")

    st.subheader("Godown stock")
    lots_df = pd.DataFrame(sc.get("lots") or [])
    edited = st.data_editor(lots_df, num_rows="dynamic", use_container_width=True, height=260, key=f"lots-{ss.scenario_id}")
    new_lots = clean_records(edited)
    if new_lots != sc.get("lots"):
        sc["lots"] = new_lots
        revalidate()
    show_issues(ss.report)

    if st.button("Plan tonight", type="primary"):
        rid = next_rid()
        ss.plan_rid = rid
        with st.spinner("Solving..."):
            c, body = call("POST", "/api/plan", json={"request_id": rid, "scenario": sc})
        if c == 422:
            ss.report = body
            ss.plan = None
            st.rerun()
        elif c != 200:
            st.error(f"Plan failed ({c}): {body.get('detail')}")
        elif body.get("request_id") == ss.plan_rid:  # only the latest response is shown
            ss.plan = body

    resp = ss.plan
    if not resp:
        return
    stale = is_stale(resp)
    result_header(resp, stale, [f"solve {resp.get('solve_ms')} ms", f"recommended {resp.get('recommended')}"])
    aria, base = resp.get("aria"), resp.get("baseline_a")
    if aria is None:
        st.warning(f"ARIA plan withheld ({resp.get('aria_withheld') or 'no solution or verifier failure'}). "
                   "Showing rule-based baseline (a), labelled.")
    st.caption(plan_label(aria, "ARIA"))
    st.caption(plan_label(base, "Baseline (a)"))

    st.subheader("KPIs vs baseline (a)")
    st.dataframe(metrics_table({"ARIA": aria, "Baseline (a)": base}), hide_index=True, use_container_width=True)

    which = st.radio("Show plan", ["ARIA", "Baseline (a)"] if aria is not None else ["Baseline (a)"], horizontal=True)
    shown = aria if which == "ARIA" else base
    if shown is None:
        return

    t_lots, t_short, t_explain, t_pick = st.tabs(["Lot table", "Shortfalls", "Explain", "Pick lists"])
    with t_lots:
        df = alloc_frame(shown)
        if df.empty:
            st.info("No shipments in this plan.")
        else:
            st.dataframe(df, hide_index=True, use_container_width=True)
    with t_short:
        df = shortfall_frame(shown)
        if df.empty:
            st.info("No shortfall rows.")
        else:
            st.dataframe(df, hide_index=True, use_container_width=True)
    with t_explain:
        pairs = sorted({(a["town_id"], a["product_id"]) for a in shown.get("allocations") or []}
                       | {(s["town_id"], s["product_id"]) for s in shown.get("shortfalls") or []})
        if not pairs:
            st.info("Nothing to explain.")
        else:
            town, product = st.selectbox("Row (town, product)", pairs, format_func=lambda p: f"{p[0]} / {p[1]}")
            c, card = call("GET", f"/api/explain/{shown['plan_id']}", params={"town": town, "product": product})
            if c != 200:
                st.error(str(card.get("detail")))
            else:
                render_explain(card)
    with t_pick:
        if stale:
            st.warning("Export disabled: results are STALE.")
        rows = shown.get("allocations") or []
        for g in sorted({a["godown_id"] for a in rows}):
            pick = pd.DataFrame([a for a in rows if a["godown_id"] == g])
            pick = pick[[c for c in ("godown_id", "town_id", "product_id", "lot_id", "units", "life_on_arrival") if c in pick]]
            st.download_button(f"Pick list - {g}", pick.to_csv(index=False).encode(), file_name=f"picklist_{g}_{str(resp.get('scenario_hash'))[:8]}.csv",
                               mime="text/csv", disabled=stale, key=f"pick-{g}")


def render_explain(card: dict):
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("τ* (route)", fmt_value("tau", card.get("tau_star")))
    c2.metric("Freight / unit", rupees(card.get("freight_per_unit_paise")))
    c3.metric("On hand (units)", fmt_value("units", card.get("on_hand_units")))
    c4.metric("Shipped (units)", fmt_value("units", card.get("shipped_units")))
    reason = card.get("reason")
    if reason:
        st.markdown(f"**Reason: {reason.get('reason')}**" + (f" ({reason.get('sub_reason')})" if reason.get("sub_reason") else "")
                    if isinstance(reason, dict) else f"**Reason: {reason}**")
        if isinstance(reason, dict) and reason.get("facts"):
            st.json(reason["facts"])
    lots = card.get("life_on_arrival")
    if isinstance(lots, list) and lots:
        shadow = card.get("lot_shadow_price_paise") or {}
        st.markdown("**Lots shipped**")
        st.dataframe(pd.DataFrame([{**r, "shadow price (indicative)": rupees(shadow.get(r.get("lot_id")))} for r in lots]),
                     hide_index=True, use_container_width=True)
        if card.get("lot_shadow_price_note"):
            st.caption(f"Shadow price: {card['lot_shadow_price_note']}")
    if card.get("segments"):
        st.markdown("**Demand segments**")
        seg = pd.DataFrame(card["segments"])
        if "value_paise" in seg:
            seg["value_paise"] = seg["value_paise"].map(rupees)
        st.dataframe(seg.rename(columns={"value_paise": "value / unit"}), hide_index=True, use_container_width=True, height=220)
    if card.get("params"):
        st.markdown("**Parameters and sources**")
        st.dataframe(pd.DataFrame(card["params"]).astype(str), hide_index=True, use_container_width=True)


# ---------- view 2: Proof ----------

def kpi_row(title: str, k: dict | None, money: bool = True, rule: str = ""):
    if not k:
        return
    fmt = rupees if money else (lambda v: fmt_value("x", v))
    diff = k.get("diff_paise", k.get("diff", k.get("diff_paise_per_unit")))
    a, b, c, d = st.columns([2, 1, 1, 1])
    a.markdown(f"**{title}**" + (f"<br><small>{rule}</small>" if rule else ""), unsafe_allow_html=True)
    b.metric("Difference", fmt(diff))
    c.metric("95% CI", f"{fmt(k.get('ci_low'))} to {fmt(k.get('ci_high'))}")
    if "pass" in k:
        d.markdown(tag("PASS", "aria-ok") if k["pass"] else tag("not met", "aria-warn"), unsafe_allow_html=True)


def view_proof():
    st.title("Proof - fair replay")
    st.caption("One full-cost bill (freight + holding + write-off + lost margin) on realised demand, every policy on the same path.")
    c, doc = call("GET", f"/api/replay/{network}")
    if c == 404:
        st.info(f"No replay results for network '{network}' yet. Run `make replay`.")
        return
    if c != 200:
        st.error(str(doc.get("detail")))
        return
    points = doc.get("available_freight_points") or [doc.get("freight_point")]
    fp = st.radio("Freight point", points, horizontal=True, format_func=lambda p: FREIGHT_POINT_LABELS.get(p, str(p)))
    if fp != doc.get("freight_point"):
        c, doc = call("GET", f"/api/replay/{network}", params={"freight_point": fp})
        if c != 200:
            st.error(str(doc.get("detail")))
            return
    if not doc.get("conservation_ok"):
        st.error("Conservation or leakage check failed for this replay - results withheld.")
        return
    st.markdown(tag(f"freight point {FREIGHT_POINT_LABELS.get(doc.get('freight_point'), doc.get('freight_point'))}")
                + tag(f"windows {doc.get('windows')}") + tag(f"products {doc.get('products')}")
                + tag("conservation ok", "aria-ok"), unsafe_allow_html=True)

    rows = []
    for name, p in (doc.get("per_policy") or {}).items():
        row = {"policy": POLICY_LABELS.get(name, name)}
        for k, v in p.items():
            if k == "conservation_ok":
                continue
            if k == "fill_rate" and isinstance(v, (int, float)):
                row[k] = f"{v:.1%}"
            elif k in MONEY_KEYS or "paise" in k:
                row[k] = rupees(v)
            else:
                row[k] = fmt_value(k, v)
        rows.append(row)
    st.subheader("Total bill per policy")
    st.dataframe(pd.DataFrame(rows), hide_index=True, use_container_width=True)

    st.subheader("Pre-registered KPIs")
    kpi_row("KPI-1: ARIA − b″ bill", doc.get("kpi1"), rule="headline: upper 95% CI < 0")
    kpi_row("KPI-1b: ARIA − b′ bill", doc.get("kpi1b"), rule="value of calibrated forecasting")
    kpi_row("KPI-1c: ARIA − (a) bill", doc.get("kpi1c"), rule="vs current practice")
    kpi_row("KPI-3: cost per unit sold − (a)", doc.get("kpi3"), rule="upper 95% CI ≤ 0")
    kpi_row("KPI-4: write-off units − (a)", doc.get("kpi4"), money=False, rule="upper 95% CI ≤ 0")
    k10 = doc.get("kpi10")
    if isinstance(k10, dict) and "pass" in k10:
        st.markdown("**KPI-10** (KPI-1 holds at ₹3.78 and ₹11.03): "
                    + (tag("PASS", "aria-ok") if k10["pass"] else tag("not met", "aria-warn")), unsafe_allow_html=True)

    gap = doc.get("gap_closed")
    if isinstance(gap, dict):
        st.metric("% of (a)-to-(c) gap closed (display only)", gap.get("display", "n/a"))

    expose = doc.get("expose")
    with st.expander("Is the headline real?", expanded=bool(expose)):
        if not expose:
            st.info("Exposé not included in this replay output.")
        else:
            st.caption("The same replay scored two ways: lost units only vs the full-cost bill.")
            if expose.get("message"):
                st.write(expose["message"])
            lost, billd = expose.get("lost_units") or {}, expose.get("bill_paise") or {}
            st.dataframe(pd.DataFrame([{"policy": POLICY_LABELS.get(p, p), "lost units": fmt_value("u", lost.get(p)), "full bill": rupees(billd.get(p))}
                                       for p in lost]), hide_index=True, use_container_width=True)
            a, b = st.columns(2)
            a.markdown("**Ranked by lost units**: " + " < ".join(POLICY_LABELS.get(p, p) for p in expose.get("rank_by_lost_units") or []))
            b.markdown("**Ranked by full cost**: " + " < ".join(POLICY_LABELS.get(p, p) for p in expose.get("rank_by_full_cost") or []))
            if expose.get("fewer_lost_units_but_dearer"):
                st.dataframe(pd.DataFrame(expose["fewer_lost_units_but_dearer"]), hide_index=True)


# ---------- view 3: Disruption Lab ----------

def default_route(sc: dict) -> tuple[str | None, str | None]:
    """The network's demo leg from /api/networks if this scenario has it, else the scenario's longest leg."""
    demo = net_info.get("demo_route") or {}
    routes = sc.get("routes", [])
    pool = [r for r in routes if r["town_id"] == demo.get("town_id") and demo.get("godown_id") in (None, r["godown_id"])] or routes
    pool = sorted(pool, key=lambda r: (-(r.get("road_km") or 0), r["godown_id"]))
    return (pool[0]["godown_id"], pool[0]["town_id"]) if pool else (None, None)


def view_lab():
    st.title("Disruption Lab")
    if ss.scenario is None:
        st.info("Pick a scenario in the sidebar.")
        return
    sc = ss.scenario
    godowns = [g["godown_id"] for g in sc.get("godowns", [])]
    towns = [t["town_id"] for t in sc.get("towns", [])]
    products = ["*"] + [p["product_id"] for p in sc.get("products", [])]
    dg, dt = default_route(sc)

    c1, c2, c3, c4 = st.columns([1.4, 1, 1, 1])
    stype = c1.selectbox("Shock", SHOCKS)
    shock = {"type": stype}
    if stype in ("ROUTE_RESTRICTION", "ROUTE_CLOSURE", "INVENTORY_LOSS"):
        shock["godown_id"] = c2.selectbox("Godown", godowns, index=godowns.index(dg) if dg in godowns else 0)
    if stype in ("ROUTE_RESTRICTION", "ROUTE_CLOSURE", "FESTIVAL_SPIKE"):
        shock["town_id"] = c3.selectbox("Town", towns, index=towns.index(dt) if dt in towns else 0)
    if stype == "ROUTE_RESTRICTION":
        shock["max_vehicle"] = c4.selectbox("Max vehicle", ["6t"])
    if stype in ("INVENTORY_LOSS", "FESTIVAL_SPIKE"):
        shock["product_id"] = c4.selectbox("Product", products)
        shock["pct"] = st.slider("Percent", 0, 100, 30)
    if stype == "FESTIVAL_SPIKE":
        st.caption("Uplift learned from event days in the demand history; labelled in the result.")

    key = (current_hash(), tuple(sorted(shock.items())))
    if st.button("Apply shock and re-plan", type="primary"):
        rid = next_rid()
        ss.whatif_rid = rid
        with st.spinner("Re-planning..."):
            c, body = call("POST", "/api/whatif", json={"request_id": rid, "scenario": sc, "shocks": [shock]})
        if c == 422:
            show_issues(body)
            return
        if c != 200:
            st.error(f"What-if failed ({c}): {body.get('detail')}")
            return
        if body.get("request_id") == ss.whatif_rid:
            body.setdefault("scenario_hash", current_hash())
            ss.whatif, ss.whatif_key = body, key

    resp = ss.whatif
    if not resp:
        return
    stale = ss.net_error is not None or ss.whatif_key != key
    result_header(resp, stale, [f"re-plan {resp.get('elapsed_ms')} ms"])

    before, after = resp.get("before") or {}, resp.get("after") or {}
    st.subheader("Before vs after")
    st.dataframe(metrics_table({"ARIA before": before.get("aria"), "ARIA after": after.get("aria"),
                                "(a) before": before.get("baseline_a"), "(a) after": after.get("baseline_a")}),
                 hide_index=True, use_container_width=True)

    diff = resp.get("diff") or {}
    left, right = st.columns(2)
    for col, name in ((left, "aria"), (right, "baseline_a")):
        with col:
            st.markdown(f"**Diff - {'ARIA' if name == 'aria' else 'baseline (a)'}**")
            render_diff(diff.get(name))

    st.subheader("τ* before and after")
    tc = pd.DataFrame(resp.get("tau_changes") or [])
    if tc.empty:
        st.info("No τ* changes.")
        return
    on_leg = tc[(tc.get("godown_id") == shock.get("godown_id")) & (tc.get("town_id") == shock.get("town_id"))] if {"godown_id", "town_id"} <= set(tc.columns) else tc
    show = on_leg if not on_leg.empty else tc
    render_tau_chart(show)
    st.dataframe(show, hide_index=True, use_container_width=True)


def render_diff(d):
    if not d:
        st.caption("No changes.")
        return
    if not isinstance(d, dict):
        st.json(d)
        return
    scalars = {k: v for k, v in d.items() if not isinstance(v, (dict, list))}
    cols = st.columns(max(1, min(3, len(scalars))))
    for i, (k, v) in enumerate(scalars.items()):
        cols[i % len(cols)].metric(k.replace("_paise", "").replace("_", " "), fmt_value(k, v))
    for k, v in d.items():
        if isinstance(v, list):
            st.caption(k.replace("_", " "))
            st.dataframe(pd.DataFrame(v) if v and isinstance(v[0], dict) else pd.DataFrame({k: v}), hide_index=True, use_container_width=True)
        elif isinstance(v, dict):
            st.caption(k.replace("_", " "))
            st.json(v)


def render_tau_chart(df: pd.DataFrame):
    b = next((c for c in ("before", "tau_before", "tau_star_before") if c in df.columns), None)
    a = next((c for c in ("after", "tau_after", "tau_star_after") if c in df.columns), None)
    if not (a and b):
        return
    label = df.get("product_id", pd.Series(range(len(df)))).astype(str)
    if "town_id" in df.columns:
        label = df["godown_id"].astype(str) + "→" + df["town_id"].astype(str) + " / " + label
    data = pd.DataFrame({"row": label, "before": df[b], "after": df[a]}).head(40)
    long = data.melt("row", var_name="when", value_name="tau")
    scale = alt.Scale(domain=[0.5, 1.0])
    rule = alt.Chart(data).mark_rule(color="#9aa5b1").encode(x=alt.X("after:Q", scale=scale, title="τ*"), x2="before:Q", y=alt.Y("row:N", title=None, sort=None))
    pts = alt.Chart(long).mark_point(filled=True, size=90).encode(
        x=alt.X("tau:Q", scale=scale), y=alt.Y("row:N", sort=None),
        color=alt.Color("when:N", scale=alt.Scale(domain=["before", "after"], range=["#2f6fde", "#d64545"]), title=None),
        tooltip=["row", "when", alt.Tooltip("tau:Q", format=".3f")])
    st.altair_chart((rule + pts).properties(height=max(120, 26 * len(data))), use_container_width=True)
    st.caption("Units with service level between the after and before τ* stop shipping on this leg: freight now exceeds what they protect.")


{"Plan & Compare": view_plan, "Proof": view_proof, "Disruption Lab": view_lab}[view]()
