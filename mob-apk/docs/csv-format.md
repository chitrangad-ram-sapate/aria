# ARIA data CSV

One file holds a whole dataset. It has several tables. Each table starts with a row whose first cell is `# <table>`, then a header row, then data rows. Blank lines are ignored.

A file with a single table needs no `#` row: its header tells which table it is. Tables missing from an upload are kept from the dataset already loaded, and the app reports which ones.

The parser is `engine/dataset_csv.py`. In the app, **Home → CSV format** shows this list, and **Get a template** downloads a filled example.

| Table | Columns (**required**) | Notes |
|---|---|---|
| `settings` | **key**, **value** | Optional. Keys: `name`, `day`, `margin`, `salvage_share`, `repo_rate`, `freight_rs_per_tkm_55t`, `freight_rs_per_tkm_road_avg`, `freight_rs_per_tkm_6t`. Missing keys use the engine defaults. |
| `products` | **product_id**, category, **kg_per_unit**, **shelf_life_days**, min_days_at_receipt, **price_rs** | Price in rupees. `min_days_at_receipt` defaults to 0. |
| `depots` | **depot_id**, name, lat, lon, capacity_units | `capacity_units` is the most units the depot can load in one night. Empty means no limit. |
| `towns` | **town_id**, name, population, priority, lat, lon | `priority` defaults to 1. |
| `routes` | **depot_id**, **town_id**, **road_km**, **transit_days**, vehicle_class, active | `vehicle_class` is `55t`, `road_avg` (default) or `6t`. `active` is true/false (default true). |
| `stock` | lot_id, **depot_id**, **product_id**, **qty_units**, **days_left** | `days_left` is the shelf life remaining. `lot_id` is generated when empty. |
| `town_stock` | **town_id**, **product_id**, **qty_units**, **days_left** | Optional. Stock already in towns. |
| `demand` | **town_id**, **product_id**, then `q0.005 … q0.995` (all 9), or `mean` and `sd`; optional `point`, `sigma` | Quantiles must not decrease. `mean`/`sd` become a normal distribution clipped at 0. |
| `sales` | **date**, **product_id**, **town_id**, **qty** | Use this instead of `demand`. Dates are `YYYY-MM-DD`. The next day is forecast on the phone: gradient-boosted quantiles with conformal calibration when there are 84+ days of history, otherwise empirical quantiles of the last 28 days (labelled). |

The first file must contain products, depots, towns, routes, stock, and demand or sales. Column names are case-insensitive. `godown_id`, `item`, `outlet/town` and `remaining_life_days` are accepted as aliases.

Every problem is reported with its table and line, for example `stock, line 30: qty_units must be a whole number, got 'fifty'`. A file with any problem is not loaded. Model rules are then checked by the engine's validator, for example days left greater than the product's shelf life.

## Sample

```csv
# settings
key,value
name,Two depot example
margin,0.05

# products
product_id,category,kg_per_unit,shelf_life_days,min_days_at_receipt,price_rs
MILK,dairy,1,5,1,60
RICE,staples,5,180,0,300

# depots
depot_id,name,capacity_units
D1,North depot,
D2,South depot,400

# towns
town_id,name,population
T1,Alpha,12000
T2,Beta,48000

# routes
depot_id,town_id,road_km,transit_days,vehicle_class
D1,T1,20,1,road_avg
D1,T2,60,1,6t
D2,T2,15,0,road_avg

# stock
depot_id,product_id,qty_units,days_left
D1,MILK,50,4
D1,RICE,80,120
D2,MILK,30,3

# demand
town_id,product_id,mean,sd
T1,MILK,12,4
T2,MILK,20,6
T2,RICE,10,2
```

Instead of `# demand`, past sales can be given:

```csv
# sales
date,product_id,town_id,qty
2026-01-01,MILK,T1,11
2026-01-02,MILK,T1,14
```

## Tests

`cd engine && ARIA_SOLVER=scipy python -m pytest app_tests -q`. They cover:
- the exact round trip of every sample;
- line-numbered errors;
- partial updates;
- the sales forecast;
- scenario comparison;
- truck options.

`npm run build && npm run smoke` drives the whole app in headless Chrome.
