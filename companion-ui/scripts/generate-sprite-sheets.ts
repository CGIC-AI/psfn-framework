// Offline sprite-sheet generator CLI.
//
// Emits the companion sprite manifest + packed placeholder sheets into
// public/sprites/. Run via `npm run sprites:generate` (esbuild-bundled to Node,
// since this repo's Node has no TypeScript loader). The runtime never runs this
// — it loads the committed public/sprites/manifest.json at boot.
//
// To swap in real art: replace the PNGs in public/sprites/ with final sheets
// that honour each sheet's grid (cols x rows, frameSize) from the manifest,
// then flip `placeholder` provenance in the manifest builder options below.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSpriteManifest } from '../src/lib/sprites/manifest.js';
import { renderSpriteSheets } from '../src/lib/sprites/render-sprites.js';

function main(): void {
  // Resolve relative to the package cwd (companion-ui): the CLI is esbuild-
  // bundled to node_modules/.cache before running, so import.meta.url would
  // point at the bundle, not the source tree.
  const outDir = resolve(process.cwd(), 'public', 'sprites');

  mkdirSync(outDir, { recursive: true });

  // Clean previously generated placeholder PNGs (but not other files) so a
  // taxonomy shrink never leaves orphaned sheets behind.
  for (const file of readdirSync(outDir)) {
    if (file.endsWith('.png') || file === 'manifest.json') {
      rmSync(join(outDir, file), { force: true });
    }
  }

  const manifest = buildSpriteManifest();
  const sheets = renderSpriteSheets();

  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const sheet of sheets) {
    writeFileSync(join(outDir, sheet.filename), sheet.png);
  }

  const entryCount = Object.keys(manifest.entries).length;
  const frameTotal = sheets.reduce((sum, sheet) => sum + sheet.png.length, 0);
  process.stdout.write(
    `Generated ${sheets.length} placeholder sheets, ${entryCount} entries -> ${outDir} ` +
      `(${(frameTotal / 1024).toFixed(1)} KiB total PNG)\n`,
  );
}

main();
