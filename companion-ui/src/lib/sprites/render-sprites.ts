// Placeholder sprite-sheet renderer.
//
// NODE-ONLY (transitively imports node:zlib via png.ts). Generates simple,
// deterministic, clearly-placeholder art: one flat-coloured, labelled frame per
// manifest frame index, packed into each sheet grid exactly where
// buildSpriteManifest() placed it. The whole point is that the *layout* and the
// manifest are real; the pixels are stand-ins. Real art regenerates the same
// PNG filenames at the same frame rects and drops in file-for-file.

import { encodePng } from './png.js';
import { buildSpriteManifest, frameRect, type SpriteEntry, type SpriteSheet } from './manifest.js';
import { baseColorIndex, EMOTIONAL_BASES, TOOL_DOMAINS, TOUCH_REACTIONS } from './taxonomy.js';

// 3x5 uppercase pixel font (rows top->bottom, 3 bits per row, MSB = left col).
const FONT: Record<string, readonly number[]> = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [5, 7, 7, 7, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 7, 3], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [6, 1, 2, 4, 7], '3': [6, 1, 2, 1, 6],
  '4': [5, 5, 7, 1, 1], '5': [7, 4, 6, 1, 6], '6': [3, 4, 6, 5, 2], '7': [7, 1, 2, 2, 2],
  '8': [2, 5, 2, 5, 2], '9': [2, 5, 3, 1, 6], '-': [0, 0, 7, 0, 0], ' ': [0, 0, 0, 0, 0],
};

type Rgb = readonly [number, number, number];

interface Canvas {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

function makeCanvas(width: number, height: number): Canvas {
  return { data: new Uint8Array(width * height * 4), width, height };
}

function setPixel(canvas: Canvas, x: number, y: number, [r, g, b]: Rgb, a = 255): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 4;
  canvas.data[i] = r;
  canvas.data[i + 1] = g;
  canvas.data[i + 2] = b;
  canvas.data[i + 3] = a;
}

function fillRect(canvas: Canvas, x0: number, y0: number, w: number, h: number, color: Rgb, a = 255): void {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) setPixel(canvas, x, y, color, a);
  }
}

