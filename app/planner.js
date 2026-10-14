// GRBC planner core: pure functions, no DOM. Used by app.js and by node tests.

export const STATUSES = new Set(['Cooled', 'Frozen', 'Burning', 'Surging', 'Shielded', 'Overcharged', 'Corroded', 'Concussed', 'Choked', 'Disrupted', 'SysMalf', 'CritMalf']);
export const NEGATIVE = new Set(['Frozen', 'Burning', 'Corroded', 'Concussed', 'Choked', 'Disrupted', 'SysMalf', 'CritMalf']);
export const RARITY_VALUE = { Common: 0.55, Rare: 0.7, Epic: 0.85, Legendary: 1.0, Experimental: 1.0, Faulty: 0 };
export const TRACKS = ['Turbojet Manifold', 'Fuel Injector', 'Repulsor Grip', 'Vector Servo', 'Structural Bracing', 'Power Cell'];
export const TRACK_STAT = { 'Turbojet Manifold': 'Ramjet', 'Fuel Injector': 'Afterburner', 'Repulsor Grip': 'Cornering', 'Vector Servo': 'Advanced', 'Structural Bracing': 'Resilience', 'Power Cell': 'Battery' };

// How often a mechanic / status is expected to be present when nothing in the build provides it.
const BASELINE = {
  Ramjet: 0.9, Afterburner: 0.9, RaceStart: 1, Speed: 0.6, Airborne: 0.5, Collision: 0.5, Energy: 0.5, PerfectStart: 0.5,
  Slipstreaming: 0.45, Crash: 0.4, FirstPlace: 0.4, SysMalf: 0.4, Redlining: 0.4, PerfectLanding: 0.35, Takedown: 0.3,
  Concussed: 0.3, Ability: 0.3, LastCrash: 0.25, CritMalf: 0.25, Surging: 0.2, Shielded: 0.2,
  Cooled: 0.15, Overcharged: 0.15, Burning: 0.15, Frozen: 0.15, Corroded: 0.15, Choked: 0.1, Disrupted: 0.1,
};

export const DEFAULT_SETTINGS = {
  partPrice: { Common: 2000, Rare: 2500, Epic: 3000, Legendary: 3500, Experimental: 3500 },
  reroll: { base: 250, step: 250 },
  upgrade: { base: 1500, step: 1000 },
  ability: { base: 2500, step: 1000 },
  offerSize: 4,
  priceMultiplier: 1,
  usefulThreshold: 0.45,
  baseSlots: 4,
  saveFloor: 0.2,
  packSize: 3,
};

export function newSession(data, partial = {}) {
  return {
    id: partial.id ?? `s${Date.now().toString(36)}`,
    name: partial.name ?? 'New run',
    mode: 'campaign', style: data.styles.find((s) => s.in_campaign)?.slug ?? data.styles[0].slug, rank: 1,
    vehicle: data.vehicles[0].slug, credits: 5000, events: 999, // 999 = every part unlocked; lower it to gate the pool
    favours: { gadgeteer: 0, bloodyBounty: 0, smugglersHope: 0 }, favourPicks: [], extraSlots: 0, pending: null,
    upgrades: Object.fromEntries(TRACKS.map((t) => [t, 0])),
    abilities: [], inventory: [], equipped: [], shop: { status: 'known', partIds: [] },
    counters: { parts: 0, rerolls: 0, upgrades: 0, abilities: 0 },
    settings: structuredClone(DEFAULT_SETTINGS),
    revision: 0, history: [],
    ...partial,
  };
}

// Installed part slugs regardless of run-shape version.
export function equippedSlugs(session) { return session.equipped ?? (session.parts ?? []).map((o) => o.slug); }
export function shopPartIds(session) { if (session.shop) return session.shop.status === 'known' ? session.shop.partIds : []; return session.offer ?? []; }

// ---------- prices for the current round ----------
export function prices(session) {
  const s = session.settings, c = session.counters, m = s.priceMultiplier ?? 1;
  return {
    part: (rarity) => Math.round((s.partPrice[rarity] ?? 3000) * m),
    reroll: Math.round((s.reroll.base + s.reroll.step * c.rerolls) * m),
    upgrade: Math.round((s.upgrade.base + s.upgrade.step * c.upgrades) * m),
    ability: Math.round((s.ability.base + s.ability.step * c.abilities) * m),
  };
}

// Base game: 4 part slots on every machine; Gadgeteer adds 1 or 2; encounters can add more (extraSlots).
export function slotCount(data, session) {
  const gad = [0, 1, 2, 2][session.favours?.gadgeteer ?? 0] ?? 0;
  return (session.settings?.baseSlots ?? 4) + gad + (session.extraSlots ?? 0);
}

