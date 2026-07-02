import type {
  PromptSectionScopeClass,
  PromptSectionScopeProvenance,
  PromptSectionVolatilityClass,
} from '../../shared/contracts/runtime.js';

/**
 * Interim per-block producer + scope registry (bead u9jo.3).
 *
 * Scope keys are implicit in the current runtime: DM/contact-scoped blocks are
 * keyed off the resolved canonical contact key, room/channel-scoped blocks off
 * the channelId, and everything else is global. This registry maps the known
 * prompt-section ids (as normalized by `normalizePromptSectionId`) to the
 * producer module and scope class so the Loom can render an inspectable header
 * per block without threading provenance through every producer yet.
 *
 * A later epic replaces this lookup with first-class provenance emitted at each
 * producer; the UI contract (PromptSectionScopeProvenance) is intended to
 * survive that change.
 */
export interface PromptSectionScopeProvenanceSpec {
  producer: string;
  scopeClass: PromptSectionScopeClass;
  volatility?: PromptSectionVolatilityClass;
}

export const PROMPT_SECTION_SCOPE_REGISTRY: Record<
  string,
  PromptSectionScopeProvenanceSpec | undefined
> = {
  // Runtime context / identity producers (global)
  rendered_static_prefix: { producer: 'identity.prompt-runtime', scopeClass: 'global', volatility: 'static' },
  rendered_dynamic_suffix: { producer: 'identity.prompt-runtime', scopeClass: 'global', volatility: 'volatile' },
  runtime_context: { producer: 'substrate-agent.runtime-context', scopeClass: 'global', volatility: 'volatile' },
  companion_runtime_context: { producer: 'substrate-agent.runtime-context', scopeClass: 'global', volatility: 'volatile' },
  companion_persona_adaptation: { producer: 'substrate-agent.runtime-context', scopeClass: 'global', volatility: 'volatile' },
  runtime_charge_budget: { producer: 'runtime-context.charge-budget', scopeClass: 'global', volatility: 'volatile' },
  runtime_satellite_endpoint: { producer: 'runtime-context.satellite-endpoint', scopeClass: 'global', volatility: 'volatile' },
  runtime_current_datetime: { producer: 'runtime-context.current-datetime', scopeClass: 'global', volatility: 'volatile' },
  current_datetime: { producer: 'runtime-context.current-datetime', scopeClass: 'global', volatility: 'volatile' },
  scratchpad_context: { producer: 'substrate-agent.scratchpad', scopeClass: 'global', volatility: 'volatile' },
  final_system_prompt: { producer: 'session.context-builder', scopeClass: 'global', volatility: 'session_stable' },
  session_context: { producer: 'session.context-builder', scopeClass: 'room', volatility: 'append_only' },

  // Memory context producers (contact/room scoped)
  memory_context: { producer: 'memory.retrieval.formatting', scopeClass: 'dm', volatility: 'volatile' },
  core_memory: { producer: 'core-memory.store', scopeClass: 'dm', volatility: 'session_stable' },
  core_profile: { producer: 'memory.retrieval.formatting', scopeClass: 'dm', volatility: 'session_stable' },
  relationship_context: { producer: 'memory.retrieval.formatting', scopeClass: 'dm', volatility: 'volatile' },
  emotional_continuity_snapshot: { producer: 'memory.retrieval.formatting', scopeClass: 'dm', volatility: 'volatile' },
  cross_session_emotional_continuity: { producer: 'memory.retrieval.formatting', scopeClass: 'dm', volatility: 'volatile' },
  memory_context_note: { producer: 'memory.retrieval.formatting', scopeClass: 'global', volatility: 'volatile' },
  episodic_landmark_chains: { producer: 'memory.retrieval.formatting', scopeClass: 'dm', volatility: 'volatile' },
  active_safety_boundaries: { producer: 'memory.retrieval.formatting', scopeClass: 'dm', volatility: 'append_only' },
  relevant_memories: { producer: 'memory.retrieval.formatting', scopeClass: 'dm', volatility: 'volatile' },
  social_context_memories: { producer: 'memory.retrieval.formatting', scopeClass: 'dm', volatility: 'volatile' },
  separate_people_memories: { producer: 'memory.retrieval.formatting', scopeClass: 'global', volatility: 'volatile' },
};

export interface TurnPromptScopeKeys {
  /** `dm:<contactId>` when a canonical contact key is resolved, else undefined. */
  dm?: string;
  /** `room:<channelId>`. */
  room: string;
  /** Always `global`. */
  global: 'global';
  /**
   * When true the turn is a direct message: DM-class blocks resolve to the
   * contact scope; otherwise DM-class blocks fall back to the room scope
   * (group/room turns are keyed to the channel).
   */
  isDirectMessage: boolean;
}

/**
 * Resolve the concrete scope keys for a turn. DM-class blocks in a group/room
 * turn fall back to the room scope key so the operator sees where the block was
 * actually keyed.
 */
export function resolveTurnPromptScopeKeys(input: {
  canonicalContactKey?: string;
  channelId: string;
  isDirectMessage: boolean;
}): TurnPromptScopeKeys {
  const trimmedContact = input.canonicalContactKey?.trim();
  return {
    ...(trimmedContact ? { dm: `dm:${trimmedContact}` } : {}),
    room: `room:${input.channelId}`,
    global: 'global',
    isDirectMessage: input.isDirectMessage,
  };
}

function scopeKeyFor(scopeClass: PromptSectionScopeClass, scopeKeys: TurnPromptScopeKeys): string {
  if (scopeClass === 'global') return scopeKeys.global;
  if (scopeClass === 'room') return scopeKeys.room;
  // DM-class: prefer the contact scope on a real DM, otherwise fall back to room.
  if (scopeKeys.isDirectMessage && scopeKeys.dm) return scopeKeys.dm;
  return scopeKeys.room;
}

/** Resolves per-block producer + scope labels for a normalized section id. */
export type PromptSectionScopeResolver = (
  sectionId: string,
) => PromptSectionScopeProvenance | undefined;

/**
 * Build a scope-provenance resolver for a turn. Given a normalized section id it
 * returns the producer + resolved scope key for that block, or undefined when
 * the section is not in the registry.
 */
export function buildTurnPromptSectionScopeResolver(
  scopeKeys: TurnPromptScopeKeys,
): PromptSectionScopeResolver {
  return (sectionId: string): PromptSectionScopeProvenance | undefined => {
    const spec = PROMPT_SECTION_SCOPE_REGISTRY[sectionId];
    if (!spec) return undefined;
    return {
      producer: spec.producer,
      scopeClass: spec.scopeClass,
      scopeKey: scopeKeyFor(spec.scopeClass, scopeKeys),
      ...(spec.volatility ? { volatility: spec.volatility } : {}),
    };
  };
}
