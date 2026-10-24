import hashlib
import json

import pytest

from aria import svcr
from aria.engine.pipeline import plan as make_plan
from tests.fixtures import tiny_scenario


def _rehash(body: bytes) -> bytes:
    return f"{svcr.MAGIC} sha256={hashlib.sha256(body).hexdigest()}\n".encode() + body


@pytest.fixture
def signed():
    sc = tiny_scenario()
    plan = make_plan(sc)["aria"]
    assert plan.verifier.passed
    return sc, plan, svcr.dumps(sc, plan, created_at="2026-10-24T00:00:00+00:00")


def test_roundtrip(signed):
    sc, plan, data = signed
    sc2, plan2, payload = svcr.loads(data)
    assert sc2 == sc and plan2 == plan and payload["network_id"] == "fixture"


def test_byte_edit_rejected(signed):
    data = signed[2].replace(b'"units":', b'"units": ', 1)
    with pytest.raises(svcr.SvcrError, match="digest"):
        svcr.loads(data)


def test_rehashed_infeasible_edit_rejected(signed):
    body = json.loads(signed[2].partition(b"\n")[2])
    body["plan"]["allocations"][0]["units"] += 10_000  # more than any lot holds
    raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    with pytest.raises(svcr.SvcrError, match="verifier"):
        svcr.loads(_rehash(raw))


def test_scenario_swap_rejected(signed):
    body = json.loads(signed[2].partition(b"\n")[2])
    body["scenario"]["lots"][0]["qty_units"] += 1
    raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    with pytest.raises(svcr.SvcrError, match="scenario_hash"):
        svcr.loads(_rehash(raw))


def test_unverified_plan_not_exportable(signed):
    sc, plan, _ = signed
    with pytest.raises(svcr.SvcrError):
        svcr.dumps(sc, plan.model_copy(update={"verifier": plan.verifier.model_copy(update={"passed": False})}))


def test_not_svcr():
    with pytest.raises(svcr.SvcrError, match="not a"):
        svcr.loads(b"hello\n{}")


@pytest.mark.parametrize("body", [b"{not json", b"[1,2,3]", b"\xff\xfe", b'{"scenario": [], "plan": "x", "scenario_hash": ""}',
                                  b'{"plan": {}, "scenario_hash": ""}'])
def test_rehashed_malformed_body_rejected_not_crash(body):
    """Regression (simulation I6): a re-hashed body that is not SVCR JSON raised JSONDecodeError/KeyError/TypeError."""
    with pytest.raises(svcr.SvcrError, match="malformed"):
        svcr.loads(_rehash(body))
