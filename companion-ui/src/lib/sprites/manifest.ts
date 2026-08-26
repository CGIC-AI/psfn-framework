// Sprite manifest — the consumer contract between the offline sprite-sheet
// generator and the companion-ui runtime. `buildSpriteManifest()` is pure and
// deterministic (no raster encoding, no I/O) so both the generator CLI and the
// runtime tests derive the exact same id space and frame layout. The runtime
// loads the *serialized* manifest (public/sprites/manifest.json) via
// `loadSpriteManifest()` and never regenerates it.

import {
  EMOTIONAL_BASES,
  FPS,
  FRAME_COUNTS,
  SHEET_GEOMETRY,
  SPRITE_CROPS,
  TOOL_DOMAINS,
  TOOL_PHASES,
  TOUCH_REACTIONS,
  expressionEntryId,
  sheetForExpression,
  toolEntryId,
  touchEntryId,
  type SheetName,
} from './taxonomy.js';

const SPRITE_MANIFEST_VERSION = 1 as const;
const SPRITE_ASSET_DIR = 'sprites';
export const SPRITE_MANIFEST_PATH = `${SPRITE_ASSET_DIR}/manifest.json`;

export type SpriteEntryKind = 'expression' | 'tool' | 'touch';

export interface SpriteEntry {
  readonly id: string;
  readonly kind: SpriteEntryKind;
  readonly sheet: SheetName;
  /** Frame indices (row-major) into the sheet grid. */
  readonly frames: readonly number[];
  readonly fps: number;
  readonly loop: boolean;
  readonly label: string;
  /** Provenance: true while this entry points at placeholder art. */
  readonly placeholder: boolean;
  readonly base?: string;
  readonly crop?: 'mini' | 'avatar';
  readonly domain?: string;
  readonly phase?: string;
  readonly reaction?: string;
}

export interface SpriteSheet {
  readonly src: string;
  readonly cols: number;
  readonly rows: number;
  readonly frameCount: number;
  readonly frameSize: { readonly w: number; readonly h: number };
  /** Load only on demand (avatar-view sheets) to keep the default bundle small. */
  readonly lazy: boolean;
  readonly placeholder: boolean;
}

export interface SpriteManifest {
  readonly version: typeof SPRITE_MANIFEST_VERSION;
  /** Provenance flag: the whole manifest is placeholder art until real art lands. */
  readonly placeholder: boolean;
  readonly generator: string;
  readonly sheets: Readonly<Record<string, SpriteSheet>>;
  readonly entries: Readonly<Record<string, SpriteEntry>>;
}

interface MutableSheet {
  src: string;
  cols: number;
  rows: number;
  frameCount: number;
  frameSize: { w: number; h: number };
  lazy: boolean;
  placeholder: boolean;
  /** Running frame cursor while entries are appended (build-time only). */
  cursor: number;
}

function initSheet(name: SheetName): MutableSheet {
  const geo = SHEET_GEOMETRY[name];
  return {
    src: `${SPRITE_ASSET_DIR}/${name}.png`,
    cols: geo.cols,
    rows: 0,
    frameCount: 0,
    frameSize: { w: geo.frameSize.w, h: geo.frameSize.h },
    lazy: geo.lazy,
    placeholder: true,
    cursor: 0,
  };
}

