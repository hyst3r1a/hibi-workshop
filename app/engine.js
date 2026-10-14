// GRBC engine: run state (event-sourced with undo), and evaluateRun() which turns the
// planner's scores into Recommendation objects with explanations. Pure: no DOM.
import * as P from './planner.js';

export const SCORE_UNIT = 'value per 1,000 CR';
const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- run state ----------
export function newRun(data, partial = {}) { return P.newSession(data, partial); }

// Accept v1 sessions (parts[]/offer[]) and v2 runs.
export function migrateRun(data, raw) {
  const run = { ...P.newSession(data), ...raw };
  if (raw.parts && !raw.equipped) {
    run.inventory = raw.parts.map((o) => ({ slug: o.slug, free: !!o.free }));
    run.equipped = raw.parts.map((o) => o.slug);
  }
  if (raw.offer && !raw.shop) run.shop = { status: 'known', partIds: raw.offer };
  run.settings = { ...structuredClone(P.DEFAULT_SETTINGS), ...(raw.settings ?? {}), partPrice: { ...P.DEFAULT_SETTINGS.partPrice, ...(raw.settings?.partPrice ?? {}) } };
  run.settings.saveFloor ??= 0.2;
  run.settings.packSize ??= 3;
  run.settings.baseSlots ??= 4;
  // Older runs defaulted 'events completed' to 0, which hid most of the part pool. Treat 0 as 'all unlocked'.
  if (!run.events) run.events = 999;
  // Inventory is gone: anything owned is installed. Fold legacy inventory into equipped up to the slot limit.
  if (run.inventory?.length) { for (const o of run.inventory) if (!run.equipped.includes(o.slug) && run.equipped.length < P.slotCount(data, run)) run.equipped.push(o.slug); run.inventory = []; }
  run.pending ??= null;
  run.favourPicks ??= [];
  run.favours ??= { gadgeteer: 0, bloodyBounty: 0 };
  run.inventory ??= []; run.equipped ??= []; run.shop ??= { status: 'known', partIds: [] };
  run.history ??= []; run.revision ??= 0;
  delete run.parts; delete run.offer; delete run.log;
  return run;
}

function snapshot(run) { const { history, ...rest } = run; return structuredClone(rest); }

// Apply an event to the run (mutates), recording it in history with an undo snapshot.
export function commit(run, event) {
  const before = snapshot(run);
  apply(run, event);
  run.revision = (run.revision ?? 0) + 1;
  run.history.push({ id: uid(), at: Date.now(), ...event, before });
  if (run.history.length > 200) run.history.splice(0, run.history.length - 200);
  for (let i = 0; i < run.history.length - 40; i++) delete run.history[i].before; // keep undo depth bounded
  return run;
}

export function canUndo(run) { const last = run.history[run.history.length - 1]; return !!(last && last.before); }
export function undo(run) {
  const last = run.history.pop();
  if (!last?.before) return run;
  const history = run.history, rev = run.revision ?? 0;
  for (const k of Object.keys(run)) if (k !== 'history') delete run[k];
  Object.assign(run, last.before, { history, revision: rev + 1 });
  return run;
}

