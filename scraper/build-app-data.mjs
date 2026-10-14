// Export a trimmed, planner-oriented JSON from data/galactic_racer.db into app/data.json
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'galactic_racer.db'), { readOnly: true });
const all = (sql, ...a) => db.prepare(sql).all(...a);

const STATUSES = ['Cooled', 'Frozen', 'Burning', 'Surging', 'Shielded', 'Overcharged', 'Corroded', 'Concussed', 'Choked', 'Disrupted', 'System Malfunction', 'Critical Malfunction'];
const STATUS_KEY = { 'System Malfunction': 'SysMalf', 'Critical Malfunction': 'CritMalf' };
const key = (s) => STATUS_KEY[s] ?? s;

const sem = {};
for (const r of all('SELECT family, relation, keyword FROM part_semantics')) ((sem[r.family] ??= {})[r.relation] ??= []).push(r.keyword);
const ssem = {};
for (const r of all('SELECT style_slug, relation, keyword FROM style_semantics')) ((ssem[r.style_slug] ??= {})[r.relation] ??= []).push(r.keyword);

const parts = all(`SELECT slug, name, family, rarity, tier, category, price, is_fault, variant_of, description, unlock, icon FROM parts ORDER BY name`).map((p) => ({
  slug: p.slug, name: p.name, family: p.family, rarity: p.rarity, tier: p.tier, category: p.category, price: p.price,
  is_fault: !!p.is_fault, variant_of: p.variant_of, description: p.description, icon: p.icon,
  unlock_events: /Complete (\d+) events/.test(p.unlock ?? '') ? Number(RegExp.$1) : 0,
  plane_trait: p.category === 'Plane Trait',
  needs: sem[p.family]?.needs ?? [], grants: sem[p.family]?.grants ?? [], boosts: sem[p.family]?.boosts ?? [], protects: sem[p.family]?.protects ?? [],
}));

const traitsBySlug = Object.fromEntries(all('SELECT slug, name, description FROM traits').map((t) => [t.slug, t]));
const styles = all('SELECT slug, name, description, in_campaign, in_multiplayer, icon FROM racer_styles ORDER BY name').map((s) => {
  const ranks = all('SELECT rank, requirement FROM racer_style_ranks WHERE style_slug = ? ORDER BY rank', s.slug).map((r) => ({
    rank: r.rank, requirement: r.requirement,
    traits: all(`SELECT trait_slug FROM racer_style_traits WHERE style_slug = ? AND context = 'campaign' AND rank = ?`, s.slug, r.rank).map((t) => traitsBySlug[t.trait_slug]),
  }));
  const mpTraits = all(`SELECT trait_slug FROM racer_style_traits WHERE style_slug = ? AND context = 'multiplayer'`, s.slug).map((t) => traitsBySlug[t.trait_slug]);
  const mpAbilities = all('SELECT ability_slug, price FROM racer_style_abilities WHERE style_slug = ?', s.slug);
  return { slug: s.slug, name: s.name, description: s.description, in_campaign: !!s.in_campaign, in_multiplayer: !!s.in_multiplayer, icon: s.icon,
    core: ssem[s.slug]?.core ?? [], grants: ssem[s.slug]?.grants ?? [], mechanics: ssem[s.slug]?.mechanics ?? [],
    ranks, multiplayer: { traits: mpTraits, abilities: mpAbilities } };
});

const abilities = all('SELECT slug, name, family, tier, price, description, icon FROM abilities ORDER BY family, tier, name').map((a) => {
  const grants = STATUSES.filter((s) => new RegExp(`[Gg]ain(?:ing)?[^.]*\\b${s}\\b`).test(a.description)).map(key);
  const inflicts = STATUSES.filter((s) => new RegExp(`(?:appl(?:y|ies)|trigger)[^.]*\\b${s}\\b`).test(a.description)).map(key);
  return { ...a, grants, inflicts,
    upgrades_to: all('SELECT to_slug FROM ability_upgrades WHERE from_slug = ?', a.slug).map((r) => r.to_slug),
    upgrades_from: all('SELECT from_slug FROM ability_upgrades WHERE to_slug = ?', a.slug).map((r) => r.from_slug) };
});

const classes = all('SELECT slug, name, advanced_stat, slot_count, description, icon FROM vehicle_classes ORDER BY name').map((c) => ({
  ...c, traits: all('SELECT name, description, is_advanced FROM vehicle_class_traits WHERE class_slug = ?', c.slug) }));
const vehicles = all('SELECT slug, name, class_slug, advanced_stat, manufacturer, price_text, hero_image, price_kit_points, owned_from_start, purchasable FROM vehicles ORDER BY class_slug, name');
const upgrades = all('SELECT DISTINCT track, stat FROM upgrades ORDER BY rowid');
const upgradeClassStats = all('SELECT class_slug, stat_name FROM upgrade_class_stats');
const favours = all(`SELECT slug, name, requirement, icon, source FROM favours WHERE slug NOT LIKE '%-%' ORDER BY name`).map((f) => ({
  ...f, ranks: all('SELECT rank, effect FROM favour_ranks WHERE favour_slug = ? ORDER BY rank', f.slug) }));
const keywords = Object.fromEntries(all('SELECT slug, name, short_description FROM keywords').map((k) => [k.slug, { name: k.name, short: k.short_description }]));

const data = { generated_at: new Date().toISOString(), source: 'https://galacticracer.gameslantern.com/', parts, styles, abilities, classes, vehicles, upgrades, upgradeClassStats, favours, keywords };
await writeFile(path.join(ROOT, 'app', 'data.json'), JSON.stringify(data), 'utf8');
console.log(`app/data.json: ${parts.length} parts, ${styles.length} styles, ${abilities.length} abilities, ${vehicles.length} vehicles, ${favours.length} favours`);
console.log('ability grants sample:', abilities.filter((a) => a.grants.length).slice(0, 8).map((a) => `${a.name}→${a.grants}`).join(' | '));
