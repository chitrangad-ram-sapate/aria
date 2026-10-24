# Data sources

Everything the app bundles in `engine/data/` so it can plan offline. Every parameter, with its value, status and source, is in [`../engine/data/params.yaml`](../engine/data/params.yaml), the parameter registry from PRD Appendix D.

| Path in `engine/data/` | What | Source | Licence |
|---|---|---|---|
| `scenarios/*.json` | Ready-to-plan scenarios (`kolhapur_normal_week`, `kolhapur_monsoon_squeeze`, `kolhapur_edge_cases`, `maharashtra_normal_week`) | Demand shapes from M5 FOODS_3, top 100 items, rescaled by population; synthetic lots | M5: CC BY 4.0 |
| `networks/kolhapur.yaml` | PRD network: 3 godowns × 6 towns, 18 routes; Ratnagiri legs marked `via: Amba Ghat NH-166` | Road km from the OSRM table API (OpenStreetMap), fetched 2026-10-24 | OSM: ODbL |
| `networks/maharashtra.yaml` | Wider network: 5 depots × 15 cities, 52 routes ≤ 450 km | Same | OSM: ODbL |
| `networks/world_*.yaml` | 50 generated networks in 50 countries, used by the real-world simulation and to show the engine is not region-specific | GeoNames `cities15000`; road km = haversine × 1.25, labelled approximate | GeoNames: CC BY 4.0 |
| `built/replay_*.json` | Fair-replay results behind the Proof screen ([results](results.md)) | Replay over 2 held-out 28-day windows | — |

## Key figures

- **Freight:** ₹1.51 (55-ton) / ₹3.78 (road average) / ₹11.03 (6-ton) per tonne-km. Source: NCAER for DPIIT, *Logistics Cost in India 2023-24*.
- **Distributor margin:** 3.5% base, 5% sensitivity. Source: Kirana Club.
- **Holding:** unit cost × 5.50% repo rate / 365, a lower bound. Source: RBI MPC, 7 Oct 2026.
- **USD→INR:** 94.94, the ECB reference rate dated 2026-10-23 (Frankfurter API). Used to convert M5 prices to rupees.
- **Town populations:** Census of India 2011. These should be cross-checked by hand; citypopulation.de blocks scripted access.
- **Shelf life and minimum days at receipt:** synthetic, within USDA FoodKeeper ranges (assumptions A4, A8).
- **Weight per unit:** typical Indian pack sizes per category, labelled Synthetic.

All assumptions (A1–A9) are listed in the PRD ([`cyberpunk.pdf`](cyberpunk.pdf), §10.2) and the [implementation plan](implementation.md). The app shows them on its Assumptions screen.

Results are evidence for the method, measured on benchmark demand. They are not claims of real-world savings.
