"""Distributor CSV import (FR-P0-01): date,item,outlet/town,qty,price → daily demand frame.

Output has the same schema as the M5 daily-demand frame (town_id, product_id, day, qty) plus
price (INR per unit, as exported). Duplicate (date, item, town) rows are summed; days with
no row inside each series' date span are filled with qty 0, so the series are regular daily
series for the forecaster. Missing columns raise ValueError listing them (the API maps it to 422).
"""
from __future__ import annotations

import pandas as pd

TOWN_ALIASES = ("town", "outlet", "outlet/town")
REQUIRED = ("date", "item", "outlet/town", "qty", "price")


def read_distributor_csv(src) -> pd.DataFrame:
    """src: path or file-like. Returns town_id, product_id, day, qty (int), price (float)."""
    raw = pd.read_csv(src)
    cols = {c.strip().lower(): c for c in raw.columns}
    town_col = next((cols[a] for a in TOWN_ALIASES if a in cols), None)
    missing = [c for c in REQUIRED if (town_col is None if c == "outlet/town" else c not in cols)]
    if missing:
        raise ValueError(f"missing required columns: {', '.join(missing)}")
    df = pd.DataFrame({
        "town_id": raw[town_col].astype(str).str.strip(),
        "product_id": raw[cols["item"]].astype(str).str.strip(),
        "day": pd.to_datetime(raw[cols["date"]]).dt.normalize(),
        "qty": pd.to_numeric(raw[cols["qty"]]),
        "price": pd.to_numeric(raw[cols["price"]]),
    })
    if df[["qty", "price"]].isna().any().any() or (df["qty"] < 0).any() or (df["price"] < 0).any():
        raise ValueError("qty and price must be non-negative numbers")
    df = df.groupby(["town_id", "product_id", "day"], as_index=False).agg(qty=("qty", "sum"), price=("price", "mean"))
    parts = []
    for (t, p), g in df.groupby(["town_id", "product_id"], sort=True):
        days = pd.date_range(g["day"].min(), g["day"].max(), freq="D")
        g = g.set_index("day").reindex(days)
        parts.append(pd.DataFrame({"town_id": t, "product_id": p, "day": days,
                                   "qty": g["qty"].fillna(0).round().astype("int32").values,
                                   "price": g["price"].ffill().bfill().values}))
    return pd.concat(parts, ignore_index=True)


def price_paise(df: pd.DataFrame) -> dict[str, int]:
    """Median INR price per item → integer paise."""
    return {p: int(round(v * 100)) for p, v in df.groupby("product_id")["price"].median().items()}


def scenario_from_import(csv_path, network_id: str, seed: int = 11):
    """Imported CSV → plannable Scenario on the last day of the history (FR-P0-01, /api/import job).

    * CSV towns are matched to the network's towns by town_id or name (case-insensitive);
      the scenario keeps only the matched towns and their routes. Unknown towns → ValueError.
    * Forecast for the last day: the same mlforecast + LightGBM + conformal pipeline, fitted on
      days before it (no leakage). With fewer than 90 days of history it falls back to the
      empirical quantiles of each series' previous 28 days. The method is recorded in the
      scenario_id: import_<network>_<day>_<lgbm_conformal|empirical_fallback>.
    * Products: CSV item ids with the median imported price; D-015 category attributes.
    * Lots and town stock: synthetic, as in the bundled normal week (seeded).
    """
    import numpy as np

    from aria.data.lots import make_products
    from aria.data.network import load_network
    from aria.data.scenarios import normal_week
    from aria.forecast.train import QCOLS, demand_to_series, forecast_windows, point_sigma, uncross
    from aria.schemas import QUANTILE_LEVELS

    demand = read_distributor_csv(csv_path)
    net = load_network(network_id)
    lookup = {}
    for t in net["towns"]:
        lookup[t["town_id"].lower()] = t["town_id"]
        lookup[t.get("name", "").lower()] = t["town_id"]
    unknown = sorted({x for x in demand["town_id"] if x.lower() not in lookup})
    if unknown:
        raise ValueError(f"towns not in network {network_id}: {', '.join(unknown)}")
    demand["town_id"] = demand["town_id"].str.lower().map(lookup)
    demand = demand.groupby(["town_id", "product_id", "day"], as_index=False).agg(qty=("qty", "sum"), price=("price", "mean"))
    keep = set(demand["town_id"])
    net = {**net, "towns": [t for t in net["towns"] if t["town_id"] in keep],
           "routes": [r for r in net.get("routes", []) if r["town_id"] in keep]}
    if not net["routes"]:
        raise ValueError(f"network {network_id} has no routes yet; run python -m aria.data.build first")

    day = demand["day"].max()
    series = demand_to_series(demand)
    # every series must reach the planning day (fill with 0 if a series ended early)
    full = series.set_index(["unique_id", "ds"]).unstack(fill_value=0.0).stack(future_stack=True).fillna(0.0).reset_index()
    if (day - full["ds"].min()).days >= 90:
        fc, _ = forecast_windows(full, [day], horizon=1, log=lambda *_: None, cal_days=28)
        method = "lgbm_conformal"
    else:
        hist = full[(full["ds"] < day) & (full["ds"] >= day - pd.Timedelta(days=28))]
        q = hist.groupby("unique_id")["y"].quantile(list(QUANTILE_LEVELS)).unstack()
        fc = pd.DataFrame(uncross(q.to_numpy()), columns=QCOLS)
        fc["unique_id"], fc["ds"] = q.index, day
        method = "empirical_fallback"
    fc = fc[fc["ds"] == day].copy()
    q = uncross(fc[QCOLS].to_numpy())
    fc[QCOLS] = q
    fc["point"], fc["sigma"] = point_sigma(q)
    keys = fc["unique_id"].str.split("|", n=1, expand=True)
    rows = fc.assign(town_id=keys[0], product_id=keys[1])[["town_id", "product_id", *QCOLS, "point", "sigma"]]
    assert np.isfinite(rows[QCOLS].to_numpy()).all()

    products = make_products(price_paise(demand))
    sc = normal_week(net, str(day.date()), rows, products, seed=seed)
    return sc.model_copy(update={"scenario_id": f"import_{network_id}_{day.date()}_{method}"})
