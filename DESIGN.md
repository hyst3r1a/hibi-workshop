# GRBC planner – suggestion model (v1, 2026-10-14)

Implemented in `app/planner.js`; UI in `app/app.js`. Numbers below are the
defaults; all are editable per run under **Prices & rules**.

## 1. Session state (one saved run per mode)

| Field | Notes |
|---|---|
| `mode` | `campaign` or `multiplayer`. Separate runs; different income, trait sets, and starting ability. |
| `style`, `rank` | Racer style; rank 1–3 selects the campaign trait set. In multiplayer the style's starting ability is owned for free. |
| `vehicle` | → class → base slot count (6 speeders / 10 podracers) and "Plane Trait" eligibility (podracers only). |
| `credits`, `events` | Money; campaign events completed, which gates the shop pool via `unlock_events`. |
| `favours`, `extraSlots` | Gadgeteer rank (+1/+2 slots; rank 3 also +2 shop offers), Bloody Bounty rank 3 (+2 shop offers), manual extra slots. |
| `upgrades` | Level 0–10 per track. |
| `parts` | Installed parts, each flagged `free` (pack, mystery encounter) or bought. |
| `abilities` | Owned ability slugs. Buying an upgrade replaces the ability it upgrades from. |
| `offer` | What the shop currently shows (up to offer size). |
| `counters` | Per round: parts, rerolls, upgrades, abilities bought. **Reset round** zeroes them (new shop visit). |
| `settings` | Prices and rules, see §6. |

## 2. Keyword graph

Shared vocabulary: statuses (Cooled, Frozen, Burning, Surging, Shielded, Overcharged, Corroded, Concussed, Choked, Disrupted, SysMalf, CritMalf) and mechanics (Ramjet, Afterburner, Redlining, Takedown, PerfectLanding, PerfectStart, Airborne, Slipstreaming, Crash, LastCrash, Ability, Energy, Speed, Collision, FirstPlace, RaceStart).

* `part_semantics` per family: `needs`, `grants`, `boosts`, `protects` (hand-curated, `scraper/part_semantics.json`).
* `style_semantics` per style: `core`, `grants`, `mechanics` (`scraper/style_semantics.json`).
* Ability `grants` are parsed from "Gain X" in the ability text (Vent → Cooled, Surge → Surging, Supercooled Vent → Cooled + Frozen …).
* **Sources** in a build = style grants ∪ owned abilities' grants ∪ installed parts' grants. The UI lists them with their origin.

## 3. Part score

```
score     = styleFit × enablement × payoff × rarityValue
marginal  = score                       (free slot)
          = score − score(owned lower tier of same family)   (tier upgrade, "replace X")
          = score − score(weakest installed)                 (slots full, "swap out X")
          = 0                                                 (same/higher tier already owned)
```

* **styleFit**: 1.0 if any keyword the part needs/boosts/grants is in the style's `core`; 0.6 if in `mechanics`; 0.8 if it protects against a status the style inflicts on itself (Firebug/Burning, Ice Cold/Frozen); else 0.3.
* **enablement**: product over `needs` of availability: 1.0 when a source exists or the style pushes the mechanic, otherwise a baseline (Ramjet/Afterburner 0.9, Airborne 0.5, Takedown 0.3, Cooled with no source 0.15 …). Parts with unmet needs are shown with "needs X (no source)".
* **payoff**: 1 + 0.25 per installed part that consumes what this part grants; +0.3 if the granted status is a style core; +0.4 if it would be the first source for an installed consumer.
* **rarityValue**: Common 0.55, Rare 0.7, Epic 0.85, Legendary 1.0. Plane Trait parts count 1.0.
* Faults, duplicate site listings (`variant_of`), locked parts, and podracer-only parts on speeders are ineligible.

## 4. Upgrade score

`weight(stat) × (1 − level/12) × 0.9`. Weights from the style: Ramjet-family cores (Ramjet, Redlining, Cooled, Frozen, Burning) → Turbojet Manifold 1.0; Afterburner → Fuel Injector 1.0; Takedown/Collision/Crash/Shielded → Structural Bracing 0.9; Ability/Energy → Power Cell 0.9; Slipstreaming/Surging/Cornering/Speed → Repulsor Grip 0.7; PerfectLanding/Airborne → Vector Servo 0.8; everything else 0.4.