function allocate(sheet: MutableSheet, count: number): number[] {
  const frames: number[] = [];
  for (let i = 0; i < count; i += 1) {
    frames.push(sheet.cursor);
    sheet.cursor += 1;
  }
  sheet.frameCount = sheet.cursor;
  sheet.rows = Math.ceil(sheet.frameCount / sheet.cols);
  return frames;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Build the canonical sprite manifest from the frozen taxonomy. Deterministic:
 * the same taxonomy always yields byte-identical JSON (stable key order via the
 * fixed taxonomy iteration order).
 */
export function buildSpriteManifest(options?: { placeholder?: boolean; generator?: string }): SpriteManifest {
  const placeholder = options?.placeholder ?? true;
  const sheets: Record<SheetName, MutableSheet> = {
    'expr-mini': initSheet('expr-mini'),
    'expr-avatar': initSheet('expr-avatar'),
    tool: initSheet('tool'),
    touch: initSheet('touch'),
  };
  const entries: Record<string, SpriteEntry> = {};

  // Expressions: each emotional base in each crop, as an idle loop.
  for (const crop of SPRITE_CROPS) {
    const sheetName = sheetForExpression(crop);
    for (const base of EMOTIONAL_BASES) {
      const frames = allocate(sheets[sheetName], FRAME_COUNTS.expression);
      const id = expressionEntryId(base, crop);
      entries[id] = {
        id,
        kind: 'expression',
        sheet: sheetName,
        frames,
        fps: FPS.expression,
        loop: true,
        label: `${titleCase(base)} (${crop})`,
        placeholder,
        base,
        crop,
      };
    }
  }

  // Tool activity: 7 domains x {started(loop), completed, failed}.
  for (const domain of TOOL_DOMAINS) {
    for (const phase of TOOL_PHASES) {
      const count = phase === 'started' ? FRAME_COUNTS.toolStarted : FRAME_COUNTS.toolDone;
      const frames = allocate(sheets.tool, count);
      const id = toolEntryId(domain, phase);
      entries[id] = {
        id,
        kind: 'tool',
        sheet: 'tool',
        frames,
        fps: phase === 'started' ? FPS.toolStarted : FPS.toolDone,
        loop: phase === 'started',
        label: `${titleCase(domain)} ${phase}`,
        placeholder,
        domain,
        phase,
      };
    }
  }

  // Touch reactions: one-shot.
  for (const reaction of TOUCH_REACTIONS) {
    const frames = allocate(sheets.touch, FRAME_COUNTS.touch);
    const id = touchEntryId(reaction);
    entries[id] = {
      id,
      kind: 'touch',
      sheet: 'touch',
      frames,
      fps: FPS.touch,
      loop: false,
      label: titleCase(reaction.replace('-', ' ')),
      placeholder,
      reaction,
    };
  }

  const finalizedSheets: Record<string, SpriteSheet> = {};
  for (const [name, sheet] of Object.entries(sheets)) {
    finalizedSheets[name] = {
      src: sheet.src,
      cols: sheet.cols,
      rows: sheet.rows,
      frameCount: sheet.frameCount,
      frameSize: sheet.frameSize,
      lazy: sheet.lazy,
      placeholder,
    };
  }

  return {
    version: SPRITE_MANIFEST_VERSION,
    placeholder,
    generator: 'companion-ui/scripts/generate-sprite-sheets.ts (placeholder art)',
    sheets: finalizedSheets,
    entries,
  };
}

/** Pixel rectangle for a frame index within a sheet grid. */
export interface FrameRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function frameRect(sheet: SpriteSheet, frameIndex: number): FrameRect {
  if (frameIndex < 0 || frameIndex >= sheet.frameCount) {
    throw new RangeError(`frame index ${frameIndex} out of range for sheet with ${sheet.frameCount} frames`);
  }
  const col = frameIndex % sheet.cols;
  const row = Math.floor(frameIndex / sheet.cols);
  return {
    x: col * sheet.frameSize.w,
    y: row * sheet.frameSize.h,
    w: sheet.frameSize.w,
    h: sheet.frameSize.h,
  };
}

function isFrameArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0);
}

/**
 * Validate a parsed manifest shape defensively — the runtime treats a
 * malformed manifest exactly like a missing one (fail-visible, CSS-face
 * fallback), so this never throws for callers that catch; it throws here and
 * the loader converts that into the fallback path.
 */
export function assertSpriteManifest(value: unknown): asserts value is SpriteManifest {
  if (typeof value !== 'object' || value === null) throw new Error('sprite manifest is not an object');
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== SPRITE_MANIFEST_VERSION) {
    throw new Error(`unsupported sprite manifest version: ${String(manifest.version)}`);
  }
  if (typeof manifest.sheets !== 'object' || manifest.sheets === null) throw new Error('sprite manifest has no sheets');
  if (typeof manifest.entries !== 'object' || manifest.entries === null) throw new Error('sprite manifest has no entries');
  for (const [name, rawSheet] of Object.entries(manifest.sheets as Record<string, unknown>)) {
    const sheet = rawSheet as Record<string, unknown>;
    if (typeof sheet.src !== 'string') throw new Error(`sheet ${name} has no src`);
    if (typeof sheet.cols !== 'number' || sheet.cols <= 0) throw new Error(`sheet ${name} has invalid cols`);
    if (typeof sheet.frameCount !== 'number' || sheet.frameCount < 0) throw new Error(`sheet ${name} has invalid frameCount`);
    const frameSize = sheet.frameSize as Record<string, unknown> | undefined;
    if (!frameSize || typeof frameSize.w !== 'number' || typeof frameSize.h !== 'number') {
      throw new Error(`sheet ${name} has invalid frameSize`);
    }
  }
  for (const [id, rawEntry] of Object.entries(manifest.entries as Record<string, unknown>)) {
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.sheet !== 'string' || !(entry.sheet in (manifest.sheets as object))) {
      throw new Error(`entry ${id} references unknown sheet ${String(entry.sheet)}`);
    }
    if (!isFrameArray(entry.frames) || entry.frames.length === 0) {
      throw new Error(`entry ${id} has invalid frames`);
    }
  }
}

/**
 * Load and validate the serialized manifest at runtime. Rejects (rather than
 * returning null) so callers can log the reason; every caller treats rejection
 * as "use the CSS-face fallback".
 */
export async function loadSpriteManifest(
  fetchImpl: typeof fetch = fetch,
  path: string = SPRITE_MANIFEST_PATH,
): Promise<SpriteManifest> {
  const response = await fetchImpl(path, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`sprite manifest fetch failed: ${response.status} ${response.statusText}`);
  }
  const parsed: unknown = await response.json();
  assertSpriteManifest(parsed);
  return parsed;
}
