"""Scenario validation (PRD FR-P0-02, Appendix A). Every issue carries a code and a JSON path; all are returned."""
from __future__ import annotations

from pydantic import ValidationError

from aria.hashing import scenario_hash
from aria.schemas import Scenario, Shock

MAX_MODEL_COLUMNS = 300_000
SEGMENTS = 100
RANGE_TYPES = {"greater_than", "greater_than_equal", "less_than", "less_than_equal"}


def _path(loc) -> str:
    out = "$"
    for part in loc:
        out += f"[{part}]" if isinstance(part, int) else f".{part}"
    return out


def _issue(code: str, path: str, message: str) -> dict:
    return {"code": code, "path": path, "message": message}


def _num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _rows(payload: dict, key: str):
    """(index, dict) pairs of a top-level list, tolerating wrong types (those are reported as E_TYPE)."""
    items = payload.get(key)
    if not isinstance(items, list):
        return []
    return [(i, x) for i, x in enumerate(items) if isinstance(x, dict)]


def _pydantic_errors(exc: ValidationError, prefix: tuple = ()) -> list[dict]:
    out = []
    for e in exc.errors():
        if e["type"] == "missing":
            code = "E_REQUIRED"
        elif e["type"] in RANGE_TYPES:
            code = "E_RANGE"
        else:
            code = "E_TYPE"
        out.append(_issue(code, _path(prefix + tuple(e["loc"])), e["msg"]))
    return out


def _duplicates(payload: dict, key: str, id_fields: tuple[str, ...]) -> list[dict]:
    seen, out = set(), []
    for i, row in _rows(payload, key):
        ident = tuple(row.get(f) for f in id_fields)
        if any(v is None for v in ident):
            continue
        if ident in seen:
            out.append(_issue("E_DUPLICATE_ID", f"$.{key}[{i}].{id_fields[-1]}", f"duplicate {'/'.join(id_fields)} {'/'.join(map(str, ident))}"))
        seen.add(ident)
    return out


def _refs(payload: dict) -> list[dict]:
    ids = {
        "product_id": {r.get("product_id") for _, r in _rows(payload, "products")},
        "godown_id": {r.get("godown_id") for _, r in _rows(payload, "godowns")},
        "town_id": {r.get("town_id") for _, r in _rows(payload, "towns")},
    }
    refs = {
        "lots": ("godown_id", "product_id"),
        "town_stock": ("town_id", "product_id"),
        "routes": ("godown_id", "town_id"),
        "demand": ("town_id", "product_id"),
    }
    out = []
    for key, fields in refs.items():
        for i, row in _rows(payload, key):
            for f in fields:
                v = row.get(f)
                if v is not None and v not in ids[f]:
                    out.append(_issue("E_BAD_REF", f"$.{key}[{i}].{f}", f"unknown {f} {v!r}"))
    return out


def _ranges(payload: dict) -> list[dict]:
    out = []
    shelf = {r.get("product_id"): r.get("shelf_life_days") for _, r in _rows(payload, "products")}
    for i, p in _rows(payload, "products"):
        m, s = p.get("min_days_at_receipt"), p.get("shelf_life_days")
        if _num(m) and _num(s) and m > s:
            out.append(_issue("E_RANGE", f"$.products[{i}].min_days_at_receipt", f"min days at receipt {m} exceeds shelf life {s}"))
        if _num(p.get("price_paise")) and p["price_paise"] < 0:
            out.append(_issue("E_RANGE", f"$.products[{i}].price_paise", "negative cost"))
    for key in ("lots", "town_stock"):
        for i, row in _rows(payload, key):
            q, r, s = row.get("qty_units"), row.get("remaining_life_days"), shelf.get(row.get("product_id"))
            if _num(q) and q < 0:
                out.append(_issue("E_RANGE", f"$.{key}[{i}].qty_units", f"negative quantity {q}"))
            if _num(r) and _num(s) and r > s:
                out.append(_issue("E_RANGE", f"$.{key}[{i}].remaining_life_days", f"remaining life {r} exceeds shelf life {s}"))
    for i, t in _rows(payload, "towns"):
        pr = t.get("priority")
        if _num(pr) and not 0.1 <= pr <= 10:
            out.append(_issue("E_RANGE", f"$.towns[{i}].priority", f"priority {pr} outside 0.1-10"))
    for i, r in _rows(payload, "routes"):
        if _num(r.get("road_km")) and r["road_km"] < 0:
            out.append(_issue("E_RANGE", f"$.routes[{i}].road_km", "negative distance"))
    policy = payload.get("policy")
    if isinstance(policy, dict):
        sv = policy.get("salvage_share")
        if _num(sv) and not 0 <= sv <= 1:
            out.append(_issue("E_RANGE", "$.policy.salvage_share", f"salvage share {sv} outside 0-1"))
        rates = policy.get("freight_paise_per_tkm")
        if isinstance(rates, dict):
            for k, v in rates.items():
                if _num(v) and v < 0:
                    out.append(_issue("E_RANGE", f"$.policy.freight_paise_per_tkm.{k}", "negative cost"))
    for i, d in _rows(payload, "demand"):
        q = d.get("quantiles")
        if isinstance(q, list) and all(_num(x) for x in q):
            if len(q) != 9:
                out.append(_issue("E_RANGE", f"$.demand[{i}].quantiles", f"expected 9 quantiles, got {len(q)}"))
            elif any(x < 0 for x in q) or any(a > b for a, b in zip(q, q[1:])):
                out.append(_issue("E_RANGE", f"$.demand[{i}].quantiles", "quantiles must be non-negative and non-crossing"))
    return out