## 5. Ability score

Candidates: tier-1 abilities when nothing is owned, otherwise the upgrade children of owned abilities. `fit` 1.0 if a granted status or the family is a style core, 0.6 if a mechanic, +0.15 per installed part consuming the granted status; Repair and Shield families floor at 0.45. Score = fit × (0.6 + 0.2 × tier).

## 6. Round economy (confirmed)

| Purchase | Price in round |
|---|---|
| Reroll | 250 + 250 × rerolls so far |
| Upgrade level | 1500 + 1000 × upgrades so far |
| Ability | 2500 + 1000 × abilities so far |
| Part | by rarity: 2000 / 2500 / 3000 / 3500 (Common … Legendary), flat |

Prices reset when the round is reset. Shop shows 4 parts (+2 Gadgeteer rank 3, +2 Bloody Bounty rank 3, or any manual offer size). A **price multiplier** covers special shop events (Sen Fira, Hibi); **free** adds cover packs and mystery encounters.

## 7. The decision table

Every option is reduced to **value per 1000 credits** and sorted:

* Buy the best visible offer: `marginal / price`.
* Best upgrade: `score / price`.
* Best ability: `score / price`.
* Reroll: `P(≥1 useful part in an offer of k) × mean(useful marginal) / reroll price`, where useful = pool parts with marginal ≥ threshold (0.45). The pool is every eligible, unowned part at the current unlock level. Zero useful parts flags the reroll as pointless.

The reroll term is the "is rolling still worth it" answer; the wishlist shows what you are rolling for.

## 8. Known simplifications

* Effect magnitudes are approximated by rarity rather than parsed percentages.
* Faults you carry are tracked for Redliner-style risk only through style self-inflicted statuses; carrying a fault that inflicts Frozen does not yet raise the value of Frost Protection.
* Multiplayer income is not modelled; the planner only compares spend options.

## 9. Recommendation engine UX (implemented 2026-10-14)

The planner is a companion, not the game: recording an action never pretends to
perform it. The loop is **evaluate → rank → explain → player acts in-game →
record → recalculate**.

### Architecture (`app/engine.js`)

* **Run state is event-sourced.** Every change is a `commit(run, event)`; the
  event is appended to `run.history` with an undo snapshot and bumps
  `run.revision`. Event types: `shop-rerolled`, `shop-offer-observed`,
  `part-purchased`, `part-acquired` (free), `part-equipped`, `part-unequipped`,
  `part-discarded`, `upgrade-purchased`, `ability-purchased`, `ability-acquired`,
  `ability-removed`, `round-reset`, `correction` (manual edits to credits, style,
  rank, vehicle, levels or settings, recorded separately from purchases).
* **Ownership is separate from equipment.** `inventory` holds every owned part;
  `equipped` holds what is installed. Buying never equips unless the player
  ticked "Equip it now"; with full slots an explicit replacement is chosen.
* **Shop state** is `{status:'known', partIds}` or `{status:'awaiting-offer'}`.
  After a confirmed reroll the planner shows "Awaiting new shop offer" and stops
  presenting shop purchases as available until the new offer is entered.
* **`evaluateRun(data, run)`** is pure. It returns `Recommendation` objects:
  `{id, kind, title, cost, value, score, scoreUnit, eligible, blockingReasons,
  rationale, metrics, explain:{summary, details, formula}, whyNot, revision}`.
  The UI only renders these; it never touches the scoring code.
* **Score semantics are unchanged.** `score` is still value ÷ price × 1000
  (unit shown on every card as "value per 1,000 CR"). Reroll uses
  `P(≥1 useful) × mean useful value`; the formula and all assumptions are
  printed in the expanded explanation.
* **Ranking:** eligible actions by score, then blocked ones (insufficient
  credits, awaiting offer, redundant tier, locked part) with the blocking reason
  spelled out. **Save credits** is always present at the configurable saving
  floor, so it can legitimately be the top card.
* **Stale protection:** each recommendation carries the run revision it was
  computed at. Confirming an action from an older revision is refused and the
  card is refreshed.
