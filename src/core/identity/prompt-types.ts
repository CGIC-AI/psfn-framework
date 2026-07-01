// ── Prompt Stack Types ──
// Layered prompt ownership: base -> operator -> system_language -> runtime -> channel -> task.
// system_language layers are owner-backed template sources and are not rendered into prompts.

export type LayerType = 'base' | 'operator' | 'system_language' | 'runtime' | 'channel' | 'task';
export const PROMPT_LAYER_ROLES = ['system', 'user', 'assistant'] as const;
export type PromptLayerRole = (typeof PROMPT_LAYER_ROLES)[number];

export const LAYER_TYPE_ORDER: Record<LayerType, number> = {
  base: 0,
  operator: 1,
  system_language: 2,
  runtime: 3,
  channel: 4,
  task: 5,
};

export interface PromptLayer {
  id: string;
  type: LayerType;
  name: string;
  /**
   * Optional prompt-manager identifier (for deterministic ordering and required-entry checks).
   * Examples: main, charDescription, charPersonality, scenario, dialogueExamples.
   */
  identifier?: string;
  /**
   * Optional role metadata for future prompt-manager routing.
   */
  role?: PromptLayerRole;
  /**
   * Optional prompt-manager order override (lower = earlier).
   */
  promptOrder?: number;
  content: string;
  enabled: boolean;
  priority: number;        // within same type, lower = first
  channelType?: string;    // 'discord_text', 'discord_voice', 'api', 'internal'
  taskKind?: string;       // 'reflection', 'planning', 'maintenance', 'heartbeat'
  updatedAt: string;       // ISO string
  updatedBy: string;       // 'system' | 'admin' | 'agent'
  checksum: string;        // SHA-256 prefix of content
  version: number;
}

export interface ComposeContext {
  channelType?: string;
  taskKind?: string;
}

export interface CompanionValuesLayerSnapshot {
  content: string;
  provenanceRefs: string[];
  historyVersions: number[];
  entryIds: string[];
}

export interface NorthStarLayerSnapshot {
  content: string;
  itemIds: string[];
}

export interface PromptComposerOptions {
  /**
   * When enabled, prepend immutable constitution amendments before mutable prompt layers.
   */
  enableConstitution?: boolean;
  /**
   * Optional provider for the secondary companion-derived values layer.
   */
  companionValuesLayerProvider?: () => CompanionValuesLayerSnapshot | null;
  /**
   * Optional provider for the North Star long-term goals layer that follows constitution content.
   */
  northStarLayerProvider?: () => NorthStarLayerSnapshot | null;
  /**
   * Persist last-known-good composed prompt snapshots to disk.
   * Defaults to true.
   */
  persistLastKnownGood?: boolean;
}

/**
 * Result of the single composer entrypoint (PromptComposer.composeSplit).
 * The static/dynamic split semantics survive downstream as PromptPlan
 * volatility boundaries; there is no unsplit compose() fallback (E2.2).
 */
export interface ComposeSplitResult {
  text: string;
  hash: string;
  layerCount: number;
  layerIds: string[];
  promptIdentifiers?: string[];
  autoHealedPromptIdentifiers?: string[];
  staticPrefix: string;
  dynamicSuffix: string;
  staticHash: string;
  dynamicHash: string;
  staticLayerIds: string[];
  dynamicLayerIds: string[];
}

export interface PromptHistoryEntry {
  layerId: string;
  layerName: string;
  previousContent: string;
  previousChecksum: string;
  newContent: string;
  newChecksum: string;
  updatedBy: string;
  reason?: string;
  timestamp: string;
  version: number;
}