def _model_columns(sc: Scenario) -> int:
    from aria.engine.eligibility import at_risk, eligible_arcs

    products = {p.product_id: p for p in sc.products}
    any_risk = any(at_risk(lot, products[lot.product_id], sc.routes) for lot in sc.lots)
    return len(sc.towns) * len(sc.products) * SEGMENTS * (2 if any_risk else 1) + len(eligible_arcs(sc))


def _warnings(sc: Scenario) -> list[dict]:
    from aria.engine.eligibility import eligible_arcs

    out = []
    for key in ("lots", "town_stock"):
        for i, row in enumerate(getattr(sc, key)):
            if row.remaining_life_days <= 0 and row.qty_units > 0:
                out.append(_issue("W_EXPIRED_STOCK", f"$.{key}[{i}].remaining_life_days", "expired stock is ignored and written off"))
    for i, r in enumerate(sc.routes):
        if not r.active:
            out.append(_issue("W_INACTIVE_ROUTE", f"$.routes[{i}].active", f"route {r.godown_id}->{r.town_id} is inactive"))
    supplied = {(r.town_id, lot.product_id) for lot, r in eligible_arcs(sc)}
    for i, d in enumerate(sc.demand):
        if (d.town_id, d.product_id) not in supplied:
            out.append(_issue("W_NO_ELIGIBLE_SUPPLY", f"$.demand[{i}]", f"no eligible lot can reach {d.town_id} for {d.product_id}"))
    return out


def validate_shocks(shocks, sc_payload: dict) -> list[dict]:
    """Shock list checks; paths are $.shocks[i]... so the API can report the shock index."""
    if not isinstance(shocks, list):
        return [_issue("E_TYPE", "$.shocks", "shocks must be a list")]
    godowns = {r.get("godown_id") for _, r in _rows(sc_payload, "godowns")}
    towns = {r.get("town_id") for _, r in _rows(sc_payload, "towns")}
    products = {r.get("product_id") for _, r in _rows(sc_payload, "products")} | {"*"}
    out = []
    for i, raw in enumerate(shocks):
        try:
            s = Shock.model_validate(raw)
        except ValidationError as exc:
            out += _pydantic_errors(exc, ("shocks", i))
            continue
        if not 0 <= s.pct <= 100:
            out.append(_issue("E_RANGE", f"$.shocks[{i}].pct", f"shock % {s.pct} outside 0-100"))
        needs_town = s.type in ("ROUTE_CLOSURE", "ROUTE_RESTRICTION")
        needs_godown = s.type in ("ROUTE_CLOSURE", "ROUTE_RESTRICTION", "INVENTORY_LOSS")
        if needs_godown and s.godown_id is None:
            out.append(_issue("E_REQUIRED", f"$.shocks[{i}].godown_id", f"{s.type} needs godown_id"))
        if needs_town and s.town_id is None:
            out.append(_issue("E_REQUIRED", f"$.shocks[{i}].town_id", f"{s.type} needs town_id"))
        if s.godown_id is not None and s.godown_id not in godowns:
            out.append(_issue("E_BAD_REF", f"$.shocks[{i}].godown_id", f"unknown godown_id {s.godown_id!r}"))
        if s.town_id is not None and s.town_id not in towns:
            out.append(_issue("E_BAD_REF", f"$.shocks[{i}].town_id", f"unknown town_id {s.town_id!r}"))
        if s.product_id not in products:
            out.append(_issue("E_BAD_REF", f"$.shocks[{i}].product_id", f"unknown product_id {s.product_id!r}"))
    return out


def validate(payload: dict, shocks: list | None = None) -> dict:
    """→ {valid, errors[], warnings[], scenario_hash}. scenario_hash is None when the scenario does not parse."""
    if not isinstance(payload, dict):
        return {"valid": False, "errors": [_issue("E_TYPE", "$", "scenario must be a JSON object")], "warnings": [], "scenario_hash": None}
    errors, sc = [], None
    try:
        sc = Scenario.model_validate(payload)
    except ValidationError as exc:
        errors += _pydantic_errors(exc)
    errors += _ranges(payload)
    for key, fields in (("products", ("product_id",)), ("godowns", ("godown_id",)), ("towns", ("town_id",)),
                        ("lots", ("lot_id",)), ("routes", ("godown_id", "town_id")), ("demand", ("town_id", "product_id")),
                        ("town_stock", ("town_id", "product_id", "remaining_life_days"))):
        errors += _duplicates(payload, key, fields)
    errors += _refs(payload)
    if shocks is not None:
        errors += validate_shocks(shocks, payload)

    # de-duplicate (pydantic and the range rules can flag the same field)
    seen, unique = set(), []
    for e in errors:
        if (e["code"], e["path"]) not in seen:
            seen.add((e["code"], e["path"]))
            unique.append(e)
    errors = unique

    warnings = []
    if sc is not None and not any(e["code"] == "E_BAD_REF" and not e["path"].startswith("$.shocks") for e in errors):
        cols = _model_columns(sc)
        if cols > MAX_MODEL_COLUMNS:
            errors.append(_issue("E_SIZE", "$", f"model would have {cols} columns (> {MAX_MODEL_COLUMNS}); plan a product subset"))
        warnings = _warnings(sc)
    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "scenario_hash": scenario_hash(sc) if sc is not None else None,
    }