function drawText(canvas: Canvas, text: string, x: number, y: number, scale: number, color: Rgb): void {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    const glyph = FONT[char] ?? FONT[' ']!;
    for (let row = 0; row < 5; row += 1) {
      const bits = glyph[row]!;
      for (let col = 0; col < 3; col += 1) {
        if (bits & (1 << (2 - col))) {
          fillRect(canvas, cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += 4 * scale; // 3px glyph + 1px gap
  }
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const xc = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, xc, 0];
  else if (hp < 2) [r, g, b] = [xc, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, xc];
  else if (hp < 4) [r, g, b] = [0, xc, c];
  else if (hp < 5) [r, g, b] = [xc, 0, c];
  else [r, g, b] = [c, 0, xc];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const KIND_BORDER: Record<SpriteEntry['kind'], Rgb> = {
  expression: [201, 163, 90], // gold
  tool: [90, 140, 201], // blue
  touch: [227, 119, 152], // pink
};

function entryHue(entry: SpriteEntry): number {
  if (entry.kind === 'expression' && entry.base) {
    return (baseColorIndex(entry.base as (typeof EMOTIONAL_BASES)[number]) / EMOTIONAL_BASES.length) * 360;
  }
  if (entry.kind === 'tool' && entry.domain) {
    return (TOOL_DOMAINS.indexOf(entry.domain as (typeof TOOL_DOMAINS)[number]) / TOOL_DOMAINS.length) * 360 + 15;
  }
  if (entry.kind === 'touch' && entry.reaction) {
    return (TOUCH_REACTIONS.indexOf(entry.reaction as (typeof TOUCH_REACTIONS)[number]) / TOUCH_REACTIONS.length) * 360 + 330;
  }
  return 210;
}

function shortCode(entry: SpriteEntry): string {
  if (entry.kind === 'expression' && entry.base) {
    return `${entry.base.slice(0, 4)}-${entry.crop === 'avatar' ? 'AV' : 'MN'}`;
  }
  if (entry.kind === 'tool' && entry.domain && entry.phase) {
    return `${entry.domain.slice(0, 4)}-${entry.phase.slice(0, 3)}`;
  }
  if (entry.kind === 'touch' && entry.reaction) {
    return entry.reaction.replace('-', ' ').slice(0, 8);
  }
  return entry.id.slice(0, 8);
}

// Draw one frame at pixel offset (ox, oy) sized fw x fh.
function drawFrame(canvas: Canvas, entry: SpriteEntry, localFrame: number, ox: number, oy: number, fw: number, fh: number): void {
  const hue = entryHue(entry);
  const frameCount = entry.frames.length;
  // Frame-varying lightness so idle/loop animation is visible.
  const lightness = 0.58 + (localFrame / Math.max(frameCount, 1)) * 0.14;
  const bg = hslToRgb(hue, 0.5, lightness);
  const border = KIND_BORDER[entry.kind];

  fillRect(canvas, ox, oy, fw, fh, bg);
  // Border frame.
  fillRect(canvas, ox, oy, fw, 2, border);
  fillRect(canvas, ox, oy + fh - 2, fw, 2, border);
  fillRect(canvas, ox, oy, 2, fh, border);
  fillRect(canvas, ox + fw - 2, oy, 2, fh, border);

  // Simple face motif, bobbing by frame for animation legibility.
  const bob = (localFrame % 2 === 0) ? 0 : 2;
  const cx = ox + Math.floor(fw / 2);
  const eyeY = oy + Math.floor(fh * 0.34) + bob;
  const dark: Rgb = [40, 40, 60];
  fillRect(canvas, cx - 14, eyeY, 6, 6, dark);
  fillRect(canvas, cx + 8, eyeY, 6, 6, dark);
  // Mouth: width encodes frame, giving a tiny talk/emote wiggle.
  const mouthW = 10 + (localFrame % 3) * 4;
  fillRect(canvas, cx - Math.floor(mouthW / 2), oy + Math.floor(fh * 0.52) + bob, mouthW, 3, dark);

  // Labels (identity + frame index) — makes every placeholder distinguishable.
  drawText(canvas, shortCode(entry), ox + 5, oy + Math.floor(fh * 0.66), 2, dark);
  drawText(canvas, `F${localFrame}`, ox + 5, oy + Math.floor(fh * 0.82), 2, [90, 30, 30]);
  // Provenance watermark.
  drawText(canvas, 'PLACEHOLDER', ox + 5, oy + fh - 12, 1, [70, 70, 90]);
}

export interface RenderedSheet {
  readonly name: string;
  readonly filename: string;
  readonly png: Uint8Array;
}

/**
 * Render every sheet's placeholder PNG. Deterministic: identical output every
 * run (fixed layout, fixed colours, fixed zlib level).
 */
export function renderSpriteSheets(): RenderedSheet[] {
  const manifest = buildSpriteManifest();
  const canvases = new Map<string, Canvas>();
  const sheetMeta = new Map<string, SpriteSheet>();

  for (const [name, sheet] of Object.entries(manifest.sheets)) {
    const width = sheet.cols * sheet.frameSize.w;
    const height = Math.max(sheet.rows, 1) * sheet.frameSize.h;
    canvases.set(name, makeCanvas(width, height));
    sheetMeta.set(name, sheet);
  }

  for (const entry of Object.values(manifest.entries)) {
    const canvas = canvases.get(entry.sheet)!;
    const sheet = sheetMeta.get(entry.sheet)!;
    entry.frames.forEach((globalFrame, localFrame) => {
      const rect = frameRect(sheet, globalFrame);
      drawFrame(canvas, entry, localFrame, rect.x, rect.y, rect.w, rect.h);
    });
  }

  const rendered: RenderedSheet[] = [];
  for (const [name, canvas] of canvases) {
    rendered.push({
      name,
      filename: `${name}.png`,
      png: encodePng(canvas.width, canvas.height, canvas.data),
    });
  }
  rendered.sort((a, b) => a.name.localeCompare(b.name));
  return rendered;
}
