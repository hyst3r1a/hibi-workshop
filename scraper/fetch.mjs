// Crawl galacticracer.gameslantern.com and cache raw HTML under cache/html/<section>/<slug>.html
// Re-runs are incremental: cached files are skipped unless --force is passed.
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache', 'html');
const BASE = 'https://galacticracer.gameslantern.com';
const FORCE = process.argv.includes('--force');
const CONCURRENCY = 4;
const DELAY_MS = 120;
const UA = 'Mozilla/5.0 (compatible; GRBC-build-planner/0.1; personal research tool)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function fetchHtml(urlPath) {
  const url = urlPath.startsWith('http') ? urlPath : BASE + urlPath;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) { console.warn(`  ! ${res.status} ${url}`); return null; }
      return await res.text();
    } catch (e) {
      console.warn(`  retry ${attempt} ${url}: ${e.message}`);
      await sleep(800 * attempt);
    }
  }
  return null;
}

async function cached(section, slug, urlPath) {
  const dir = path.join(CACHE, section);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slug}.html`);
  if (!FORCE && (await exists(file))) return readFile(file, 'utf8');
  const html = await fetchHtml(urlPath);
  if (html) await writeFile(file, html, 'utf8');
  await sleep(DELAY_MS);
  return html;
}

async function pool(items, fn) {
  const queue = [...items];
  let done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
      done++;
      if (done % 25 === 0) console.log(`  ${done}/${items.length}`);
    }
  });
  await Promise.all(workers);
}

// Collect detail slugs for a section from any page's links.
function slugsFrom(html, section) {
  const $ = cheerio.load(html);
  const re = new RegExp(`^(?:${BASE.replace(/\./g, '\\.')})?/${section}/([a-z0-9-]+)$`);
  const set = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href').split('#')[0].split('?')[0];
    const m = href.match(re);
    if (m) set.add(m[1]);
  });
  return [...set].sort();
}

const INDEX_PAGES = [
  'vehicle-parts', 'vehicles', 'vehicle-classes', 'manufacturers', 'abilities',
  'upgrades', 'racer-styles', 'traits', 'glossary', 'racers', 'body-parts', 'favours', 'sponsors', 'scenarios', 'events',
];

// Sections whose detail pages we crawl, and which index page(s) list them.
const DETAIL_SECTIONS = {
  'vehicle-parts': ['vehicle-parts'],
  vehicles: ['vehicles'],
  'vehicle-classes': ['vehicle-classes', 'vehicles'],
  abilities: ['abilities'],
  'racer-styles': ['racer-styles'],
  glossary: ['glossary'],
  racers: ['racers'],
};

async function main() {
  console.log('Fetching index pages...');
  const index = {};
  for (const p of INDEX_PAGES) {
    index[p] = await cached('index', p, `/${p}`);
    console.log(`  ${p}: ${index[p] ? 'ok' : 'FAILED'}`);
  }

  for (const [section, sources] of Object.entries(DETAIL_SECTIONS)) {
    const slugs = new Set();
    for (const src of sources) if (index[src]) slugsFrom(index[src], section).forEach((s) => slugs.add(s));
    const list = [...slugs];
    console.log(`\n${section}: ${list.length} pages`);
    await pool(list, (slug) => cached(section, slug, `/${section}/${slug}`));
  }

  // Second pass: ability and glossary pages link to abilities/glossary entries that
  // the index pages do not list (e.g. tiered ability variants). Crawl those too.
  for (const section of ['abilities', 'glossary']) {
    const dir = path.join(CACHE, section);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    const known = new Set(files.map((f) => f.replace(/\.html$/, '')));
    const extra = new Set();
    for (const f of files) {
      const html = await readFile(path.join(dir, f), 'utf8');
      slugsFrom(html, section).forEach((s) => { if (!known.has(s)) extra.add(s); });
    }
    // Also harvest glossary links referenced from parts, traits and styles.
    if (section === 'glossary') {
      for (const sec of ['vehicle-parts', 'racer-styles', 'abilities']) {
        const d = path.join(CACHE, sec);
        for (const f of await readdir(d)) {
          const html = await readFile(path.join(d, f), 'utf8');
          slugsFrom(html, 'glossary').forEach((s) => { if (!known.has(s)) extra.add(s); });
        }
      }
      if (index.traits) slugsFrom(index.traits, 'glossary').forEach((s) => { if (!known.has(s)) extra.add(s); });
    }
    if (extra.size) {
      console.log(`\n${section} (second pass): ${extra.size} extra pages`);
      await pool([...extra], (slug) => cached(section, slug, `/${section}/${slug}`));
    }
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
