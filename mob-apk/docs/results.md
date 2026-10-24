# Replay results

Fair replay (PRD FR-P0-09), measured on 2026-10-24.

Every policy starts from the same stock, receives the same inflow and faces the same realised demand. Each is charged one bill: **freight + holding + write-off + lost margin**. The pass rules were fixed in PRD §9 before any replay ran, and none was changed afterwards.

**Setup:**
- Network `kolhapur`: 3 godowns × 6 towns, 100 products.
- 2 held-out 28-day windows: 2016-03-28 → 04-24 and 04-25 → 05-22.
- 95% CIs from a moving-block bootstrap (7-day blocks, 1,000 resamples) on daily paired differences.
- Integrity checks: conservation held for every policy, window and freight point; no leakage; 0 verifier failures.

## KPI table, `kolhapur`

| KPI | Pass rule | Own vehicle class (headline) | All ₹3.78/t-km | All ₹11.03/t-km (6-ton) | All ₹1.51/t-km (reported only) |
|---|---|---|---|---|---|
| KPI-1: ARIA − b″ total bill | upper CI < 0 | −₹16.99 lakh, CI [−39.7, −0.04] lakh: **PASS** | **PASS** | upper bound +₹11.6k: **FAIL** | PASS |
| KPI-1b: ARIA − b′ | upper CI < 0 | −₹20.5 lakh: **PASS** | PASS | PASS | PASS |
| KPI-1c: ARIA − (a) rule-based | upper CI < 0 | −₹88.5 lakh: **PASS** | PASS | PASS | PASS |
| KPI-3: (freight + holding + write-off) per unit sold, vs (a) | upper CI ≤ 0 | −₹9.07/unit: **PASS** | PASS | PASS | PASS |
| KPI-4: write-off units vs (a) | upper CI ≤ 0 | −39,424 units: **PASS** | PASS | PASS | PASS |
| KPI-10: KPI-1 holds at ₹3.78 and ₹11.03 | both pass | — | — | — | **FAIL** |

**Total bill at the headline point (₹ lakh):** (a) 284.6 · b′ 216.6 · b″ 213.1 · **ARIA 196.1** · hindsight 223.6.

**Fill rate:** (a) 0.935 · ARIA 0.960 · hindsight 0.978.

## Against the problem statement's three goals (ARIA vs rule-based baseline (a))

| Goal | Result |
|---|---|
| Fewer stockouts | Fill rate 0.960 vs 0.935 |
| Lower total transport + holding + waste per unit sold | −₹9.07 per unit sold (CI entirely below 0) |
| Less wastage | 39,424 fewer write-off units (CI entirely below 0) |

## Reading the results honestly

- **Write-off dominates:** it is about 98% of every bill. It comes from synthetic 5–10-day shelf-life classes, which also makes the CIs wide.
- **KPI-10 fails:** when every leg is priced at 6-ton rates, the advantage over one global service level is no longer significant. This is reported as measured; the planned follow-up is the P1-05 ablations.
- **Hindsight (c) is a reference, not a bound.** It plans day by day on realised demand, so "% of gap closed" can exceed 100%.
- **`maharashtra` (40 products) is reported, not gated.** KPI-1 fails at own / ₹3.78 / ₹11.03 and passes at ₹1.51. KPI-1c, KPI-3 and KPI-4 pass at every point.

The raw results are in [`../engine/data/built/`](../engine/data/built/).
