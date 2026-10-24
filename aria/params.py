"""Parameter registry (PRD Appendix D, rule R-9): loads data/params.yaml."""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import yaml

from aria.schemas import Policy

PARAMS_PATH = Path(__file__).resolve().parents[1] / "data" / "params.yaml"
FX_URL = "https://api.frankfurter.app/latest?from=USD&to=INR"


def load_params(path: str | Path = PARAMS_PATH) -> dict:
    """Raw registry: {key: {value, status, source, ...}}."""
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)["parameters"]


def value(key: str, path: str | Path = PARAMS_PATH):
    return load_params(path)[key]["value"]


def registry(path: str | Path = PARAMS_PATH) -> list[dict]:
    """Flat list for explain cards: [{key, value, status, source}, ...]."""
    return [{"key": k, **v} for k, v in load_params(path).items()]


def default_policy(path: str | Path = PARAMS_PATH) -> Policy:
    p = load_params(path)
    return Policy(margin=p["margin"]["value"], salvage_share=p["salvage_share"]["value"],
                  repo_rate=p["repo_rate"]["value"], freight_paise_per_tkm=p["freight_paise_per_tkm"]["value"])


def ensure_fx(offline: bool = False, path: str | Path = PARAMS_PATH) -> float:
    """USD→INR rate (D-013). Fetched once with scrapling and cached in params.yaml."""
    fx = load_params(path)["usd_inr_fx"]
    if fx.get("value"):
        return float(fx["value"])
    if offline:
        raise RuntimeError("usd_inr_fx missing from params.yaml and --offline set")
    from scrapling.fetchers import Fetcher

    data = Fetcher.get(FX_URL, timeout=30).json()
    rate = float(data["rates"]["INR"])
    block = (f"  usd_inr_fx:\n    value: {rate}\n    status: Fetched\n"
             f"    source: \"Frankfurter API (ECB reference rate) {FX_URL}, rate date {data['date']}\"\n"
             f"    fetched: \"{dt.date.today().isoformat()}\"\n")
    lines = Path(path).read_text(encoding="utf-8").splitlines(keepends=True)
    start = lines.index("  usd_inr_fx:\n")
    end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith("  ") and not lines[i].startswith("    "))
    Path(path).write_text("".join(lines[:start]) + block + "".join(lines[end:]), encoding="utf-8")
    return rate
