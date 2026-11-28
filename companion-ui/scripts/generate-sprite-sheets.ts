// Offline sprite-sheet generator CLI.
//
// Emits the companion sprite manifest + packed placeholder sheets into
// public/sprites/. Run via `npm run sprites:generate` (esbuild-bundled to Node,
// since this repo's Node has no TypeScript loader). The runtime never runs this
// — it loads the committed public/sprites/manifest.json at boot.
//
// Real art is packed by scripts/pack-sprite-sheets.ts (npm run sprites:pack),
// which keeps per-entry provenance truthful; this generator refuses to
// overwrite a manifest that already lists real-art entries.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSpriteManifest } from '../src/lib/sprites/manifest.js';
import { renderSpriteSheets } from '../src/lib/sprites/render-sprites.js';

function main(): void {
  // Resolve relative to the package cwd (companion-ui): the CLI is esbuild-
  // bundled to node_modules/.cache before running, so import.meta.url would
  // point at the bundle, not the source tree.
  const outDir = resolve(process.cwd(), 'public', 'sprites');

  mkdirSync(outDir, { recursive: true });

  // Never overwrite packed real art with placeholders.
  const manifestPath = join(outDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entries?: Record<string, { placeholder?: boolean }> };
    const real = Object.values(existing.entries ?? {}).filter((entry) => entry.placeholder === false).length;
    if (real > 0) {
      throw new Error(`${manifestPath} lists ${real} real-art entries; repack with npm run sprites:pack instead of regenerating placeholders`);
    }
  }

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
