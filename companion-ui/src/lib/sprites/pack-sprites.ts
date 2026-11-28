// Real-art sprite packer.
//
// NODE-ONLY (node:fs, node:zlib via png.ts). Packs a directory of full-body,
// transparent character images into the frozen manifest atlas: every mapped
// emotional base is scaled into both expression crops (full-body avatar and
// head-only mini) at exactly the frame rects buildSpriteManifest() assigns.
// Entries without source art keep their placeholder frames and placeholder
// provenance, so sheet- and manifest-level flags stay truthful.
//
// Resampling is an area average in premultiplied alpha. The supported source
// art is painted/softened at ~10x the frame size, not grid-aligned pixel art,
// so nearest-neighbour would drop outline pixels at random; averaging
// premultiplied colour keeps transparent edges free of dark or light halos.

import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { isRecord } from '../../../../src/shared/utils/types.js';
import { buildSpriteManifest, frameRect, type SpriteManifest } from './manifest.js';
import { decodePng, type DecodedPng } from './png.js';
import { encodeSheetCanvases, renderPlaceholderCanvases, type RenderedSheet, type SheetCanvas } from './render-sprites.js';
import {
  EMOTIONAL_BASES,
  SHEET_GEOMETRY,
  SPRITE_CROPS,
  expressionEntryId,
  type EmotionalBase,
  type SheetName,
  type SpriteCrop,
} from './taxonomy.js';

/** The packed bundle must stay under this many PNG bytes (bead 7ang.9 budget). */
export const SPRITE_PNG_BUDGET_BYTES = 1_500_000;

export interface SquareCrop {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** Operator-authored description of which source image serves which base. */
export interface SpritePackMapping {
  /** Emotional base -> PNG path relative to the source directory. Unlisted bases stay placeholder. */
  readonly expressions: Readonly<Partial<Record<EmotionalBase, string>>>;
  /** Head-only square in source pixels used for the mini crop of every mapped base. */
  readonly miniCrop: SquareCrop;
  /** Source alpha below this is treated as fully transparent (drops extraction haze). */
  readonly alphaFloor: number;
}

export interface PackedSprites {
  readonly manifest: SpriteManifest;
  readonly sheets: readonly RenderedSheet[];
  /** Expression entry ids now carrying real art, in manifest order. */
  readonly artEntries: readonly string[];
  /** Mapped base -> source path, in taxonomy order. */
  readonly sources: ReadonlyArray<{ readonly base: EmotionalBase; readonly path: string }>;
  readonly totalBytes: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validate a parsed mapping file, rejecting unknown bases and keys. */
export function parseSpritePackMapping(value: unknown): SpritePackMapping {
  if (!isRecord(value)) throw new Error('sprite pack mapping must be a JSON object');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'alphaFloor,expressions,miniCrop') {
    throw new Error(`sprite pack mapping must have exactly expressions, miniCrop and alphaFloor (got ${keys.join(', ')})`);
  }
  const { expressions, miniCrop, alphaFloor } = value;
  if (!isRecord(expressions)) throw new Error('mapping.expressions must be an object');
  for (const [base, path] of Object.entries(expressions)) {
    if (!(EMOTIONAL_BASES as readonly string[]).includes(base)) throw new Error(`unknown emotional base in mapping: ${base}`);
    if (typeof path !== 'string' || !path.toLowerCase().endsWith('.png')) {
      throw new Error(`mapping for ${base} must be a relative .png path`);
    }
  }
  if (!isRecord(miniCrop) || Object.keys(miniCrop).sort().join(',') !== 'size,x,y'
    || !isNonNegativeInteger(miniCrop.x) || !isNonNegativeInteger(miniCrop.y)
    || !isNonNegativeInteger(miniCrop.size) || miniCrop.size === 0) {
    throw new Error('mapping.miniCrop must be { x, y, size } in non-negative integer source pixels');
  }
  if (!isNonNegativeInteger(alphaFloor) || alphaFloor > 255) throw new Error('mapping.alphaFloor must be an integer 0..255');
  return {
    expressions: expressions as SpritePackMapping['expressions'],
    miniCrop: { x: miniCrop.x, y: miniCrop.y, size: miniCrop.size },
    alphaFloor,
  };
}

function resolveInside(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`mapping path must be relative to the source directory: ${path}`);
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`mapping path escapes the source directory: ${path}`);
  return full;
}

interface SourceRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Area-average `rect` of `image` down to dw x dh, in premultiplied alpha.
 * Returns straight-alpha RGBA. Separable: horizontal pass, then vertical.
 */
