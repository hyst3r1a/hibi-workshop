// Parse cached HTML (cache/html) into data/galactic_racer.db (SQLite) and data/galactic_racer.json.
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as cheerio from 'cheerio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache', 'html');
const OUT_DIR = path.join(ROOT, 'data');
const BASE = 'https://galacticracer.gameslantern.com';

// ---------- helpers ----------
const clean = (s) => (s ?? '').replace(/​/g, '').replace(/\s+/g, ' ').trim();
const slugOf = (href, section) => {
  if (!href) return null;
  const m = href.replace(BASE, '').match(new RegExp(`^/${section}/([a-z0-9-]+)`));
  return m ? m[1] : null;
};
const anchorSlug = (href, prefix) => {
  const m = (href ?? '').match(new RegExp(`#${prefix}-([a-z0-9-]+)$`));
  return m ? m[1] : null;
};
const num = (s) => {
  const m = clean(s).replace(/,/g, '').match(/-?\d+/);
  return m ? Number(m[0]) : null;
};
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
function splitFamily(name) {
  const m = name.match(/^(.*?)\s+(I|II|III|IV|V)$/);
  return m ? { family: m[1], tierFromName: ROMAN[m[2].toLowerCase()] } : { family: name, tierFromName: null };
}
async function loadSection(section) {
  const dir = path.join(CACHE, section);
  const out = [];
  for (const f of (await readdir(dir)).sort()) {
    if (!f.endsWith('.html')) continue;
    out.push({ slug: f.replace(/\.html$/, ''), $: cheerio.load(await readFile(path.join(dir, f), 'utf8')) });
  }
  return out;
}
const main$ = ($) => $('.swgr-frame-inner .space-y-6').first();
const chips = ($, root) => root.find('.swgr-chip').map((_, e) => clean($(e).text())).get();
function keywordsIn($, el) {
  const seen = new Map();
  $(el).find('a[href*="/glossary/"]').each((_, a) => {
    const s = slugOf($(a).attr('href'), 'glossary');
    if (s && !seen.has(s)) seen.set(s, clean($(a).attr('title')) || null);
  });
  return [...seen].map(([slug, name]) => ({ slug, name }));
}
function facts($, root) {
  const out = {};
  root.find('dl.swgr-facts').first().children('dt').each((_, dt) => {
    const dd = $(dt).next('dd');
    out[clean($(dt).text())] = { text: clean(dd.text()), html: dd.html(), links: dd.find('a').map((_, a) => $(a).attr('href')).get() };
  });
  return out;
}
function sections($, root) {
  return root.find('section').map((_, s) => ({ el: s, title: clean($(s).find('h2').first().text()), label: clean($(s).find('.swgr-label').first().text()) })).get();
}
function parseHeader($, root) {
  const header = root.children().first();
  const h1 = clean(header.find('h1').first().text());
  const icon = header.find('img').first().attr('src') || null;
  const kind = clean(header.find('.swgr-label').first().text());
  return { name: h1, icon, kind, chips: chips($, header) };
}
// First description card after header: <div class="swgr-card"> with <p>
function parseDescriptionCard($, root) {
  const card = root.children('.swgr-card').eq(1).length ? root.children('.swgr-card').eq(1) : root.children().eq(1);
  const ps = card.children('p');
  return { card, paragraphs: ps.map((_, p) => ({ text: clean($(p).text()), html: $(p).html() })).get() };
}

// ---------- parsers ----------
function parseParts(pages) {
  const RARITIES = new Set(['Common', 'Rare', 'Epic', 'Legendary', 'Experimental', 'Faulty']);
  return pages.map(({ slug, $ }) => {
    const root = main$($);
    const h = parseHeader($, root);
    let rarity = null, tier = null, price = null, category = null;
    for (const c of h.chips) {
      if (RARITIES.has(c) && !rarity) rarity = c;
      else if (/^Tier \d$/.test(c)) tier = num(c);
      else if (/credits$/.test(c)) price = num(c);
      else if (!category) category = c;
      else if (c === 'Faulty' && !category) category = c;
    }
    if (rarity === 'Faulty' && !category) category = 'Faulty';
    const { paragraphs, card } = parseDescriptionCard($, root);
    const descP = paragraphs[0] ?? { text: '', html: '' };
    const f = facts($, card);
    const { family, tierFromName } = splitFamily(h.name);
    const tierSection = sections($, root).find((s) => /^Every tier of/i.test(s.title));
    const familyFromTable = tierSection ? clean(tierSection.title.replace(/^Every tier of/i, '')) : null;
    return {
      slug, name: h.name, rarity, tier: tier ?? tierFromName, category, price,
      is_fault: rarity === 'Faulty' ? 1 : 0,
      family: familyFromTable || family,
      description: descP.text, description_html: descP.html,
      unlock: f['How to unlock']?.text ?? null,
      icon: h.icon,
      keywords: keywordsIn($, card),
      url: `${BASE}/vehicle-parts/${slug}`,
    };
  });
}

