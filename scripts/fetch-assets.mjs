// Mirror every image the app references (part/style/favour/class icons, one hero per class) into app/assets/
// so the deployed site does not hotlink the fan database. Paths keep their structure minus the common prefix.
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://galacticracer.gameslantern.com';
const PREFIX = '/storage/sites/galacticracer';
const OUT = path.join(ROOT, 'app', 'assets');
const data = JSON.parse(await readFile(path.join(ROOT, 'app', 'data.json'), 'utf8'));

const wanted = new Set();
for (const p of data.parts) if (p.icon) wanted.add(p.icon);
for (const s of data.styles) if (s.icon) wanted.add(s.icon);
for (const f of data.favours) if (f.icon) wanted.add(f.icon);
for (const c of data.classes) if (c.icon) wanted.add(c.icon);
for (const a of data.abilities) if (a.icon) wanted.add(a.icon);
for (const c of data.classes) { const v = data.vehicles.find((x) => x.class_slug === c.slug && x.hero_image); if (v) wanted.add(v.hero_image); }

const exists = async (f) => { try { await access(f); return true; } catch { return false; } };
let done = 0, skipped = 0, failed = [];
const list = [...wanted];
const worker = async () => {
  while (list.length) {
    const src = list.shift();
    const rel = src.startsWith(PREFIX) ? src.slice(PREFIX.length) : src;
    const file = path.join(OUT, rel);
    if (await exists(file)) { skipped++; continue; }
    await mkdir(path.dirname(file), { recursive: true });
    try {
      const res = await fetch(SITE + src, { headers: { 'user-agent': 'Mozilla/5.0 (GRBC asset mirror)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      done++;
    } catch (e) { failed.push(`${src}: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 60));
  }
};
await Promise.all(Array.from({ length: 4 }, worker));
console.log(`assets: ${done} downloaded, ${skipped} already present, ${failed.length} failed`);
for (const f of failed) console.log('  !', f);
