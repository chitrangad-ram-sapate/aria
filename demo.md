# ARIA judge demo script

Target length: 6–7 minutes. Network: `kolhapur`. Every number on screen comes from the API; nothing below is a pre-recorded result except where marked illustrative.

## Before the judges arrive (T − 10 min)

1. Wi-Fi **off**.
2. Start the app: `powershell -ExecutionPolicy Bypass -File scripts\run.ps1` (or `docker compose up`).
3. Open <http://127.0.0.1:8501>. Sidebar shows **API online** and the HiGHS version.
4. Check <http://127.0.0.1:8000/api/health> returns `status: ok` and data hashes.
5. Sidebar: network `kolhapur`, scenario `normal_week`. Press **Plan tonight** once to warm up.
6. Proof view: confirm a replay result loads for `kolhapur` (conservation ok).
7. Fallback screen recording open in a second window, paused at 0:00.

## J1 — Build tonight's plan (≈ 90 s)

1. **Plan & Compare** view. Say: "One super-stockist, 3 godowns, 6 towns. Tonight's stock is in this table."
2. Edit one lot's quantity in **Godown stock**. Point at the tags: results are marked **STALE** and the pick-list export is disabled the moment an input changes.
3. Type a negative quantity in another lot. The validation panel lists the error code and JSON path (`E_RANGE $.lots[i].qty_units`). Press **Plan tonight**: the API returns 422 with all errors and no plan. Undo the edit.
4. Press **Plan tonight**. Point at:
   - `solve … ms` (target ≤ 10 s end to end) and the `scenario_hash` / `request_id` tags.
   - The plan labels: stage 1 / stage 2 status and **verified**.
   - **KPIs vs baseline (a)**, side by side.
5. **Lot table** tab: godown → town → product → lot → units, freight ₹, life on arrival, τ\*.
6. **Pick lists** tab: download the CSV for one godown.

## J2 — Investigate a row (≈ 60 s)

1. **Shortfalls** tab: every row has exactly one reason code (`NO_STOCK_ANYWHERE`, `NO_ELIGIBLE_STOCK`, `STOCK_BLOCKED`, `SUPPLY_USED`) with its facts.
2. **Explain** tab: pick the Ratnagiri row for a product. Show τ\* for the route, freight per unit, the demand segments filled, lots with life on arrival, the indicative shadow price and the parameter sources.
3. Say: "Every fact on this card equals the plan or the scenario; the verifier is separate code from the solver."

## J3 — Check the proof (≈ 90 s)

1. **Proof** view. Total ₹ bill per policy: ARIA, baselines (a), b′, b″, and hindsight (c) as reference.
2. KPI-1 card: ARIA − b″ with its 95% CI. Read the rule aloud: "pre-registered: the upper CI must be below zero". Read whatever the screen says, pass or not.
3. Switch the freight point: route class → ₹3.78 → ₹11.03 → ₹1.51 per t-km.
4. Open **Is the headline real?**: the same replay scored by lost units only versus the full-cost bill.

## J4 — Apply a disruption, live (≈ 2 min)

1. **Disruption Lab**. The shock defaults to `ROUTE_RESTRICTION` on the long Ratnagiri leg over Amba Ghat, max vehicle 6t.
2. Say: "Amba Ghat is restricted to 6-ton trucks. Freight on this leg goes from the road average ₹3.78 to ₹11.03 per tonne-km."
3. Press **Apply shock and re-plan**. Point at the re-plan time (≤ 10 s).
4. **Before vs after** table, then the two diff panels: changed rows, Δ freight, Δ lost margin, new reason codes.
5. **τ\* before and after** chart for the Ratnagiri leg. For the PRD's illustrative product (1 kg, ₹100, 3.5% margin) τ\* moves from **0.856 to 0.588** (illustrative, PRD §6.1). The on-screen values are computed live for the scenario's products. Say: "Units between the two markers stop shipping to Ratnagiri: freight now exceeds what they protect."
6. If time allows: `ROUTE_CLOSURE` on the same leg (rows on that lane disappear), then `INVENTORY_LOSS` at 0% (empty diff).

## Fallback steps

| Problem | Do this |
|---|---|
| UI shows **API offline** | Restart: close both windows, rerun `scripts\run.ps1`. Health check at `/api/health`. |
| Plan takes > 10 s or errors | Show the error banner as-is (the failure path is part of the design), then switch to the `normal_week` scenario and re-plan. |
| ARIA plan withheld | Point at the label: ARIA failed the verifier or had no solution, so baseline (a) is shown, labelled. This is the designed behaviour. |
| Proof view says no replay results | Run `make replay` beforehand; during the demo, skip to J4 and come back. |
| Results tagged **STALE** unexpectedly | An input changed or the API dropped a request. Press **Plan tonight** again. |
| Laptop or Docker fails | Play the screen recording made at the H17 rehearsal. |
| Judges ask for another region | Switch the sidebar network to `maharashtra` and plan; the same engine runs on any network. |