export function offerSize(data, session) {
  const gad = (session.favours?.gadgeteer ?? 0) >= 3 ? 2 : 0;
  const bb = (session.favours?.bloodyBounty ?? 0) >= 3 ? 2 : 0;
  return (session.settings.offerSize ?? 4) + gad + bb;
}

// ---------- context ----------
export function buildContext(data, session) {
  const style = data.styles.find((s) => s.slug === session.style) ?? data.styles[0];
  const vehicle = data.vehicles.find((v) => v.slug === session.vehicle) ?? data.vehicles[0];
  const cls = data.classes.find((c) => c.slug === vehicle.class_slug);
  const byslug = Object.fromEntries(data.parts.map((p) => [p.slug, p]));
  const abil = Object.fromEntries(data.abilities.map((a) => [a.slug, a]));
  const owned = equippedSlugs(session).map((slug) => byslug[slug]).filter(Boolean);
  const ownedAbilities = new Set(session.abilities);
  if (session.mode === 'multiplayer') for (const a of style.multiplayer.abilities) ownedAbilities.add(a.ability_slug);

  // Sources of statuses: style, abilities, owned parts
  const sources = new Map(); // status -> [reason]
  const add = (k, why) => { if (!sources.has(k)) sources.set(k, []); sources.get(k).push(why); };
  for (const k of style.grants) add(k, `style ${style.name}`);
  for (const slug of ownedAbilities) for (const k of abil[slug]?.grants ?? []) add(k, `ability ${abil[slug].name}`);
  for (const p of owned) for (const k of p.grants) add(k, `part ${p.name}`);
  // Faults the player carries inflict negative statuses on themselves
  const selfInflicted = new Set([...style.grants].filter((k) => NEGATIVE.has(k)));
  for (const a of ownedAbilities) for (const k of abil[a]?.grants ?? []) if (NEGATIVE.has(k)) selfInflicted.add(k);

  const mechanics = new Set(style.mechanics);
  const core = new Set(style.core);
  const ownedByFamily = {};
  for (const p of owned) if (!ownedByFamily[p.family] || (p.tier ?? 0) > (ownedByFamily[p.family].tier ?? 0)) ownedByFamily[p.family] = p;
  // Build focus: stats the installed parts already boost. Parts and upgrades that push the same stat stack with them.
  const focus = new Map();
  for (const p of owned) for (const b of p.boosts) { if (!focus.has(b)) focus.set(b, []); focus.get(b).push(p); }

  const availability = (k) => {
    if (sources.has(k)) return 1;
    if (mechanics.has(k) || core.has(k)) return 1;
    if (k === 'Ability') return ownedAbilities.size ? 1 : BASELINE.Ability;
    return BASELINE[k] ?? 0.3;
  };

  return { data, session, style, vehicle, cls, owned, ownedAbilities, ownedByFamily, sources, selfInflicted, mechanics, core, availability, focus,
    slots: slotCount(data, session), partsBySlug: byslug, abilitiesBySlug: abil };
}

// ---------- part scoring ----------
function styleFit(part, ctx) {
  let best = 0.3; const why = [];
  const kws = [...part.needs, ...part.boosts, ...part.grants];
  for (const k of kws) {
    if (ctx.core.has(k)) { if (best < 1) { best = 1; why.length = 0; } why.push(`${k} is core to ${ctx.style.name}`); }
    else if (ctx.mechanics.has(k) && best < 0.6) { best = 0.6; why.push(`${k} fits ${ctx.style.name}`); }
  }
  for (const k of part.protects) {
    if (ctx.selfInflicted.has(k) && best < 0.8) { best = 0.8; why.push(`protects against self-inflicted ${k}`); }
  }
  return { value: best, why };
}

function enablement(part, ctx) {
  let v = 1; const missing = [];
  for (const k of part.needs) {
    const a = ctx.availability(k);
    v *= a;
    if (a < 0.5) missing.push(k);
  }
  return { value: v, missing };
}

