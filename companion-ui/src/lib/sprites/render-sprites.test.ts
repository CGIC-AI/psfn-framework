import { describe, expect, it } from 'vitest';
import { buildSpriteManifest } from './manifest.js';
import { isPng } from './png.js';
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
    expect(total).toBeLessThan(1_500_000);
  });
});
