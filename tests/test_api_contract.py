"""API contract (PRD §7.7): shapes, request_id echo, scenario_hash, 422 paths, KPI values == engine values."""
import importlib.util

import pytest
from fastapi.encoders import jsonable_encoder
from fastapi.testclient import TestClient

from api.main import app
from aria.hashing import scenario_hash
from tests.fixtures import tiny_scenario

client = TestClient(app)
HAS_PIPELINE = importlib.util.find_spec("aria.engine.pipeline") is not None
needs_pipeline = pytest.mark.skipif(not HAS_PIPELINE, reason="aria/engine/pipeline.py (owner A) not present yet")


def body(**extra):
    return {"request_id": 7, "scenario": tiny_scenario().model_dump(mode="json"), **extra}


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "ok" and "highspy" in j["solver_version"] and isinstance(j["data_hashes"], dict)


def test_lists():
    assert client.get("/api/scenarios").status_code == 200
    assert client.get("/api/networks").status_code == 200
    assert client.get("/api/scenarios/does-not-exist").status_code == 404
    assert client.get("/api/replay/does-not-exist").status_code == 404
    assert client.get("/api/explain/nope", params={"town": "A", "product": "P1"}).status_code == 404


def test_validate_ok():
    r = client.post("/api/validate", json=body())
    assert r.status_code == 200
    j = r.json()
    assert j["request_id"] == 7 and j["valid"] and j["scenario_hash"] == scenario_hash(tiny_scenario())


def test_validate_bad_body_400():
    assert client.post("/api/validate", json={"request_id": 1}).status_code == 400


def test_plan_invalid_422_lists_all_errors():
    b = body()
    b["scenario"]["lots"][0]["qty_units"] = -1
    b["scenario"]["lots"][1]["godown_id"] = "GX"
    r = client.post("/api/plan", json=b)
    assert r.status_code == 422
    j = r.json()
    assert j["request_id"] == 7
    assert {("E_RANGE", "$.lots[0].qty_units"), ("E_BAD_REF", "$.lots[1].godown_id")} <= {(e["code"], e["path"]) for e in j["errors"]}


def test_whatif_invalid_shock_422_has_index():
    r = client.post("/api/whatif", json=body(shocks=[{"type": "ROUTE_RESTRICTION", "godown_id": "G1", "town_id": "B"},
                                                      {"type": "INVENTORY_LOSS", "godown_id": "G1", "pct": 150}]))
    assert r.status_code == 422
    assert any(e["path"] == "$.shocks[1].pct" for e in r.json()["errors"])


@needs_pipeline
def test_plan_echoes_and_matches_engine():
    from aria.engine import pipeline

    r = client.post("/api/plan", json=body())
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["request_id"] == 7
    assert j["scenario_hash"] == scenario_hash(tiny_scenario())
    engine = jsonable_encoder(pipeline.plan(tiny_scenario()))
    for name in ("aria", "baseline_a"):
        if engine[name] is None:
            assert j[name] is None
            continue
        assert j[name]["metrics"] == engine[name]["metrics"]  # every KPI shown == engine value
        assert j[name]["allocations"] == engine[name]["allocations"]
        assert j[name]["shortfalls"] == engine[name]["shortfalls"]
    assert j["recommended"] == engine["recommended"]


@needs_pipeline
def test_explain_after_plan():
    j = client.post("/api/plan", json=body()).json()
    plan = j["aria"] or j["baseline_a"]
    r = client.get(f"/api/explain/{plan['plan_id']}", params={"town": "B", "product": "P1"})
    assert r.status_code == 200, r.text


@needs_pipeline
def test_whatif_route_restriction():
    from aria.engine import pipeline
    from aria.schemas import Shock

    shock = {"type": "ROUTE_RESTRICTION", "godown_id": "G1", "town_id": "B", "max_vehicle": "6t"}
    r = client.post("/api/whatif", json=body(shocks=[shock]))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["request_id"] == 7
    assert {"before", "after", "diff", "tau_changes"} <= set(j)
    engine = jsonable_encoder(pipeline.whatif(tiny_scenario(), [Shock(**shock)]))
    assert j["diff"] == engine["diff"]
    assert j["tau_changes"] == engine["tau_changes"]


def test_replay_selects_freight_point(tmp_path, monkeypatch):
    import json

    import api.main as m

    (tmp_path / "built").mkdir()
    point = {"conservation_ok": True, "per_policy": {}, "kpi1": {"diff_paise": -1, "ci_low": -2, "ci_high": 0}}
    doc = {"network": "net", "points": {"own": {**point, "freight_point": "own"}, "6t": {**point, "freight_point": "6t"}}}
    (tmp_path / "built" / "replay_net.json").write_text(json.dumps(doc))
    monkeypatch.setattr(m, "DATA", tmp_path)
    assert client.get("/api/replay/net").json()["freight_point"] == "own"
    j = client.get("/api/replay/net", params={"freight_point": "6t"}).json()
    assert j["freight_point"] == "6t" and j["available_freight_points"] == ["own", "6t"]
    assert client.get("/api/replay/net", params={"freight_point": "x"}).status_code == 404
