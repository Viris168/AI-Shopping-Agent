// Fails the build when dist/widget.js is over the 40 KB gzipped budget (CLAUDE.md).
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const LIMIT = 40 * 1024;
const raw = readFileSync(new URL('../dist/widget.js', import.meta.url));
const gz = gzipSync(raw, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`dist/widget.js: ${kb(raw.length)} raw, ${kb(gz)} gzipped (limit ${kb(LIMIT)})`);
if (gz > LIMIT) {
  console.error('Widget bundle is over budget.');
  process.exit(1);
}
