// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readLocalSpritePack } from './import-sprite-pack.js';
import { frameRect, type SpriteManifest } from './manifest.js';
import { packSpriteSheets, parseSpritePackMapping, type SpritePackMapping } from './pack-sprites.js';
import { decodePng, encodePng, type DecodedPng } from './png.js';
import { renderSpriteSheets } from './render-sprites.js';
import { EMOTIONAL_BASES, SPRITE_CROPS, expressionEntryId } from './taxonomy.js';

// Synthetic 64x96 (2:3) "character": transparent canvas whose fully
// transparent pixels carry white RGB (a straight-alpha average would leak it
// into edges), a faint full-canvas haze below the alpha floor, and one opaque
// colour block. Real operator art never enters the repository or CI.
const SOURCE_W = 64;
const SOURCE_H = 96;

function sourcePng(colour: readonly [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(SOURCE_W * SOURCE_H * 4);
  for (let y = 0; y < SOURCE_H; y += 1) {
    for (let x = 0; x < SOURCE_W; x += 1) {
      const i = (y * SOURCE_W + x) * 4;
      const inside = x >= 13 && x < 51 && y >= 5 && y < 91;
      rgba.set(inside ? [...colour, 255] : [255, 255, 255, x % 3 === 0 ? 8 : 0], i);
    }
  }
  return encodePng(SOURCE_W, SOURCE_H, rgba);
}

const root = mkdtempSync(join(tmpdir(), 'sprite-pack-test-'));
mkdirSync(join(root, 'set'));
writeFileSync(join(root, 'set', 'red.png'), sourcePng([220, 20, 40]));
writeFileSync(join(root, 'set', 'blue.png'), sourcePng([30, 60, 210]));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const mapping: SpritePackMapping = {
  expressions: { neutral: 'set/red.png', sad: 'set/blue.png' },
  miniCrop: { x: 9, y: 0, size: 40 },
  alphaFloor: 16,
};

function frameOf(manifest: SpriteManifest, sheets: ReadonlyMap<string, DecodedPng>, id: string, index: number) {
  const entry = manifest.entries[id]!;
  const sheet = manifest.sheets[entry.sheet]!;
  const rect = frameRect(sheet, entry.frames[index]!);
  const image = sheets.get(entry.sheet)!;
  const pixels: number[][] = [];
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const i = (y * image.width + x) * 4;
      pixels.push(Array.from(image.rgba.subarray(i, i + 4)));
    }
  }
  return pixels;
}