function payoff(part, ctx) {
  let v = 1; const why = [];
  for (const g of part.grants) {
    const consumers = ctx.owned.filter((p) => p.slug !== part.slug && p.needs.includes(g));
    if (consumers.length) { v += 0.25 * consumers.length; why.push(`feeds ${consumers.map((c) => c.name).join(', ')}`); }
    if (ctx.core.has(g)) v += 0.3;
    if (!ctx.sources.has(g) && ctx.owned.some((p) => p.needs.includes(g))) { v += 0.4; why.push(`first source of ${g}`); }
  }
  for (const n of part.needs) {
    const n_sources = ctx.sources.get(n)?.length ?? 0;
    if (n_sources >= 2) v += 0.1;
  }
  // Stat stacking: a part that boosts a stat the build already boosts multiplies with it.
  for (const b of part.boosts) {
    const peers = (ctx.focus.get(b) ?? []).filter((p) => p.slug !== part.slug && p.family !== part.family);
    if (peers.length) { v += Math.min(0.3, 0.1 * peers.length); why.push(`stacks with ${peers.map((p) => p.name).join(', ')} (${b})`); }
  }
  return { value: v, why };
}

export function scorePart(part, ctx) {
  const reasons = [];
  if (part.is_fault) return { score: 0, reasons: ['fault'], eligible: false };
  if (part.variant_of) return { score: 0, reasons: ['duplicate listing'], eligible: false };
  if (part.plane_trait && ctx.cls?.slug !== 'podracer') return { score: 0, reasons: ['podracer only'], eligible: false };
  if (ctx.session.mode === 'campaign' && part.unlock_events > (ctx.session.events ?? 0)) return { score: 0, reasons: [`unlocks after ${part.unlock_events} events`], eligible: false };

  const sf = styleFit(part, ctx), en = enablement(part, ctx), po = payoff(part, ctx);
  const rv = part.plane_trait ? 1 : (RARITY_VALUE[part.rarity] ?? 0.6);
  let score = sf.value * en.value * po.value * rv;
  for (const r of [...sf.why, ...po.why]) if (!reasons.includes(r)) reasons.push(r);
  if (en.missing.length) reasons.push(`needs ${en.missing.join(' + ')} (no source)`);

  // Redundancy within family
  const ownedSame = ctx.ownedByFamily[part.family];
  let replaces = null, delta = score, redundant = false;
  if (ownedSame) {
    if ((ownedSame.tier ?? 0) >= (part.tier ?? 0)) { redundant = true; delta = 0; reasons.push(`already own ${ownedSame.name}`); }
    else { replaces = ownedSame; const prev = scoreRaw(ownedSame, ctx); delta = Math.max(0, score - prev); reasons.push(`upgrade over ${ownedSame.name}`); }
  }
  return { score, delta, replaces, ownedSame, redundant, eligible: true, reasons, components: { styleFit: sf.value, enablement: en.value, payoff: po.value, rarity: rv } };
}

function scoreRaw(part, ctx) {
  const sf = styleFit(part, ctx), en = enablement(part, ctx), po = payoff(part, ctx);
  return sf.value * en.value * po.value * (part.plane_trait ? 1 : (RARITY_VALUE[part.rarity] ?? 0.6));
}

// Marginal value of adding a part given slot pressure.
// Total value of a build (sum of installed part scores) for a given equipped list.
export function buildTotal(ctx, equipped) {
  const c = buildContext(ctx.data, { ...ctx.session, equipped });
  return installedScores(c).reduce((s, x) => s + x.score, 0);
}

// With every slot full: which installed part should make way for `part`? Re-scores the whole build for each
// candidate swap, so a part that feeds others (a Cooled source) is kept over a lone high scorer.
export function bestSwap(part, ctx) {
  const equipped = equippedSlugs(ctx.session);
  const before = buildTotal(ctx, equipped);
  const options = equipped.map((slug) => {
    const after = buildTotal(ctx, equipped.map((s) => (s === slug ? part.slug : s)));
    return { slug, part: ctx.partsBySlug[slug], gain: after - before };
  }).sort((a, b) => b.gain - a.gain);
  return { options, best: options[0] ?? null, before };
}

export function marginalValue(part, ctx, installedScores) {
  const r = scorePart(part, ctx);
  if (!r.eligible || r.redundant) return { ...r, marginal: 0 };
  if (r.replaces) return { ...r, marginal: r.delta, swapOut: r.replaces };
  const free = ctx.slots - ctx.owned.length;
  if (free > 0) return { ...r, marginal: r.score };
  const swap = bestSwap(part, ctx);
  return { ...r, marginal: Math.max(0, swap.best?.gain ?? 0), swapOut: swap.best?.part ?? null, swapOptions: swap.options };
}

export function installedScores(ctx) {
  return ctx.owned.map((part) => ({ part, score: scoreRaw(part, ctx) }));
}