function parseVehicles(pages) {
  const vehicles = [], bodyParts = [], classTraits = new Map();
  for (const { slug, $ } of pages) {
    const root = main$($);
    const card = root.children('.swgr-card').first();
    const name = clean(card.find('h1').first().text());
    const label = clean(card.find('.swgr-label').first().text()); // "Landspeeder · Jadrax Race Rigs"
    const f = facts($, card);
    const classSlug = slugOf(f.Class?.links?.[0], 'vehicle-classes');
    const manufacturer = f.Manufacturer ? clean(f.Manufacturer.text) : null;
    const manufacturerSlug = anchorSlug(f.Manufacturer?.links?.[0], 'maker');
    const paras = card.find('p').map((_, p) => clean($(p).text())).get();
    const classDesc = paras[0] ?? null;
    const allText = paras.join(' ');
    const bodyPartCount = (allText.match(/built from (\d+) body parts/) || [])[1];
    const kitPointsAll = num(f['All parts']?.text);
    const priceText = f.Price?.text ?? null;
    const racerSlugs = [];
    card.find('a[href*="/racers/"]').each((_, a) => { const s = slugOf($(a).attr('href'), 'racers'); if (s && !racerSlugs.includes(s)) racerSlugs.push(s); });
    const tourAnchor = card.find('a[href*="multiplayer-tours#"]').first().attr('href');
    const model = root.find('model-viewer-panel').first().attr('src') || null;
    const modelCode = model ? path.basename(model, '.glb') : null;
    const hero = root.find('.swgr-viewer img').first().attr('src') || null;
    const secs = sections($, root);
    const traitsSec = secs.find((s) => / traits in /i.test(s.title));
    if (traitsSec && classSlug && !classTraits.has(classSlug)) {
      const list = $(traitsSec.el).find('.swgr-card.p-3').map((_, c) => ({
        class_slug: classSlug,
        name: clean($(c).find('.swgr-heading').text()),
        description: clean($(c).find('p').text()),
        is_advanced: $(c).hasClass('swgr-card--gold') ? 1 : 0,
      })).get();
      classTraits.set(classSlug, list);
    }
    const buildSec = secs.find((s) => / build sheet$/i.test(s.title));
    if (buildSec) {
      $(buildSec.el).find('tbody tr').each((i, tr) => {
        const td = $(tr).find('td');
        bodyParts.push({ vehicle_slug: slug, position: i, slot: clean(td.eq(0).text()), part: clean(td.eq(1).text()), cost: num(td.eq(2).text()), unlock: clean(td.eq(3).text()) === '—' ? null : clean(td.eq(3).text()) });
      });
    }
    vehicles.push({
      slug, name, class_slug: classSlug, manufacturer, manufacturer_slug: manufacturerSlug, label,
      class_description: classDesc, description: paras.slice(1).join(' '),
      price_text: priceText, price_kit_points: /kit points/i.test(priceText ?? '') ? num(priceText) : null,
      owned_from_start: /owned from the start/i.test(priceText ?? '') ? 1 : 0,
      purchasable: /not purchasable/i.test(priceText ?? '') ? 0 : 1,
      all_parts_kit_points: kitPointsAll, body_part_count: bodyPartCount ? Number(bodyPartCount) : null,
      unlock: f['How to unlock']?.text ?? null, advanced_stat: f['Advanced stat']?.text ?? null,
      racer_slugs: racerSlugs, tour: tourAnchor ? anchorSlug(tourAnchor, 'tour') : null,
      model_code: modelCode, model_url: model, hero_image: hero, url: `${BASE}/vehicles/${slug}`,
    });
  }
  return { vehicles, bodyParts, classTraits: [...classTraits.values()].flat() };
}

function parseClasses(pages) {
  const classes = [], slots = [];
  for (const { slug, $ } of pages) {
    const root = main$($);
    const h = parseHeader($, root);
    let advanced = null, kits = null, slotCount = null;
    for (const c of h.chips) {
      if (/^Advanced:/.test(c)) advanced = clean(c.replace('Advanced:', ''));
      else if (/kits?$/.test(c)) kits = num(c);
      else if (/part slots?$/.test(c)) slotCount = num(c);
    }
    const { paragraphs } = parseDescriptionCard($, root);
    const secs = sections($, root);
    const slotSec = secs.find((s) => / part slots$/i.test(s.title));
    if (slotSec) $(slotSec.el).find('span').each((i, sp) => { const t = clean($(sp).text()); if (t && !/^\s*$/.test(t)) slots.push({ class_slug: slug, position: i, slot: t }); });
    const tracks = [];
    const trackSec = secs.find((s) => /^Tracks built for/i.test(s.title));
    if (trackSec) $(trackSec.el).find('a[href*="/tracks/"]').each((_, a) => tracks.push(slugOf($(a).attr('href'), 'tracks')));
    classes.push({ slug, name: h.name, advanced_stat: advanced, kit_count: kits, slot_count: slotCount, description: paragraphs[0]?.text ?? null, icon: h.icon, track_slugs: tracks, url: `${BASE}/vehicle-classes/${slug}` });
  }
  return { classes, slots };
}

