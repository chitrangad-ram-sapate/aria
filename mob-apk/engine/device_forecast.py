"""On-device forecasting for an imported sales CSV (the desktop pipeline's LightGBM step is not available
in Pyodide, so aria.forecast.train is never imported here).

Method, per (town, product) for the day after the last CSV date, at the 9 levels of QUANTILE_LEVELS:
  1. scikit-learn HistGradientBoostingRegressor(loss="quantile"), one pooled model per level, with
     split-conformal adjustment on the last 28 days (shift each level by the empirical level-quantile
     of the calibration residuals);
  2. if scikit-learn is missing, the history is short, or fitting fails or runs past the time budget:
     empirical quantiles of the last 28 days ("statistical fallback").
"""
from __future__ import annotations

import csv
import io
import time
from datetime import date, timedelta

import numpy as np

from aria.schemas import QUANTILE_LEVELS

CAL_DAYS = 28
MIN_ML_DAYS = 2 * CAL_DAYS + 28  # history for lags + training + calibration
MAX_TRAIN_ROWS = 40_000
TIME_BUDGET_S = 45.0
ML_LABEL = "scikit-learn gradient-boosted quantile forecast, conformal-calibrated (on device)"
FALLBACK_LABEL = "statistical fallback: empirical quantiles of the last 28 days"


def read_sales(text: str, towns: list[dict], products: list[dict]) -> tuple[dict, date, date, dict]:
    """CSV (date,item,outlet/town,qty[,price]) -> {(town_id, product_id): {date: qty}}, first, last, counts."""
    rows = list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))
    cols = {c.strip().lower(): c for c in (rows[0].keys() if rows else [])}
    town_col = cols.get("outlet/town") or cols.get("town") or cols.get("outlet")
    missing = [c for c, ok in (("date", "date" in cols), ("item", "item" in cols), ("outlet/town", town_col), ("qty", "qty" in cols)) if not ok]
    if missing:
        raise ValueError(f"CSV is missing column(s): {', '.join(missing)}")
    town_ids = {}
    for t in towns:
        town_ids[t["town_id"].lower()] = t["town_id"]
        if t.get("name"):
            town_ids[t["name"].lower()] = t["town_id"]
    product_ids = {p["product_id"].lower(): p["product_id"] for p in products}
    series: dict[tuple[str, str], dict[date, float]] = {}
    counts = {"rows": len(rows), "used": 0, "unknown_town": 0, "unknown_item": 0, "bad_value": 0}
    for r in rows:
        town = town_ids.get(str(r[town_col]).strip().lower())
        item = product_ids.get(str(r[cols["item"]]).strip().lower())
        if town is None:
            counts["unknown_town"] += 1
            continue
        if item is None:
            counts["unknown_item"] += 1
            continue
        try:
            d = date.fromisoformat(str(r[cols["date"]]).strip()[:10])
            q = float(r[cols["qty"]])
        except ValueError:
            counts["bad_value"] += 1
            continue
        s = series.setdefault((town, item), {})
        s[d] = s.get(d, 0.0) + max(q, 0.0)
        counts["used"] += 1
    if not series:
        raise ValueError("no CSV rows match this scenario's towns and products")
    first = min(min(s) for s in series.values())
    last = max(max(s) for s in series.values())
    return series, first, last, counts


def _matrix(series: dict, first: date, last: date) -> tuple[list, np.ndarray]:
    n = (last - first).days + 1
    keys = sorted(series)
    y = np.zeros((len(keys), n))
    for i, k in enumerate(keys):
        for d, q in series[k].items():
            y[i, (d - first).days] = q
    return keys, y


def _features(y: np.ndarray, t: int, first: date) -> np.ndarray:
    """Features for predicting day t of every series from days < t."""
    n_series = y.shape[0]
    dow = (first + timedelta(days=t)).weekday()
    return np.column_stack([
        np.arange(n_series), np.full(n_series, dow),
        y[:, t - 1], y[:, t - 7], y[:, t - 14],
        y[:, t - 7:t].mean(axis=1), y[:, t - 28:t].mean(axis=1), y[:, t - 28:t].std(axis=1),
    ])


def _ml(y: np.ndarray, first: date) -> np.ndarray:
    from sklearn.ensemble import HistGradientBoostingRegressor  # lazy: only for imports

    n_series, n = y.shape
    cal_start = n - CAL_DAYS
    start = max(28, cal_start - max(1, MAX_TRAIN_ROWS // n_series))
    x_tr = np.vstack([_features(y, t, first) for t in range(start, cal_start)])
    y_tr = np.concatenate([y[:, t] for t in range(start, cal_start)])
    x_cal = np.vstack([_features(y, t, first) for t in range(cal_start, n)])
    y_cal = np.concatenate([y[:, t] for t in range(cal_start, n)])
    x_next = _features(y, n, first)
    t0 = time.perf_counter()
    out = []
    for level in QUANTILE_LEVELS:
        m = HistGradientBoostingRegressor(loss="quantile", quantile=level, max_iter=80, categorical_features=[0, 1], random_state=0)
        m.fit(x_tr, y_tr)
        shift = np.quantile(y_cal - m.predict(x_cal), level)  # split-conformal adjustment for this level
        out.append(m.predict(x_next) + shift)
        if time.perf_counter() - t0 > TIME_BUDGET_S:
            raise TimeoutError("quantile fit exceeded the on-device time budget")
    return np.column_stack(out)


def _empirical(y: np.ndarray) -> np.ndarray:
    return np.quantile(y[:, -CAL_DAYS:], QUANTILE_LEVELS, axis=1).T


def forecast(text: str, scenario: dict, use_ml: bool) -> dict:
    """-> {demand: [Demand dicts], method, label, counts, first, last, forecast_day, seconds, note}."""
    t0 = time.perf_counter()
    series, first, last, counts = read_sales(text, scenario.get("towns", []), scenario.get("products", []))
    keys, y = _matrix(series, first, last)
    method, label, note = "fallback", FALLBACK_LABEL, None
    q = None
    if not use_ml:
        note = "scikit-learn is not available on this device"
    elif y.shape[1] < MIN_ML_DAYS:
        note = f"history has {y.shape[1]} days; the model needs at least {MIN_ML_DAYS}"
    else:
        try:
            q = _ml(y, first)
            method, label = "ml", ML_LABEL
        except Exception as exc:  # any fit failure or timeout falls back, labelled
            note = f"model fit failed ({type(exc).__name__}: {exc})"
    if q is None:
        q = _empirical(y)
    q = np.sort(np.maximum(q, 0.0), axis=1)  # non-negative, non-crossing
    recent = y[:, -CAL_DAYS:]
    demand = [{"town_id": k[0], "product_id": k[1], "quantiles": [round(float(v), 3) for v in q[i]],
               "point": round(float(q[i][4]), 3), "sigma": round(float(recent[i].std()), 3)}
              for i, k in enumerate(keys)]
    return {"demand": demand, "method": method, "label": label, "note": note, "counts": counts,
            "first": first.isoformat(), "last": last.isoformat(), "forecast_day": (last + timedelta(days=1)).isoformat(),
            "days": int(y.shape[1]), "seconds": round(time.perf_counter() - t0, 2)}
