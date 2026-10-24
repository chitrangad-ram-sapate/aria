"""The app's data file: one CSV holding a whole distribution dataset, converted to and from a Scenario.

Layout: sections, each started by a marker row whose first cell is `# <section>`, then a header row,
then data rows. A file with no markers is one section, recognised by its header. Sections:

  settings    key, value                       name, day, margin, salvage_share, repo_rate,
                                                freight_rs_per_tkm_<vehicle class>
  products    product_id, category, kg_per_unit, shelf_life_days, min_days_at_receipt, price_rs
  depots      depot_id, name, lat, lon, capacity_units
  towns       town_id, name, population, priority, lat, lon
  routes      depot_id, town_id, road_km, transit_days, vehicle_class, active
  stock       lot_id, depot_id, product_id, qty_units, days_left
  town_stock  town_id, product_id, qty_units, days_left
  demand      town_id, product_id, then the 9 quantiles q0.005 … q0.995, or mean and sd
              (normal, clipped at 0); optional point and sigma (default: median, (q0.835 − q0.165) / 2)
  sales       date, product_id, town_id, qty    (history; forecast on the device into `demand`)

Sections missing from an upload are taken from the current dataset when one is given (reported),
otherwise products, depots, towns, routes, stock and demand-or-sales are required.
"""
from __future__ import annotations

import csv
import io
import math
from itertools import pairwise
from statistics import NormalDist

from aria.schemas import QUANTILE_LEVELS, Policy

QCOLS = [f"q{lv:g}" for lv in QUANTILE_LEVELS]
VEHICLES = ("55t", "road_avg", "6t")

# section -> [(column, type, required, default)]; types: str, int, float, bool
SPEC: dict[str, list[tuple[str, str, bool, object]]] = {
    "products": [("product_id", "str", True, None), ("category", "str", False, "general"), ("kg_per_unit", "float", True, None),
                 ("shelf_life_days", "int", True, None), ("min_days_at_receipt", "int", False, 0), ("price_rs", "float", True, None)],
    "depots": [("depot_id", "str", True, None), ("name", "str", False, ""), ("lat", "float", False, None), ("lon", "float", False, None),
               ("capacity_units", "int", False, None)],
    "towns": [("town_id", "str", True, None), ("name", "str", False, ""), ("population", "int", False, 0), ("priority", "float", False, 1.0),
              ("lat", "float", False, None), ("lon", "float", False, None)],
    "routes": [("depot_id", "str", True, None), ("town_id", "str", True, None), ("road_km", "float", True, None),
               ("transit_days", "int", True, None), ("vehicle_class", "str", False, "road_avg"), ("active", "bool", False, True)],
    "stock": [("lot_id", "str", False, None), ("depot_id", "str", True, None), ("product_id", "str", True, None),
              ("qty_units", "int", True, None), ("days_left", "int", True, None)],
    "town_stock": [("town_id", "str", True, None), ("product_id", "str", True, None), ("qty_units", "int", True, None),
                   ("days_left", "int", True, None)],
    "demand": [("town_id", "str", True, None), ("product_id", "str", True, None)] + [(c, "float", False, None) for c in QCOLS]
              + [("mean", "float", False, None), ("sd", "float", False, None), ("point", "float", False, None), ("sigma", "float", False, None)],
    "sales": [("date", "str", True, None), ("product_id", "str", True, None), ("town_id", "str", True, None), ("qty", "float", True, None)],
    "settings": [("key", "str", True, None), ("value", "str", True, None)],
}
REQUIRED = ("products", "depots", "towns", "routes", "stock")
ALIASES = {"godown_id": "depot_id", "item": "product_id", "outlet/town": "town_id", "outlet": "town_id", "town": "town_id",
           "remaining_life_days": "days_left", "dispatch_capacity_units": "capacity_units", "population_2011": "population"}
SETTINGS = {"margin", "salvage_share", "repo_rate"}


class CsvError(ValueError):
    pass


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return repr(v)  # shortest exact form, so a CSV round trip keeps every value
    return str(v)