function parseAbilities(pages) {
  const abilities = [], upgrades = [], styleStarts = [];
  for (const { slug, $ } of pages) {
    const root = main$($);
    const h = parseHeader($, root);
    const tier = num(h.chips.find((c) => /^Tier/.test(c)));
    const price = num(h.chips.find((c) => /credits$/.test(c)));
    const { paragraphs, card } = parseDescriptionCard($, root);
    const desc = paragraphs.find((p) => !/^Pre-race check/i.test(p.text)) ?? { text: '', html: '' };
    const pre = paragraphs.find((p) => /^Pre-race check/i.test(p.text));
    const secs = sections($, root);
    const famSec = secs.find((s) => / abilities in Star Wars/i.test(s.title));
    const family = famSec ? clean(famSec.title.replace(/ abilities in Star Wars.*$/i, '')) : h.name;
    const up = secs.find((s) => /^Upgrade path/i.test(s.title));
    if (up) {
      $(up.el).find('.swgr-label').each((_, lab) => {
        const kind = clean($(lab).text());
        $(lab).next().find('a[href*="/abilities/"]').each((_, a) => {
          const other = slugOf($(a).attr('href'), 'abilities');
          if (!other) return;
          if (/from/i.test(kind)) upgrades.push({ from_slug: other, to_slug: slug });
          else if (/into/i.test(kind)) upgrades.push({ from_slug: slug, to_slug: other });
        });
      });
    }
    const st = secs.find((s) => /^Racer styles that start with/i.test(s.title));
    if (st) $(st.el).find('a[href*="/racer-styles/"]').each((_, a) => styleStarts.push({ style_slug: slugOf($(a).attr('href'), 'racer-styles'), ability_slug: slug }));
    abilities.push({ slug, name: h.name, family, tier, price, description: desc.text, description_html: desc.html, pre_race_check: pre ? clean(pre.text.replace(/^Pre-race check:\s*/i, '')) : null, icon: h.icon, keywords: keywordsIn($, card), url: `${BASE}/abilities/${slug}` });
  }
  const seen = new Set();
  const dedupUp = upgrades.filter((u) => { const k = `${u.from_slug}>${u.to_slug}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { abilities, upgrades: dedupUp, styleStarts };
}

function parseGlossary(pages) {
  const terms = [], refs = [];
  for (const { slug, $ } of pages) {
    const root = main$($);
    const h = parseHeader($, root);
    const type = h.chips.find((c) => !/references?$/.test(c)) ?? null;
    const refCount = num(h.chips.find((c) => /references?$/.test(c)));
    const { paragraphs } = parseDescriptionCard($, root);
    const secs = sections($, root);
    const longSec = secs.find((s) => / in Star Wars Galactic Racer$/i.test(s.title) && !/^(Abilities|Parts|Traits|Racer styles|Vehicles)/i.test(s.title));
    const longDesc = longSec ? $(longSec.el).find('p').map((_, p) => clean($(p).text())).get().join('\n') : null;
    for (const s of secs) {
      $(s.el).find('a[href]').each((_, a) => {
        const href = $(a).attr('href');
        for (const [section, type] of [['vehicle-parts', 'part'], ['abilities', 'ability'], ['racer-styles', 'racer_style'], ['vehicles', 'vehicle'], ['vehicle-classes', 'vehicle_class']]) {
          const rs = slugOf(href, section);
          if (rs) refs.push({ keyword_slug: slug, ref_type: type, ref_slug: rs, context: s.title });
        }
        const tr = anchorSlug(href, 'trait');
        if (tr) refs.push({ keyword_slug: slug, ref_type: 'trait', ref_slug: tr, context: s.title });
      });
    }
    terms.push({ slug, name: h.name, type, reference_count: refCount, short_description: paragraphs[0]?.text ?? null, long_description: longDesc, icon: h.icon, url: `${BASE}/glossary/${slug}` });
  }
  return { terms, refs };
}

function parseTraitsIndex($) {
  const traits = new Map();
  $('div[id^="trait-"]').each((_, el) => {
    const slug = $(el).attr('id').replace(/^trait-/, '');
    const name = clean($(el).find('.swgr-heading').first().text());
    const p = $(el).find('p').first();
    const styles = $(el).find('a[href*="/racer-styles/"]').map((_, a) => slugOf($(a).attr('href'), 'racer-styles')).get();
    const icon = $(el).find('img').first().attr('src') || null;
    const existing = traits.get(slug);
    if (existing) { for (const s of styles) if (!existing.style_slugs.includes(s)) existing.style_slugs.push(s); return; }
    traits.set(slug, { slug, name, description: clean(p.text()), description_html: p.html(), icon, keywords: keywordsIn($, p), style_slugs: styles, url: `${BASE}/traits#trait-${slug}` });
  });
  return [...traits.values()];
}

