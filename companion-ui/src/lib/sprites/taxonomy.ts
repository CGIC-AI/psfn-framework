// Sprite v2 taxonomy — the frozen id space the generated sprite sheets must
// serve. This is the single source of truth shared by the offline generator
// (scripts/generate-sprite-sheets.ts), the manifest builder, the runtime
// catalog, and the tests. It mirrors the taxonomy in bead psfn-framework-7ang.3
// (emotional base x operational overlay x tool-domain animation).
//
// NB: the *art* referenced by the generated manifest is placeholder art
// (see build-sprites/render-sprites); this module only fixes the id space and
// frame layout, both of which are stable across the placeholder -> final-art
// swap so real sheets drop in file-for-file.

export type SpriteCrop = 'mini' | 'avatar';

// VAD-quadrant emotional base ids (~16). Order is load-bearing: it fixes the
// frame ordering within the expression sheets, so do not reorder without
// regenerating the sheets.
export const EMOTIONAL_BASES = [
  'neutral',
  'content',
  'happy',
  'excited',
  'laughing',
  'love',
  'curious',
  'surprised',
  'sad',
  'tired',
  'anxious',
  'grumpy',
  'smug',
  'embarrassed',
  'thinking',
  'asleep',
] as const;
export type EmotionalBase = (typeof EMOTIONAL_BASES)[number];

// First-party tool domains (~7), mirrored from
// src/core/agent/tool-surface/registry.ts groupings (see 7ang.3):
//   memory/knowledge          -> notebook
//   analysis/orientation      -> magnifier
//   boundary/system/tracked   -> wrench
//   media/self_expression     -> painting
//   contacts/sessions/notify  -> envelope
//   scheduler                 -> clock
//   subagents/shards/adaptive -> clones
export const TOOL_DOMAINS = [
  'notebook',
  'magnifier',
  'wrench',
  'painting',
  'envelope',
  'clock',
  'clones',
] as const;
export type ToolDomain = (typeof TOOL_DOMAINS)[number];

// Tool activity phases (mirror ToolActivityPhase in the hub protocol; the
// 'progress' phase reuses the 'started' loop, so no separate frames).
export const TOOL_PHASES = ['started', 'completed', 'failed'] as const;
export type ToolPhase = (typeof TOOL_PHASES)[number];

// Touch reaction frames (coalesced affection stimuli, 7ang.5 / 7ang.4).
export const TOUCH_REACTIONS = ['headpat-happy', 'hug-squeeze', 'kiss-blush'] as const;
export type TouchReaction = (typeof TOUCH_REACTIONS)[number];

// Frame counts per animation family. Kept small for placeholder art; the
// counts are part of the manifest contract, so real art must supply the same
// frame counts per entry.
export const FRAME_COUNTS = {
  expression: 2, // subtle idle loop
  toolStarted: 4, // running loop
  toolDone: 3, // completed / failed
  touch: 3, // one-shot reaction
} as const;

export const FPS = {
  expression: 2,
  toolStarted: 6,
  toolDone: 8,
  touch: 8,
} as const;

export type SheetName = 'expr-mini' | 'expr-avatar' | 'tool' | 'touch';

export interface SheetGeometry {
  readonly frameSize: { readonly w: number; readonly h: number };
  readonly cols: number;
  readonly lazy: boolean;
}

// Per-sheet geometry. cols fixes the grid; rows are derived from frame count.
// The avatar sheet is lazy-loaded (full-body crop, only needed by the avatar
// view) to keep the default bundle small.
export const SHEET_GEOMETRY: Record<SheetName, SheetGeometry> = {
  'expr-mini': { frameSize: { w: 96, h: 96 }, cols: 8, lazy: false },
  'expr-avatar': { frameSize: { w: 96, h: 144 }, cols: 8, lazy: true },
  tool: { frameSize: { w: 96, h: 96 }, cols: 8, lazy: false },
  touch: { frameSize: { w: 96, h: 96 }, cols: 8, lazy: false },
};

export const SPRITE_CROPS: readonly SpriteCrop[] = ['mini', 'avatar'];

export function expressionEntryId(base: EmotionalBase, crop: SpriteCrop): string {
  return `expr.${base}.${crop}`;
}

export function toolEntryId(domain: ToolDomain, phase: ToolPhase): string {
  return `tool.${domain}.${phase}`;
}

export function touchEntryId(reaction: TouchReaction): string {
  return `touch.${reaction}`;
}

export function sheetForExpression(crop: SpriteCrop): SheetName {
  return crop === 'avatar' ? 'expr-avatar' : 'expr-mini';
}

// Deterministic 0..1 hue index per emotional base, used by the placeholder
// renderer to give each base a distinguishable colour.
export function baseColorIndex(base: EmotionalBase): number {
  return EMOTIONAL_BASES.indexOf(base);
}
