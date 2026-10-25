"""App-side data CSV and analysis tests. Run from mob-apk/engine: ARIA_SOLVER=scipy python -m pytest app_tests -q"""
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))

import analysis  # noqa: E402
import bridge  # noqa: E402
import dataset_csv  # noqa: E402
from aria.hashing import scenario_hash  # noqa: E402
from aria.schemas import Scenario  # noqa: E402

SAMPLES = sorted(p.stem for p in (ENGINE / "data" / "scenarios").glob("*.json"))

MINI = """# settings
key,value
name,two depot test
margin,0.05
freight_rs_per_tkm_road_avg,4.5

# products
product_id,category,kg_per_unit,shelf_life_days,min_days_at_receipt,price_rs
MILK,dairy,1,5,1,60
RICE,staples,5,180,0,300

# depots
depot_id,name,capacity_units
D1,North depot,
D2,South depot,40

# towns
town_id,name,population
T1,Alpha,1000
T2,Beta,2000

# routes
depot_id,town_id,road_km,transit_days,vehicle_class
D1,T1,20,1,road_avg
D1,T2,60,1,6t
D2,T2,15,0,road_avg

# stock
depot_id,product_id,qty_units,days_left
D1,MILK,50,4
D1,RICE,80,120
D2,MILK,30,3

# demand
town_id,product_id,mean,sd
T1,MILK,12,4
T2,MILK,20,6
T2,RICE,10,0
"""


def load(text, base=None):
    return json.loads(bridge.load_csv(text, json.dumps(base) if base else None, False))


@pytest.mark.parametrize("sid", SAMPLES)
def test_every_sample_round_trips_exactly(sid):
    original = Scenario.model_validate(json.loads(bridge.get_scenario(sid)))
    r = load(bridge.sample_csv(sid))
    assert r["ok"] and r["validation"]["valid"]
    assert scenario_hash(Scenario.model_validate(r["scenario"])) == scenario_hash(original)


def test_own_dataset_plans_and_uses_its_values():
    r = load(MINI)
    assert r["ok"], r["errors"]
    sc = r["scenario"]
    assert sc["policy"]["margin"] == 0.05 and sc["policy"]["freight_paise_per_tkm"]["road_avg"] == 450
    assert [g["dispatch_capacity_units"] for g in sc["godowns"]] == [None, 40]
    assert sc["products"][0]["price_paise"] == 6000
    d = next(d for d in sc["demand"] if d["product_id"] == "RICE")
    assert d["quantiles"] == [10] * 9  # sd 0 -> a point mass
    out = json.loads(bridge.plan(json.dumps(sc)))
    assert out["valid"] and out["aria"]["verifier"]["passed"]
    dash = out["dashboard"]["aria"]
    assert sum(f["units"] for f in dash["flows"]) == out["aria"]["metrics"]["units_shipped"]
    assert sum(b["units"] for b in dash["life_on_arrival"]) == out["aria"]["metrics"]["units_shipped"]
    assert {f["godown_id"] for f in dash["flows"]} <= {"D1", "D2"}


def test_errors_carry_line_numbers():
    bad = MINI.replace("D1,MILK,50,4", "D1,MILK,fifty,4").replace("D2,T2,15,0,road_avg", "D9,T2,15,0,road_avg")
    r = load(bad)
    assert not r["ok"]
    msgs = {(e["section"], e["line"]): e["message"] for e in r["errors"]}
    assert any(s == "stock" and "whole number" in m for (s, _), m in msgs.items())
    assert any(s == "routes" and "D9" in m and line == 26 for (s, line), m in msgs.items())


@pytest.mark.parametrize("value", ["inf", "-inf", "1e400", "nan"])
def test_impossible_numbers_are_row_errors_not_crashes(value):
    r = load(MINI.replace("D1,MILK,50,4", f"D1,MILK,{value},4"))
    assert not r["ok"]
    assert any(e["section"] == "stock" and "whole number" in e["message"] for e in r["errors"])
    assert not load(MINI.replace("margin,0.05", f"margin,{value}"))["ok"]


@pytest.mark.parametrize("row, why", [("T1,Alpha,1000,,18.5,", "both lat and lon"), ("T1,Alpha,1000,,95,73.8", "from -90 to 90")])
def test_town_positions_must_be_whole_and_on_the_globe(row, why):
    text = MINI.replace("town_id,name,population\nT1,Alpha,1000", f"town_id,name,population,priority,lat,lon\n{row}")
    r = load(text)
    assert not r["ok"] and any(e["section"] == "towns" and why in e["message"] for e in r["errors"])
    assert load(text.replace(row, "T1,Alpha,1000,,18.5,73.8"))["ok"]


def test_missing_sections_and_columns_are_reported():
    r = load("# products\nproduct_id,kg_per_unit\nA,1\n")
    assert not r["ok"]
    text = " | ".join(e["message"] for e in r["errors"])
    assert "missing column(s): shelf_life_days, price_rs" in text and "section '# depots' is missing" in text
    assert not load("")["ok"]
    assert not load("# nonsense\na,b\n")["ok"]


def test_partial_upload_updates_only_its_section():
    base = load(MINI)["scenario"]
    r = load("depot_id,product_id,qty_units,days_left\nD1,MILK,5,4\n", base)  # header-detected stock table
    assert r["ok"] and r["sections"] == {"stock": 1}
    assert "products" in r["kept"] and len(r["scenario"]["lots"]) == 1 and r["scenario"]["products"] == base["products"]


def test_sales_history_is_forecast_on_device():
    base = load(MINI)["scenario"]
    start = date(2026, 1, 1)
    rows = [f"{start + timedelta(days=i)},MILK,T1,{10 + i % 7}" for i in range(40)]
    r = load("# sales\ndate,product_id,town_id,qty\n" + "\n".join(rows) + "\n", base)
    assert r["ok"], r["errors"]
    d = next(d for d in r["scenario"]["demand"] if d["town_id"] == "T1" and d["product_id"] == "MILK")
    assert 10 <= d["quantiles"][4] <= 16
    assert r["forecast"]["method"] == "fallback" and len(r["history"]["dates"]) == 40


def test_compare_reports_differences_from_baseline():
    sc = load(MINI)["scenario"]
    c = json.loads(bridge.compare(json.dumps(sc), json.dumps([
        {"id": "a", "name": "More demand", "params": {"demand_pct": 50}},
        {"id": "b", "name": "Half capacity", "params": {"capacity_pct": 50}},
        {"id": "c", "name": "Bad", "params": {"closures": [["D1", "NOPE"]]}},
    ])))
    assert c["valid"]
    more, half, bad = c["variants"]
    b = c["baseline"]["kpis"]
    assert more["kpis"]["units_shipped"] >= b["units_shipped"]
    d = more["diff"]["units_shipped"]
    assert d["abs"] == more["kpis"]["units_shipped"] - b["units_shipped"]
    assert half["depots"][1]["capacity"] == 20 and half["depots"][1]["shipped"] <= 20
    assert "error" in bad


def test_vehicle_options_follow_the_shock_rule():
    sc = Scenario.model_validate(load(MINI)["scenario"])
    assert analysis.vehicle_options(sc, "D1", "T1") == ["6t"]  # dearer than road_avg
    assert analysis.vehicle_options(sc, "D1", "T2") == []  # already the dearest class
    restricted = analysis.apply(sc, {"restrictions": [["D1", "T1", "6t"]]})
    assert next(r for r in restricted.routes if r.town_id == "T1").vehicle_class == "6t"
