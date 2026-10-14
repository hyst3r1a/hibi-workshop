import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as E from '../app/engine.js';
import * as P from '../app/planner.js';

const data = JSON.parse(await readFile(new URL('../app/data.json', import.meta.url), 'utf8'));
const mk = (partial) => E.newRun(data, { style: 'redliner', vehicle: 'arz-41', credits: 6000, events: 30, ...partial });

test('a full Weaponized build still finds its Takedown parts', () => {
  const run = E.newRun(data, { style: 'weaponized', vehicle: 'arz-41', credits: 9000, equipped: ['ramming-jet-iii', 'plug-f-power-cell', 'faster-attachments-ii', 'scrap-recycler-ii'] });
  assert.equal(run.events, 999);
  const ev = E.evaluateRun(data, run);
  const top = ev.wishlist.slice(0, 14).map((r) => r.part.family);
  assert.ok(top.includes('Cooling Actuator') && top.includes('Lethal Velocity') && top.includes('Fuel Agitator'), top.join(', '));
  assert.ok(ev.reroll.usefulCount > 0, 'useful parts exist with a full build');
  const old = E.migrateRun(data, { id: 'o', style: 'weaponized', vehicle: 'arz-41', events: 0 });
  assert.equal(old.events, 999);
});

test('reroll probability follows 1 - C(N-U,k)/C(N,k)', () => {
  const run = mk({});
  const ev = E.evaluateRun(data, run);
  const r = ev.recommendations.find((x) => x.kind === 'reroll');
  const { poolSize: N, usefulCount: U, offerSize: k } = r.metrics;
  const C = (n, kk) => { let v = 1; for (let i = 1; i <= kk; i++) v = (v * (n - kk + i)) / i; return v; };
  assert.ok(N > 0 && U > 0);
  assert.ok(Math.abs(r.metrics.usefulOfferChance - (1 - C(N - U, k) / C(N, k))) < 1e-9);
  assert.equal(r.score, (r.value / r.cost) * 1000);
});

test('insufficient credits keeps the recommendation but marks it ineligible', () => {
  const run = mk({ credits: 100, shop: { status: 'known', partIds: ['ramjet-accelerator-i'] } });
  const ev = E.evaluateRun(data, run);
  const buy = ev.recommendations.find((x) => x.kind === 'buy-part');
  assert.equal(buy.eligible, false);
  assert.match(buy.blockingReasons[0], /more CR/);
  assert.ok(ev.recommendations.indexOf(buy) > ev.recommendations.indexOf(ev.recommendations.find((x) => x.kind === 'save-credits')));
});

test('awaiting shop offer: no shop purchase is presented as available', () => {
  const run = mk({});
  E.commit(run, { type: 'shop-rerolled', cost: 250 });
  assert.equal(run.shop.status, 'awaiting-offer');
  assert.equal(run.credits, 5750);
  const ev = E.evaluateRun(data, run);
  const buys = ev.recommendations.filter((x) => x.kind === 'buy-part');
  assert.ok(buys.every((b) => !b.eligible));
  assert.ok(ev.recommendations.some((x) => x.kind === 'upgrade' && x.eligible));
  E.commit(run, { type: 'shop-offer-observed', partIds: ['surging-alarm-i', 'spark-plugs-i'] });
  assert.equal(run.shop.status, 'known');
  assert.ok(E.evaluateRun(data, run).recommendations.some((x) => x.kind === 'buy-part' && x.eligible));
});

test('save credits can be the top recommendation', () => {
  const run = mk({ credits: 2000, events: 0, shop: { status: 'known', partIds: ['spark-plugs-i'] } });
  run.settings.saveFloor = 5; // absurd floor forces it to the top
  const ev = E.evaluateRun(data, run);
  assert.equal(ev.top.kind, 'save-credits');
});

test('four base slots, Gadgeteer adds up to two; buying into a full build swaps a part out', () => {
  const run = mk({ shop: { status: 'known', partIds: ['ramjet-power-i'] } });
  assert.equal(P.slotCount(data, run), 4);
  run.favours.gadgeteer = 2;
  assert.equal(P.slotCount(data, run), 6);
  run.favours.gadgeteer = 0;
  E.commit(run, { type: 'part-purchased', partId: 'ramjet-power-i', cost: 2000, equip: true });
  assert.deepEqual(run.equipped, ['ramjet-power-i']);
  assert.deepEqual(run.shop.partIds, []);
  run.equipped = ['ramjet-power-i', 'extended-alarm-i', 'spark-plugs-i', 'enriched-fuel-i'];
  E.commit(run, { type: 'part-purchased', partId: 'redlining-power', cost: 3000, equip: true, replace: 'spark-plugs-i' });
  assert.equal(run.equipped.length, 4);
  assert.ok(run.equipped.includes('redlining-power') && !run.equipped.includes('spark-plugs-i'));
});

test('best swap keeps a part that feeds others', () => {
  // Phase-change Radiators is the only Cooled source; Ramjet Accelerator needs Cooled. Swapping the source out would gut the accelerator.
  const run = mk({ events: 200, equipped: ['phase-change-radiators-i', 'ramjet-accelerator-i', 'spark-plugs-i', 'enriched-fuel-i'], shop: { status: 'known', partIds: ['redlining-power'] } });
  const ev = E.evaluateRun(data, run);
  const rec = ev.recommendations.find((r) => r.targetId === 'redlining-power');
  assert.ok(rec.eligible);
  assert.notEqual(rec.metrics.swapOut, 'phase-change-radiators-i');
  assert.ok(['spark-plugs-i', 'enriched-fuel-i'].includes(rec.metrics.swapOut));
  assert.equal(rec.metrics.swapOptions.length, 4);
  assert.ok(rec.metrics.swapOptions[0].gain >= rec.metrics.swapOptions[3].gain);
});

