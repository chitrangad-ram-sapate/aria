"""M5 FOODS_3 demand (R10, FR-P0-01, assumption A2, decision D-020).

* Products: FOODS_3 top-N items by total unit sales over all 10 stores and the full history.
* Town → store: round-robin over mapping.yaml `stores` in network-YAML town order
  (a town may pin `m5_store`), so networks with more than 10 towns still work.
* Rescale: town qty = round(store qty × scale), with
      scale = (population_2011 / m5_store_population_equiv) × (mean store volume / store volume).
  The second factor removes store size, so every town's volume is proportional to its
  Census 2011 population while keeping its store's daily shape and M5's own event calendar.
* Prices: median USD sell price over the last 52 M5 weeks (all stores) × FX → paise (D-013).
"""
from __future__ import annotations

from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "data" / "raw" / "m5"
BUILT_DIR = ROOT / "data" / "built"


def load_store_daily(top_n: int = 100, raw_dir: Path = RAW_DIR, cache_dir: Path = BUILT_DIR) -> pd.DataFrame:
    """Long frame: store_id, item_id, day (datetime64), qty, event (0/1), snap (0/1). Cached as parquet."""
    cache = Path(cache_dir) / f"m5_foods3_top{top_n}.parquet"
    if cache.exists():
        return pd.read_parquet(cache)
    wide = pd.read_csv(Path(raw_dir) / "sales_train_evaluation.csv")
    wide = wide[wide["cat_id"].eq("FOODS") & wide["dept_id"].eq("FOODS_3")]
    dcols = [c for c in wide.columns if c.startswith("d_")]
    totals = wide.groupby("item_id")[dcols].sum().sum(axis=1)
    items = totals.sort_values(ascending=False, kind="stable").index[:top_n]
    wide = wide[wide["item_id"].isin(items)]
    long = wide.melt(id_vars=["store_id", "state_id", "item_id"], value_vars=dcols, var_name="d", value_name="qty")
    cal = pd.read_csv(Path(raw_dir) / "calendar.csv")
    cal["event"] = cal["event_name_1"].notna().astype("int8")
    snap = cal.melt(id_vars=["d", "date", "event"], value_vars=["snap_CA", "snap_TX", "snap_WI"],
                    var_name="state_id", value_name="snap")
    snap["state_id"] = snap["state_id"].str[5:]
    long = long.merge(snap, on=["d", "state_id"], how="left")
    out = pd.DataFrame({"store_id": long["store_id"], "item_id": long["item_id"],
                        "day": pd.to_datetime(long["date"]), "qty": long["qty"].astype("int32"),
                        "event": long["event"].astype("int8"), "snap": long["snap"].astype("int8")})
    out = out.sort_values(["store_id", "item_id", "day"], kind="stable").reset_index(drop=True)
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
    out.to_parquet(cache, index=False)
    return out


def item_prices_usd(items: list[str], raw_dir: Path = RAW_DIR) -> dict[str, float]:
    """Median sell price (USD) per item over the last 52 M5 weeks, all stores."""
    path = (Path(raw_dir) / "sell_prices.csv").as_posix()
    con = duckdb.connect()
    con.register("items", pd.DataFrame({"item_id": list(items)}))
    df = con.execute(f"""
        WITH p AS (SELECT * FROM read_csv_auto('{path}') WHERE item_id IN (SELECT item_id FROM items))
        SELECT item_id, median(sell_price) AS usd FROM p
        WHERE wm_yr_wk > (SELECT max(wm_yr_wk) FROM p) - 100  -- wm_yr_wk is YWWW-coded: minus 100 = same week a year earlier
        GROUP BY item_id""").df()
    return dict(zip(df["item_id"], df["usd"].astype(float)))


def usd_to_paise(usd: float, fx: float) -> int:
    """D-013: price_paise = round(usd × FX × 100)."""
    return int(round(usd * fx * 100))


def town_scales(net: dict, store_daily: pd.DataFrame, mapping: dict, pop_ref: float) -> pd.DataFrame:
    """One row per town: town_id, store_id, population_2011, scale (see module docstring)."""
    stores = mapping["stores"]
    vol = store_daily.groupby("store_id")["qty"].sum()
    rows = []
    for k, t in enumerate(net["towns"]):
        s = t.get("m5_store") or stores[k % len(stores)]
        rows.append({"town_id": t["town_id"], "store_id": s, "population_2011": t["population_2011"],
                     "scale": t["population_2011"] / pop_ref * vol.mean() / vol[s]})
    return pd.DataFrame(rows)


def town_daily(store_daily: pd.DataFrame, scales: pd.DataFrame) -> pd.DataFrame:
    """Daily demand frame: town_id, product_id, day, qty (int units)."""
    parts = []
    for r in scales.itertuples():
        s = store_daily[store_daily["store_id"] == r.store_id]
        parts.append(pd.DataFrame({"town_id": r.town_id, "product_id": s["item_id"].values, "day": s["day"].values,
                                   "qty": np.floor(s["qty"].values * r.scale + 0.5).astype("int32")}))
    return pd.concat(parts, ignore_index=True)
