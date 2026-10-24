"""One case per Appendix A rule: expected code at the expected JSON path."""
import pytest

from aria.validate import validate
from tests.fixtures import tiny_scenario


def payload():
    return tiny_scenario().model_dump(mode="json")


def codes(report, kind="errors"):
    return {(e["code"], e["path"]) for e in report[kind]}


def test_tiny_scenario_is_valid():
    r = validate(payload())
    assert r["valid"] and r["errors"] == []
    assert len(r["scenario_hash"]) == 64


def test_hash_matches_shared_hashing():
    from aria.hashing import scenario_hash
    assert validate(payload())["scenario_hash"] == scenario_hash(tiny_scenario())


def test_required():
    p = payload()
    del p["products"][0]["category"]
    del p["routes"]
    assert {("E_REQUIRED", "$.products[0].category"), ("E_REQUIRED", "$.routes")} <= codes(validate(p))


def test_type():
    p = payload()
    p["lots"][1]["qty_units"] = "ten"
    p["routes"][0]["vehicle_class"] = "truck"
    r = validate(p)
    assert {("E_TYPE", "$.lots[1].qty_units"), ("E_TYPE", "$.routes[0].vehicle_class")} <= codes(r)
    assert r["scenario_hash"] is None


@pytest.mark.parametrize("mutate,path", [
    (lambda p: p["lots"][0].update(qty_units=-1), "$.lots[0].qty_units"),
    (lambda p: p["town_stock"][0].update(qty_units=-2), "$.town_stock[0].qty_units"),
    (lambda p: p["products"][0].update(price_paise=-5), "$.products[0].price_paise"),
    (lambda p: p["lots"][3].update(remaining_life_days=8), "$.lots[3].remaining_life_days"),  # P2 shelf life 7
    (lambda p: p["products"][1].update(min_days_at_receipt=9), "$.products[1].min_days_at_receipt"),
    (lambda p: p["towns"][0].update(priority=0.05), "$.towns[0].priority"),
    (lambda p: p["towns"][1].update(priority=11), "$.towns[1].priority"),
    (lambda p: p["policy"].update(salvage_share=1.5), "$.policy.salvage_share"),
])
def test_range(mutate, path):
    p = payload()
    mutate(p)
    r = validate(p)
    assert ("E_RANGE", path) in codes(r)
    assert not r["valid"]


def test_shock_pct_range():
    r = validate(payload(), shocks=[{"type": "INVENTORY_LOSS", "godown_id": "G1", "pct": 120}])
    assert ("E_RANGE", "$.shocks[0].pct") in codes(r)


def test_shock_bad_ref_reports_index():
    shocks = [{"type": "ROUTE_RESTRICTION", "godown_id": "G1", "town_id": "B"},
              {"type": "ROUTE_CLOSURE", "godown_id": "G9", "town_id": "B"}]
    assert codes(validate(payload(), shocks=shocks)) == {("E_BAD_REF", "$.shocks[1].godown_id")}


def test_duplicate_id():
    p = payload()
    p["lots"][2]["lot_id"] = "L1"
    p["towns"].append(dict(p["towns"][0]))
    assert {("E_DUPLICATE_ID", "$.lots[2].lot_id"), ("E_DUPLICATE_ID", "$.towns[2].town_id")} <= codes(validate(p))


def test_bad_ref():
    p = payload()
    p["lots"][0]["godown_id"] = "GX"
    p["routes"][1]["town_id"] = "Z"
    p["demand"][0]["product_id"] = "P9"
    assert {("E_BAD_REF", "$.lots[0].godown_id"), ("E_BAD_REF", "$.routes[1].town_id"),
            ("E_BAD_REF", "$.demand[0].product_id")} <= codes(validate(p))


def test_size():
    p = payload()
    p["products"] += [dict(p["products"][0], product_id=f"X{i}") for i in range(78)]
    p["towns"] += [dict(p["towns"][0], town_id=f"T{i}") for i in range(38)]  # 40 x 80 x 100 = 320,000
    assert ("E_SIZE", "$") in codes(validate(p))


def test_all_errors_returned():
    p = payload()
    p["lots"][0]["qty_units"] = -1
    p["lots"][1]["godown_id"] = "GX"
    del p["products"][0]["category"]
    p["towns"][0]["priority"] = 50
    got = {c for c, _ in codes(validate(p))}
    assert {"E_RANGE", "E_BAD_REF", "E_REQUIRED"} <= got
    assert len(validate(p)["errors"]) >= 4


def test_warn_expired_stock():
    p = payload()
    p["lots"][0]["remaining_life_days"] = 0
    r = validate(p)
    assert r["valid"]
    assert ("W_EXPIRED_STOCK", "$.lots[0].remaining_life_days") in codes(r, "warnings")


def test_warn_inactive_route():
    p = payload()
    p["routes"][3]["active"] = False
    assert ("W_INACTIVE_ROUTE", "$.routes[3].active") in codes(validate(p), "warnings")


def test_warn_no_eligible_supply():
    p = payload()
    for r in p["routes"]:
        if r["town_id"] == "B":
            r["active"] = False
    w = codes(validate(p), "warnings")
    b_rows = [i for i, d in enumerate(p["demand"]) if d["town_id"] == "B"]
    assert all(("W_NO_ELIGIBLE_SUPPLY", f"$.demand[{i}]") in w for i in b_rows)


def test_e_size_reported_alongside_bad_refs():
    """Regression (simulation I3): with an E_BAD_REF present, E_SIZE was never reported, even when
    towns x products x 100 segments alone exceed the limit, so 'all errors at once' failed."""
    from aria.validate import validate as _validate
    from tests.fixtures import tiny_scenario

    d = tiny_scenario().model_dump(mode="json")
    d["towns"] = [{**d["towns"][0], "town_id": f"T{i}"} for i in range(40)]
    d["products"] = [{**d["products"][0], "product_id": f"P{i}"} for i in range(80)]
    d["lots"][0]["godown_id"] = "NOPE"
    codes = {(e["code"], e["path"]) for e in _validate(d)["errors"]}
    assert ("E_BAD_REF", "$.lots[0].godown_id") in codes and ("E_SIZE", "$") in codes