def to_csv(sc: dict) -> str:
    """Scenario dict -> data CSV (every section, exact quantiles), the format from_csv reads back."""
    pol = sc.get("policy") or {}
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")

    def section(name: str, cols: list[str], rows: list[list]):
        w.writerow([f"# {name}"])
        w.writerow(cols)
        w.writerows([[_cell(v) for v in r] for r in rows])
        w.writerow([])

    settings = [["name", sc.get("scenario_id", "")], ["network_id", sc.get("network_id", "")], ["day", sc.get("day", "")]]
    settings += [[k, pol[k]] for k in ("margin", "salvage_share", "repo_rate") if k in pol]
    settings += [[f"freight_rs_per_tkm_{k}", v / 100] for k, v in (pol.get("freight_paise_per_tkm") or {}).items()]
    section("settings", ["key", "value"], settings)
    section("products", [c for c, *_ in SPEC["products"]], [[p["product_id"], p.get("category"), p["kg_per_unit"], p["shelf_life_days"],
            p.get("min_days_at_receipt", 0), p["price_paise"] / 100] for p in sc["products"]])
    section("depots", [c for c, *_ in SPEC["depots"]], [[g["godown_id"], g.get("name"), g.get("lat"), g.get("lon"),
            g.get("dispatch_capacity_units")] for g in sc["godowns"]])
    section("towns", [c for c, *_ in SPEC["towns"]], [[t["town_id"], t.get("name"), t.get("population_2011", 0), t.get("priority", 1.0),
            t.get("lat"), t.get("lon")] for t in sc["towns"]])
    section("routes", [c for c, *_ in SPEC["routes"]], [[r["godown_id"], r["town_id"], r["road_km"], r["transit_days"],
            r.get("vehicle_class", "road_avg"), r.get("active", True)] for r in sc["routes"]])
    section("stock", [c for c, *_ in SPEC["stock"]], [[l["lot_id"], l["godown_id"], l["product_id"], l["qty_units"],
            l["remaining_life_days"]] for l in sc["lots"]])
    if sc.get("town_stock"):
        section("town_stock", [c for c, *_ in SPEC["town_stock"]], [[s["town_id"], s["product_id"], s["qty_units"],
                s["remaining_life_days"]] for s in sc["town_stock"]])
    section("demand", ["town_id", "product_id"] + QCOLS + ["point", "sigma"],
            [[d["town_id"], d["product_id"], *d["quantiles"], d.get("point"), d.get("sigma")] for d in sc["demand"]])
    return out.getvalue()


def _split(text: str) -> dict[str, tuple[int, list[str], list[tuple[int, list[str]]]]]:
    """-> {section: (header line no, header, [(line no, row)])}."""
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    out: dict = {}
    cur = None
    for i, r in enumerate(rows, start=1):
        cells = [c.strip() for c in r]
        if not any(cells):
            continue
        if cells[0].startswith("#"):
            name = cells[0].lstrip("#").strip().lower().replace(" ", "_")
            name = {"godowns": "depots", "lots": "stock", "history": "sales", "policy": "settings"}.get(name, name)
            if name not in SPEC:
                raise CsvError(f"line {i}: unknown section '{cells[0]}' (known: {', '.join(SPEC)})")
            if name in out:
                raise CsvError(f"line {i}: section '{name}' appears twice")
            cur = name
            out[cur] = (None, [], [])
            continue
        if cur is None:  # no markers: a single table recognised by its header
            cur = _detect([ALIASES.get(c.lower(), c.lower()) for c in cells], i)
            out[cur] = (None, [], [])
        hl, _header, data = out[cur]
        if hl is None:
            out[cur] = (i, [ALIASES.get(c.lower(), c.lower()) for c in cells], data)
        else:
            data.append((i, cells))
    return out


def _detect(header: list[str], line: int) -> str:
    cols = set(header)
    for name in ("sales", "stock", "routes", "demand", "town_stock", "products", "depots", "towns", "settings"):
        need = {c for c, _, req, _ in SPEC[name] if req}
        if need <= cols:
            return name
    raise CsvError(f"line {line}: header ({', '.join(header)}) does not match any section; "
                   f"start each table with a '# section' row, e.g. '# products'")