function resampleArea(image: DecodedPng, rect: SourceRect, dw: number, dh: number, alphaFloor: number): Uint8Array {
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > image.width || rect.y + rect.h > image.height) {
    throw new Error(`crop ${rect.w}x${rect.h}+${rect.x}+${rect.y} lies outside the ${image.width}x${image.height} source`);
  }
  const { rgba, width } = image;
  const xScale = rect.w / dw;
  const yScale = rect.h / dh;

  // Horizontal pass: rect.h rows x dw columns, premultiplied RGBA sums.
  const horizontal = new Float64Array(rect.h * dw * 4);
  for (let row = 0; row < rect.h; row += 1) {
    const srcRow = (rect.y + row) * width;
    for (let dx = 0; dx < dw; dx += 1) {
      const start = dx * xScale;
      const end = start + xScale;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      // Clamp: float drift must never read past the crop edge.
      for (let sx = Math.floor(start); sx < Math.min(Math.ceil(end), rect.w); sx += 1) {
        const weight = Math.min(end, sx + 1) - Math.max(start, sx);
        const i = (srcRow + rect.x + sx) * 4;
        const alpha = rgba[i + 3]! < alphaFloor ? 0 : rgba[i + 3]!;
        const wa = weight * alpha;
        r += rgba[i]! * wa;
        g += rgba[i + 1]! * wa;
        b += rgba[i + 2]! * wa;
        a += wa;
      }
      const o = (row * dw + dx) * 4;
      horizontal[o] = r;
      horizontal[o + 1] = g;
      horizontal[o + 2] = b;
      horizontal[o + 3] = a;
    }
  }

  // Vertical pass and un-premultiply.
  const out = new Uint8Array(dw * dh * 4);
  const area = xScale * yScale;
  for (let dy = 0; dy < dh; dy += 1) {
    const start = dy * yScale;
    const end = start + yScale;
    for (let dx = 0; dx < dw; dx += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = Math.floor(start); sy < Math.min(Math.ceil(end), rect.h); sy += 1) {
        const weight = Math.min(end, sy + 1) - Math.max(start, sy);
        const i = (sy * dw + dx) * 4;
        r += horizontal[i]! * weight;
        g += horizontal[i + 1]! * weight;
        b += horizontal[i + 2]! * weight;
        a += horizontal[i + 3]! * weight;
      }
      const alpha = Math.round(a / area);
      const o = (dy * dw + dx) * 4;
      if (alpha === 0) continue;
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = alpha;
    }
  }
  return out;
}

/** Scale one source image into a crop's frame (w x h), straight-alpha RGBA. */
function renderCropFrame(image: DecodedPng, crop: SpriteCrop, mapping: SpritePackMapping): Uint8Array {
  const frame = SHEET_GEOMETRY[crop === 'avatar' ? 'expr-avatar' : 'expr-mini'].frameSize;
  if (crop === 'mini') {
    const { x, y, size } = mapping.miniCrop;
    return resampleArea(image, { x, y, w: size, h: size }, frame.w, frame.h, mapping.alphaFloor);
  }
  // Avatar: the whole canvas, contain-fit, bottom-centred so feet share a baseline.
  const scale = Math.min(frame.w / image.width, frame.h / image.height);
  const dw = Math.round(image.width * scale);
  const dh = Math.round(image.height * scale);
  const scaled = resampleArea(image, { x: 0, y: 0, w: image.width, h: image.height }, dw, dh, mapping.alphaFloor);
  if (dw === frame.w && dh === frame.h) return scaled;
  const out = new Uint8Array(frame.w * frame.h * 4);
  const ox = Math.floor((frame.w - dw) / 2);
  const oy = frame.h - dh;
  for (let row = 0; row < dh; row += 1) {
    out.set(scaled.subarray(row * dw * 4, (row + 1) * dw * 4), ((oy + row) * frame.w + ox) * 4);
  }
  return out;
}

function blit(canvas: SheetCanvas, pixels: Uint8Array, x: number, y: number, w: number, h: number): void {
  for (let row = 0; row < h; row += 1) {
    canvas.data.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * canvas.width + x) * 4);
  }
}

function sameRect(canvas: DecodedPng, pixels: Uint8Array, x: number, y: number, w: number, h: number): boolean {
  for (let row = 0; row < h; row += 1) {
    const start = ((y + row) * canvas.width + x) * 4;
    const actual = canvas.rgba.subarray(start, start + w * 4);
    const expected = pixels.subarray(row * w * 4, (row + 1) * w * 4);
    if (!actual.every((value, index) => value === expected[index])) return false;
  }
  return true;
}

