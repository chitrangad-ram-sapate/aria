""".svcr — Scenario-Verified Consignment Record (decision D-026).

One file carries a dispatch plan *and the exact inputs it was solved on*, so whoever opens it
(the godown dispatcher, another phone, an auditor) can re-check it offline with the independent
verifier instead of trusting the sender. No server, accounts or network are needed.

Layout (UTF-8 text, inspectable in any editor):
    line 1: SVCR/1 sha256=<hex digest of the body bytes>
    body:   canonical JSON {format, version, created_at, network_id, scenario_hash, scenario, plan}

Opening a file fails loudly unless all three hold:
  1. the digest matches the body          → nothing was corrupted or hand-edited in transit;
  2. scenario_hash(scenario) matches      → the plan is bound to these exact inputs (PRD §4);
  3. verify(scenario, plan) passes V1–V8  → the plan is feasible for those inputs (App. B).
The digest gives integrity, not authorship: anyone can recompute it. Check 3 is what makes an
edited-but-rehashed file unusable unless the edit is itself a feasible plan.
# ponytail: no signatures (no user accounts in scope, PRD §5.4); add Ed25519 signing if senders must be authenticated.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from aria.hashing import scenario_hash
from aria.schemas import Plan, Scenario
from aria.verify.verifier import verify

MAGIC = "SVCR/1"
EXTENSION = ".svcr"
MIME_TYPE = "application/vnd.aria.svcr+json"


class SvcrError(ValueError):
    """Raised when a .svcr file is malformed, altered, or holds an unverifiable plan."""


def dumps(sc: Scenario, plan: Plan, created_at: str | None = None) -> bytes:
    if not plan.verifier.passed:
        raise SvcrError("only plans that passed the verifier can be exported")
    payload = {
        "format": "svcr",
        "version": 1,
        "created_at": created_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "network_id": sc.network_id,
        "scenario_hash": scenario_hash(sc),
        "scenario": sc.model_dump(mode="json"),
        "plan": plan.model_dump(mode="json"),
    }
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return f"{MAGIC} sha256={hashlib.sha256(body).hexdigest()}\n".encode() + body


def loads(data: bytes) -> tuple[Scenario, Plan, dict]:
    header, _, body = data.partition(b"\n")
    parts = header.decode(errors="replace").split()
    if len(parts) != 2 or parts[0] != MAGIC or not parts[1].startswith("sha256="):
        raise SvcrError(f"not a {MAGIC} file")
    if hashlib.sha256(body).hexdigest() != parts[1][len("sha256="):]:
        raise SvcrError("digest mismatch: file was altered or corrupted")
    payload = json.loads(body)
    sc, plan = Scenario(**payload["scenario"]), Plan(**payload["plan"])
    if scenario_hash(sc) != payload["scenario_hash"]:
        raise SvcrError("scenario_hash mismatch: plan is not bound to these inputs")
    result = verify(sc, plan)
    if not result.passed:
        codes = ", ".join(sorted({v.code for v in result.violations}))
        raise SvcrError(f"plan fails the verifier ({codes}); do not dispatch")
    return sc, plan, payload
