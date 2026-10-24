"""Network YAML → godowns, towns, routes (FR-P0-01, decisions D-014, D-020).

A network file lists godowns and towns with coordinates. Route road_km comes from the
public OSRM table API (OpenStreetMap data, R19), fetched once and written back into the
YAML with its source and date. Offline fallback: haversine × 1.25, labelled approximate.
Nothing here names a city: every place lives in the YAML.
"""
from __future__ import annotations

import datetime as dt
import math
from pathlib import Path

import yaml

from aria.schemas import Godown, Route, Town

NETWORKS_DIR = Path(__file__).resolve().parents[2] / "data" / "networks"
OSRM_URL = "https://router.project-osrm.org/table/v1/driving/{coords}?sources={src}&destinations={dst}&annotations=distance"
DETOUR_FACTOR = 1.25
SIX_TON_MAX_KM = 100  # D-014: intra-district legs (≤ 100 km) use ≤ 6-ton vehicles (A6)
KM_PER_TRANSIT_DAY = 400  # D-014


def network_path(name_or_path: str | Path) -> Path:
    p = Path(name_or_path)
    return p if p.suffix in (".yaml", ".yml") else NETWORKS_DIR / f"{name_or_path}.yaml"


def load_network(name_or_path: str | Path) -> dict:
    with open(network_path(name_or_path), encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def save_network(net: dict, name_or_path: str | Path) -> None:
    with open(network_path(name_or_path), "w", encoding="utf-8") as fh:
        yaml.safe_dump(net, fh, sort_keys=False, allow_unicode=True, width=200)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def vehicle_class(road_km: float) -> str:
    return "6t" if road_km <= SIX_TON_MAX_KM else "road_avg"


def transit_days(road_km: float) -> int:
    return max(1, math.ceil(road_km / KM_PER_TRANSIT_DAY))


def fetch_osrm_km(godowns: list[dict], towns: list[dict]) -> list[list[float]]:
    """One OSRM table call: km[i][j] from godown i to town j (scrapling Fetcher)."""
    from scrapling.fetchers import Fetcher

    pts = godowns + towns
    coords = ";".join(f"{p['lon']:.5f},{p['lat']:.5f}" for p in pts)
    src = ";".join(str(i) for i in range(len(godowns)))
    dst = ";".join(str(len(godowns) + j) for j in range(len(towns)))
    resp = Fetcher.get(OSRM_URL.format(coords=coords, src=src, dst=dst), timeout=60)
    data = resp.json()
    if data.get("code") != "Ok":
        raise RuntimeError(f"OSRM error: {data.get('code')} {data.get('message', '')}")
    return [[d / 1000.0 for d in row] for row in data["distances"]]


def ensure_road_km(name_or_path: str | Path, offline: bool = False) -> dict:
    """Fill routes[] once (OSRM, or haversine fallback) and write them back to the YAML.

    Routes already present are kept as is (cached). With offline=True nothing is fetched.
    Each written route carries road_km, transit_days and vehicle_class (D-014 rules) and, for
    towns marked with `via` (e.g. a mountain pass), the same `via` marker.
    """
    net = load_network(name_or_path)
    if net.get("routes"):
        return net
    gs, ts = net["godowns"], net["towns"]
    today = dt.date.today().isoformat()
    km, source = None, None
    if not offline:
        try:
            km = fetch_osrm_km(gs, ts)
            source = f"OSRM table API (router.project-osrm.org, OpenStreetMap data R19), fetched {today}"
        except Exception as exc:  # network down → labelled approximation
            print(f"OSRM fetch failed ({exc}); using haversine x {DETOUR_FACTOR} (approximate)")
    if km is None:
        km = [[haversine_km(g["lat"], g["lon"], t["lat"], t["lon"]) * DETOUR_FACTOR for t in ts] for g in gs]
        source = f"approximate: haversine x {DETOUR_FACTOR} detour factor, computed {today}"
    max_km = net.get("max_route_km")
    routes = []
    for i, g in enumerate(gs):
        for j, t in enumerate(ts):
            d = round(km[i][j], 1)
            if max_km is not None and d > max_km:
                continue
            r = {"godown_id": g["godown_id"], "town_id": t["town_id"], "road_km": d,
                 "transit_days": transit_days(d), "vehicle_class": vehicle_class(d)}
            if t.get("via"):  # a town-level `via` is a one-time hint: it moves onto every route to that town
                r["via"] = t["via"]
            routes.append(r)
    for t in ts:
        t.pop("via", None)
    net["road_km_source"] = source
    net["routes"] = routes
    save_network(net, name_or_path)
    return net


def build_network(net: dict) -> tuple[list[Godown], list[Town], list[Route]]:
    """YAML dict → schema objects. vehicle_class/transit_days follow D-014 unless set in the YAML."""
    godowns = [Godown(godown_id=g["godown_id"], name=g.get("name", ""), lat=g.get("lat"), lon=g.get("lon"),
                      dispatch_capacity_units=g.get("dispatch_capacity_units")) for g in net["godowns"]]
    towns = [Town(town_id=t["town_id"], name=t.get("name", ""), population_2011=t["population_2011"],
                  priority=t.get("priority", 1.0), lat=t.get("lat"), lon=t.get("lon")) for t in net["towns"]]
    routes = [Route(godown_id=r["godown_id"], town_id=r["town_id"], road_km=r["road_km"],
                    transit_days=r.get("transit_days", transit_days(r["road_km"])),
                    vehicle_class=r.get("vehicle_class", vehicle_class(r["road_km"])),
                    active=r.get("active", True)) for r in net["routes"]]
    return godowns, towns, routes


def route_via(net: dict) -> dict[tuple[str, str], str]:
    """(godown_id, town_id) → named pass/highway, e.g. for targeting the demo route shock."""
    return {(r["godown_id"], r["town_id"]): r["via"] for r in net["routes"] if r.get("via")}