/**
 * Pack the mapped source art into the manifest atlas and verify the result:
 * decoded PNG dimensions equal each sheet grid, every mapped frame round-trips
 * pixel-exact at its rect, provenance flags match the mapping, only the
 * avatar sheet is lazy, and the total stays under the size budget.
 */
export function packSpriteSheets(sourceDir: string, mapping: SpritePackMapping): PackedSprites {
  const root = resolve(sourceDir);
  const sources = EMOTIONAL_BASES.flatMap((base) => {
    const path = mapping.expressions[base];
    return path === undefined ? [] : [{ base, path }];
  });
  const artEntries = SPRITE_CROPS.flatMap((crop) =>
    sources.map(({ base }) => expressionEntryId(base, crop)));
  const mappedCount = sources.length;
  const manifest = buildSpriteManifest({
    artEntries: new Set(artEntries),
    generator: `companion-ui/scripts/pack-sprite-sheets.ts (${mappedCount * SPRITE_CROPS.length} of `
      + `${Object.keys(buildSpriteManifest().entries).length} entries real art)`,
  });

  const canvases = renderPlaceholderCanvases();
  const expectedFrames: Array<{ sheet: string; pixels: Uint8Array; x: number; y: number; w: number; h: number }> = [];
  for (const { base, path } of sources) {
    const image = decodePng(new Uint8Array(readFileSync(resolveInside(root, path))));
    for (const crop of SPRITE_CROPS) {
      const entry = manifest.entries[expressionEntryId(base, crop)]!;
      const sheet = manifest.sheets[entry.sheet]!;
      const canvas = canvases.get(entry.sheet)!;
      const pixels = renderCropFrame(image, crop, mapping);
      // Source art is a static expression: every idle frame holds the same image.
      for (const frame of entry.frames) {
        const rect = frameRect(sheet, frame);
        blit(canvas, pixels, rect.x, rect.y, rect.w, rect.h);
        expectedFrames.push({ sheet: entry.sheet, pixels, ...rect });
      }
    }
  }

  const sheets = encodeSheetCanvases(canvases);
  verifyPackedSheets(manifest, sheets, expectedFrames);
  const totalBytes = sheets.reduce((sum, sheet) => sum + sheet.png.length, 0);
  if (totalBytes >= SPRITE_PNG_BUDGET_BYTES) {
    throw new Error(`packed sheets total ${totalBytes} bytes, over the ${SPRITE_PNG_BUDGET_BYTES}-byte budget`);
  }
  return { manifest, sheets, artEntries, sources, totalBytes };
}

function verifyPackedSheets(
  manifest: SpriteManifest,
  sheets: readonly RenderedSheet[],
  expectedFrames: ReadonlyArray<{ sheet: string; pixels: Uint8Array; x: number; y: number; w: number; h: number }>,
): void {
  const decoded = new Map<string, DecodedPng>();
  for (const rendered of sheets) {
    const sheet = manifest.sheets[rendered.name];
    if (!sheet) throw new Error(`packed sheet ${rendered.name} is not in the manifest`);
    const image = decodePng(rendered.png);
    const width = sheet.cols * sheet.frameSize.w;
    const height = sheet.rows * sheet.frameSize.h;
    if (image.width !== width || image.height !== height) {
      throw new Error(`${rendered.filename} is ${image.width}x${image.height}; the manifest grid requires ${width}x${height}`);
    }
    if (sheet.lazy !== SHEET_GEOMETRY[rendered.name as SheetName].lazy || sheet.lazy !== (rendered.name === 'expr-avatar')) {
      throw new Error(`only the avatar sheet may be lazy-loaded (${rendered.name} lazy=${sheet.lazy})`);
    }
    decoded.set(rendered.name, image);
  }
  if (decoded.size !== Object.keys(manifest.sheets).length) throw new Error('a manifest sheet was not packed');

  for (const frame of expectedFrames) {
    if (!sameRect(decoded.get(frame.sheet)!, frame.pixels, frame.x, frame.y, frame.w, frame.h)) {
      throw new Error(`packed ${frame.sheet} frame at ${frame.x},${frame.y} does not match its source art`);
    }
  }

  for (const [name, sheet] of Object.entries(manifest.sheets)) {
    const placeholderEntries = Object.values(manifest.entries).some((entry) => entry.sheet === name && entry.placeholder);
    if (sheet.placeholder !== placeholderEntries) throw new Error(`sheet ${name} placeholder flag is stale`);
  }
  if (manifest.placeholder !== Object.values(manifest.sheets).some((sheet) => sheet.placeholder)) {
    throw new Error('manifest placeholder flag is stale');
  }
}
