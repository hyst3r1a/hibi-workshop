import * as P from './planner.js';
import * as E from './engine.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');
const f2 = (x) => Number(x).toFixed(2);
const KEY = 'grbc.v1';
// Images: local mirror (app/assets, see scripts/fetch-assets.mjs) unless a bundle points at the fan database.
const ASSET_BASE = window.GRBC_ASSET_BASE ?? './assets';
const ASSET_PREFIX = '/storage/sites/galacticracer';
const FAV_GADGETEER = 'mechanicfavourb', FAV_BLOODY = 'sponsor03favour';

let data, store, run, kwRegex;
// presentation-only state (never triggers evaluation)
const ui = { tab: 'wish', gtab: 'run', classTab: null, selected: null, expanded: false, confirm: null, eval: null, query: '' };

// ---------- persistence ----------
function load() {
  try { store = JSON.parse(localStorage.getItem(KEY)) || null; } catch { store = null; }
  if (!store || !store.sessions || !Object.keys(store.sessions).length) {
    const r = E.newRun(data, { name: 'Run 1' });
    store = { sessions: { [r.id]: r }, current: r.id };
  }
  for (const id of Object.keys(store.sessions)) store.sessions[id] = E.migrateRun(data, store.sessions[id]);
  run = store.sessions[store.current] ?? Object.values(store.sessions)[0];
  store.current = run.id;
  ui.selected = null; ui.confirm = null; ui.expanded = false;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* storage unavailable */ } }
function commit(event) { E.commit(run, event); ui.confirm = null; evaluate(); render(); }
function correct(set) { commit({ type: 'correction', set }); }
function evaluate() { ui.eval = E.evaluateRun(data, run); if (ui.selected && !recById(ui.selected)) ui.selected = null; }

// ---------- helpers ----------
const partBySlug = (slug) => data.parts.find((p) => p.slug === slug);
const abilityBySlug = (slug) => data.abilities.find((a) => a.slug === slug);
const recById = (id) => ui.eval.recommendations.find((r) => r.id === id);
const inInventory = (slug) => run.inventory.some((o) => o.slug === slug);
const isEquipped = (slug) => run.equipped.includes(slug);
const img = (src, cls) => src ? `<img class="${cls}" src="${ASSET_BASE}${esc(src.startsWith(ASSET_PREFIX) ? src.slice(ASSET_PREFIX.length) : src)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="${cls}"></span>`;
const chip = (p) => `<span class="chip ${esc(p.rarity)}">${esc(p.rarity)}${p.tier ? ' ' + p.tier : ''}</span>`;
function hl(text) { return esc(text).replace(kwRegex, (m) => `<em class="kw">${m}</em>`); }
const KIND_LABEL = { reroll: 'Restock', 'buy-part': 'Buy part', upgrade: 'Upgrade pack', 'buy-ability': 'Ability pack', 'save-credits': 'Save credits' };
const openDlg = (id) => { const d = $(id); if (!d.open) d.showModal(); };
const closeDlg = (id) => { const d = $(id); if (d.open) d.close(); };
const statName = (track) => ui.eval.upgrades.find((u) => u.track === track)?.stat ?? track;
const favRank = (slug) => run.favourPicks.find((f) => f.slug === slug)?.rank ?? 0;

// ---------- actions ----------
function showRec(id, { confirm = false } = {}) {
  const rec = recById(id); if (!rec) return;
  ui.selected = id; ui.expanded = false;
  ui.confirm = confirm && rec.eligible && rec.kind !== 'save-credits' ? { recId: id, equip: ui.eval.slotsFree > 0 } : null;
  renderDetail(); openDlg('detailDlg');
}
function performConfirmed(rec, opts) {
  if (rec.revision !== run.revision) { ui.confirm = null; evaluate(); render(); renderDetail(); return; }
  switch (rec.kind) {
    case 'reroll': closeDlg('detailDlg'); commit({ type: 'shop-rerolled', cost: rec.cost }); ui.tab = 'offer'; render(); $('offerSearch')?.focus(); break;
    case 'buy-part': closeDlg('detailDlg'); commit({ type: 'part-purchased', partId: rec.targetId, cost: rec.cost, equip: true, replace: ui.eval.slotsFree <= 0 ? (opts.replace || rec.metrics.swapOut || run.equipped[run.equipped.length - 1]) : undefined }); break;
    case 'upgrade': commit({ type: 'upgrade-pack-purchased', cost: rec.cost }); openPicker(); break;
    case 'buy-ability': commit({ type: 'ability-pack-purchased', cost: rec.cost }); openPicker(); break;
  }
}
function openPicker() { ui.selected = null; ui.confirm = null; renderDetail(); openDlg('detailDlg'); }
function freePack(kind) { commit({ type: kind === 'upgrade' ? 'upgrade-pack-purchased' : 'ability-pack-purchased', cost: 0, free: true }); openPicker(); }
function takeOption(id) {
  const pp = ui.eval.pendingPack; if (!pp) return;
  closeDlg('detailDlg');
  if (pp.kind === 'upgrade') commit({ type: 'upgrade-chosen', track: id, stat: statName(id) });
  else { const a = abilityBySlug(id); commit({ type: 'ability-chosen', abilityId: id, replaces: a?.upgrades_from ?? [] }); }
}
// Add a part you got outside the shop (pack, encounter, already owned). With a full build, ask which part makes way, best swap first.
function acquirePart(slug, paid) {
  if (isEquipped(slug)) return;
  const p = partBySlug(slug);
  const base = { partId: slug, equip: true };
  const ev = paid ? { type: 'part-purchased', cost: ui.eval.prices.part(p.rarity), ...base } : { type: 'part-acquired', source: 'pack/encounter', ...base };
  if (ui.eval.ctx.slots - run.equipped.length > 0) return commit(ev);
  const swap = P.bestSwap(p, ui.eval.ctx);
  const lines = swap.options.map((o, i) => `${i + 1}. ${o.part?.name}  (build ${o.gain >= 0 ? '+' : ''}${f2(o.gain)})`).join('\n');
  const choice = prompt(`All ${ui.eval.ctx.slots} slots are full. Which part makes way for ${p.name}?\n${lines}`, '1');
  if (choice === null) return;
  commit({ ...ev, replace: swap.options[Number(choice) - 1]?.slug ?? swap.best?.slug });
}
function setFavour(slug, rank) {
  const picks = run.favourPicks.filter((f) => f.slug !== slug);
  if (rank > 0) { if (picks.length >= 3) { alert('Three favours max — drop one first.'); return; } picks.push({ slug, rank }); }
  correct({ favourPicks: picks, 'favours.gadgeteer': picks.find((f) => f.slug === FAV_GADGETEER)?.rank ?? 0, 'favours.bloodyBounty': picks.find((f) => f.slug === FAV_BLOODY)?.rank ?? 0 });
}