describe('packSpriteSheets', () => {
  const packed = packSpriteSheets(root, mapping);
  const decoded = new Map(packed.sheets.map((sheet) => [sheet.name, decodePng(sheet.png)]));

  it('writes every sheet at exactly its manifest grid size', () => {
    for (const [name, sheet] of Object.entries(packed.manifest.sheets)) {
      expect(decoded.get(name)!.width).toBe(sheet.cols * sheet.frameSize.w);
      expect(decoded.get(name)!.height).toBe(sheet.rows * sheet.frameSize.h);
    }
    expect(packed.totalBytes).toBeLessThan(1_500_000);
    expect(Object.entries(packed.manifest.sheets).filter(([, sheet]) => sheet.lazy).map(([name]) => name))
      .toEqual(['expr-avatar']);
  });

  it('marks only mapped entries as real art and keeps sheet and manifest flags truthful', () => {
    const real = Object.values(packed.manifest.entries).filter((entry) => !entry.placeholder).map((entry) => entry.id);
    expect(real.sort()).toEqual(['expr.neutral.avatar', 'expr.neutral.mini', 'expr.sad.avatar', 'expr.sad.mini']);
    // Two of sixteen bases mapped: every sheet still holds placeholders.
    expect(Object.values(packed.manifest.sheets).every((sheet) => sheet.placeholder)).toBe(true);
    expect(packed.manifest.placeholder).toBe(true);
    expect(packed.manifest.generator).toContain('4 of 56 entries real art');
  });

  it('clears expression-sheet placeholder flags only when every base has art', () => {
    const all = packSpriteSheets(root, {
      ...mapping,
      expressions: Object.fromEntries(EMOTIONAL_BASES.map((base) => [base, 'set/red.png'])),
    });
    expect(all.manifest.sheets['expr-mini']!.placeholder).toBe(false);
    expect(all.manifest.sheets['expr-avatar']!.placeholder).toBe(false);
    expect(all.manifest.sheets.tool!.placeholder).toBe(true);
    expect(all.manifest.placeholder).toBe(true);
  });

  it('places the art in both crops with clean alpha edges and no haze', () => {
    for (const crop of SPRITE_CROPS) {
      const first = frameOf(packed.manifest, decoded, expressionEntryId('neutral', crop), 0);
      const second = frameOf(packed.manifest, decoded, expressionEntryId('neutral', crop), 1);
      expect(second).toEqual(first); // static source: idle frames hold the same image
      const visible = first.filter((pixel) => pixel[3]! > 0);
      expect(visible.length).toBeGreaterThan(0);
      // Premultiplied averaging: edge pixels keep the block colour, never blend toward the white transparent RGB.
      for (const pixel of visible) expect(pixel.slice(0, 3)).toEqual([220, 20, 40]);
      expect(visible.some((pixel) => pixel[3]! < 255)).toBe(true);
      // The faint haze sits below the alpha floor and must vanish entirely.
      expect(first.filter((pixel) => pixel[3]! === 0).every((pixel) => pixel.every((v) => v === 0))).toBe(true);
    }
    const sad = frameOf(packed.manifest, decoded, 'expr.sad.mini', 0).filter((pixel) => pixel[3] === 255);
    expect(sad[0]!.slice(0, 3)).toEqual([30, 60, 210]);
  });

  it('keeps unmapped frames byte-identical to the placeholder renderer', () => {
    const placeholder = new Map(renderSpriteSheets().map((sheet) => [sheet.name, decodePng(sheet.png)]));
    for (const id of ['expr.happy.mini', 'expr.happy.avatar', 'tool.wrench.started', 'touch.kiss-blush']) {
      expect(frameOf(packed.manifest, decoded, id, 0)).toEqual(frameOf(packed.manifest, placeholder, id, 0));
    }
    const toolSheet = packed.sheets.find((sheet) => sheet.name === 'tool')!;
    expect(Buffer.from(toolSheet.png).equals(Buffer.from(renderSpriteSheets().find((sheet) => sheet.name === 'tool')!.png)))
      .toBe(true);
  });

  it('is byte-for-byte deterministic', () => {
    const again = packSpriteSheets(root, mapping);
    expect(JSON.stringify(again.manifest)).toBe(JSON.stringify(packed.manifest));
    for (const [index, sheet] of packed.sheets.entries()) {
      expect(Buffer.from(again.sheets[index]!.png).equals(Buffer.from(sheet.png))).toBe(true);
    }
  });

  it('produces a pack the app sprite-pack importer accepts', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:pack-${Math.random()}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const files = [
      new File([JSON.stringify(packed.manifest)], 'manifest.json', { type: 'application/json' }),
      ...packed.sheets.map((sheet) => new File([new Uint8Array(sheet.png)], sheet.filename, { type: 'image/png' })),
    ];
    const pack = await readLocalSpritePack(files);
    expect(pack.manifest.entries['expr.neutral.mini']!.placeholder).toBe(false);
    expect(pack.manifest.entries['tool.wrench.started']!.placeholder).toBe(true);
    pack.dispose();
    vi.restoreAllMocks();
  });

  it('rejects crops outside the source and paths outside the source directory', () => {
    expect(() => packSpriteSheets(root, { ...mapping, miniCrop: { x: 40, y: 0, size: 48 } })).toThrow(/outside/);
    expect(() => packSpriteSheets(root, { ...mapping, expressions: { neutral: '../escape.png' } })).toThrow(/escapes/);
    expect(() => packSpriteSheets(root, { ...mapping, expressions: { neutral: join(root, 'set/red.png') } }))
      .toThrow(/relative/);
  });
});

describe('parseSpritePackMapping', () => {
  const valid = { expressions: { neutral: 'a.png' }, miniCrop: { x: 0, y: 0, size: 10 }, alphaFloor: 16 };

  it('accepts a well-formed mapping', () => {
    expect(parseSpritePackMapping(valid)).toEqual(valid);
  });

  it.each([
    ['unknown base', { ...valid, expressions: { joyful: 'a.png' } }, /unknown emotional base/],
    ['non-png path', { ...valid, expressions: { neutral: 'a.jpg' } }, /\.png/],
    ['extra key', { ...valid, tool: {} }, /exactly/],
    ['zero crop', { ...valid, miniCrop: { x: 0, y: 0, size: 0 } }, /miniCrop/],
    ['bad floor', { ...valid, alphaFloor: 300 }, /alphaFloor/],
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseSpritePackMapping(value)).toThrow(message);
  });
});
