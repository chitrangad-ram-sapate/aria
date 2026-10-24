"""Calibrated quantile forecasts (FR-P0-03, PRD 4.1, R11, R13).

* mlforecast + LightGBM, one model per level in QUANTILE_LEVELS (objective="quantile").
* Features: lags 28..364 and rolling stats on lag 28 (all ≥ the 28-day horizon, so the
  28-step forecast uses actuals only), date features, and any exogenous calendar columns
  present in the frame (M5: event, snap).
* Split-conformal per level (CQR-style, scale-normalised) on the 28 days just before the
  origin, scored by a model fitted on data before that calibration slice.
* Uncross by sorting, clip ≥ 0. Point = median; σ = (q0.835 − q0.165) / (2 · z0.835).

Works on any daily frame with columns unique_id, ds, y (+ optional exogenous columns),
so M5 and CSV-imported demand share one code path. No leakage: a fit with cutoff c sees
only ds ≤ c; test rows contribute exogenous columns only.
"""
from __future__ import annotations

import time
from statistics import NormalDist

import lightgbm as lgb
import numpy as np
import pandas as pd
from mlforecast import MLForecast
from mlforecast.lag_transforms import RollingMean, RollingStd

from aria.schemas import QUANTILE_LEVELS

HORIZON = 28
LAGS = [28, 35, 42, 49, 56, 364]
QCOLS = [f"q{i}" for i in range(len(QUANTILE_LEVELS))]
Z_835 = NormalDist().inv_cdf(0.835)
LGB_PARAMS = dict(n_estimators=150, learning_rate=0.08, num_leaves=63, min_child_samples=50,
                  subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1, n_jobs=-1)


def fit_predict(df: pd.DataFrame, cutoff: pd.Timestamp, horizon: int = HORIZON, train_days: int = 900) -> pd.DataFrame:
    """Fit on ds ∈ (cutoff − train_days − 364, cutoff], predict (cutoff, cutoff + horizon]. Raw quantiles."""
    exog = [c for c in df.columns if c not in ("unique_id", "ds", "y")]
    start = cutoff - pd.Timedelta(days=train_days + max(LAGS))
    train = df[(df["ds"] > start) & (df["ds"] <= cutoff)]
    future = df[(df["ds"] > cutoff) & (df["ds"] <= cutoff + pd.Timedelta(days=horizon))][["unique_id", "ds", *exog]]
    assert train["ds"].max() < future["ds"].min(), "leakage"
    span = (cutoff - df["ds"].min()).days
    lags = [lag for lag in LAGS if lag * 2 <= span]  # short histories (e.g. CSV import) drop the yearly lag
    models = {q: lgb.LGBMRegressor(objective="quantile", alpha=a, **LGB_PARAMS) for q, a in zip(QCOLS, QUANTILE_LEVELS)}
    fc = MLForecast(models=models, freq="D", lags=lags,
                    lag_transforms={28: [RollingMean(window_size=7), RollingMean(window_size=28), RollingStd(window_size=28)]},
                    date_features=["dayofweek", "month", "day"])
    fc.fit(train, static_features=[], dropna=True)
    return fc.predict(horizon, X_df=future if exog else None)


def demand_to_series(demand: pd.DataFrame, exog: tuple[str, ...] = ()) -> pd.DataFrame:
    """Daily demand frame (town_id, product_id, day, qty) → mlforecast frame (unique_id, ds, y, *exog)."""
    out = pd.DataFrame({"unique_id": demand["town_id"].astype(str) + "|" + demand["product_id"].astype(str),
                        "ds": pd.to_datetime(demand["day"]), "y": demand["qty"].astype(float)})
    for c in exog:
        out[c] = demand[c].values
    return out


def series_to_keys(fc: pd.DataFrame) -> pd.DataFrame:
    """Split unique_id back into town_id, product_id and rename ds → day."""
    keys = fc["unique_id"].str.split("|", n=1, expand=True)
    return fc.assign(town_id=keys[0], product_id=keys[1]).rename(columns={"ds": "day"})


