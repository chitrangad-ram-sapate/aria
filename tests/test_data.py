"""Data & forecasting checks (FR-P0-01, FR-P0-03, PRD 4.10 no-leakage)."""
import io
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from aria.data.csv_import import read_distributor_csv
from aria.data.scenarios import random_scenario
from aria.forecast.gaussian import gaussian_quantiles
from aria.forecast.segments import segments_from_quantiles
from aria.forecast.train import QCOLS, demand_to_series, fit_predict
from aria.schemas import QUANTILE_LEVELS, Scenario

ROOT = Path(__file__).resolve().parents[1]
BUILT = ROOT / "data" / "built"
SCEN = ROOT / "data" / "scenarios"
SAMPLE = Path(__file__).parent / "data" / "sample_import.csv"
needs_build = pytest.mark.skipif(not (BUILT / "kolhapur_forecasts.parquet").exists(), reason="run python -m aria.data.build")


@needs_build
@pytest.mark.parametrize("net", ["kolhapur", "maharashtra"])
def test_real_forecasts_non_crossing_and_segments(net):
    fc = pd.read_parquet(BUILT / f"{net}_forecasts.parquet")
    q = fc[QCOLS].to_numpy()
    assert (q >= 0).all() and (np.diff(q, axis=1) >= 0).all()
    assert set(fc["window"]) == {1, 2} and fc.groupby("window")["day"].nunique().eq(28).all()
    for row in q[:: max(1, len(q) // 500)]:
        b = segments_from_quantiles(row.tolist())
        assert len(b) == 100 and min(b) >= 0 and sum(b) == int(np.rint(row[-1]))


@needs_build
def test_no_leakage_in_built_windows():
    meta = json.loads((BUILT / "forecast_meta.json").read_text())
    origins = [pd.Timestamp(o) for o in meta["origins"]]
    cutoffs = sorted(pd.Timestamp(c) for c in meta["fit_seconds_by_cutoff"])
    fc = pd.read_parquet(BUILT / "kolhapur_forecasts.parquet")
    for w, origin in enumerate(origins, start=1):
        days = fc.loc[fc["window"] == w, "day"]
        assert days.min() == origin
        test_fit = max(c for c in cutoffs if c < origin)  # model used for the window
        assert test_fit < days.min()
    assert origins[1] > fc.loc[fc["window"] == 1, "day"].max()  # windows do not overlap


def test_fit_predict_ignores_future_targets():
    df = demand_to_series(read_distributor_csv(SAMPLE))
    cutoff = df["ds"].max() - pd.Timedelta(days=28)
    a = fit_predict(df, cutoff)
    poisoned = df.copy()
    poisoned.loc[poisoned["ds"] > cutoff, "y"] = 1e6
    b = fit_predict(poisoned, cutoff)
    assert len(a) == df["unique_id"].nunique() * 28
    pd.testing.assert_frame_equal(a, b)


def test_csv_import_schema_and_fill():
    df = read_distributor_csv(SAMPLE)
    assert list(df.columns) == ["town_id", "product_id", "day", "qty", "price"]
    assert df.groupby(["town_id", "product_id"]).size().eq(120).all()  # missing days filled with 0
    assert (df["qty"] >= 0).all() and df["qty"].dtype.kind == "i"


def test_csv_import_missing_columns():
    with pytest.raises(ValueError, match="outlet/town.*price|price"):
        read_distributor_csv(io.StringIO("date,item,qty\n2026-01-01,A,3\n"))
    with pytest.raises(ValueError, match="outlet/town"):
        read_distributor_csv(io.StringIO("date,item,qty,price\n2026-01-01,A,3,10\n"))


def test_random_scenarios_validate():
    for seed in range(200):
        sc = random_scenario(seed)
        again = Scenario.model_validate(json.loads(sc.model_dump_json()))
        assert again == sc == random_scenario(seed)
        assert 2 <= len(sc.godowns) <= 3 and 2 <= len(sc.towns) <= 6 and 1 <= len(sc.products) <= 8
        assert all(np.all(np.diff(d.quantiles) >= 0) for d in sc.demand)


@needs_build
@pytest.mark.parametrize("name", ["kolhapur_normal_week", "kolhapur_monsoon_squeeze", "kolhapur_edge_cases",
                                  "maharashtra_normal_week"])
def test_bundled_scenarios_load(name):
    sc = Scenario.model_validate_json((SCEN / f"{name}.json").read_text(encoding="utf-8"))
    pids, tids = {p.product_id for p in sc.products}, {t.town_id for t in sc.towns}
    assert {(d.town_id, d.product_id) for d in sc.demand} == {(t, p) for t in tids for p in pids}
    assert all(len(d.quantiles) == len(QUANTILE_LEVELS) and np.all(np.diff(d.quantiles) >= 0) for d in sc.demand)
    assert all(l.product_id in pids and l.qty_units > 0 for l in sc.lots)
    p_by = {p.product_id: p for p in sc.products}
    assert all(1 <= l.remaining_life_days <= p_by[l.product_id].shelf_life_days for l in sc.lots)


def test_gaussian_quantiles_monotone():
    q = gaussian_quantiles(10.0, 3.0)
    assert len(q) == 9 and q == sorted(q) and abs(q[4] - 10.0) < 1e-9 and min(q) >= 0


def test_scenario_from_import_plannable():
    from aria.data.csv_import import scenario_from_import

    sc = scenario_from_import(SAMPLE, "kolhapur")
    assert sc.scenario_id.startswith("import_kolhapur_2026-09-28_")
    assert {t.town_id for t in sc.towns} == {"T_KOLHAPUR", "T_RATNAGIRI"} and sc.lots and sc.routes
    assert len(sc.demand) == 4 and all(np.all(np.diff(d.quantiles) >= 0) for d in sc.demand)
    with pytest.raises(ValueError, match="Atlantis"):
        scenario_from_import(io.StringIO("date,item,town,qty,price\n2026-01-01,A,Atlantis,3,10\n"), "kolhapur")


def test_network_routes_written_with_via():
    from aria.data.network import build_network, load_network

    net = load_network("kolhapur")
    g, t, r = build_network(net)
    assert len(g) == 3 and len(t) == 6 and len(r) == 18
    assert all({"road_km", "transit_days", "vehicle_class"} <= set(x) for x in net["routes"])
    via = {(x["godown_id"], x["town_id"]) for x in net["routes"] if x.get("via")}
    assert via == {(x.godown_id, "T_RATNAGIRI") for x in g}
    assert all(x.vehicle_class == ("6t" if x.road_km <= 100 else "road_avg") for x in r)
