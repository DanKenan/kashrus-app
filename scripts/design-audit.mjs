#!/usr/bin/env node
// Shutfey design audit (D1, SPEC §1d / Decision Q9) — READ-ONLY.
//
// Walks src/**/*.{ts,tsx} and index.html and counts the raw design values the
// spec bans in new code: raw Tailwind palette colour classes, raw #hex inside
// className/style, text-[Npx] below the 12 px floor, rounded-[Npx] outside the
// signed radius set, and raw durations (duration-[N] classes and `duration: N`
// motion props). The ratchet rule: the counts may go down, never up.
//
//   node scripts/design-audit.mjs                  print the counts table
//   node scripts/design-audit.mjs --check         exit 1 if any count rose vs docs/design/baseline.json
//   node scripts/design-audit.mjs --write-baseline  write docs/design/baseline.json
//
// It never edits a source file.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(root, 'docs', 'design', 'baseline.json');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield p;
  }
}

const files = [...walk(join(root, 'src')), join(root, 'index.html')];

const PALETTES = ['emerald', 'rose', 'amber', 'red', 'green', 'blue', 'slate', 'gray', 'zinc', 'white', 'black'];
const paletteRe = new RegExp(`\\b(?:bg|text|border|ring|from|to|via)-(?:${PALETTES.join('|')})(?:-\\d{2,3})?\\b`, 'g');
// Raw hex is only a violation where it styles UI: inside className attributes or style props.
const classOrStyleRe = /(?:className|style)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\{([\s\S]*?)\}\}|\{`([\s\S]*?)`\})/g;
const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
const smallTextRe = /\btext-\[(\d+(?:\.\d+)?)px\]/g;
const radiusRe = /\brounded-\[(\d+(?:\.\d+)?)px\]/g;
const ALLOWED_RADII = new Set([6, 8, 12, 16, 24]);
const durationClassRe = /\bduration-\[\d+\]/g;
const durationPropRe = /\bduration:\s*\d/g;

const counts = {
  paletteColourClasses: 0,
  rawHexInClassOrStyle: 0,
  textBelow12px: 0,
  radiusOutsideSet: 0,
  rawDurations: 0,
};

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  counts.paletteColourClasses += [...text.matchAll(paletteRe)].length;
  for (const m of text.matchAll(classOrStyleRe)) {
    const segment = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    counts.rawHexInClassOrStyle += [...segment.matchAll(hexRe)].length;
  }
  for (const m of text.matchAll(smallTextRe)) if (parseFloat(m[1]) < 12) counts.textBelow12px += 1;
  for (const m of text.matchAll(radiusRe)) if (!ALLOWED_RADII.has(parseFloat(m[1]))) counts.radiusOutsideSet += 1;
  counts.rawDurations += [...text.matchAll(durationClassRe)].length + [...text.matchAll(durationPropRe)].length;
}

function printTable(c, title) {
  console.log(title);
  console.log('------------------------------ ------');
  for (const [k, v] of Object.entries(c)) console.log(k.padEnd(30), String(v).padStart(6));
}

const args = process.argv.slice(2);
if (args.includes('--write-baseline')) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ counts }, null, 2) + '\n');
  printTable(counts, 'Design audit — baseline written to docs/design/baseline.json');
} else if (args.includes('--check')) {
  printTable(counts, 'Design audit — current counts');
  if (!existsSync(BASELINE_PATH)) {
    console.error('\nNo baseline at docs/design/baseline.json — run with --write-baseline first.');
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).counts;
  let rose = false;
  for (const [k, v] of Object.entries(counts)) {
    const base = baseline[k] ?? 0;
    if (v > base) {
      console.error(`RATCHET: ${k} rose ${base} -> ${v} (counts may go down, never up — SPEC §1d)`);
      rose = true;
    }
  }
  if (rose) process.exit(1);
  console.log('\nRatchet OK: no count above baseline.');
} else {
  printTable(counts, 'Design audit — counts (read-only)');
}
