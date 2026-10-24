"""Batch data build (FR-P0-01, FR-P0-03): raw M5 + network YAML → parquet + scenario JSON.

    python -m aria.data.build [--network kolhapur|maharashtra|all] [--offline] [--top 100] [--refit]

Outputs in data/built/:
  {net}_demand_daily.parquet  town_id, product_id, day, qty
  {net}_forecasts.parquet     town_id, product_id, day, window, q0..q8, point, sigma
  {net}_coverage.parquet      window (0 = pooled), level, nominal, raw, conformal, n
  {net}_products.parquet      product_id, category, kg_per_unit, shelf_life_days, min_days_at_receipt, price_paise, usd_price, volume_rank
  m5_store_forecasts_top{N}.parquet (store-level cache), forecast_meta.json, data_hashes.json
and the bundled scenario JSONs in data/scenarios/.

Forecasting runs once on the M5 store × item series; each town's quantiles are its store's
quantiles × the town's population scale (town demand is defined as round(scale × store demand)).
--offline uses only cached values (YAML road_km, params FX) and never opens a connection.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from aria import params as P
from aria.data import m5
from aria.data.lots import load_mapping, make_products
from aria.data.network import ensure_road_km
from aria.data.scenarios import SCENARIO_DIR, edge_cases, monsoon_squeeze, normal_week
from aria.forecast.train import HORIZON, QCOLS, coverage_table, demand_to_series, forecast_windows, series_to_keys

ROOT = Path(__file__).resolve().parents[2]
BUILT = ROOT / "data" / "built"
NETWORKS = ("kolhapur", "maharashtra")
SCENARIO_PRODUCTS = {"maharashtra": 40}  # keeps the LP under the E_SIZE guard (D-020)


def store_forecasts(store_daily: pd.DataFrame, top_n: int, refit: bool) -> tuple[pd.DataFrame, dict]:
    cache, meta_path = BUILT / f"m5_store_forecasts_top{top_n}.parquet", BUILT / "forecast_meta.json"
    if cache.exists() and meta_path.exists() and not refit:
        return pd.read_parquet(cache), json.loads(meta_path.read_text())
    df = demand_to_series(store_daily.rename(columns={"store_id": "town_id", "item_id": "product_id"}), exog=("event", "snap"))
    last = df["ds"].max()
    origins = [last - pd.Timedelta(days=2 * HORIZON - 1), last - pd.Timedelta(days=HORIZON - 1)]
    print(f"forecasting {df['unique_id'].nunique()} store x item series, windows from {[str(o.date()) for o in origins]}")
    t0 = time.perf_counter()
    fc, timings = forecast_windows(df, origins)
    meta = {"top_n": top_n, "series": int(df["unique_id"].nunique()), "origins": [str(o.date()) for o in origins],
            "fit_seconds_by_cutoff": timings, "total_seconds": round(time.perf_counter() - t0, 1),
            "label": "" if top_n >= 100 else f"fallback: top-{top_n} products (fit time)"}
    fc.to_parquet(cache, index=False)
    meta_path.write_text(json.dumps(meta, indent=2))
    return fc, meta


def build_network(name: str, store_daily, store_fc, fx: float, offline: bool, mapping: dict) -> list[Path]:
    net = ensure_road_km(name, offline=offline)
    missing = [t["town_id"] for t in net["towns"] if not t.get("population_2011")]
    if missing:
        raise ValueError(f"{name}: population_2011 missing for {missing}")
    scales = m5.town_scales(net, store_daily, mapping, float(P.value("m5_store_population_equiv")))
    demand = m5.town_daily(store_daily, scales)
    # town forecasts = store forecasts × scale; realised town demand from the demand frame
    sf = series_to_keys(store_fc).rename(columns={"town_id": "store_id"})
    rows = []
    for r in scales.itertuples():
        f = sf[sf["store_id"] == r.store_id].copy()
        f["town_id"] = r.town_id
        cols = QCOLS + [f"raw_{c}" for c in QCOLS] + ["point", "sigma"]
        f[cols] = f[cols].to_numpy() * r.scale
        rows.append(f)
    fc = pd.concat(rows, ignore_index=True).merge(demand.rename(columns={"qty": "y_town"}), on=["town_id", "product_id", "day"])
    cov = coverage_table(fc, y_col="y_town")
    pooled = coverage_table(fc.assign(window=0), y_col="y_town")
    cov = pd.concat([cov, pooled], ignore_index=True)
    forecasts = fc[["town_id", "product_id", "day", "window", *QCOLS, "point", "sigma"]].sort_values(
        ["window", "day", "town_id", "product_id"], kind="stable").reset_index(drop=True)

    items = sorted(store_daily["item_id"].unique())
    usd = m5.item_prices_usd(items)
    products = make_products({i: m5.usd_to_paise(usd[i], fx) for i in items}, mapping)
    vol_rank = store_daily.groupby("item_id")["qty"].sum().rank(ascending=False, method="first").astype(int)
    prod_df = pd.DataFrame([p.model_dump() for p in products])
    prod_df["usd_price"] = prod_df["product_id"].map(usd)
    prod_df["volume_rank"] = prod_df["product_id"].map(vol_rank)

    out = {f"{name}_demand_daily.parquet": demand, f"{name}_forecasts.parquet": forecasts,
           f"{name}_coverage.parquet": cov, f"{name}_products.parquet": prod_df}
    paths = []
    for fn, df in out.items():
        df.to_parquet(BUILT / fn, index=False)
        paths.append(BUILT / fn)

    # bundled scenarios: first day of held-out window 1, real calibrated quantiles
    day0 = forecasts.loc[forecasts["window"] == 1, "day"].min()
    day_rows = forecasts[(forecasts["window"] == 1) & (forecasts["day"] == day0)]
    day = str(day0.date())
    n_sc = SCENARIO_PRODUCTS.get(name)
    sc_products = sorted(products, key=lambda p: vol_rank[p.product_id])[:n_sc] if n_sc else products
    scen = [normal_week(net, day, day_rows, sc_products)]
    if name == "kolhapur":
        scen += [monsoon_squeeze(net, day, day_rows, products), edge_cases(net, day, day_rows, products)]
    SCENARIO_DIR.mkdir(parents=True, exist_ok=True)
    for sc in scen:
        p = SCENARIO_DIR / f"{sc.scenario_id}.json"
        p.write_text(json.dumps(sc.model_dump(mode="json"), indent=1), encoding="utf-8")
        paths.append(p)

    print(f"{name}: {len(net['towns'])} towns, {len(net['routes'])} routes, {len(products)} products, "
          f"{len(forecasts)} forecast rows; road km: {net.get('road_km_source')}")
    print(cov[cov["window"] == 0][["level", "nominal", "raw", "conformal"]].to_string(index=False))
    return paths


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--network", default="all", choices=[*NETWORKS, "all"])
    ap.add_argument("--offline", action="store_true", help="no network access; use cached YAML values")
    ap.add_argument("--top", type=int, default=int(P.value("top_products")), help="top-N FOODS_3 items (fallback 50)")
    ap.add_argument("--refit", action="store_true", help="refit forecasts even if cached")
    a = ap.parse_args(argv)
    BUILT.mkdir(parents=True, exist_ok=True)
    fx = P.ensure_fx(offline=a.offline)
    mapping = load_mapping()
    store_daily = m5.load_store_daily(a.top)
    store_fc, meta = store_forecasts(store_daily, a.top, a.refit)
    print(f"forecast fits: {meta['fit_seconds_by_cutoff']} (total {meta['total_seconds']} s) {meta['label']}")
    paths = []
    for name in (NETWORKS if a.network == "all" else (a.network,)):
        paths += build_network(name, store_daily, store_fc, fx, a.offline, mapping)
    hashes_path = BUILT / "data_hashes.json"
    hashes = json.loads(hashes_path.read_text()) if hashes_path.exists() else {}
    hashes.update({p.relative_to(ROOT).as_posix(): sha256(p) for p in paths})
    hashes_path.write_text(json.dumps(dict(sorted(hashes.items())), indent=2))
    print(f"wrote {len(paths)} files; hashes in {hashes_path.relative_to(ROOT).as_posix()}")


if __name__ == "__main__":
    main()