function apply(run, e) {
  const spend = (c) => { run.credits = Math.max(0, (run.credits || 0) - (c || 0)); };
  const equip = (slug, replace) => {
    if (run.equipped.includes(slug)) return;
    if (replace) run.equipped = run.equipped.filter((s) => s !== replace);
    run.equipped.push(slug);
  };
  switch (e.type) {
    case 'shop-rerolled': spend(e.cost); run.counters.rerolls++; run.shop = { status: 'awaiting-offer', partIds: [] }; break;
    case 'shop-offer-observed': run.shop = { status: 'known', partIds: [...new Set(e.partIds)] }; break;
    case 'part-purchased':
      spend(e.cost); run.counters.parts++;
      if (!run.inventory.some((o) => o.slug === e.partId)) run.inventory.push({ slug: e.partId, free: false });
      if (run.shop.status === 'known') run.shop.partIds = run.shop.partIds.filter((s) => s !== e.partId);
      if (e.equip) equip(e.partId, e.replace);
      break;
    case 'part-acquired':
      if (!run.inventory.some((o) => o.slug === e.partId)) run.inventory.push({ slug: e.partId, free: true, source: e.source ?? 'free' });
      if (run.shop.status === 'known') run.shop.partIds = run.shop.partIds.filter((s) => s !== e.partId);
      if (e.equip) equip(e.partId, e.replace);
      break;
    case 'part-equipped': equip(e.partId, e.replace); break;
    case 'part-unequipped': run.equipped = run.equipped.filter((s) => s !== e.partId); break;
    case 'part-discarded': run.equipped = run.equipped.filter((s) => s !== e.partId); run.inventory = run.inventory.filter((o) => o.slug !== e.partId); break;
    case 'upgrade-purchased': spend(e.cost); run.counters.upgrades++; run.upgrades[e.track] = Math.min(10, (run.upgrades[e.track] ?? 0) + 1); break;
    case 'upgrade-pack-purchased': spend(e.cost); if (!e.free) run.counters.upgrades++; run.pending = { kind: 'upgrade', cost: e.cost, free: !!e.free }; break;
    case 'upgrade-chosen': run.upgrades[e.track] = Math.min(10, (run.upgrades[e.track] ?? 0) + 1); run.pending = null; break;
    case 'ability-pack-purchased': spend(e.cost); if (!e.free) run.counters.abilities++; run.pending = { kind: 'ability', cost: e.cost, free: !!e.free }; break;
    case 'ability-chosen': { if (e.replaces) for (const r of e.replaces) run.abilities = run.abilities.filter((s) => s !== r); if (!run.abilities.includes(e.abilityId)) run.abilities.push(e.abilityId); run.pending = null; break; }
    case 'pack-discarded': run.pending = null; break;
    case 'ability-purchased':
    case 'ability-acquired': {
      if (e.type === 'ability-purchased') { spend(e.cost); run.counters.abilities++; }
      if (e.replaces) for (const r of e.replaces) run.abilities = run.abilities.filter((s) => s !== r);
      if (!run.abilities.includes(e.abilityId)) run.abilities.push(e.abilityId);
      break;
    }
    case 'ability-removed': run.abilities = run.abilities.filter((s) => s !== e.abilityId); break;
    case 'round-reset': run.counters = { parts: 0, rerolls: 0, upgrades: 0, abilities: 0 }; if (run.shop.status === 'awaiting-offer') run.shop = { status: 'known', partIds: [] }; break;
    case 'correction': {
      // Manual edit of run details: e.path like 'credits' | 'settings.reroll.base' | 'upgrades.Power Cell'; or e.set = { path: value, ... }
      const entries = e.set ? Object.entries(e.set) : [[e.path, e.value]];
      for (const [path, value] of entries) {
        const keys = path.split('.'); let o = run;
        for (const k of keys.slice(0, -1)) o = o[k] ??= {};
        o[keys[keys.length - 1]] = value;
      }
      break;
    }
    default: throw new Error(`unknown event ${e.type}`);
  }
}

