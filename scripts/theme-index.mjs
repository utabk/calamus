// Builds src/lib/themeIndex.json (id, name, type) from @shikijs/themes so the picker can
// list themes without loading them all.
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve('node_modules/@shikijs/themes/dist');
const ids = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs').map((f) => f.slice(0, -4));
const out = [];
for (const id of ids.sort()) {
  const t = (await import(path.join(dir, id + '.mjs'))).default;
  out.push({ id, name: t.displayName || id, type: t.type === 'light' ? 'light' : 'dark' });
}
fs.writeFileSync('src/lib/themeIndex.json', JSON.stringify(out, null, 1) + '\n');
console.log(out.length, 'themes');