function parseStyles(pages) {
  const styles = [], ranks = [], rankTraits = [], mpAbilities = [], styleRacers = [];
  for (const { slug, $ } of pages) {
    const root = main$($);
    const h = parseHeader($, root);
    const { paragraphs } = parseDescriptionCard($, root);
    const secs = sections($, root);
    const racersSec = secs.find((s) => /^Racers who run/i.test(s.title));
    if (racersSec) $(racersSec.el).find('a[href*="/racers/"]').each((_, a) => styleRacers.push({ style_slug: slug, racer_slug: slugOf($(a).attr('href'), 'racers') }));
    const collectTraits = (secEl, context, rank) => {
      $(secEl).find('a[href*="/traits#trait-"]').each((_, a) => {
        const tslug = anchorSlug($(a).attr('href'), 'trait');
        const desc = clean($(a).closest('.min-w-0').find('p').first().text());
        rankTraits.push({ style_slug: slug, context, rank, trait_slug: tslug, trait_name: clean($(a).text()), description: desc });
      });
    };
    for (const s of secs) {
      const m = s.title.match(/^Campaign rank (\d)/i);
      if (m) {
        const rank = Number(m[1]);
        ranks.push({ style_slug: slug, rank, requirement: s.label || null });
        collectTraits(s.el, 'campaign', rank);
      } else if (/^Multiplayer$/i.test(s.title)) {
        collectTraits(s.el, 'multiplayer', null);
        $(s.el).find('a[href*="/abilities/"]').each((_, a) => {
          mpAbilities.push({ style_slug: slug, ability_slug: slugOf($(a).attr('href'), 'abilities'), price: num($(a).find('.swgr-num').text()) });
        });
      }
    }
    styles.push({ slug, name: h.name, description: paragraphs[0]?.text ?? null, in_campaign: h.chips.includes('Campaign') ? 1 : 0, in_multiplayer: h.chips.includes('Multiplayer') ? 1 : 0, rank_count: ranks.filter((r) => r.style_slug === slug).length, icon: h.icon, url: `${BASE}/racer-styles/${slug}` });
  }
  return { styles, ranks, rankTraits, mpAbilities, styleRacers };
}

function parseRacers(pages) {
  return pages.map(({ slug, $ }) => {
    const root = main$($);
    const card = root.children('.swgr-card').first();
    const name = clean(card.find('h1').first().text());
    const paras = card.find('p').map((_, p) => clean($(p).text())).get();
    const f = facts($, card);
    const vehicleSlug = slugOf(root.find('a[href*="/vehicles/"]').first().attr('href'), 'vehicles');
    const styleSlugs = [];
    root.find('section a[href*="/racer-styles/"]').each((_, a) => { const s = slugOf($(a).attr('href'), 'racer-styles'); if (s && !styleSlugs.includes(s)) styleSlugs.push(s); });
    const tour = (paras.find((p) => /race in the .* Tour/i.test(p)) || '').match(/race in the (.*?)\.?$/i)?.[1] ?? null;
    const portrait = card.find('img').first().attr('src') || null;
    return { slug, name, description: paras[0] ?? null, summary: paras.slice(1).join(' '), vehicle_slug: vehicleSlug, style_slugs: styleSlugs, unlock: f['How to unlock']?.text ?? null, tour, portrait, url: `${BASE}/racers/${slug}` };
  });
}

function parseUpgrades($) {
  const out = [];
  $('h2.swgr-heading').each((_, h2) => {
    const name = clean($(h2).text());
    const container = $(h2).closest('.swgr-card, section, div').parent();
    const table = $(h2).parent().parent().parent().find('table').first().length ? $(h2).parent().parent().parent().find('table').first() : container.find('table').first();
    if (!table.length) return;
    const ths = table.find('thead th').map((_, th) => clean($(th).text())).get();
    if (ths[0] !== 'Level') return;
    const stat = ths[1];
    const classLinks = $(h2).parent().find('a[href*="/vehicle-classes/"]').map((_, a) => ({ class_slug: slugOf($(a).attr('href'), 'vehicle-classes'), stat_name: clean($(a).text()) })).get();
    table.find('tbody tr').each((_, tr) => {
      const td = $(tr).find('td');
      out.push({ track: name, stat, level: num(td.eq(0).text()), bonus: num(td.eq(1).text()), price: num(td.eq(2).text()), faulty_price: num(td.eq(3).text()), class_stats: classLinks });
    });
  });
  return out;
}