def _parse(name: str, hl: int, header: list[str], data: list, errors: list) -> list[dict]:
    spec = SPEC[name]
    missing = [c for c, _, req, _ in spec if req and c not in header]
    if missing:
        errors.append({"section": name, "line": hl, "message": f"missing column(s): {', '.join(missing)}"})
        return []
    idx = {c: header.index(c) for c, *_ in spec if c in header}
    out = []
    for line, cells in data:
        rec, ok = {}, True
        for col, typ, req, default in spec:
            raw = cells[idx[col]].strip() if col in idx and idx[col] < len(cells) else ""
            if raw == "":
                if req:
                    errors.append({"section": name, "line": line, "message": f"{col} is empty"})
                    ok = False
                rec[col] = default
                continue
            try:
                if typ == "int":
                    f = float(raw)
                    if not math.isfinite(f) or f != int(f):  # "inf" / "1e400" would overflow int()
                        raise ValueError
                    rec[col] = int(f)
                elif typ == "float":
                    rec[col] = float(raw)
                    if not math.isfinite(rec[col]):
                        raise ValueError
                elif typ == "bool":
                    if raw.lower() not in ("true", "false", "1", "0", "yes", "no"):
                        raise ValueError
                    rec[col] = raw.lower() in ("true", "1", "yes")
                else:
                    rec[col] = raw
            except ValueError:
                kind = {"int": "a whole number", "float": "a number", "bool": "true or false"}.get(typ, "text")
                errors.append({"section": name, "line": line, "message": f"{col} must be {kind}, got '{raw}'"})
                ok = False
        if ok:
            rec["_line"] = line
            out.append(rec)
    return out


def _quantiles(rec: dict, errors: list) -> list[float] | None:
    qs = [rec.get(c) for c in QCOLS]
    if all(q is not None for q in qs):
        if any(q < 0 for q in qs):
            errors.append({"section": "demand", "line": rec["_line"], "message": "quantiles must not be negative"})
            return None
        if any(b < a for a, b in pairwise(qs)):
            errors.append({"section": "demand", "line": rec["_line"], "message": "quantiles must not decrease from q0.005 to q0.995"})
            return None
        return qs
    if rec.get("mean") is not None and rec.get("sd") is not None:
        if rec["mean"] < 0 or rec["sd"] < 0:
            errors.append({"section": "demand", "line": rec["_line"], "message": "mean and sd must not be negative"})
            return None
        if rec["sd"] == 0:
            return [rec["mean"]] * len(QUANTILE_LEVELS)
        nd = NormalDist(rec["mean"], rec["sd"])
        return [max(0.0, nd.inv_cdf(lv)) for lv in QUANTILE_LEVELS]  # normal, clipped at 0
    errors.append({"section": "demand", "line": rec["_line"], "message": f"give all of {QCOLS[0]}…{QCOLS[-1]}, or mean and sd"})
    return None


