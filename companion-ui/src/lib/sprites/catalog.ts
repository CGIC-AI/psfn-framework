// Sprite catalog — resolves a companion runtime state to a manifest entry id.
//
// This is the seam sprite v2 (bead psfn-framework-7ang.3) will extend: today
// the companion-ui only knows the six operational SpriteStates, so this maps
// each to a representative emotional-base / tool / touch entry. When the redacted
// emotion.snapshot and tool-domain signals land, pass them through
// `SpriteResolveInput` and the priority order below already picks the richer
// entry (touch > tool > emotion base). The generated manifest and the entry ids
// below are art-agnostic, so swapping placeholder art for final art is
// file-for-file with no change here.

import type { SpriteState } from '../../ui/types.js';
import {
  EMOTIONAL_BASES,
  TOOL_DOMAINS,
  expressionEntryId,
  toolEntryId,
  touchEntryId,
  type EmotionalBase,
  type SpriteCrop,
  type ToolDomain,
  type ToolPhase,
  type TouchReaction,
} from './taxonomy.js';

export interface SpriteResolveInput {
  readonly state: SpriteState;
  /** Coalesced affection reaction is in flight (headpat etc.). */
  readonly touch?: TouchReaction | null;
  /** Future: VAD-quadrant emotional base from emotion.snapshot (7ang.3). */
  readonly base?: EmotionalBase | null;
  /** Future: active tool domain + phase from tool.activity (7ang.3). */
  readonly toolDomain?: ToolDomain | null;
  readonly toolPhase?: ToolPhase | null;
  /** Which crop the surface wants (mini floating sprite vs full-body avatar). */
  readonly crop?: SpriteCrop;
}

// Fallback emotional base per operational state, used until emotion.snapshot is
// wired. Every value is a member of EMOTIONAL_BASES.
const STATE_BASE: Record<SpriteState, EmotionalBase> = {
  attentive: 'neutral',
  speaking: 'happy',
  listening: 'curious',
  thinking: 'thinking',
  tool_use: 'content',
  error: 'anxious',
};

// Default tool domain for the undifferentiated `tool_use` state until the
// tool-domain signal is wired (boundary/system bucket == wrench).
const DEFAULT_TOOL_DOMAIN: ToolDomain = 'wrench';

/**
 * Resolve the manifest entry id for a runtime state. Priority (highest first):
 *   1. touch reaction (affection overrides everything)
 *   2. explicit tool domain/phase, or the `tool_use` operational state
 *   3. emotional base (explicit, else the per-state fallback)
 * Returns an id that `buildSpriteManifest()` is guaranteed to contain.
 */
export function resolveSpriteEntryId(input: SpriteResolveInput): string {
  const crop: SpriteCrop = input.crop ?? 'mini';

  if (input.touch) {
    return touchEntryId(input.touch);
  }

  if (input.toolDomain) {
    return toolEntryId(input.toolDomain, input.toolPhase ?? 'started');
  }
  if (input.state === 'tool_use') {
    return toolEntryId(DEFAULT_TOOL_DOMAIN, input.toolPhase ?? 'started');
  }

  const base = input.base && EMOTIONAL_BASES.includes(input.base)
    ? input.base
    : STATE_BASE[input.state] ?? 'neutral';
  return expressionEntryId(base, crop);
}

export { EMOTIONAL_BASES, TOOL_DOMAINS, STATE_BASE };