export function rankPool(ctx) {
  const inst = installedScores(ctx);
  const ownedSlugs = new Set(ctx.owned.map((p) => p.slug));
  return ctx.data.parts
    .filter((p) => !ownedSlugs.has(p.slug))
    .map((p) => ({ part: p, ...marginalValue(p, ctx, inst) }))
    .filter((r) => r.eligible)
    .sort((a, b) => b.marginal - a.marginal);
}

// ---------- upgrades ----------
export function upgradeWeights(ctx) {
  const w = { Ramjet: 0.4, Afterburner: 0.4, Cornering: 0.4, Advanced: 0.4, Resilience: 0.4, Battery: 0.4 };
  const bump = (k, v) => { w[k] = Math.max(w[k], v); };
  const all = [...ctx.core, ...ctx.mechanics];
  for (const k of ctx.core) {
    if (['Ramjet', 'Redlining', 'Cooled', 'Frozen', 'Burning'].includes(k)) bump('Ramjet', 1);
    if (k === 'Afterburner') bump('Afterburner', 1);
    if (['Takedown', 'Collision', 'Crash', 'Shielded', 'LastCrash'].includes(k)) bump('Resilience', 0.9);
    if (['Ability', 'Energy'].includes(k)) bump('Battery', 0.9);
    if (['Slipstreaming', 'Surging', 'Cornering', 'Speed'].includes(k)) bump('Cornering', 0.7);
    if (['PerfectLanding', 'Airborne'].includes(k)) bump('Advanced', 0.8);
  }
  for (const k of all) {
    if (['Ramjet', 'Redlining'].includes(k)) bump('Ramjet', 0.7);
    if (k === 'Afterburner') bump('Afterburner', 0.7);
    if (['Takedown', 'Collision', 'Crash'].includes(k)) bump('Resilience', 0.6);
    if (['Ability', 'Energy'].includes(k)) bump('Battery', 0.6);
  }
  // Installed parts that boost a stat make its upgrade worth more (+0.15 per part, capped).
  for (const [b, parts] of ctx.focus ?? []) {
    const stat = BOOST_STAT[b];
    if (stat) w[stat] = Math.min(1.2, w[stat] + 0.15 * parts.length);
  }
  return w;
}
export const BOOST_STAT = { Afterburner: 'Afterburner', Ramjet: 'Ramjet', 'Ramjet-heat': 'Ramjet', Abilities: 'Battery', Energy: 'Battery', Cornering: 'Cornering', Collision: 'Resilience' };
export function upgradeStacks(ctx, stat) {
  const names = [];
  for (const [b, parts] of ctx.focus ?? []) if (BOOST_STAT[b] === stat) names.push(...parts.map((p) => p.name));
  return [...new Set(names)];
}

export function rankUpgrades(ctx) {
  const w = upgradeWeights(ctx);
  return TRACKS.map((track) => {
    const level = ctx.session.upgrades[track] ?? 0;
    const stat = TRACK_STAT[track];
    const statName = stat === 'Advanced' ? (ctx.cls?.advanced_stat ?? 'Advanced stat') : stat;
    const score = level >= 10 ? 0 : w[stat] * (1 - level / 12) * 0.9;
    return { track, stat: statName, level, score, weight: w[stat], stacks: upgradeStacks(ctx, stat) };
  }).sort((a, b) => b.score - a.score);
}

// ---------- abilities ----------
export function rankAbilities(ctx) {
  const owned = ctx.ownedAbilities;
  const cands = new Map();
  // Packs draw from every base (tier 1) ability you do not own, plus direct upgrades of abilities you do own.
  for (const a of ctx.data.abilities) if (a.tier === 1 && !owned.has(a.slug)) cands.set(a.slug, { a, from: null });
  for (const slug of owned) for (const to of ctx.abilitiesBySlug[slug]?.upgrades_to ?? []) if (!owned.has(to)) cands.set(to, { a: ctx.abilitiesBySlug[to], from: ctx.abilitiesBySlug[slug] });
  return [...cands.values()].map(({ a, from }) => {
    let fit = 0.3; const why = [];
    for (const k of [...a.grants, a.family]) {
      if (ctx.core.has(k)) { fit = Math.max(fit, 1); why.push(`${k} is core`); }
      else if (ctx.mechanics.has(k)) { fit = Math.max(fit, 0.6); why.push(`${k} fits style`); }
    }
    for (const g of a.grants) {
      const consumers = ctx.owned.filter((p) => p.needs.includes(g));
      if (consumers.length) { fit += 0.15 * consumers.length; why.push(`feeds ${consumers.length} part${consumers.length > 1 ? 's' : ''} needing ${g}`); }
    }
    if (a.family === 'Repair' || a.family === 'Shield') fit = Math.max(fit, 0.45);
    const score = fit * (0.6 + 0.2 * a.tier);
    return { ability: a, from, score, reasons: why };
  }).sort((a, b) => b.score - a.score);
}