function parseManufacturers($) {
  return $('section[id^="maker-"]').map((_, s) => ({
    slug: $(s).attr('id').replace(/^maker-/, ''),
    name: clean($(s).find('h2').first().text()),
    description: clean($(s).find('p').first().text()) || null,
    logo: $(s).find('img').first().attr('src') || null,
    vehicle_slugs: $(s).find('a[href*="/vehicles/"]').map((_, a) => slugOf($(a).attr('href'), 'vehicles')).get().filter(Boolean),
  })).get();
}

function parseFavours($) {
  const favours = [], ranks = [];
  $('section[id^="favour-"]').each((_, sec) => {
    const slug = $(sec).attr('id').replace(/^favour-/, '');
    const name = clean($(sec).find('h2').first().text());
    const requirement = clean($(sec).find('h2').first().parent().next().text());
    const source = clean($(sec).find('a[href*="/sponsors#"]').first().text()) || null;
    $(sec).find('span').each((_, sp) => {
      const m = clean($(sp).text()).match(/^Rank (\d)$/);
      if (m) ranks.push({ favour_slug: slug, rank: Number(m[1]), effect: clean($(sp).next('span').text()) });
    });
    favours.push({ slug, name, requirement, source, icon: $(sec).find('img').first().attr('src') || null });
  });
  return { favours, ranks };
}