def from_csv(text: str, base: dict | None = None, use_ml: bool = True) -> dict:
    """-> {ok, scenario, sections: {name: rows}, kept: [section], errors: [...], warnings: [...], forecast, history}.

    errors carry the CSV line number; ok is False when any error exists."""
    errors: list[dict] = []
    warnings: list[str] = []
    try:
        parts = _split(text)
    except CsvError as e:
        return {"ok": False, "errors": [{"section": "", "line": None, "message": str(e)}]}
    if not parts:
        return {"ok": False, "errors": [{"section": "", "line": None, "message": "the file is empty"}]}
    recs = {name: _parse(name, hl or 0, header, data, errors) for name, (hl, header, data) in parts.items()}
    sc: dict = dict(base) if base else {"scenario_id": "my data", "network_id": "custom", "day": ""}
    sc["policy"] = dict(sc.get("policy") or Policy().model_dump())  # schema defaults until settings override them
    kept = []
    for name in REQUIRED + ("town_stock",):
        if name not in parts:
            if base is not None:
                kept.append(name)
            elif name in REQUIRED:
                errors.append({"section": name, "line": None, "message": f"section '# {name}' is missing"})
    if "demand" not in parts and "sales" not in parts:
        if base is not None:
            kept.append("demand")
        else:
            errors.append({"section": "demand", "line": None, "message": "add a '# demand' (forecast) or '# sales' (history) section"})

    for r in recs.get("settings", []):
        k, v = r["key"].strip().lower(), r["value"].strip()
        try:
            if k == "name":
                sc["scenario_id"] = v
            elif k in ("network_id", "day"):
                sc[k] = v
            elif k in SETTINGS:
                sc["policy"][k] = float(v)
                if not math.isfinite(sc["policy"][k]):
                    raise ValueError("must be a number")
            elif k.startswith("freight_rs_per_tkm_"):
                vc = k.removeprefix("freight_rs_per_tkm_")
                if vc not in VEHICLES:
                    raise ValueError(f"vehicle class must be one of {', '.join(VEHICLES)}")
                sc["policy"].setdefault("freight_paise_per_tkm", {})
                sc["policy"]["freight_paise_per_tkm"] = {**sc["policy"]["freight_paise_per_tkm"], vc: round(float(v) * 100)}
            else:
                warnings.append(f"line {r['_line']}: setting '{k}' is not used")
        except ValueError as e:
            errors.append({"section": "settings", "line": r["_line"], "message": f"{k}: {e}"})

    def uniq(name: str, key):
        seen = {}
        for r in recs.get(name, []):
            kk = key(r)
            if kk in seen:
                errors.append({"section": name, "line": r["_line"], "message": f"duplicate {kk} (first on line {seen[kk]})"})
            seen.setdefault(kk, r["_line"])

    uniq("products", lambda r: r["product_id"])
    uniq("depots", lambda r: r["depot_id"])
    uniq("towns", lambda r: r["town_id"])
    uniq("routes", lambda r: (r["depot_id"], r["town_id"]))
    uniq("demand", lambda r: (r["town_id"], r["product_id"]))
    # map positions: both or neither, and on the globe (a town with half a position gets no delivery point)
    for name in ("depots", "towns"):
        for r in recs.get(name, []):
            lat, lon = r["lat"], r["lon"]
            if (lat is None) != (lon is None):
                errors.append({"section": name, "line": r["_line"], "message": "give both lat and lon, or leave both empty"})
            elif lat is not None and not (-90 <= lat <= 90 and -180 <= lon <= 180):
                errors.append({"section": name, "line": r["_line"], "message": "lat must be from -90 to 90 and lon from -180 to 180"})
    if "products" in parts:
        sc["products"] = [{"product_id": r["product_id"], "category": r["category"], "kg_per_unit": r["kg_per_unit"],
                           "shelf_life_days": r["shelf_life_days"], "min_days_at_receipt": r["min_days_at_receipt"],
                           "price_paise": round(r["price_rs"] * 100)} for r in recs["products"]]
    if "depots" in parts:
        sc["godowns"] = [{"godown_id": r["depot_id"], "name": r["name"], "lat": r["lat"], "lon": r["lon"],
                          "dispatch_capacity_units": r["capacity_units"]} for r in recs["depots"]]
    if "towns" in parts:
        sc["towns"] = [{"town_id": r["town_id"], "name": r["name"], "population_2011": r["population"], "priority": r["priority"],
                        "lat": r["lat"], "lon": r["lon"]} for r in recs["towns"]]
    for r in recs.get("routes", []):
        if r["vehicle_class"] not in VEHICLES:
            errors.append({"section": "routes", "line": r["_line"], "message": f"vehicle_class must be one of {', '.join(VEHICLES)}"})
    if "routes" in parts:
        sc["routes"] = [{"godown_id": r["depot_id"], "town_id": r["town_id"], "road_km": r["road_km"], "transit_days": r["transit_days"],
                         "vehicle_class": r["vehicle_class"], "active": r["active"]} for r in recs["routes"]]
    if "stock" in parts:
        sc["lots"] = [{"lot_id": r["lot_id"] or f"L{r['_line']}-{r['depot_id']}-{r['product_id']}", "godown_id": r["depot_id"],
                       "product_id": r["product_id"], "qty_units": r["qty_units"], "remaining_life_days": r["days_left"]} for r in recs["stock"]]
        uniq("stock", lambda r: r["lot_id"] or r["_line"])
    if "town_stock" in parts:
        sc["town_stock"] = [{"town_id": r["town_id"], "product_id": r["product_id"], "qty_units": r["qty_units"],
                             "remaining_life_days": r["days_left"]} for r in recs["town_stock"]]
    sc.setdefault("town_stock", [])

    # references between sections (reported with line numbers; aria.validate re-checks the scenario)
    ids = {k: {x[f] for x in sc.get(k) or []} for k, f in (("products", "product_id"), ("godowns", "godown_id"), ("towns", "town_id"))}
    refs = {"routes": (("depot_id", "godowns"), ("town_id", "towns")), "stock": (("depot_id", "godowns"), ("product_id", "products")),
            "town_stock": (("town_id", "towns"), ("product_id", "products")), "demand": (("town_id", "towns"), ("product_id", "products")),
            "sales": (("town_id", "towns"), ("product_id", "products"))}
    for name, checks in refs.items():
        bad = 0
        for r in recs.get(name, []):
            for col, target in checks:
                if r[col] not in ids[target]:
                    bad += 1
                    if bad <= 20:
                        errors.append({"section": name, "line": r["_line"], "message": f"{col} '{r[col]}' is not in {'depots' if target == 'godowns' else target}"})
        if bad > 20:
            errors.append({"section": name, "line": None, "message": f"…and {bad - 20} more unknown references"})

    forecast = history = None
    if "demand" in parts:
        demand = []
        for r in recs["demand"]:
            q = _quantiles(r, errors)
            if q is not None:
                sigma = r["sigma"] if r.get("sigma") is not None else r["sd"] if r.get("sd") is not None else (q[6] - q[2]) / 2
                demand.append({"town_id": r["town_id"], "product_id": r["product_id"], "quantiles": q,
                               "point": r["point"] if r.get("point") is not None else q[4], "sigma": sigma})
        sc["demand"] = demand
    if "sales" in parts and not errors:
        import device_forecast

        legacy = "date,item,outlet/town,qty\n" + "".join(f"{r['date']},{r['product_id']},{r['town_id']},{r['qty']}\n" for r in recs["sales"])
        try:
            fc = device_forecast.forecast(legacy, sc, use_ml)
        except (ValueError, KeyError) as e:
            errors.append({"section": "sales", "line": None, "message": str(e)})
        else:
            new = {(d["town_id"], d["product_id"]): d for d in fc.pop("demand")}
            sc["demand"] = [d for d in sc.get("demand") or [] if (d["town_id"], d["product_id"]) not in new] + list(new.values())
            forecast = {**fc, "pairs": len(new), "keys": [f"{t}|{p}" for t, p in new]}
            if fc["counts"]["bad_value"]:
                warnings.append(f"sales: {fc['counts']['bad_value']} row(s) with a bad date or quantity were skipped")
            if not sc.get("day"):
                sc["day"] = fc["forecast_day"]
        by_day: dict[str, float] = {}
        for r in recs["sales"]:
            by_day[r["date"][:10]] = by_day.get(r["date"][:10], 0.0) + max(r["qty"], 0.0)
        days = sorted(by_day)
        history = {"dates": days, "qty": [round(by_day[d], 3) for d in days]}
    for name in ("products", "godowns", "towns", "routes", "lots"):
        if not errors and not sc.get(name):
            errors.append({"section": {"godowns": "depots", "lots": "stock"}.get(name, name), "line": None, "message": "no rows"})
    counts = {name: len(recs[name]) for name in recs}
    return {"ok": not errors, "scenario": sc if not errors else None, "sections": counts, "kept": kept,
            "errors": errors[:60], "error_count": len(errors), "warnings": warnings, "forecast": forecast, "history": history}


def format_spec() -> list[dict]:
    """The format, for the in-app help: section, columns with type and required flag."""
    return [{"section": name, "columns": [{"name": c, "type": t, "required": req, "default": d} for c, t, req, d in cols]}
            for name, cols in SPEC.items()]
