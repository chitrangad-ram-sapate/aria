# `.svcr` — Scenario-Verified Consignment Record

ARIA's file format for moving a dispatch plan between devices with no server: from the planner's phone to the godown's shared device, or to an auditor. Decision D-026.

| | |
|---|---|
| Extension | `.svcr` |
| MIME type | `application/vnd.aria.svcr+json` |
| iOS type identifier | `app.aria.svcr` (conforms to `public.json`, `public.data`) |
| Encoding | UTF-8 text |
| Implementation | `engine/aria/svcr.py` (`dumps`, `loads`, `SvcrError`) |

## Locked files from the app (D-043)

Plan files shared from the app (sent to drivers or shared to other apps) are wrapped so their contents cannot be read outside the team:

```
ARIA-LOCKED/1 team=<orgId>
   header, also used as AES-GCM associated data
<12-byte IV><AES-256-GCM ciphertext of gzip(.svcr file)>
```

The key is the team's 32-byte key at `orgs/{orgId}/secret/key`, readable only by active members of that team (`src/seal.ts`). Inside the lock is the unchanged `SVCR/1` file this document describes, and every check still runs after unlocking.

## Why it exists

1. The plan is made at night by the planner but loaded onto trucks at 6 am by the dispatcher, on a shared device with patchy connectivity.
2. ARIA has no server or accounts, so the plan travels as a file.
3. A CSV pick list loses everything that makes a plan trustworthy: which inputs produced it, whether it passed the verifier, and whether anyone changed a quantity on the way.
4. `.svcr` carries the plan **and the exact scenario it was solved on**, so the receiver can check it, offline, without trusting the sender.

## Layout

```
SVCR/1 sha256=<64 hex chars: SHA-256 of the body bytes>
{"created_at":"…","format":"svcr","network_id":"…","plan":{…},"scenario":{…},"scenario_hash":"…","version":1}
```

- **Line 1** is the header: the magic `SVCR/1` and the body digest.
- **The body** is canonical JSON: sorted keys, no whitespace, non-ASCII kept as UTF-8. `scenario` and `plan` follow the shared data contract (`engine/aria/schemas.py`). Money is in integer paise and quantities are in integer units.

## Opening a file: every check must pass before a single row is shown

| # | Check | Catches |
|---|---|---|
| 1 | Header is `SVCR/1 sha256=…` | Wrong file type |
| 2 | SHA-256 of the body equals the header digest | Corruption, truncation, hand edits |
| 3 | Body parses into a Scenario and a Plan | A re-hashed body that is not a valid record |
| 4 | `scenario_hash(scenario)` equals the stored `scenario_hash` | A plan detached from, or swapped onto, different inputs |
| 5 | Independent verifier V1–V8 passes on (scenario, plan) | Infeasible or edited plans: over-shipped lots, short shelf life on arrival, broken capacity or value order |

Any failure raises `SvcrError` with the reason. The app then shows a red **REJECTED — do not dispatch** banner. Only a fully checked file shows the **VERIFIED** badge and the pick list per godown.

Only plans that passed the verifier can be exported. `dumps` refuses anything else.

## Limits

The digest proves **integrity, not authorship**: anyone can recompute it. Check 5 is the real guarantee, because an edited file is only accepted if the edit is itself a feasible plan for the embedded inputs. Sender signatures (Ed25519) can be added if user accounts are ever introduced; accounts are out of scope today (PRD §5.4).

## OS registration

- **Android:** `intent-filter`s for `VIEW` / `SEND` on `*.svcr` and the MIME type above.
- **iOS:** `UTExportedTypeDeclarations` + `CFBundleDocumentTypes` in `Info.plist`.

Tapping a `.svcr` file opens ARIA, which runs the checks above.
