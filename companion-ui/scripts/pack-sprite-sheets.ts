// Offline real-art sprite packer CLI.
//
//   npm run sprites:pack -- --source <art dir> --map <mapping.json> --out <dir>
//
// Reads transparent full-body PNGs from --source (never modified), maps them to
// emotional bases with --map (see SpritePackMapping in
// src/lib/sprites/pack-sprites.ts), and writes manifest.json plus the four
// sheets to --out. The output is a complete local sprite pack: select the five
// files in Settings -> Appearance -> Choose sprite pack. The packer verifies
// sheet dimensions, frame placement, provenance flags, the lazy avatar sheet
// and the size budget before writing anything.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { packSpriteSheets, parseSpritePackMapping, SPRITE_PNG_BUDGET_BYTES } from '../src/lib/sprites/pack-sprites.js';

function main(): void {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      map: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  if (!values.source || !values.map || !values.out) {
    throw new Error('usage: npm run sprites:pack -- --source <art dir> --map <mapping.json> --out <dir>');
  }

  const mapping = parseSpritePackMapping(JSON.parse(readFileSync(resolve(values.map), 'utf8')) as unknown);
  const packed = packSpriteSheets(values.source, mapping);

  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(packed.manifest, null, 2)}\n`);
  for (const sheet of packed.sheets) writeFileSync(join(outDir, sheet.filename), sheet.png);

  const placeholderIds = Object.values(packed.manifest.entries).filter((entry) => entry.placeholder).map((entry) => entry.id);
  process.stdout.write(`${JSON.stringify({
    out: outDir,
    sheets: packed.sheets.map((sheet) => ({ file: sheet.filename, bytes: sheet.png.length })),
    totalBytes: packed.totalBytes,
    budgetBytes: SPRITE_PNG_BUDGET_BYTES,
    sources: packed.sources,
    artEntries: packed.artEntries.length,
    placeholderEntries: placeholderIds,
    manifestPlaceholder: packed.manifest.placeholder,
  }, null, 2)}\n`);
}

main();
