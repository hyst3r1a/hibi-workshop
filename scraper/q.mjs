// tiny query helper: node scraper/q.mjs "SQL"
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(new URL('../data/galactic_racer.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), { readOnly: true });
for (const sql of process.argv.slice(2)) { console.log('>', sql); console.table(db.prepare(sql).all()); }
