# GRBC – Galactic Racer Build Companion

Data layer for an interactive build planner for *Star Wars: Galactic Racer*.
All game data is scraped from the public database at
<https://galacticracer.gameslantern.com/> (Games Lantern) and stored in SQLite.

## Layout

| Path | What |
|---|---|
| `scraper/fetch.mjs` | Crawls index + detail pages into `cache/html/<section>/<slug>.html` (incremental; `--force` refetches). |
| `scraper/build-db.mjs` | Parses the cache into `data/galactic_racer.db` and `data/galactic_racer.json`. |
| `scraper/q.mjs` | Tiny CLI: `node scraper/q.mjs "SELECT ..."` prints a table. |
| `data/galactic_racer.db` | The SQLite database (Node ≥ 22.13 `node:sqlite`, no native deps). |
| `data/galactic_racer.json` | Same data as one JSON document, for a browser-side planner. |

```bash
npm install
npm run data        # fetch (≈520 pages, cached) + build-db
```

## Row counts (2026-10-14 snapshot)

| Table | Rows | Notes |
|---|---|---|
| `parts` | 318 | 40 Common, 91 Rare, 70 Epic, 57 Legendary, 1 Experimental, 59 Faulty. 4 rows are site duplicates linked via `variant_of`. 254 distinct installable non-fault parts. |
| `part_keywords` | 558 | Glossary terms linked from each part's effect text (Afterburner 75, Ramjet 47, Cooled 43, Surging 35, Redlining 30, Takedown 28 …). |
| `keywords` | 55 | Glossary: status effects (Cooled, Frozen, Burning, Surging…), mechanics (Redlining, Takedown, Perfect Landing…), abilities. |
| `keyword_refs` | 736 | Site-side "Parts/Abilities/Traits/Styles that use X" lists per glossary term. |
| `abilities` | 45 | 9 base families with tiered upgrades; `ability_upgrades` is the 36-edge upgrade graph. |
| `traits` | 68 | Passive traits granted by racer styles; `trait_keywords` links them to glossary terms. |
| `racer_styles` | 20 | 14 generic styles (campaign ranks 1–3 + multiplayer) and 6 podracer "character" styles (multiplayer only). |
| `racer_style_traits` | 180 | Traits per style × context (`campaign` rank 1–3 cumulative, or `multiplayer`). |
| `racer_style_abilities` | 16 | Starting ability per style in multiplayer (e.g. Redliner → Surge, Ramjet Rider → Vent). |
| `vehicles` | 50 | 12 each of Speeder Bike / Landspeeder / Skim Speeder, 14 Podracers. |
| `vehicle_classes` | 4 | Advanced stat, kit count, part-slot count (6 for speeders, 10 for podracers) and slot names. |
| `vehicle_class_traits` | 9 | Three class traits each for the three speeder classes (podracers have none; their traits are "Plane Trait" parts). |
| `upgrades` | 66 | Six upgrade tracks × levels 0–10 (Ramjet, Afterburner, Cornering, Advanced stat, Resilience, Battery). |
| `racers` | 20 | Rival racers, their vehicle and style. |

Views: `v_part_keywords` (parts with comma-joined keywords), `v_style_traits`.

## Part model

Each part row carries:

* `rarity` – Common / Rare / Epic / Legendary / Experimental / Faulty; shop price follows rarity (2000 / 2500 / 3000 / 4000; faults cost 250 to clear).
* `tier` (1–4) and `family` – "Ramjet Power I…IV" share family `Ramjet Power`; higher tier is a strict upgrade of the same effect.
* `category` – the site's single tag per part (Afterburner, Ramjet, Cooled, Takedown, Conditions, Plane Trait, Energy, …). "Plane Trait" parts are podracer-only vehicle traits with no price.
* `description` – effect text; `part_keywords` are the glossary terms it references, in order of appearance. For "While X, gain Y" parts the first keyword is usually the **condition** and later ones the **payoff**.
* `unlock` – "Start the Campaign." (91) or "Complete N events." (shop pool grows with campaign progress).

## Data caveats

* Campaign rank trait lists are stored exactly as the site shows them (cumulative per rank).
* `keyword_refs.context` keeps the heading of the list the link appeared in; the same part may be referenced under several keywords.
* The glossary has two Afterburner entries (`afterburner` = stat, `afterburner-2` = boost mechanic) and two Ramjet entries; parts link to `afterburner-2` / `ramjet`.
* One trait (`energy-leech-2`) has unresolved `{int…}` template placeholders on the source site.
* Experimental part `Plug-F Power Cell` has no price or category on the site.

## Semantic layer

`scraper/part_semantics.json` (per part family) and `scraper/style_semantics.json` (per racer style) are hand-curated and loaded into `part_semantics` / `style_semantics`. They use one shared vocabulary so sources (style grants, abilities, "gain X" parts) can be matched with consumers ("While X" parts). See [DESIGN.md](DESIGN.md) for the planner model built on them.

## Planner app

```bash
npm test           # engine unit tests (node:test)
npm run serve      # http://localhost:5173 (static, no build step)
npm run bundle     # dist/grbc.html – single self-contained file, open anywhere
npm run app-data   # regenerate app/data.json from the DB after re-scraping
```

Runs are saved in the browser (localStorage) as event histories with undo. `app/planner.js` holds the scoring math, `app/engine.js` the run state and recommendation objects, `app/app.js` the UI. See [DESIGN.md](DESIGN.md) for the scoring model and the round economy.

## Deploying

The app is static: `app/` is the whole site (HTML, CSS, JS, `data.json`, mirrored icons in `app/assets/`). Runs are stored in the visitor's browser; use **Garage → Run → Export runs** to move them between devices.

**GitHub Pages** (configured in `.github/workflows/pages.yml`): every push to `main` publishes the `app/` folder. One-time setup in the repository: *Settings → Pages → Build and deployment → Source: GitHub Actions*. The site then lives at `https://<owner>.github.io/<repo>/`.

**Anywhere else**: upload the `app/` folder to any static host (Cloudflare Pages, Netlify, Vercel), or hand out `dist/grbc.html`, a single self-contained file that hotlinks icons from the fan database.

Refresh data from the source site with `npm run data` (scrape → SQLite → `app/data.json` → icons), then commit and push.

## Credits

Fan-made tool, not affiliated with the game or its publishers. Part, style, ability, favour and vehicle data and the icons in `app/assets/` come from [galacticracer.gameslantern.com](https://galacticracer.gameslantern.com/) (Games Lantern). Star Wars and Galactic Racer are trademarks of their respective owners.