// ---------- search widgets ----------
function wireSearch(inputId, resultsId, items, renderItem, onAct) {
  const input = $(inputId), box = $(resultsId);
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';
  const close = () => { box.classList.remove('open'); box.innerHTML = ''; };
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) return close();
    const hits = items().filter((it) => it.text.includes(q)).slice(0, 14);
    box.innerHTML = hits.length ? hits.map(renderItem).join('') : '<div class="r"><span class="hint">No match</span></div>';
    box.classList.add('open');
  });
  input.addEventListener('focus', () => input.dispatchEvent(new Event('input')));
  document.addEventListener('click', (e) => { if (!input.contains(e.target) && !box.contains(e.target)) close(); });
  box.addEventListener('click', (e) => { const b = e.target.closest('button[data-act]'); if (!b) return; onAct(b.dataset.act, b.dataset.slug); input.value = ''; close(); });
}
function partItems() {
  const cls = ui.eval.ctx.cls;
  return data.parts.filter((p) => !p.variant_of && (!p.plane_trait || cls?.slug === 'podracer')).map((p) => ({ p, text: `${p.name} ${p.family} ${p.category ?? ''} ${p.description}`.toLowerCase() }));
}
const partResult = (btns) => ({ p }) => `<div class="r on-cream"><div><span class="nm">${esc(p.name)}</span>${chip(p)}</div><div class="btns">${btns(p)}</div><div class="ds">${hl(p.description)}</div></div>`;

// ---------- render: HUD ----------
function renderHud() {
  const { ctx } = ui.eval;
  $('creditsBig').textContent = fmt(run.credits);
  const srcs = [...ctx.sources.entries()].map(([k, why]) => `<em class="kw" title="${esc(why.join(', '))}">${esc(k)}</em>`).join(' ');
  $('styleLine').innerHTML = `<b>${esc(run.name)}</b> · <b>${esc(ctx.cls?.name ?? '')}</b> · <b>${esc(ctx.style.name)}</b>${run.mode === 'campaign' ? ` rank ${run.rank}` : ' · multiplayer'}<br>Builds on <b>${esc(ctx.style.core.join(', ') || '—')}</b>${srcs ? ` · has ${srcs}` : ''}`;
  $('undoBtn').disabled = !E.canUndo(run);
  const last = run.history[run.history.length - 1];
  $('lastAction').textContent = last ? E.describeEvent(data, last) : 'Tell the planner what you did in-game and it re-ranks the shop.';
}

// ---------- render: installed ----------
function renderInstalled() {
  const { ctx, installed } = ui.eval;
  const score = Object.fromEntries(installed.map((x) => [x.part.slug, x.score]));
  $('slotsInfo').textContent = `${run.equipped.length} / ${ctx.slots}`;
  const rows = run.equipped.map((slug) => { const p = partBySlug(slug); if (!p) return ''; return `<div class="slot" data-part="${slug}" title="Click to remove from the build">${img(p.icon, 'bg')}<span class="fade"></span><span class="nm">${esc(p.name)}</span><span class="sc">${f2(score[slug] ?? 0)}</span><span class="ds">${hl(p.description)}</span></div>`; }).join('');
  const empty = Math.max(0, ctx.slots - run.equipped.length);
  $('installed').innerHTML = rows + Array.from({ length: Math.min(empty, 10) }, () => '<div class="slot empty">Empty slot</div>').join('');
}