def series_scale(df: pd.DataFrame, cutoff: pd.Timestamp) -> pd.Series:
    """Per-series scale for conformal normalisation: mean of the last 28 days up to cutoff, + 1."""
    w = df[(df["ds"] > cutoff - pd.Timedelta(days=28)) & (df["ds"] <= cutoff)]
    return w.groupby("unique_id")["y"].mean() + 1.0


def uncross(q: np.ndarray) -> np.ndarray:
    return np.maximum(np.sort(q, axis=1), 0.0)


def point_sigma(q: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lv = list(QUANTILE_LEVELS)
    return q[:, lv.index(0.5)], (q[:, lv.index(0.835)] - q[:, lv.index(0.165)]) / (2 * Z_835)


def forecast_windows(df: pd.DataFrame, origins: list[pd.Timestamp], horizon: int = HORIZON,
                     train_days: int = 900, log=print, cal_days: int = HORIZON) -> tuple[pd.DataFrame, dict]:
    """Calibrated forecasts for each 28-day window starting at origins[w] (window = w + 1).

    The calibration slice is the cal_days days before each origin. Returns (frame, timings). Frame columns: unique_id, ds, window, y, raw q0..q8, q0..q8
    (conformal, uncrossed, ≥0), point, sigma. Fits are cached by cutoff, so contiguous
    windows reuse the previous window's model for calibration.
    """
    fits, timings = {}, {}

    def get(cutoff, h):
        if cutoff not in fits:
            t0 = time.perf_counter()
            fits[cutoff] = fit_predict(df, cutoff, h, train_days)
            timings[str(cutoff.date())] = round(time.perf_counter() - t0, 1)
            log(f"  fit cutoff {cutoff.date()}: {timings[str(cutoff.date())]} s")
        return fits[cutoff]

    actual = df[["unique_id", "ds", "y"]]
    out = []
    for w, origin in enumerate(origins, start=1):
        test_cut = origin - pd.Timedelta(days=1)
        cal_cut = test_cut - pd.Timedelta(days=cal_days)
        cal = get(cal_cut, cal_days).merge(actual, on=["unique_id", "ds"])
        s_cal = cal["unique_id"].map(series_scale(df, cal_cut)).to_numpy()
        resid = (cal["y"].to_numpy()[:, None] - cal[QCOLS].to_numpy()) / s_cal[:, None]
        delta = np.array([np.quantile(resid[:, i], a) for i, a in enumerate(QUANTILE_LEVELS)])
        test = get(test_cut, max(horizon, cal_days)).merge(actual, on=["unique_id", "ds"])
        assert cal["ds"].max() < test["ds"].min()
        raw = test[QCOLS].to_numpy()
        s_test = test["unique_id"].map(series_scale(df, test_cut)).to_numpy()
        cq = uncross(raw + delta[None, :] * s_test[:, None])
        frame = test[["unique_id", "ds", "y"]].copy()
        frame["window"] = w
        frame[[f"raw_{c}" for c in QCOLS]] = raw
        frame[QCOLS] = cq
        frame["point"], frame["sigma"] = point_sigma(cq)
        out.append(frame)
    return pd.concat(out, ignore_index=True), timings


def coverage_table(fc: pd.DataFrame, y_col: str = "y") -> pd.DataFrame:
    """Per window and level: nominal, raw (uncrossed, clipped) and conformal coverage P(y ≤ q)."""
    rows = []
    for w, g in fc.groupby("window"):
        y = g[y_col].to_numpy()[:, None]
        raw = uncross(g[[f"raw_{c}" for c in QCOLS]].to_numpy())
        cal = g[QCOLS].to_numpy()
        for i, a in enumerate(QUANTILE_LEVELS):
            rows.append({"window": int(w), "level": a, "nominal": a, "raw": float((y[:, 0] <= raw[:, i]).mean()),
                         "conformal": float((y[:, 0] <= cal[:, i]).mean()), "n": len(g)})
    return pd.DataFrame(rows)
