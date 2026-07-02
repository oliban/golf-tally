#!/usr/bin/env node
/*
 * Regenerate courses.js (the bundled catalog) from courses/gothenburg.json.
 *
 * Routine to add more courses:
 *   1. Add course objects to courses/gothenburg.json (see the shape below).
 *   2. Run:  node scripts/gen-courses.js
 *   3. Commit courses/gothenburg.json + courses.js and push.
 *
 * Course shape (only name + holes are required; the rest are optional):
 *   {
 *     "name": "...", "holesCount": 18,
 *     "region": "...", "city": "...",
 *     "location": { "lat": 0, "lng": 0 },
 *     "access": "pay-and-play" | "greenfee" | "members",
 *     "maxHcp": 36, "greenFee": { "min": 0, "max": 0, "currency": "SEK" },
 *     "tees": { "yellow": { "slope": 113 }, "red": { "slope": 113 } },
 *     "holes": [ { "index": 1, "par": 4, "si": 5, "len": { "yellow": 0, "red": 0 } }, ... ]
 *   }
 * Stroke index (si) must be a 1..N permutation — this script fails loudly if not.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcPath = path.join(root, 'courses', 'gothenburg.json');
const courses = JSON.parse(fs.readFileSync(srcPath, 'utf8'));

let errors = 0;
const seen = new Set();
for (const c of courses) {
  const n = Array.isArray(c.holes) ? c.holes.length : 0;
  if (n !== 9 && n !== 18) { console.error(`✗ ${c.name}: ${n} holes (need 9 or 18)`); errors++; continue; }
  const sis = c.holes.map(h => h.si).sort((a, b) => a - b);
  if (!sis.every((v, i) => v === i + 1)) { console.error(`✗ ${c.name}: stroke index is not a 1..${n} permutation`); errors++; }
  const key = (c.name || '').toLowerCase() + '|' + n;
  if (seen.has(key)) { console.error(`✗ duplicate: ${c.name} (${n} holes)`); errors++; }
  seen.add(key);
}
if (errors) { console.error(`\n${errors} problem(s) — courses.js NOT written.`); process.exit(1); }

const header = [
  '// Bundled course catalog — AUTO-GENERATED from courses/gothenburg.json.',
  '// Do not edit by hand. Regenerate with:  node scripts/gen-courses.js',
  '// Loaded by index.html before app.js; seeded into the course list on first run.',
  '',
].join('\n');
fs.writeFileSync(path.join(root, 'courses.js'), header + 'globalThis.BUNDLED_COURSES = ' + JSON.stringify(courses, null, 2) + ';\n');
console.log(`courses.js written: ${courses.length} courses.`);