* **Recalculation policy:** selecting a card, expanding the math or opening a
  picker only re-renders; committed events re-evaluate everything (cheap at
  this catalogue size).
* **Undo** pops the last event and restores its snapshot (depth 40).

Tests: `npm test` (`test/engine.test.mjs`) covers the probability formula,
insufficient credits, awaiting-offer, save-credits on top, buy-without-equip and
full-slot replacement, duplicate tiers, undo, corrections, round reset, and v1
run migration.

## 10. Screen layout (after the Hibi's Shop pass)

The main screen mirrors the in-game shop so a first-time user already knows
where to look:

| Game | Planner | Our additions on top |
|---|---|---|
| Header: HIBI'S SHOP, credits top-right | Same, plus run picker and ⚙ Setup | One-line style summary: vehicle, style, what it builds on, status sources |
| Left: INSTALLED PARTS n/N | Same rows (icon, name, one-line effect) | Fit score per part; collapsible inventory; add-owned-part search |
| Middle: PARTS grid, RESTOCK button | Cream cards with name banner, effect, ◎ price; restock with price | "Best move" / "Best buy" ribbon, value bar, restock odds line, **Next move** strip with "Did it" and "Why?" |
| Right: PACKS | UPGRADES and ABILITIES packs | Best track/ability with price, level bars, owned abilities, "Looking for" wishlist |

Everything else lives in dialogs: the recommendation detail (summary → "Show
the math" → confirm), Run setup (mode, style, vehicle, credits, favours, upgrade
levels, abilities, prices), and History. The bottom bar holds Undo, the last
recorded action, History and "New shop visit" (round reset).

## 11. Packs, Garage and the shop look (2026-10-14, third pass)

* **Upgrades and abilities are packs.** Buying shows `packSize` (default 3;
  2–4 via Setup) random options and you keep one. The engine values a pack as
  the expected best of k draws from the pool: `Σ score(i) × C(n−1−i, k−1) / C(n, k)`
  over the pool sorted by score (`planner.packExpectedBest`). Upgrade pool =
  stats not yet +10 (shown by stat name, e.g. "Afterburner +1", not track name).
  Ability pool = base abilities you lack plus direct upgrades of abilities you
  own. Flow: confirm payment → `*-pack-purchased` sets `run.pending` → picker
  ("Which 3 were offered?", planner marks the best) → `*-chosen` clears it.
  While a pack is open, other packs are blocked. Free packs (race rewards)
  skip the payment and the counter.
* **Parts area** has two tabs: *Looking for* (top wishlist as cards, with
  "In shop" / "Got it") and *On offer* (what the dealer shows). Entering the
  offer is optional; the planner is useful from the wishlist alone.
* **Garage** replaces the settings form: Run (mode tiles, saved runs), Style
  (icon tiles + rank), Machine (class tabs, hero-image tiles), Favours (pick up
  to three, click to cycle rank; Gadgeteer and Bloody Bounty feed the engine),
  Upgrades (stat steppers + owned-ability tiles), Wallet (credits, events, pack
  and offer size, prices). Every change is a `correction` event.
* **Look** sampled from the in-game shop: cream stage with diagonal orange and
  teal stripes, teal-slate panels and part cards (image, white uppercase name,
  description with gold keywords, cream price pill), orange restock button,
  italic heavy title with the orange slash, teal bottom bar. No proprietary
  fonts or art are bundled; part icons are hotlinked from gameslantern.

## 12. Slots, swaps and the machine (2026-10-14, fourth pass)

* **Four part slots** on every machine (`settings.baseSlots`), +1/+2 from
  Gadgeteer, plus manual extra slots. The site's "part slots" are body-part
  slots and are no longer used.
* **No inventory.** Everything owned is installed. Buying or receiving a part
  into a full build means swapping one out. `planner.bestSwap` re-scores the
  whole build for every candidate swap (so a Cooled source that feeds three
  "While Cooled" parts is kept over a lone high scorer) and the confirm step
  lists each option with its net build gain, best first.
* **Machine = class.** The body is cosmetic; the Garage offers the four classes
  (advanced stat, class traits) and the run stores a representative vehicle of
  that class.
* After a restock the parts area no longer locks onto "On offer"; the Looking-for
  tab shows a "shop restocked" note instead.