test('duplicate ownership: same family at equal or higher tier is redundant', () => {
  const run = mk({ events: 200, equipped: ['ramjet-power-ii'], inventory: [{ slug: 'ramjet-power-ii' }], shop: { status: 'known', partIds: ['ramjet-power-i', 'ramjet-power-iii'] } });
  const ev = E.evaluateRun(data, run);
  const low = ev.recommendations.find((x) => x.targetId === 'ramjet-power-i');
  const high = ev.recommendations.find((x) => x.targetId === 'ramjet-power-iii');
  assert.equal(low.eligible, false);
  assert.ok(high.eligible && high.value > 0 && high.metrics.replaces === 'ramjet-power-ii');
});

test('undo restores credits, counters and shop state; revision always moves forward', () => {
  const run = mk({});
  const r0 = run.revision;
  E.commit(run, { type: 'upgrade-purchased', track: 'Turbojet Manifold', cost: 1500 });
  assert.equal(run.credits, 4500); assert.equal(run.upgrades['Turbojet Manifold'], 1); assert.equal(run.counters.upgrades, 1);
  E.commit(run, { type: 'shop-rerolled', cost: 250 });
  E.undo(run);
  assert.equal(run.credits, 4500); assert.equal(run.shop.status, 'known');
  E.undo(run);
  assert.equal(run.credits, 6000); assert.equal(run.upgrades['Turbojet Manifold'], 0); assert.equal(run.counters.upgrades, 0);
  assert.ok(run.revision > r0 + 2);
});

test('corrections are recorded separately and invalidate recommendation revisions', () => {
  const run = mk({});
  const ev = E.evaluateRun(data, run);
  E.commit(run, { type: 'correction', path: 'credits', value: 100 });
  assert.equal(run.credits, 100);
  assert.notEqual(ev.revision, run.revision);
  assert.equal(run.history.at(-1).type, 'correction');
});

test('round reset zeroes counters and prices', () => {
  const run = mk({});
  E.commit(run, { type: 'shop-rerolled', cost: 250 });
  E.commit(run, { type: 'shop-rerolled', cost: 500 });
  assert.equal(P.prices(run).reroll, 750);
  E.commit(run, { type: 'round-reset' });
  assert.equal(P.prices(run).reroll, 250);
  assert.equal(run.shop.status, 'known');
});

test('v1 session migrates to v2 run', () => {
  const run = E.migrateRun(data, { id: 'x', name: 'old', mode: 'campaign', style: 'redliner', vehicle: 'arz-41', credits: 1, parts: [{ slug: 'ramjet-power-i', free: true }], offer: ['spark-plugs-i'], settings: { reroll: { base: 300, step: 300 } } });
  assert.deepEqual(run.equipped, ['ramjet-power-i']);
  assert.deepEqual(run.inventory, []);
  assert.deepEqual(run.shop, { status: 'known', partIds: ['spark-plugs-i'] });
  assert.equal(run.settings.reroll.base, 300);
  assert.equal(run.settings.partPrice.Epic, 3000);
});

test('pack expected-best matches brute force', () => {
  const scores = [0.9, 0.5, 0.36, 0.36, 0.2, 0.1];
  // brute force over all 3-combos
  let sum = 0, n = 0;
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) { sum += Math.max(scores[a], scores[b], scores[c]); n++; }
  assert.ok(Math.abs(P.packExpectedBest(scores, 3) - sum / n) < 1e-12);
  assert.equal(P.packExpectedBest([0.4], 3), 0.4);
  assert.equal(P.packExpectedBest([], 3), 0);
});

test('upgrade pack: buy, then pick one of the offered stats; pending blocks a second pack', () => {
  const run = mk({});
  let ev = E.evaluateRun(data, run);
  const up = ev.recommendations.find((r) => r.kind === 'upgrade');
  assert.equal(up.title, 'Upgrade pack');
  assert.ok(up.options.length === 6 && up.value > 0 && up.value <= up.metrics.bestSingle);
  E.commit(run, { type: 'upgrade-pack-purchased', cost: up.cost });
  assert.equal(run.credits, 4500); assert.equal(run.counters.upgrades, 1); assert.equal(run.pending.kind, 'upgrade');
  ev = E.evaluateRun(data, run);
  assert.ok(ev.pendingPack && ev.pendingPack.options.length === 6);
  assert.equal(ev.recommendations.find((r) => r.kind === 'upgrade').eligible, false);
  E.commit(run, { type: 'upgrade-chosen', track: 'Turbojet Manifold', stat: 'Ramjet' });
  assert.equal(run.upgrades['Turbojet Manifold'], 1); assert.equal(run.pending, null);
  assert.equal(P.prices(run).upgrade, 2500);
});

test('ability pack pool: bases you lack plus upgrades of bases you own', () => {
  const run = mk({ abilities: ['surge'] });
  const ev = E.evaluateRun(data, run);
  const pack = ev.recommendations.find((r) => r.kind === 'buy-ability');
  const names = pack.options.map((o) => o.ability.slug);
  assert.ok(names.includes('impact-surge') && names.includes('overtaking-surge'), 'upgrades of owned Surge');
  assert.ok(names.includes('vent') && !names.includes('surge'), 'bases not owned, owned excluded');
  assert.ok(!names.includes('impact-surge-ii'), 'tier-3 needs its tier-2 base');
  E.commit(run, { type: 'ability-pack-purchased', cost: 0, free: true });
  assert.equal(run.credits, 6000); assert.equal(run.counters.abilities, 0);
  E.commit(run, { type: 'ability-chosen', abilityId: 'impact-surge', replaces: ['surge'] });
  assert.deepEqual(run.abilities, ['impact-surge']); assert.equal(run.pending, null);
});
