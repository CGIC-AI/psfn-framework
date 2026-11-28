// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSpriteManifest, buildSpriteManifest } from './manifest.js';
import { SPRITE_PNG_BUDGET_BYTES } from './pack-sprites.js';
import { decodePng, isPng } from './png.js';
import { renderSpriteSheets } from './render-sprites.js';

describe('renderSpriteSheets', () => {
  const sheets = renderSpriteSheets();
  const manifest = buildSpriteManifest();

  it('renders one PNG per manifest sheet', () => {
    expect(sheets.map((s) => s.name).sort()).toEqual(Object.keys(manifest.sheets).sort());
    for (const sheet of sheets) {
      expect(sheet.filename).toBe(`${sheet.name}.png`);
      expect(isPng(sheet.png)).toBe(true);
    }
  });

  it('is byte-for-byte deterministic across runs', () => {
    const again = renderSpriteSheets();
    expect(sheets).toHaveLength(again.length);
    for (let i = 0; i < sheets.length; i += 1) {
      expect(sheets[i]!.name).toBe(again[i]!.name);
      expect(Buffer.from(sheets[i]!.png).equals(Buffer.from(again[i]!.png))).toBe(true);
    }
  });

  it('encodes PNG dimensions matching each sheet grid', () => {
    for (const rendered of sheets) {
      const sheet = manifest.sheets[rendered.name]!;
      // IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
      const view = new DataView(rendered.png.buffer, rendered.png.byteOffset, rendered.png.byteLength);
      const width = view.getUint32(16);
      const height = view.getUint32(20);
      expect(width).toBe(sheet.cols * sheet.frameSize.w);
      expect(height).toBe(Math.max(sheet.rows, 1) * sheet.frameSize.h);
    }
  });

  it('stays well under the 1.5MB sprite budget', () => {
    const total = sheets.reduce((sum, sheet) => sum + sheet.png.length, 0);
    expect(total).toBeLessThan(SPRITE_PNG_BUDGET_BYTES);
  });
});

// Guards whatever art is committed under public/sprites: the runtime only
// detects a wrong-sized sheet after it loads, so catch it before shipping.
describe('committed public/sprites atlas', () => {
  const dir = resolve(import.meta.dirname, '../../../public/sprites');
  const committed: unknown = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
  assertSpriteManifest(committed);
  const canonical = buildSpriteManifest();

  it('keeps the canonical grid, frame ordering and lazy avatar sheet', () => {
    for (const [name, sheet] of Object.entries(canonical.sheets)) {
      const { placeholder: _flag, ...geometry } = committed.sheets[name]!;
      const { placeholder: _expected, ...expected } = sheet;
      expect(geometry).toEqual(expected);
    }
    for (const [id, entry] of Object.entries(canonical.entries)) {
      expect(committed.entries[id]!.frames).toEqual(entry.frames);
    }
    expect(Object.keys(committed.entries).sort()).toEqual(Object.keys(canonical.entries).sort());
  });

  it('ships sheets whose pixel size matches the manifest within the size budget', () => {
    let total = 0;
    for (const [name, sheet] of Object.entries(committed.sheets)) {
      const bytes = new Uint8Array(readFileSync(resolve(dir, `${name}.png`)));
      total += bytes.length;
      const image = decodePng(bytes);
      expect([image.width, image.height]).toEqual([sheet.cols * sheet.frameSize.w, sheet.rows * sheet.frameSize.h]);
    }
    expect(total).toBeLessThan(SPRITE_PNG_BUDGET_BYTES);
  });

  it('reports truthful provenance at sheet and manifest level', () => {
    for (const [name, sheet] of Object.entries(committed.sheets)) {
      expect(sheet.placeholder).toBe(Object.values(committed.entries).some((entry) => entry.sheet === name && entry.placeholder));
    }
    expect(committed.placeholder).toBe(Object.values(committed.sheets).some((sheet) => sheet.placeholder));
  });
});