// ---------- DB ----------
const SCHEMA = `

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE vehicle_classes (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, advanced_stat TEXT, kit_count INTEGER, slot_count INTEGER,
  description TEXT, icon TEXT, url TEXT);
CREATE TABLE vehicle_class_slots (class_slug TEXT REFERENCES vehicle_classes(slug), position INTEGER, slot TEXT, PRIMARY KEY(class_slug, position));
CREATE TABLE vehicle_class_traits (class_slug TEXT REFERENCES vehicle_classes(slug), name TEXT, description TEXT, is_advanced INTEGER, PRIMARY KEY(class_slug, name));
CREATE TABLE vehicle_class_tracks (class_slug TEXT REFERENCES vehicle_classes(slug), track_slug TEXT, PRIMARY KEY(class_slug, track_slug));

CREATE TABLE manufacturers (slug TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, logo TEXT);

CREATE TABLE vehicles (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, class_slug TEXT REFERENCES vehicle_classes(slug),
  manufacturer_slug TEXT REFERENCES manufacturers(slug), manufacturer TEXT, description TEXT, class_description TEXT,
  price_text TEXT, price_kit_points INTEGER, owned_from_start INTEGER, purchasable INTEGER,
  all_parts_kit_points INTEGER, body_part_count INTEGER, unlock TEXT, advanced_stat TEXT, tour TEXT,
  model_code TEXT, model_url TEXT, hero_image TEXT, url TEXT);
CREATE TABLE vehicle_body_parts (vehicle_slug TEXT REFERENCES vehicles(slug), position INTEGER, slot TEXT, part TEXT, cost INTEGER, unlock TEXT, PRIMARY KEY(vehicle_slug, position));

CREATE TABLE keywords (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, reference_count INTEGER,
  short_description TEXT, long_description TEXT, icon TEXT, url TEXT);
CREATE TABLE keyword_refs (keyword_slug TEXT REFERENCES keywords(slug), ref_type TEXT, ref_slug TEXT, context TEXT, PRIMARY KEY(keyword_slug, ref_type, ref_slug, context));

CREATE TABLE parts (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, family TEXT NOT NULL, rarity TEXT, tier INTEGER, category TEXT,
  price INTEGER, is_fault INTEGER NOT NULL DEFAULT 0, variant_of TEXT REFERENCES parts(slug), description TEXT, description_html TEXT, unlock TEXT, icon TEXT, url TEXT);
CREATE TABLE part_keywords (part_slug TEXT REFERENCES parts(slug), keyword_slug TEXT, keyword_name TEXT, position INTEGER, PRIMARY KEY(part_slug, keyword_slug));

CREATE TABLE abilities (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, family TEXT, tier INTEGER, price INTEGER, description TEXT, description_html TEXT,
  pre_race_check TEXT, icon TEXT, url TEXT);
CREATE TABLE ability_upgrades (from_slug TEXT REFERENCES abilities(slug), to_slug TEXT REFERENCES abilities(slug), PRIMARY KEY(from_slug, to_slug));
CREATE TABLE ability_keywords (ability_slug TEXT REFERENCES abilities(slug), keyword_slug TEXT, keyword_name TEXT, position INTEGER, PRIMARY KEY(ability_slug, keyword_slug));

CREATE TABLE traits (slug TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, description_html TEXT, icon TEXT, url TEXT);
CREATE TABLE trait_keywords (trait_slug TEXT REFERENCES traits(slug), keyword_slug TEXT, keyword_name TEXT, position INTEGER, PRIMARY KEY(trait_slug, keyword_slug));

CREATE TABLE racer_styles (slug TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, in_campaign INTEGER, in_multiplayer INTEGER, rank_count INTEGER, icon TEXT, url TEXT);
CREATE TABLE racer_style_ranks (style_slug TEXT REFERENCES racer_styles(slug), rank INTEGER, requirement TEXT, PRIMARY KEY(style_slug, rank));
-- context: 'campaign' (with rank 1..3, cumulative as shown on site) or 'multiplayer' (rank NULL)
CREATE TABLE racer_style_traits (style_slug TEXT REFERENCES racer_styles(slug), context TEXT, rank INTEGER, trait_slug TEXT REFERENCES traits(slug), PRIMARY KEY(style_slug, context, rank, trait_slug));
CREATE TABLE racer_style_abilities (style_slug TEXT REFERENCES racer_styles(slug), ability_slug TEXT REFERENCES abilities(slug), price INTEGER, PRIMARY KEY(style_slug, ability_slug));

CREATE TABLE racers (slug TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, summary TEXT, vehicle_slug TEXT REFERENCES vehicles(slug), unlock TEXT, tour TEXT, portrait TEXT, url TEXT);
CREATE TABLE racer_styles_racers (racer_slug TEXT REFERENCES racers(slug), style_slug TEXT REFERENCES racer_styles(slug), PRIMARY KEY(racer_slug, style_slug));

CREATE TABLE upgrades (track TEXT, stat TEXT, level INTEGER, bonus INTEGER, price INTEGER, faulty_price INTEGER, PRIMARY KEY(track, level));
CREATE TABLE upgrade_class_stats (track TEXT, class_slug TEXT REFERENCES vehicle_classes(slug), stat_name TEXT, PRIMARY KEY(track, class_slug));

-- Curated semantics (scraper/part_semantics.json, scraper/style_semantics.json)
-- relation: needs | grants | boosts | protects ; keyword uses the shared planner vocabulary
CREATE TABLE part_semantics (family TEXT NOT NULL, relation TEXT NOT NULL, keyword TEXT NOT NULL, PRIMARY KEY(family, relation, keyword));
-- relation: core | grants | mechanics
CREATE TABLE style_semantics (style_slug TEXT REFERENCES racer_styles(slug), relation TEXT NOT NULL, keyword TEXT NOT NULL, PRIMARY KEY(style_slug, relation, keyword));
CREATE INDEX idx_part_semantics_kw ON part_semantics(relation, keyword);
CREATE TABLE favours (slug TEXT PRIMARY KEY, name TEXT NOT NULL, requirement TEXT, source TEXT, icon TEXT);
CREATE TABLE favour_ranks (favour_slug TEXT REFERENCES favours(slug), rank INTEGER, effect TEXT, PRIMARY KEY(favour_slug, rank));
CREATE INDEX idx_parts_family ON parts(family);
CREATE INDEX idx_parts_category ON parts(category);
CREATE INDEX idx_parts_rarity ON parts(rarity);
CREATE INDEX idx_part_keywords_kw ON part_keywords(keyword_slug);
CREATE INDEX idx_keyword_refs_ref ON keyword_refs(ref_type, ref_slug);

-- Convenience views
CREATE VIEW v_part_keywords AS
  SELECT p.slug, p.name, p.family, p.rarity, p.tier, p.category, p.price, p.is_fault, p.variant_of, p.description,
         group_concat(pk.keyword_name, ', ') AS keywords
  FROM parts p LEFT JOIN part_keywords pk ON pk.part_slug = p.slug
  GROUP BY p.slug;
CREATE VIEW v_style_traits AS
  SELECT rs.name AS style, rst.context, rst.rank, t.name AS trait, t.description
  FROM racer_style_traits rst JOIN racer_styles rs ON rs.slug = rst.style_slug JOIN traits t ON t.slug = rst.trait_slug;
`;

function insertAll(db, table, rows, cols) {
  if (!rows.length) return;
  const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const r of rows) stmt.run(...cols.map((c) => (r[c] === undefined ? null : r[c])));
}