export function describeEvent(data, e) {
  const part = (id) => data.parts.find((p) => p.slug === id)?.name ?? id;
  const ab = (id) => data.abilities.find((a) => a.slug === id)?.name ?? id;
  const cr = (c) => (c ? ` −${Number(c).toLocaleString('en-US')} CR` : '');
  switch (e.type) {
    case 'shop-rerolled': return `Rerolled shop${cr(e.cost)}`;
    case 'shop-offer-observed': return `Shop offer: ${e.partIds.map(part).join(', ') || '(empty)'}`;
    case 'part-purchased': return `Bought ${part(e.partId)}${cr(e.cost)}${e.equip ? ' and equipped' : ''}${e.replace ? ` (replacing ${part(e.replace)})` : ''}`;
    case 'part-acquired': return `Acquired ${part(e.partId)} (${e.source ?? 'free'})${e.equip ? ', equipped' : ''}`;
    case 'part-equipped': return `Equipped ${part(e.partId)}${e.replace ? ` over ${part(e.replace)}` : ''}`;
    case 'part-unequipped': return `Unequipped ${part(e.partId)}`;
    case 'part-discarded': return `Removed ${part(e.partId)} from the run`;
    case 'upgrade-purchased': return `Upgraded ${e.track}${cr(e.cost)}`;
    case 'upgrade-pack-purchased': return `${e.free ? 'Opened a free upgrade pack' : 'Bought an upgrade pack'}${cr(e.cost)}`;
    case 'upgrade-chosen': return `Took ${e.stat ?? e.track} +1 from the pack`;
    case 'ability-pack-purchased': return `${e.free ? 'Opened a free ability pack' : 'Bought an ability pack'}${cr(e.cost)}`;
    case 'ability-chosen': return `Took ${ab(e.abilityId)} from the pack`;
    case 'pack-discarded': return 'Closed the pack without picking';
    case 'ability-purchased': return `Bought ${ab(e.abilityId)}${cr(e.cost)}`;
    case 'ability-acquired': return `Acquired ${ab(e.abilityId)} (free)`;
    case 'ability-removed': return `Removed ${ab(e.abilityId)}`;
    case 'round-reset': return 'Round reset (new shop visit)';
    case 'correction': { const ent = e.set ? Object.entries(e.set) : [[e.path, e.value]]; return `Set ${ent.map(([p, v]) => `${p.split('.').pop()} → ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')}`; }
    default: return e.type;
  }
}

// ---------- evaluation ----------
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fmt = (n) => Number(n).toLocaleString('en-US');
const f2 = (x) => Number(x).toFixed(2);

function rerollExplanation(r, ctx) {
  const N = r.poolSize, U = r.usefulCount, k = Math.min(r.offerSize, N);
  return {
    summary: `${U} useful parts in a pool of ${N}. ${pct(r.pAtLeastOne)} chance the new offer shows at least one.`,
    details: [
      `Offer size: ${r.offerSize} distinct parts, drawn without replacement (assumption).`,
      `Pool: every part ${(ctx.session.events ?? 999) >= 999 ? 'in the game' : `unlocked by ${ctx.session.events} completed events`}, eligible for this class, not already owned at equal or higher tier (${N}).`,
      `Useful: pool parts whose marginal value is ≥ ${(ctx.slots - ctx.owned.length <= 0 ? (ctx.session.settings.usefulThreshold ?? 0.45) * 0.35 : (ctx.session.settings.usefulThreshold ?? 0.45)).toFixed(2)} (${U})${ctx.slots - ctx.owned.length <= 0 ? ' — the bar is lowered while every slot is full, since values are gains over a swap' : ''}.`,
      `P(≥1 useful) = 1 − C(${N - U}, ${k}) / C(${N}, ${k}) = ${pct(r.pAtLeastOne)}; P(none) = ${pct(1 - r.pAtLeastOne)}.`,
      `Expected useful parts per offer: ${f2(r.expectedUseful)}. Mean marginal value of a useful part: ${f2(r.meanUseful)}.`,
      `Expected value = P(≥1 useful) × mean useful value = ${f2(r.expectedValue)}. Divided by the reroll price (${fmt(r.cost)} CR) → ${f2((r.expectedValue / r.cost) * 1000)} ${SCORE_UNIT}.`,
      'Probability is not expected value: a useful part still has to be affordable and better than what the slot holds. The shop generation rules are assumed uniform; if the game weights rarity, the real odds differ.',
    ],
    formula: `P = 1 − C(${N - U}, ${k}) / C(${N}, ${k})`,
  };
}

function partExplanation(o, ctx, slotsFree) {
  const c = o.components ?? {};
  const d = [
    `Style fit ${f2(c.styleFit ?? 0)} × enablement ${f2(c.enablement ?? 0)} × payoff ${f2(c.payoff ?? 0)} × rarity ${f2(c.rarity ?? 0)} = score ${f2(o.score ?? 0)}.`,
    ...(o.reasons ?? []).map((r) => `• ${r}`),
  ];
  if (o.replaces) d.push(`Marginal value is the gain over ${o.replaces.name} already installed: ${f2(o.marginal)}.`);
  else if (!slotsFree && o.swapOut) d.push(`All ${ctx.slots} slots are full: every swap was re-scored as a whole build, and swapping out ${o.swapOut.name} loses the least (net ${f2(o.marginal)}). Parts that feed other parts are kept over lone high scorers.`);
  else if (o.redundant) d.push('Already owned at equal or higher tier: no marginal value.');
  else d.push(`A free slot is available, so the full score counts (${f2(o.marginal)}).`);
  if (o.price) d.push(`${f2(o.marginal)} ÷ ${fmt(o.price)} CR × 1000 = ${f2(o.valuePerK)} ${SCORE_UNIT}.`);
  return { summary: (o.reasons ?? []).slice(0, 2).join(' · ') || 'No specific synergy with this style.', details: d };
}

export function evaluateRun(data, run) {
  const adv = P.advise(data, run);
  const { ctx, prices: pr } = adv;
  const slotsFree = ctx.slots - ctx.owned.length;
  const shopKnown = run.shop.status === 'known';
  const recs = [];
  const base = (kind, title, cost, value, targetId) => ({
    id: `${kind}:${targetId ?? ''}`, kind, title, cost, value, score: cost ? (value / cost) * 1000 : 0, scoreUnit: SCORE_UNIT,
    eligible: true, blockingReasons: [], rationale: [], metrics: {}, explain: null, targetId, revision: run.revision,
  });
  const block = (r, why) => { r.eligible = false; r.blockingReasons.push(why); return r; };

  // Buy part (one per visible offer)
  for (const o of adv.offer) {
    const r = base('buy-part', `Buy ${o.part.name}`, o.price, o.marginal, o.part.slug);
    r.part = o.part; r.metrics = { marginal: o.marginal, score: o.score, components: o.components, replaces: o.replaces?.slug ?? null, swapOut: o.swapOut?.slug ?? null, swapOptions: (o.swapOptions ?? []).map((x) => ({ slug: x.slug, name: x.part?.name, gain: x.gain })), slotsFree };
    r.rationale = o.reasons ?? []; r.explain = partExplanation(o, ctx, slotsFree > 0);
    if (!o.eligible) block(r, o.reasons?.[0] ?? 'not eligible');
    else if (o.redundant) block(r, `already own ${o.ownedSame?.name ?? 'this family'} at equal or higher tier`);
    if (run.credits < o.price) block(r, `needs ${fmt(o.price - run.credits)} more CR`);
    recs.push(r);
  }
  if (!shopKnown) {
    const r = base('buy-part', 'Buy from shop', 0, 0, null);
    block(r, 'awaiting the new shop offer'); r.explain = { summary: 'Enter the parts the dealer now shows to rank them.', details: [] };
    recs.push(r);
  }

  const k = run.settings.packSize ?? 3;
  const pending = run.pending ?? null;

  // Upgrade pack: k random stats (not yet maxed), keep one.
  {
    const options = adv.upgrades.filter((u) => u.level < 10).map((u) => ({ track: u.track, stat: u.stat, level: u.level, score: u.score, weight: u.weight, stacks: u.stacks }));
    const ev = P.packExpectedBest(options.map((o) => o.score), k);
    const r = base('upgrade', 'Upgrade pack', pr.upgrade, ev, 'pack');
    r.options = options; r.metrics = { packSize: k, expectedBest: ev, bestSingle: options[0]?.score ?? 0, bestStat: options[0]?.stat ?? null };
    r.rationale = options.slice(0, 3).map((o) => `${o.stat} +1 → ${f2(o.score)}`);
    r.explain = { summary: options.length ? `${Math.min(k, options.length)} random stats offered, you keep one. Best case ${options[0].stat} +1.` : 'Every stat is maxed.', details: [
      `Pool: ${options.length} stats not yet at +10 (${options.map((o) => `${o.stat} ${f2(o.score)}${o.stacks.length ? ` ← stacks with ${o.stacks.join(', ')}` : ''}`).join('; ')}).`,
      `Each stat score = style weight × (1 − level/12) × 0.9.`,
      `Expected best of ${Math.min(k, options.length)} = Σ score(i) × P(i is the best drawn) = ${f2(ev)} (best possible single pick ${f2(options[0]?.score ?? 0)}).`,
      `Price this visit: ${fmt(pr.upgrade)} CR (base ${fmt(run.settings.upgrade.base)} + ${fmt(run.settings.upgrade.step)} × ${run.counters.upgrades} bought). ${f2(ev)} ÷ ${fmt(pr.upgrade)} × 1000 = ${f2(r.score)} ${SCORE_UNIT}.`,
      'Assumes the pack draws uniformly from the non-maxed stats. Favours and encounters can change the pack size (Setup → pack size).',
    ] };
    if (!options.length) block(r, 'all stats maxed');
    if (pending) block(r, `pick from the open ${pending.kind} pack first`);
    if (run.credits < pr.upgrade) block(r, `needs ${fmt(pr.upgrade - run.credits)} more CR`);
    recs.push(r);
  }

  // Ability pack: k random abilities (bases you lack, upgrades of bases you own), keep one.
  {
    const options = adv.abilities.map((a) => ({ ability: a.ability, from: a.from, score: a.score, reasons: a.reasons }));
    const ev = P.packExpectedBest(options.map((o) => o.score), k);
    const r = base('buy-ability', 'Ability pack', pr.ability, ev, 'pack');
    r.options = options; r.metrics = { packSize: k, expectedBest: ev, bestSingle: options[0]?.score ?? 0, bestName: options[0]?.ability.name ?? null };
    r.rationale = options.slice(0, 3).map((o) => `${o.ability.name} → ${f2(o.score)}`);
    r.explain = { summary: options.length ? `${Math.min(k, options.length)} random abilities offered, you keep one. Best case ${options[0].ability.name}.` : 'Nothing left to draw.', details: [
      `Pool: ${options.length} (base abilities you do not own, plus upgrades of abilities you own).`,
      `Top of pool: ${options.slice(0, 5).map((o) => `${o.ability.name} ${f2(o.score)}`).join(', ')}.`,
      `Expected best of ${Math.min(k, options.length)} = ${f2(ev)}; best possible single pick ${f2(options[0]?.score ?? 0)}.`,
      `Price this visit: ${fmt(pr.ability)} CR. ${f2(ev)} ÷ ${fmt(pr.ability)} × 1000 = ${f2(r.score)} ${SCORE_UNIT}.`,
      'An upgraded ability can only appear once you own its base version.',
    ] };
    if (!options.length) block(r, 'nothing left to draw');
    if (pending) block(r, `pick from the open ${pending.kind} pack first`);
    if (run.credits < pr.ability) block(r, `needs ${fmt(pr.ability - run.credits)} more CR`);
    recs.push(r);
  }

  // Reroll
  {
    const rr = adv.reroll;
    const r = base('reroll', 'Reroll shop', rr.cost, rr.expectedValue, null);
    r.metrics = { usefulOfferChance: rr.pAtLeastOne, expectedUseful: rr.expectedUseful, meanUseful: rr.meanUseful, poolSize: rr.poolSize, usefulCount: rr.usefulCount, offerSize: rr.offerSize, expectedGain: rr.expectedValue };
    r.rationale = [`${rr.usefulCount} useful parts in the pool of ${rr.poolSize}`, `${pct(rr.pAtLeastOne)} chance of ≥1 useful part in ${rr.offerSize}`];
    r.explain = rerollExplanation(rr, ctx);
    r.wishlist = rr.useful.map((x) => x.part.slug);
    if (rr.usefulCount === 0) block(r, 'nothing useful left in the pool');
    if (run.credits < rr.cost) block(r, `needs ${fmt(rr.cost - run.credits)} more CR`);
    recs.push(r);
  }

  // Save credits
  {
    const floor = run.settings.saveFloor ?? 0.2;
    const r = base('save-credits', 'Save credits', 0, 0, null);
    r.score = floor; r.metrics = { floor };
    r.rationale = [`Nothing above ${f2(floor)} ${SCORE_UNIT} is worth it right now`];
    r.explain = { summary: `Ranked at the saving floor of ${f2(floor)} ${SCORE_UNIT} (editable). Anything scoring below it is a worse use of credits than waiting.`, details: [
      `Next prices this round: reroll ${fmt(pr.reroll)}, upgrade ${fmt(pr.upgrade)}, ability ${fmt(pr.ability)} CR.`,
      'Prices reset on the next shop visit, so saving also buys cheaper rerolls and upgrades later.',
    ] };
    recs.push(r);
  }

  // Rank: eligible by score desc, then blocked by score desc
  recs.sort((a, b) => (b.eligible - a.eligible) || (b.score - a.score));
  const top = recs.find((r) => r.eligible);
  for (const r of recs) {
    if (r === top) continue;
    r.whyNot = top ? (r.eligible
      ? `${top.title} gives ${f2(top.score)} ${SCORE_UNIT} versus ${f2(r.score)} here${r.kind === 'upgrade' ? ' — guaranteed, but less projected utility per credit' : ''}.`
      : `Not available: ${r.blockingReasons.join('; ')}.`) : '';
  }

  // Open pack (bought, not yet picked): the ranked option list the picker shows.
  let pendingPack = null;
  if (pending) {
    const rec = recs.find((r) => r.kind === (pending.kind === 'upgrade' ? 'upgrade' : 'buy-ability'));
    pendingPack = { kind: pending.kind, options: rec?.options ?? [], packSize: k };
  }
  return { revision: run.revision, recommendations: recs, top, ctx, prices: pr, offer: adv.offer, wishlist: adv.ranked.slice(0, 40), ranked: adv.ranked, installed: adv.installed, upgrades: adv.upgrades, abilities: adv.abilities, reroll: adv.reroll, shop: run.shop, slotsFree, pendingPack };
}