// ---------- packs: k random options, you keep one ----------
// Expected value of the best option when k are drawn uniformly without replacement from `scores`.
export function packExpectedBest(scores, k) {
  const s = [...scores].sort((a, b) => b - a);
  const n = s.length;
  if (!n) return 0;
  k = Math.min(k, n);
  // P(best drawn = s[i]) = C(n-1-i, k-1) / C(n, k)
  let ev = 0;
  for (let i = 0; i < n; i++) ev += s[i] * (comb(n - 1 - i, k - 1) / comb(n, k));
  return ev;
}

// ---------- reroll analysis ----------
function comb(n, k) { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }

export function rerollAnalysis(ctx, ranked) {
  const k = offerSize(ctx.data, ctx.session);
  // With every slot full, marginal values are gains over a swap and run much lower than raw scores, so the bar drops.
  const full = ctx.slots - ctx.owned.length <= 0;
  const threshold = (ctx.session.settings.usefulThreshold ?? 0.45) * (full ? 0.35 : 1);
  const pool = ranked; // eligible, not owned
  const useful = pool.filter((r) => r.marginal >= threshold);
  const N = pool.length, U = useful.length;
  const pAtLeastOne = N === 0 ? 0 : 1 - comb(N - U, Math.min(k, N)) / comb(N, Math.min(k, N));
  const expectedUseful = N === 0 ? 0 : (U * Math.min(k, N)) / N;
  const meanUseful = U ? useful.reduce((s, r) => s + r.marginal, 0) / U : 0;
  const cost = prices(ctx.session).reroll;
  return { offerSize: k, poolSize: N, usefulCount: U, pAtLeastOne, expectedUseful, meanUseful, expectedValue: pAtLeastOne * meanUseful, cost, useful: useful.slice(0, 12) };
}

// ---------- decision table ----------
export function advise(data, session) {
  const ctx = buildContext(data, session);
  const pr = prices(session);
  const ranked = rankPool(ctx);
  const inst = installedScores(ctx);
  const offer = shopPartIds(session).map((slug) => ctx.partsBySlug[slug]).filter(Boolean).map((p) => {
    const r = marginalValue(p, ctx, inst);
    const price = pr.part(p.rarity);
    return { part: p, ...r, price, valuePerK: price ? (r.marginal / price) * 1000 : 0 };
  }).sort((a, b) => b.marginal - a.marginal);
  const upgrades = rankUpgrades(ctx).map((u) => ({ ...u, price: pr.upgrade, valuePerK: (u.score / pr.upgrade) * 1000 }));
  const abilities = rankAbilities(ctx).map((a) => ({ ...a, price: pr.ability, valuePerK: (a.score / pr.ability) * 1000 }));
  const reroll = rerollAnalysis(ctx, ranked);
  const options = [];
  if (offer[0]) options.push({ kind: 'buy', label: `Buy ${offer[0].part.name}`, value: offer[0].marginal, price: offer[0].price, valuePerK: offer[0].valuePerK, affordable: session.credits >= offer[0].price });
  if (upgrades[0]) options.push({ kind: 'upgrade', label: `Upgrade ${upgrades[0].track} (${upgrades[0].stat} +1)`, value: upgrades[0].score, price: pr.upgrade, valuePerK: upgrades[0].valuePerK, affordable: session.credits >= pr.upgrade });
  if (abilities[0]) options.push({ kind: 'ability', label: `${abilities[0].from ? 'Upgrade to' : 'Buy'} ${abilities[0].ability.name}`, value: abilities[0].score, price: pr.ability, valuePerK: abilities[0].valuePerK, affordable: session.credits >= pr.ability });
  options.push({ kind: 'reroll', label: `Reroll shop (${reroll.usefulCount} useful of ${reroll.poolSize} in pool)`, value: reroll.expectedValue, price: reroll.cost, valuePerK: reroll.cost ? (reroll.expectedValue / reroll.cost) * 1000 : 0, affordable: session.credits >= reroll.cost, pointless: reroll.usefulCount === 0 });
  options.sort((a, b) => b.valuePerK - a.valuePerK);
  return { ctx, prices: pr, offer, ranked, installed: inst, upgrades, abilities, reroll, options };
}
