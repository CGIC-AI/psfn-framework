// ── Reaction surface contract (psfn-framework-kbdvl.1) ──
//
// Core-owned prompt-rendering contract for curated emoji reactions. Concrete
// channel adapters build surfaces via `channels/shared/reaction-surface.ts`;
// core prompt assembly depends only on this pure contract.

/** A curated standard-emoji reaction with a one-line meaning. */
export interface StandardReactionEntry {
  /** The unicode emoji used verbatim as the reaction token. */
  readonly emoji: string;
  /** One-line meaning shown to the companion. */
  readonly meaning: string;
}

/** A resolved guild-custom emoji that carries a configured one-line meaning. */
export interface ResolvedCustomReactionEntry {
  readonly name: string;
  /** Discord reaction token: `name:id` (or `a:name:id` when animated). */
  readonly token: string;
  readonly meaning: string;
}

/** The curated reaction surface available for a turn. */
export interface ResolvedReactionSurface {
  readonly standard: readonly StandardReactionEntry[];
  readonly custom: readonly ResolvedCustomReactionEntry[];
}

/** True when the surface carries no reactions at all (renders nothing). */
export function reactionSurfaceIsEmpty(surface: ResolvedReactionSurface): boolean {
  return surface.standard.length === 0 && surface.custom.length === 0;
}