async function main() {
  console.log('Parsing...');
  const [partPages, vehiclePages, classPages, abilityPages, glossaryPages, stylePages, racerPages] = await Promise.all(
    ['vehicle-parts', 'vehicles', 'vehicle-classes', 'abilities', 'glossary', 'racer-styles', 'racers'].map(loadSection));
  const traits$ = cheerio.load(await readFile(path.join(CACHE, 'index', 'traits.html'), 'utf8'));
  const upgrades$ = cheerio.load(await readFile(path.join(CACHE, 'index', 'upgrades.html'), 'utf8'));
  const favours$ = cheerio.load(await readFile(path.join(CACHE, 'index', 'favours.html'), 'utf8'));
  const makers$ = cheerio.load(await readFile(path.join(CACHE, 'index', 'manufacturers.html'), 'utf8'));

  const parts = parseParts(partPages);
  // Site lists a few parts twice under "<slug>-2" with identical name/effect; link them to the canonical entry.
  for (const p of parts) {
    const m = p.slug.match(/^(.*)-2$/);
    const base = m && parts.find((o) => o.slug === m[1] && o.name === p.name);
    p.variant_of = base ? base.slug : null;
    if (base && !p.category) p.category = base.category;
  }
  parts.sort((a, b) => (a.variant_of ? 1 : 0) - (b.variant_of ? 1 : 0) || a.slug.localeCompare(b.slug));
  const { vehicles, bodyParts, classTraits } = parseVehicles(vehiclePages);
  const { classes, slots } = parseClasses(classPages);
  const { abilities, upgrades: abilityUpgrades, styleStarts } = parseAbilities(abilityPages);
  const { terms, refs } = parseGlossary(glossaryPages);
  const traits = parseTraitsIndex(traits$);
  const { styles, ranks, rankTraits, mpAbilities, styleRacers } = parseStyles(stylePages);
  const racers = parseRacers(racerPages);
  const upgrades = parseUpgrades(upgrades$);
  const partSem = JSON.parse(await readFile(path.join(ROOT, 'scraper', 'part_semantics.json'), 'utf8'));
  const styleSem = JSON.parse(await readFile(path.join(ROOT, 'scraper', 'style_semantics.json'), 'utf8'));
  const partSemRows = Object.entries(partSem).filter(([k]) => k !== '_doc').flatMap(([family, rel]) =>
    Object.entries(rel).flatMap(([relation, kws]) => kws.map((keyword) => ({ family, relation, keyword }))));
  const styleSemRows = Object.entries(styleSem).filter(([k]) => k !== '_doc').flatMap(([style_slug, rel]) =>
    Object.entries(rel).flatMap(([relation, kws]) => kws.map((keyword) => ({ style_slug, relation, keyword }))));
  const untagged = [...new Set(parts.filter((p) => !p.is_fault && !partSem[p.family]).map((p) => p.family))];
  if (untagged.length) console.warn('  ! part families without semantics:', untagged.join(', '));
  const manufacturers = parseManufacturers(makers$);
  const { favours, ranks: favourRanks } = parseFavours(favours$);

  const data = { generated_at: new Date().toISOString(), source: BASE, classes, slots, classTraits, manufacturers, vehicles, bodyParts, keywords: terms, keywordRefs: refs, parts, abilities, abilityUpgrades, styleStarts, traits, styles, ranks, rankTraits, mpAbilities, styleRacers, racers, upgrades, favours, favourRanks, partSemantics: partSem, styleSemantics: styleSem };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'galactic_racer.json'), JSON.stringify(data, null, 1), 'utf8');

  const dbPath = path.join(OUT_DIR, 'galactic_racer.db');
  for (const suffix of ['', '-wal', '-shm']) await rm(dbPath + suffix, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  db.exec('BEGIN');
  insertAll(db, 'meta', [{ key: 'source', value: BASE }, { key: 'generated_at', value: data.generated_at }], ['key', 'value']);
  insertAll(db, 'vehicle_classes', classes, ['slug', 'name', 'advanced_stat', 'kit_count', 'slot_count', 'description', 'icon', 'url']);
  insertAll(db, 'vehicle_class_slots', slots, ['class_slug', 'position', 'slot']);
  insertAll(db, 'vehicle_class_traits', classTraits, ['class_slug', 'name', 'description', 'is_advanced']);
  insertAll(db, 'vehicle_class_tracks', classes.flatMap((c) => c.track_slugs.map((t) => ({ class_slug: c.slug, track_slug: t }))), ['class_slug', 'track_slug']);
  insertAll(db, 'manufacturers', manufacturers, ['slug', 'name', 'description', 'logo']);
  insertAll(db, 'vehicles', vehicles, ['slug', 'name', 'class_slug', 'manufacturer_slug', 'manufacturer', 'description', 'class_description', 'price_text', 'price_kit_points', 'owned_from_start', 'purchasable', 'all_parts_kit_points', 'body_part_count', 'unlock', 'advanced_stat', 'tour', 'model_code', 'model_url', 'hero_image', 'url']);
  insertAll(db, 'vehicle_body_parts', bodyParts, ['vehicle_slug', 'position', 'slot', 'part', 'cost', 'unlock']);
  insertAll(db, 'keywords', terms, ['slug', 'name', 'type', 'reference_count', 'short_description', 'long_description', 'icon', 'url']);
  insertAll(db, 'keyword_refs', refs, ['keyword_slug', 'ref_type', 'ref_slug', 'context']);
  insertAll(db, 'parts', parts, ['slug', 'name', 'family', 'rarity', 'tier', 'category', 'price', 'is_fault', 'variant_of', 'description', 'description_html', 'unlock', 'icon', 'url']);
  insertAll(db, 'part_keywords', parts.flatMap((p) => p.keywords.map((k, i) => ({ part_slug: p.slug, keyword_slug: k.slug, keyword_name: k.name, position: i }))), ['part_slug', 'keyword_slug', 'keyword_name', 'position']);
  insertAll(db, 'abilities', abilities, ['slug', 'name', 'family', 'tier', 'price', 'description', 'description_html', 'pre_race_check', 'icon', 'url']);
  insertAll(db, 'ability_upgrades', abilityUpgrades, ['from_slug', 'to_slug']);
  insertAll(db, 'ability_keywords', abilities.flatMap((a) => a.keywords.map((k, i) => ({ ability_slug: a.slug, keyword_slug: k.slug, keyword_name: k.name, position: i }))), ['ability_slug', 'keyword_slug', 'keyword_name', 'position']);
  insertAll(db, 'traits', traits, ['slug', 'name', 'description', 'description_html', 'icon', 'url']);
  insertAll(db, 'trait_keywords', traits.flatMap((t) => t.keywords.map((k, i) => ({ trait_slug: t.slug, keyword_slug: k.slug, keyword_name: k.name, position: i }))), ['trait_slug', 'keyword_slug', 'keyword_name', 'position']);
  insertAll(db, 'racer_styles', styles, ['slug', 'name', 'description', 'in_campaign', 'in_multiplayer', 'rank_count', 'icon', 'url']);
  insertAll(db, 'racer_style_ranks', ranks, ['style_slug', 'rank', 'requirement']);
  insertAll(db, 'racer_style_traits', rankTraits, ['style_slug', 'context', 'rank', 'trait_slug']);
  insertAll(db, 'racer_style_abilities', mpAbilities, ['style_slug', 'ability_slug', 'price']);
  insertAll(db, 'racers', racers, ['slug', 'name', 'description', 'summary', 'vehicle_slug', 'unlock', 'tour', 'portrait', 'url']);
  insertAll(db, 'racer_styles_racers', racers.flatMap((r) => r.style_slugs.map((s) => ({ racer_slug: r.slug, style_slug: s }))), ['racer_slug', 'style_slug']);
  insertAll(db, 'upgrades', upgrades, ['track', 'stat', 'level', 'bonus', 'price', 'faulty_price']);
  insertAll(db, 'favours', favours, ['slug', 'name', 'requirement', 'source', 'icon']);
  insertAll(db, 'favour_ranks', favourRanks, ['favour_slug', 'rank', 'effect']);
  insertAll(db, 'part_semantics', partSemRows, ['family', 'relation', 'keyword']);
  insertAll(db, 'style_semantics', styleSemRows, ['style_slug', 'relation', 'keyword']);
  insertAll(db, 'upgrade_class_stats', upgrades.flatMap((u) => u.class_stats.map((c) => ({ track: u.track, ...c }))), ['track', 'class_slug', 'stat_name']);
  db.exec('COMMIT');

  // Integrity report
  const count = (t) => db.prepare(`SELECT count(*) n FROM ${t}`).get().n;
  for (const t of ['vehicle_classes', 'vehicle_class_slots', 'vehicle_class_traits', 'manufacturers', 'vehicles', 'vehicle_body_parts', 'keywords', 'keyword_refs', 'parts', 'part_keywords', 'abilities', 'ability_upgrades', 'traits', 'racer_styles', 'racer_style_ranks', 'racer_style_traits', 'racer_style_abilities', 'racers', 'upgrades', 'upgrade_class_stats', 'part_semantics', 'style_semantics', 'favours', 'favour_ranks'])
    console.log(`  ${t.padEnd(24)} ${count(t)}`);
  const missing = db.prepare(`SELECT DISTINCT keyword_slug FROM part_keywords WHERE keyword_slug NOT IN (SELECT slug FROM keywords)`).all();
  if (missing.length) console.warn('  ! part keywords without glossary page:', missing.map((m) => m.keyword_slug).join(', '));
  const missingTraits = db.prepare(`SELECT DISTINCT trait_slug FROM racer_style_traits WHERE trait_slug NOT IN (SELECT slug FROM traits)`).all();
  if (missingTraits.length) console.warn('  ! style traits missing from traits table:', missingTraits.map((m) => m.trait_slug).join(', '));
  db.close();
  console.log(`\nWrote ${dbPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