// ---------- render: parts area ----------
function partCard(p, { rec, marginal, mode, reason, tag }) {
  const best = rec && (rec === ui.eval.top || rec === ui.eval.recommendations.find((r) => r.kind === 'buy-part' && r.eligible));
  let ribbon = '';
  if (mode === 'offer' && rec) ribbon = rec === ui.eval.top ? '<span class="ribbon">Best move</span>' : best ? '<span class="ribbon">Best buy</span>' : !rec.eligible ? `<span class="ribbon off">${esc(rec.blockingReasons[0].split(' ').slice(0, 3).join(' '))}</span>` : '';
  if (tag) ribbon = `<span class="ribbon off">${esc(tag)}</span>`;
  const acts = mode === 'offer' ? `<button data-unoffer="${p.slug}">Gone</button>` : isEquipped(p.slug) ? '' : `<button data-wish-offer="${p.slug}">In shop</button><button data-got="${p.slug}">Got it</button>`;
  const foot = mode === 'offer' ? `<span class="price">${fmt(rec ? rec.cost : ui.eval.prices.part(p.rarity))}</span>` : `<span class="price">${esc(reason ?? '')}</span>`;
  return `<div class="card ${mode === 'wish' ? 'wish' : ''} ${best ? 'best' : ''}" data-card="${p.slug}" data-mode="${mode}">${ribbon}<div class="acts">${acts}</div>
    <div class="pic">${img(p.icon, '')}</div><div class="banner">${esc(p.name)}</div><div class="body">${hl(p.description)}</div>
    <div class="foot">${foot}<span class="val" title="value ${f2(marginal ?? 0)}"><i style="width:${Math.min(100, (marginal ?? 0) * 100)}%"></i></span></div></div>`;
}
function renderParts() {
  const ev = ui.eval;
  const k = ev.reroll.offerSize;
  const awaiting = run.shop.status === 'awaiting-offer';
  const entered = (run.shop.partIds ?? []).length;
  $('offerCount').textContent = awaiting ? 'new' : `${entered}/${k}`;
  for (const b of $('partsTabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === ui.tab);
  let cards = '';
  if (ui.tab === 'offer') {
    if (awaiting) cards += `<div class="awaiting">Awaiting the new offer<small>You restocked. Add the ${k} parts the dealer now shows and the planner re-ranks them.</small></div>`;
    const shown = awaiting ? (run.shop.partIds ?? []).map((slug) => ({ part: partBySlug(slug) })).filter((x) => x.part) : ev.offer;
    for (const o of shown) cards += partCard(o.part, { rec: recById(`buy-part:${o.part.slug}`), marginal: o.marginal, mode: 'offer' });
    if (!shown.length && !awaiting) cards += '<div class="empty-grid">Add what the dealer is showing to rank it</div>';
  } else if (ui.tab === 'all') {
    const q = ui.query.trim().toLowerCase();
    const byslug = Object.fromEntries(ev.ranked.map((r) => [r.part.slug, r]));
    const list = data.parts.filter((p) => !p.variant_of && !p.is_fault && (!q || `${p.name} ${p.family} ${p.category ?? ''} ${p.description}`.toLowerCase().includes(q)))
      .map((p) => { const r = byslug[p.slug]; const eq = isEquipped(p.slug); const sc = r ? r.marginal : 0; const tag = eq ? 'Installed' : r ? '' : (P.scorePart(p, ev.ctx).reasons[0] ?? 'not available'); return { p, r, sc, tag, order: eq ? -1 : r ? sc : -2 }; })
      .sort((a, b) => b.order - a.order || a.p.name.localeCompare(b.p.name)).slice(0, 60);
    for (const x of list) cards += partCard(x.p, { marginal: x.sc, mode: 'wish', reason: x.r?.reasons[0] ?? '', tag: x.tag });
    if (!list.length) cards += '<div class="empty-grid">No part matches</div>';
  } else {
    if (awaiting) cards += `<div class="awaiting">Shop restocked<small>Enter the new offer under "On offer" when you want it ranked. Below is what you are hoping to see.</small></div>`;
    for (const r of ev.wishlist.slice(0, 30)) cards += partCard(r.part, { marginal: r.marginal, mode: 'wish', reason: r.reasons[0] ?? '' });
    if (!ev.wishlist.length) cards += '<div class="empty-grid">Nothing left worth looking for</div>';
  }
  $('offerGrid').innerHTML = cards;
  $('offerGrid').classList.toggle('scroll', ui.tab !== 'offer');
  $('offerSearchWrap').style.display = ui.tab === 'offer' && (entered < k || awaiting) ? '' : 'none';
  $('allSearchWrap').style.display = ui.tab === 'all' ? '' : 'none';

  const rr = recById('reroll:');
  $('restockBtn').innerHTML = `Restock <small>◎ ${fmt(rr.cost)}</small>`;
  $('restockBtn').disabled = !rr.eligible;
  $('odds').innerHTML = rr.metrics.usefulCount === 0 ? '<b>Nothing useful left</b> for this build — restocking is pointless.' : `<b>${(rr.metrics.usefulOfferChance * 100).toFixed(0)}%</b> chance a restock shows something useful · <b>${rr.metrics.usefulCount}</b> useful parts still out there${rr.eligible ? '' : ` · <span style="color:var(--red)">${esc(rr.blockingReasons.join('; '))}</span>`}`;

  const top = ev.top;
  const pp = ev.pendingPack;
  $('advisor').innerHTML = pp ? `<span class="lbl">Open pack</span><span class="what">Which ${pp.kind === 'upgrade' ? 'upgrade' : 'ability'} did you take?</span><span class="act"><button class="pill solid" id="openPicker">Choose</button></span><span class="why">Buying anything else waits until the pack is resolved.</span>`
    : top ? `<span class="lbl">Next move</span><span class="what">${esc(top.title)}${top.cost ? ` · ◎ ${fmt(top.cost)}` : ''}</span><span class="act"><button class="pill solid" data-rec-confirm="${esc(top.id)}">${top.kind === 'save-credits' ? 'Got it' : 'Did it'}</button><button class="pill" data-rec="${esc(top.id)}">Why</button></span><span class="why">${esc(top.explain?.summary ?? '')}</span>`
    : '<span class="lbl">Next move</span><span class="what">Nothing to do</span>';
}

// ---------- render: packs & machine ----------
function renderPacks() {
  const ev = ui.eval;
  const pp = ev.pendingPack;
  const packCard = (rec, kind, label, bestLine) => {
    const open = pp?.kind === kind;
    return `<div class="pack ${open ? 'open' : ''}"><div class="top"><span class="nm">${label}</span><span class="price">${fmt(rec.cost)}</span></div>
      <div class="ds">${open ? '<b>Open pack</b> — tell the planner what you took.' : rec.eligible || !/pick from/.test(rec.blockingReasons.join()) ? `${rec.metrics.packSize} random, keep one. ${bestLine}` : esc(rec.blockingReasons[0])}</div>
      <div class="acts">${open ? '<button class="pill solid" id="openPicker2">Choose</button>' : `<button class="pill solid" data-rec-confirm="${esc(rec.id)}" ${rec.eligible ? '' : 'disabled'}>Bought</button><button class="pill" data-rec="${esc(rec.id)}">Why</button><button class="link" data-free-pack="${kind}">free pack</button>`}</div></div>`;
  };
  const up = ev.recommendations.find((r) => r.kind === 'upgrade');
  const ab = ev.recommendations.find((r) => r.kind === 'buy-ability');
  $('upgradePack').innerHTML = packCard(up, 'upgrade', 'Upgrade pack', up.metrics.bestStat ? `Best case <b>${esc(up.metrics.bestStat)} +1</b>.` : 'All stats maxed.');
  $('abilityPack').innerHTML = packCard(ab, 'ability', 'Ability pack', ab.metrics.bestName ? `Best case <b>${esc(ab.metrics.bestName)}</b>.` : 'Nothing left to draw.');

  const hot = up.metrics.bestStat;
  const levels = ev.upgrades.slice().sort((a, b) => P.TRACKS.indexOf(a.track) - P.TRACKS.indexOf(b.track)).map((u) => `<div class="lv"><span>${esc(u.stat)}</span><b>+${u.level}</b><div class="bar"><i class="${u.stat === hot ? 'hot' : ''}" style="width:${u.level * 10}%"></i></div></div>`).join('');
  const owned = [...ev.ctx.ownedAbilities].map((s) => { const a = abilityBySlug(s); return `<span title="${esc(a.description)}">${esc(a.name)}${run.abilities.includes(s) ? '' : ' <i class="hint">(style)</i>'}</span>`; }).join('');
  $('machineBox').innerHTML = `<div class="hint" style="margin-bottom:6px"><b>${esc(ev.ctx.cls?.name ?? '')}</b> · ${ev.ctx.slots} part slots · ${Object.values(run.upgrades).reduce((a, b) => a + b, 0)} upgrade levels</div>${levels}<div class="hint" style="margin-top:8px">Abilities</div><div class="chips">${owned || '<span class="hint">none yet</span>'}</div>`;
}

// ---------- render: detail / picker dialog ----------
function renderDetail() {
  const ev = ui.eval;
  const pp = ev.pendingPack;
  if (pp && !ui.selected) { $('detailBody').innerHTML = renderPicker(pp); return; }
  const sel = recById(ui.selected) ?? ev.top;
  if (!sel) { $('detailBody').innerHTML = '<div class="hint">No actions available.</div>'; return; }
  const details = sel.explain?.details ?? [];
  const alts = ev.recommendations.slice(0, 7).map((r, i) => `<div class="alt ${r.id === sel.id ? 'cur' : ''} ${r.eligible ? '' : 'blocked'}" data-alt="${esc(r.id)}"><span class="n">${i + 1}</span><span>${esc(r.title)}${r.eligible ? '' : ` <span class="hint">· ${esc(r.blockingReasons[0])}</span>`}</span><span class="v">${f2(r.score)}</span><span class="c">${r.cost ? '◎ ' + fmt(r.cost) : '—'}</span></div>`).join('');
  let html = `<div class="det"><div class="dlg-head"><span class="kind">${esc(KIND_LABEL[sel.kind])}${sel === ev.top ? ' · recommended' : ''}</span><button class="pill sm" data-close="detailDlg">Close</button></div>
    <h3>${esc(sel.title)}</h3>
    <div class="nums"><div>${f2(sel.score)}<small>${esc(sel.scoreUnit)}</small></div><div>${sel.cost ? '◎ ' + fmt(sel.cost) : '—'}<small>cost now</small></div>${sel.value ? `<div>${f2(sel.value)}<small>expected value</small></div>` : ''}</div>
    <div class="sum">${esc(sel.explain?.summary ?? '')}</div>
    ${sel.whyNot && sel !== ev.top ? `<div class="whynot">${esc(sel.whyNot)}</div>` : ''}
    <button class="link" id="toggleExplain">${ui.expanded ? 'Hide the math' : 'Show the math'}</button>
    ${ui.expanded ? `<div class="math">${sel.explain?.formula ? `<code>${esc(sel.explain.formula)}</code>` : ''}${details.map((d) => `<div>${esc(d)}</div>`).join('')}${sel.kind === 'reroll' ? `<div class="pbar"><i style="width:${(sel.metrics.usefulOfferChance * 100).toFixed(1)}%"></i></div><div class="hint">${(sel.metrics.usefulOfferChance * 100).toFixed(1)}% at least one useful · ${((1 - sel.metrics.usefulOfferChance) * 100).toFixed(1)}% none</div>` : ''}<div class="hint">All actions share one unit (${esc(sel.scoreUnit)}): expected value ÷ price × 1000.</div></div>` : ''}`;
  const cf = ui.confirm && ui.confirm.recId === sel.id ? ui.confirm : null;
  if (!sel.eligible) html += `<div class="block">Cannot record this now: ${esc(sel.blockingReasons.join('; '))}.</div>`;
  else if (sel.kind !== 'save-credits' && !cf) html += `<div class="actions"><button class="pill solid" id="recordAction">I did this in-game${sel.cost ? ` · ◎ ${fmt(sel.cost)}` : ''}</button></div>`;
  else if (cf) {
    const stale = sel.revision !== run.revision;
    let body = '';
    if (sel.kind === 'reroll') body = `You paid <b>◎ ${fmt(sel.cost)}</b> to restock. The current offer is gone; you will enter the new one next.`;
    else if (sel.kind === 'buy-part') {
      const opts = sel.metrics.swapOptions?.length ? sel.metrics.swapOptions : run.equipped.map((s) => ({ slug: s, name: partBySlug(s)?.name, gain: 0 }));
      body = `You paid <b>◎ ${fmt(sel.cost)}</b> for ${esc(sel.part.name)}. It goes straight on the machine.
        ${ev.slotsFree <= 0 ? `<div>All ${ev.ctx.slots} slots are full. Swap out: <select id="cfReplace">${opts.map((o) => `<option value="${o.slug}" ${o.slug === (cf.replace || sel.metrics.swapOut) ? 'selected' : ''}>${esc(o.name)} · build ${o.gain >= 0 ? '+' : ''}${f2(o.gain)}</option>`).join('')}</select></div><div class="hint">Each option is the whole build re-scored with that part gone and ${esc(sel.part.name)} in its place.</div>` : ''}`;
    } else if (sel.kind === 'upgrade') body = `You paid <b>◎ ${fmt(sel.cost)}</b> for an upgrade pack. Next, tell the planner which stat you took.`;
    else if (sel.kind === 'buy-ability') body = `You paid <b>◎ ${fmt(sel.cost)}</b> for an ability pack. Next, tell the planner which ability you took.`;
    html += `<div class="confirm">${stale ? '<div class="stale">The run changed since this was computed — refreshed.</div>' : ''}${body}<div class="actions"><button class="pill solid" id="confirmAction" ${stale ? 'disabled' : ''}>Confirm</button><button class="pill" id="confirmCancel">Cancel</button></div></div>`;
  }
  html += `<h4>All options right now</h4><div class="alts">${alts}</div></div>`;
  $('detailBody').innerHTML = html;
}
function renderPicker(pp) {
  const isUp = pp.kind === 'upgrade';
  const opts = pp.options.map((o) => ({ id: isUp ? o.track : o.ability.slug, name: isUp ? `${o.stat} +1` : o.ability.name, desc: isUp ? `level ${o.level} → ${o.level + 1}` : (o.from ? `upgrade of ${o.from.name} · ` : '') + o.ability.description, score: o.score })).sort((a, b) => b.score - a.score);
  return `<div class="det"><div class="dlg-head"><span class="kind">${isUp ? 'Upgrade pack' : 'Ability pack'} · open</span><button class="pill sm" id="discardPack">Close without picking</button></div>
    <h3>What did you take?</h3><div class="sum">Ranked for this build, best first. Pick the one you chose in-game.</div>
    <div class="picker">${opts.map((o, i) => `<div class="opt ${i === 0 ? 'best' : ''}" data-take="${esc(o.id)}"><span class="rank">${i + 1}</span><span class="nm">${esc(o.name)}</span><span class="v">${f2(o.score)}</span><button class="pill sm solid" data-take="${esc(o.id)}">Took it</button><span class="ds">${hl(o.desc)}</span></div>`).join('')}</div></div>`;
}

// ---------- render: garage ----------
function renderGarage() {
  const ev = ui.eval, ctx = ev.ctx;
  for (const b of $('gtabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.gtab === ui.gtab);
  let html = '';
  if (ui.gtab === 'run') {
    html = `<div class="gsec"><h3>Mode</h3><div class="lead">Campaign and multiplayer have different income, traits and starting abilities, so each run keeps its own books.</div>
      <div class="tiles big">${['campaign', 'multiplayer'].map((m) => `<div class="tile mode ${run.mode === m ? 'on' : ''}" data-set-mode="${m}"><span class="nm">${m}</span><span class="ds">${m === 'campaign' ? 'Scrap dealer visits, favours, event unlocks' : 'Fixed trait set, style starting ability'}</span></div>`).join('')}</div>
      <h3 style="margin-top:22px">Runs</h3><div class="runs">${Object.values(store.sessions).map((s) => `<div class="tile ${s.id === run.id ? 'on' : ''}" data-run-switch="${s.id}"><span class="nm">${esc(s.name)}</span><span class="ds">${esc(s.mode)} · ${esc(data.styles.find((x) => x.slug === s.style)?.name ?? '')} · ◎ ${fmt(s.credits)}</span>${s.id === run.id ? `<div class="acts"><button class="pill sm" data-run-rename="1">Rename</button><button class="pill sm danger" data-run-delete="1">Delete</button></div>` : ''}</div>`).join('')}<div class="tile" data-run-new="1"><span class="nm">＋ New run</span><span class="ds">Start fresh with this mode</span></div></div>
      <div class="actions" style="margin-top:18px"><button class="pill" id="exportRuns">Export runs</button><button class="pill" id="importRuns">Import runs</button><input type="file" id="importFile" accept="application/json" style="display:none"></div>
      <div class="hint" style="margin-top:6px">Runs live in this browser. Export to move them to another device or keep a backup.</div>
      <div class="hint" style="margin-top:18px">Fan-made planner, not affiliated with the game. Part data and icons come from <a href="https://galacticracer.gameslantern.com/" target="_blank" rel="noopener">galacticracer.gameslantern.com</a>.</div></div>`;
  } else if (ui.gtab === 'style') {
    const styles = data.styles.filter((s) => (run.mode === 'campaign' ? s.in_campaign : s.in_multiplayer));
    const traits = run.mode === 'campaign' ? (ctx.style.ranks.find((r) => r.rank === Number(run.rank))?.traits ?? []) : ctx.style.multiplayer.traits;
    html = `<div class="gsec"><h3>Racer style</h3><div class="lead">The style decides what the build is for. Everything in the shop is ranked against it.</div>
      <div class="tiles">${styles.map((s) => `<div class="tile ${s.slug === run.style ? 'on' : ''}" data-set-style="${s.slug}">${img(s.icon, 'ico')}<span class="nm">${esc(s.name)}</span><span class="ds">${esc((s.description ?? '').replace(/<[^>]+>/g, '').slice(0, 70))}</span></div>`).join('')}</div>
      ${run.mode === 'campaign' ? `<div class="actions" style="margin-top:18px"><span class="hint" style="letter-spacing:.14em;text-transform:uppercase">Style rank</span><div class="seg big">${[1, 2, 3].map((r) => `<button class="${run.rank === r ? 'on' : ''}" data-set-rank="${r}">${r}</button>`).join('')}</div></div>` : ''}
      <div class="traitlist">${traits.map((t) => `<div><b>${esc(t.name)}</b> — ${hl(t.description)}</div>`).join('') || '<span class="hint">No traits listed for this style.</span>'}${run.mode === 'multiplayer' && ctx.style.multiplayer.abilities.length ? `<div><b>Starts with</b> ${ctx.style.multiplayer.abilities.map((a) => esc(abilityBySlug(a.ability_slug)?.name)).join(', ')}</div>` : ''}</div></div>`;
  } else if (ui.gtab === 'machine') {
    html = `<div class="gsec"><h3>Machine class</h3><div class="lead">The body you drive is cosmetic; the class decides the advanced stat and which traits and parts apply. Every machine carries ${run.settings.baseSlots ?? 4} parts, plus Gadgeteer.</div>
      <div class="tiles big">${data.classes.map((k) => { const v = data.vehicles.find((x) => x.class_slug === k.slug && x.hero_image) ?? data.vehicles.find((x) => x.class_slug === k.slug); return `<div class="tile hero ${k.slug === ctx.cls?.slug ? 'on' : ''}" data-set-class="${k.slug}">${img(v?.hero_image, '')}<span class="nm">${esc(k.name)}</span><span class="ds">Advanced stat: ${esc(k.advanced_stat)} · ${esc(k.description ?? '')}</span></div>`; }).join('')}</div>
      <div class="traitlist">${(ctx.cls?.traits ?? []).map((t) => `<div><b>${esc(t.name)}</b> — ${hl(t.description)}</div>`).join('') || '<span class="hint">Podracer traits come from Plane Trait parts.</span>'}</div></div>`;
  } else if (ui.gtab === 'favours') {
    html = `<div class="gsec"><h3>Favours <span class="hint">${run.favourPicks.length} / 3</span></h3><div class="lead">Click a favour to raise its rank; click past rank 3 to drop it. Gadgeteer adds part slots, Bloody Bounty widens shop packs.</div>
      <div class="tiles">${data.favours.map((f) => { const r = favRank(f.slug); const eff = f.ranks.find((x) => x.rank === (r || 1))?.effect ?? ''; return `<div class="tile ${r ? 'on' : ''} ${!r && run.favourPicks.length >= 3 ? 'dim' : ''}" data-fav="${f.slug}"><div class="pips">${[1, 2, 3].map((n) => `<i class="${n <= r ? 'on' : ''}"></i>`).join('')}</div>${img(f.icon, 'ico')}<span class="nm">${esc(f.name)}</span><span class="ds">${r ? `Rank ${r}: ` : ''}${hl(eff)}</span></div>`; }).join('')}</div></div>`;
  } else if (ui.gtab === 'upgrades') {
    const rows = P.TRACKS.map((t) => { const lv = run.upgrades[t] ?? 0; return `<div class="stat-row"><span class="nm">${esc(statName(t))}</span><button class="step" data-upg-dec="${esc(t)}">−</button><span class="lvl">${lv}</span><button class="step" data-upg-inc="${esc(t)}">+</button><div class="bar"><i style="width:${lv * 10}%"></i></div></div>`; }).join('');
    const total = Object.values(run.upgrades).reduce((a, b) => a + b, 0);
    const owned = new Set(run.abilities);
    const pool = data.abilities.filter((a) => a.tier === 1 || a.upgrades_from.some((f) => owned.has(f)) || owned.has(a.slug));
    html = `<div class="gsec"><h3>Upgrades <span class="hint">${total} levels on the machine</span></h3><div class="lead">Set the levels as they are in-game. Upgrade packs later add to these.</div><div class="stat-rows">${rows}</div>
      <h3 style="margin-top:24px">Abilities owned</h3><div class="lead">Tap what you have. Upgraded versions appear once their base is owned.</div>
      <div class="tiles">${pool.map((a) => `<div class="tile ${owned.has(a.slug) ? 'on' : ''}" data-ability-toggle="${a.slug}">${img(a.icon, 'ico')}<span class="nm">${esc(a.name)}</span><span class="ds">${hl(a.description).slice(0, 110)}</span></div>`).join('')}</div></div>`;
  } else if (ui.gtab === 'wallet') {
    const st = run.settings;
    html = `<div class="gsec"><h3>Wallet &amp; rules</h3><div class="lead">What you have and how the dealer prices things this visit.</div>
      <div class="wallet">
        <div class="wbox"><h4>Credits</h4><div class="bigin"><button class="step" data-credits-add="-500">−</button><input id="wCredits" type="number" min="0" step="50" value="${run.credits}"><button class="step" data-credits-add="500">+</button></div></div>
        ${run.mode === 'campaign' ? `<div class="wbox"><h4>Part pool · events completed</h4><div class="bigin"><button class="step" data-events-add="-5">−</button><input id="wEvents" type="number" min="0" value="${run.events ?? 999}"><button class="step" data-events-add="5">+</button></div><div class="hint" style="margin-top:6px">Parts unlock as you complete events across runs. Leave it at 999 if everything is unlocked.</div></div>` : ''}
        <div class="wbox"><h4>Pack size</h4><div class="seg">${[2, 3, 4].map((n) => `<button class="${(st.packSize ?? 3) === n ? 'on' : ''}" data-pack-size="${n}">${n}</button>`).join('')}</div><div class="hint" style="margin-top:6px">Options per upgrade or ability pack. Encounters and favours change it.</div></div>
        <div class="wbox"><h4>Shop offer size</h4><div class="seg">${[3, 4, 5, 6].map((n) => `<button class="${st.offerSize === n ? 'on' : ''}" data-offer-size="${n}">${n}</button>`).join('')}</div><div class="hint" style="margin-top:6px">Favours add to this automatically.</div></div>
        <div class="wbox sm"><h4>Prices this visit</h4><div class="grid2">
          <label>Reroll base <input data-set="settings.reroll.base" type="number" value="${st.reroll.base}"></label><label>Reroll step <input data-set="settings.reroll.step" type="number" value="${st.reroll.step}"></label>
          <label>Upgrade pack base <input data-set="settings.upgrade.base" type="number" value="${st.upgrade.base}"></label><label>Upgrade step <input data-set="settings.upgrade.step" type="number" value="${st.upgrade.step}"></label>
          <label>Ability pack base <input data-set="settings.ability.base" type="number" value="${st.ability.base}"></label><label>Ability step <input data-set="settings.ability.step" type="number" value="${st.ability.step}"></label>
          <label>Common part <input data-set="settings.partPrice.Common" type="number" value="${st.partPrice.Common}"></label><label>Rare part <input data-set="settings.partPrice.Rare" type="number" value="${st.partPrice.Rare}"></label>
          <label>Epic part <input data-set="settings.partPrice.Epic" type="number" value="${st.partPrice.Epic}"></label><label>Legendary part <input data-set="settings.partPrice.Legendary" type="number" value="${st.partPrice.Legendary}"></label>
          <label>Event price multiplier <input data-set="settings.priceMultiplier" type="number" step="0.05" value="${st.priceMultiplier}"></label><label>Extra part slots <input data-set="extraSlots" type="number" value="${run.extraSlots ?? 0}"></label>
          <label>Useful threshold <input data-set="settings.usefulThreshold" type="number" step="0.05" value="${st.usefulThreshold}"></label><label>Saving floor <input data-set="settings.saveFloor" type="number" step="0.05" value="${st.saveFloor ?? 0.2}"></label>
        </div></div>
      </div></div>`;
  }
  $('garageBody').innerHTML = html;
}

function renderHistory() {
  $('log').innerHTML = run.history.slice().reverse().map((e) => `<div><span class="t">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${esc(E.describeEvent(data, e))}</div>`).join('') || '<div class="hint">Nothing recorded yet.</div>';
}

function render() {
  save(); renderHud(); renderInstalled(); renderParts(); renderPacks();
  if ($('garageDlg').open) renderGarage();
  if ($('detailDlg').open) renderDetail();
  wireSearch('offerSearch', 'offerSearchResults', partItems, partResult((p) => `<button class="pill" data-act="offer" data-slug="${p.slug}">In shop</button>`), (act, slug) => {
    const ids = [...(run.shop.partIds ?? []), slug];
    if (run.shop.status === 'awaiting-offer') { run.shop.partIds = ids; if (ids.length >= ui.eval.reroll.offerSize) commit({ type: 'shop-offer-observed', partIds: ids }); else { save(); render(); } }
    else commit({ type: 'shop-offer-observed', partIds: ids });
  });
}

// ---------- wiring ----------
function wire() {
  $('openGarage').addEventListener('click', () => { renderGarage(); openDlg('garageDlg'); });
  $('historyBtn').addEventListener('click', () => { renderHistory(); openDlg('historyDlg'); });
  $('partsTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { ui.tab = b.dataset.tab; renderParts(); if (ui.tab === 'all') $('allSearch').focus(); } });
  $('allSearch').addEventListener('input', (e) => { ui.query = e.target.value; renderParts(); });

  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('button, .card, .slot, .alt, .tile, .opt'); if (!el) return;
    const d = el.dataset;
    if (d.close) { closeDlg(d.close); if (d.close === 'garageDlg') render(); return; }
    if (d.rec) { showRec(d.rec); return; }
    if (d.recConfirm) { showRec(d.recConfirm, { confirm: true }); return; }
    if (d.alt) { ui.selected = d.alt; ui.confirm = null; ui.expanded = false; renderDetail(); return; }
    if (el.id === 'toggleExplain') { ui.expanded = !ui.expanded; renderDetail(); return; }
    if (el.id === 'recordAction') { const sel = recById(ui.selected) ?? ui.eval.top; if (sel.revision !== run.revision) { evaluate(); render(); } ui.confirm = { recId: sel.id, equip: ui.eval.slotsFree > 0 }; renderDetail(); return; }
    if (el.id === 'confirmAction') { const sel = recById(ui.confirm?.recId); if (sel) performConfirmed(sel, { equip: $('cfEquip')?.checked, replace: $('cfReplace')?.value }); return; }
    if (el.id === 'confirmCancel') { ui.confirm = null; renderDetail(); return; }
    if (el.id === 'openPicker' || el.id === 'openPicker2') { openPicker(); return; }
    if (el.id === 'discardPack') { closeDlg('detailDlg'); commit({ type: 'pack-discarded' }); return; }
    if (d.take) { e.stopPropagation(); takeOption(d.take); return; }
    if (d.freePack) { freePack(d.freePack); return; }
    if (el.id === 'restockBtn') { showRec('reroll:', { confirm: true }); return; }
    if (el.id === 'resetRound') { commit({ type: 'round-reset' }); return; }
    if (el.id === 'undoBtn') { E.undo(run); ui.confirm = null; evaluate(); render(); return; }
    if (d.unoffer) { e.stopPropagation(); commit({ type: 'shop-offer-observed', partIds: run.shop.partIds.filter((s) => s !== d.unoffer) }); return; }
    if (d.wishOffer) { e.stopPropagation(); if (!run.shop.partIds.includes(d.wishOffer)) { ui.tab = 'offer'; commit({ type: 'shop-offer-observed', partIds: [...run.shop.partIds, d.wishOffer] }); } return; }
    if (d.got) { e.stopPropagation(); acquirePart(d.got, false); return; }
    if (d.card) { if (d.mode === 'offer') showRec(`buy-part:${d.card}`); return; }
    if (d.part) { if (confirm(`Remove ${partBySlug(d.part)?.name} from the build?`)) commit({ type: 'part-discarded', partId: d.part }); return; }
    // garage
    if (d.gtab) { ui.gtab = d.gtab; renderGarage(); return; }
    if (d.setMode) { correct({ mode: d.setMode }); return; }
    if (d.setStyle) { correct({ style: d.setStyle }); return; }
    if (d.setRank) { correct({ rank: Number(d.setRank) }); return; }
    if (d.setClass) { const v = data.vehicles.find((x) => x.class_slug === d.setClass); if (v) correct({ vehicle: v.slug }); return; }
    if (d.fav) { const r = favRank(d.fav); setFavour(d.fav, r >= 3 ? 0 : r + 1); return; }
    if (d.upgInc) { correct({ [`upgrades.${d.upgInc}`]: Math.min(10, (run.upgrades[d.upgInc] ?? 0) + 1) }); return; }
    if (d.upgDec) { correct({ [`upgrades.${d.upgDec}`]: Math.max(0, (run.upgrades[d.upgDec] ?? 0) - 1) }); return; }
    if (d.abilityToggle) { if (run.abilities.includes(d.abilityToggle)) commit({ type: 'ability-removed', abilityId: d.abilityToggle }); else commit({ type: 'ability-acquired', abilityId: d.abilityToggle, replaces: [] }); return; }
    if (d.creditsAdd) { correct({ credits: Math.max(0, run.credits + Number(d.creditsAdd)) }); return; }
    if (d.eventsAdd) { correct({ events: Math.max(0, (run.events ?? 0) + Number(d.eventsAdd)) }); return; }
    if (d.packSize) { correct({ 'settings.packSize': Number(d.packSize) }); return; }
    if (d.offerSize) { correct({ 'settings.offerSize': Number(d.offerSize) }); return; }
    if (el.id === 'exportRuns') { const blob = new Blob([JSON.stringify(store, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `hibi-runs-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); return; }
    if (el.id === 'importRuns') { $('importFile').click(); return; }
    if (d.runSwitch) { store.current = d.runSwitch; load(); evaluate(); render(); renderGarage(); return; }
    if (d.runNew) { const r = E.newRun(data, { name: `Run ${Object.keys(store.sessions).length + 1}`, mode: run.mode }); store.sessions[r.id] = r; store.current = r.id; load(); evaluate(); render(); renderGarage(); return; }
    if (d.runRename) { e.stopPropagation(); const n = prompt('Run name', run.name); if (n) { run.name = n; render(); renderGarage(); } return; }
    if (d.runDelete) { e.stopPropagation(); if (!confirm(`Delete "${run.name}"?`)) return; delete store.sessions[run.id]; store.current = Object.keys(store.sessions)[0]; load(); evaluate(); render(); renderGarage(); return; }
  });
  $('garageBody').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'importFile') {
      const f = t.files?.[0]; if (!f) return;
      try {
        const inc = JSON.parse(await f.text());
        if (!inc?.sessions) throw new Error('not a runs file');
        let n = 0; for (const [id, s] of Object.entries(inc.sessions)) { store.sessions[id] = E.migrateRun(data, s); n++; }
        if (inc.current && store.sessions[inc.current]) store.current = inc.current;
        load(); evaluate(); render(); renderGarage(); alert(`Imported ${n} run${n === 1 ? '' : 's'}.`);
      } catch (err) { alert('Could not import: ' + err.message); }
      t.value = ''; return;
    }
    if (t.id === 'wCredits') correct({ credits: Number(t.value) || 0 });
    else if (t.id === 'wEvents') correct({ events: Number(t.value) || 0 });
    else if (t.dataset.set) correct({ [t.dataset.set]: Number(t.value) });
  });

  wireSearch('partSearch', 'partSearchResults', partItems, partResult((p) => `<button class="pill" data-act="free" data-slug="${p.slug}">Have it</button><button class="pill" data-act="bought" data-slug="${p.slug}">Bought</button>`), (act, slug) => acquirePart(slug, act === 'bought'));
}

async function main() {
  data = window.GRBC_DATA ?? (await (await fetch('data.json')).json());
  const names = [...new Set(Object.values(data.keywords).map((k) => k.name))].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  kwRegex = new RegExp(`\\b(${names.join('|')})(s|ed|ing)?\\b`, 'g');
  load(); evaluate(); wire(); render();
  if (!run.history.length && run.credits === 5000 && !run.equipped.length) { ui.gtab = 'run'; renderGarage(); openDlg('garageDlg'); }
}
main();
