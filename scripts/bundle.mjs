// Bundle app/ into a single self-contained dist/grbc.html (data + planner + engine + UI inlined).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = (f) => readFile(path.join(ROOT, 'app', f), 'utf8');
const exportsOf = (src) => [...src.matchAll(/^export (?:const|function) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
const stripModule = (src) => src.replace(/^import [^\n]*\n/gm, '').replace(/^export\s+/gm, '');

let html = await app('index.html');
const css = await app('styles.css');
const data = await app('data.json');
const plannerSrc = await app('planner.js');
const engineSrc = await app('engine.js');
const uiSrc = await app('app.js');

// Each module becomes an IIFE returning its exports as a namespace object.
const wrap = (src, deps) => `(() => {\n${deps}\n${stripModule(src)}\nreturn { ${exportsOf(src).join(', ')} };\n})()`;
const script = [
  `const P = ${wrap(plannerSrc, '')};`,
  `const E = ${wrap(engineSrc, '')};`,
  stripModule(uiSrc),
].join('\n');

html = html.replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`);
html = html.replace('<script type="module" src="app.js"></script>', `<script>window.GRBC_DATA = ${data}; window.GRBC_ASSET_BASE = 'https://galacticracer.gameslantern.com/storage/sites/galacticracer';</script>\n<script type="module">\n${script}\n</script>`);
await mkdir(path.join(ROOT, 'dist'), { recursive: true });
await writeFile(path.join(ROOT, 'dist', 'grbc.html'), html, 'utf8');
console.log(`dist/grbc.html written (${(html.length / 1024).toFixed(0)} KB)`);
