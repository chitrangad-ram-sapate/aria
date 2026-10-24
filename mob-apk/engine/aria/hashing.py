"""scenario_hash = SHA-256 of canonical scenario JSON (PRD §4 result integrity)."""
import hashlib
import json

from aria.schemas import Scenario


def scenario_hash(sc: Scenario) -> str:
    canon = json.dumps(sc.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()
