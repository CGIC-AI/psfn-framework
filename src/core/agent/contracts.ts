// ── Agent Contracts ──
// Shared interfaces used by agent, session, memory, gateway, and REPL modules.
// This module is intentionally dependency-light to avoid circular imports.

import type { CompletionPurpose, CorrelationMetadata, LLMModelHint, LLMRequestMetadata, LLMContext, LLMResponse, LLMWorkSpec, StreamCallbacks, TurnID } from '../../shared/contracts/runtime.js';
import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import type { TrustLevel } from '../../system/trust/types.js';
import type { ChannelMeta } from '../../system/trust/policy.js';
import type { TurnMemorySnapshot } from '../turns/snapshot.js';
import type { ContextBudgetTurnCharacteristics } from '../../shared/context-budget.js';
import type {
  MemoryScopeQuery,
  RetrievalCallerContext,
  RetrievalModeInput,
} from '../../faculties/memory/types.js';
import type {
  ActiveMemoryContextRequest,
  ActiveMemoryContextSnapshot,
} from '../../faculties/memory/active-context.js';
import type { WikiContextSnapshot } from '../../faculties/wiki/active-context.js';
import type { ConversationScope } from '../session/conversation-scope.js';
import type { SessionEntry } from '../session/types.js';
import type { TurnRetrievalQueryEmbedding } from '../../shared/retrieval-query-embedding.js';
export type { ScratchpadEntry, ScratchpadProvider } from './scratchpad-port.js';

export interface LLMProviderPort {
  /**
   * mmo9.6.1 + mmo9.5.1: `options.signal` cancels the in-flight provider request
   * mid-generation (tears down the upstream HTTP stream, mirroring the existing
   * `complete` cancellation channel). It carries both the caller/barge-in
   * cancellation signal (mmo9.6.1) and the model-call gate's preempt signal
   * (mmo9.5.1), composed together. Optional and additive; a transport that
   * ignores it only stops local consumption.
   */
  stream(
    context: LLMContext,
    callbacks?: StreamCallbacks,
    options?: LLMProviderStreamOptions,
  ): Promise<LLMResponse>;
  complete(context: LLMContext, purpose: CompletionPurpose, options?: LLMProviderCompletionOptions): Promise<LLMResponse>;
}

export interface LLMProviderStreamOptions {
  /**
   * Aborts the in-flight streaming transport call. Composes the caller/barge-in
   * cancellation signal (mmo9.6.1) with the model-call gate's preempt signal
   * (mmo9.5.1) so the upstream stream is torn down when either fires.
   */
  signal?: AbortSignal;
  /**
   * mmo9.7.1: optional typed work spec for an autonomous stream. When present the
   * client honors its correlation + purpose instead of dropping option-level
   * correlation and hardcoding purpose 'chat' (also the mmo9.8 streaming seam).
   * Absent for the interactive chat turn, whose purpose is 'chat'.
   */
  workSpec?: LLMWorkSpec;
  /**
   * an52.3: server-injected authenticated companion identity for per-companion
   * eligibility. Set by the gateway RPC layer from the connection's
   * authenticated companion — never from caller-supplied params or correlation
   * (correlation.companionId is agent-controlled and stripped for
   * companion_private telemetry). Absent for embedded/agent-process clients.
   */
  eligibilityCompanionId?: string;
}

export interface LLMProviderCompletionOptions {
  signal?: AbortSignal;
  modelHint?: LLMModelHint;
  correlation?: Partial<CorrelationMetadata>;
  /**
   * mmo9.7.1: typed work spec supplied by the autonomous client entry
   * (`completeWithWorkSpec`). Optional on the shared port so foreground/tool and
   * gateway callers stay unchanged; the client validates + reconciles it when
   * present. Autonomous src/core + src/faculties call sites always carry one
   * (enforced by the entry's required param and a lint/AST test).
   */
  workSpec?: LLMWorkSpec;
  /** an52.3: see LLMProviderStreamOptions.eligibilityCompanionId. */
  eligibilityCompanionId?: string;
}

export function createLLMProviderPort(provider: LLMProviderPort): LLMProviderPort {
  return {
    stream: (context, callbacks, options) => provider.stream(context, callbacks, options),
    complete: (context, purpose, options) => provider.complete(context, purpose, options),
  };
}

export type { LLMRequestMetadata };

/**
 * E8.3: supplemental wiki RAG surface consumed by turn execution. Held on the
 * agent as an optional provider (null until wired); pre-turn assembly calls it
 * AFTER memory context is resolved and appends the returned block as its own
 * labeled section. Implementations fail closed (empty block) rather than throw.
 *
 * mmo9.7.4: the turn hot path reads a synchronous last-good snapshot via
 * {@link getWikiContextBlock} and schedules a fire-and-forget
 * {@link refreshWikiContextBlock} — it never awaits embed+search. This mirrors
 * active-memory's `getActiveMemoryContext`/`refreshActiveMemoryContext`.
 */
export interface WikiRetrievalRequest {
  channelId: string;
  queryText: string;
  isDirectMessage: boolean | undefined;
  focusActive: boolean;
  turnId?: string;
  requestId?: string;
  companionId?: string;
  canonicalContactId?: string;
  retrievalQueryEmbedding?: TurnRetrievalQueryEmbedding;
  /**
   * W5b: companion's current site (from the situated place seam). Consulted
   * only under multi-companion mode to add the site's shared-world scope.
   */
  currentSiteId?: string | undefined;
  correlation?: Partial<CorrelationMetadata>;
}

export interface WikiRetrievalPort {
  /**
   * Synchronous last-good read for the turn hot path. Never issues embed or
   * search. Returns null on a genuine cold cache miss for an enabled lane
   * (caller serves an empty block and emits a typed turn-degraded event); a
   * closed deterministic gate returns a `ready`, empty, non-degraded snapshot.
   */
  getWikiContextBlock(request: WikiRetrievalRequest): WikiContextSnapshot | null;
  /**
   * Off-path refresh (fire-and-forget from the turn). Runs embed+search,
   * updates the keyed cache, preserves the `wiki.retrieval` telemetry, and
   * degrades to last-good on a hard failure.
   */
  refreshWikiContextBlock(request: WikiRetrievalRequest): Promise<WikiContextSnapshot | null>;
}

export interface RetrievalVADInput {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface MemoryProvider {
  createTurnRetrievalQueryEmbedding?(input: {
    turnId: string;
    requestId: string;
    companionId: string;
    channelId: string;
    canonicalContactId?: string;
    queryText: string;
  }): TurnRetrievalQueryEmbedding;
  getActiveMemoryContext?(request: ActiveMemoryContextRequest): ActiveMemoryContextSnapshot | null;
  refreshActiveMemoryContext?(request: ActiveMemoryContextRequest): Promise<ActiveMemoryContextSnapshot | null>;
  captureTurnMemorySnapshot?(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
    scopeQuery?: MemoryScopeQuery,
    callerContext?: RetrievalCallerContext,
    retrievalMode?: RetrievalModeInput,
  ): Promise<TurnMemorySnapshot>;
  retrieve(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnSnapshot?: TurnMemorySnapshot,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
    currentVAD?: RetrievalVADInput,
    scopeQuery?: MemoryScopeQuery,
    callerContext?: RetrievalCallerContext,
    retrievalMode?: RetrievalModeInput,
    conversationScope?: ConversationScope,
  ): Promise<string>;
}

export interface FinalReflectionExtractionInput {
  source: 'reflection_journal';
  journalEntryId: string;
  templateId: string;
  templateName: string;
  channelId: string;
  reflection: string;
  mode: 'agent' | 'deliberation';
  createdAt: string;
}

export interface MemoryExtractionOutputs {
  memoryIds: string[];
  concernIds: string[];
  contactIds: string[];
}

export interface MemoryExtractor {
  maybeExtract(
    channelId: string,
    canonicalContactId?: string,
    turnId?: TurnID,
    placeId?: string,
    icpCorrelation?: IcpConversationCorrelation,
    assertEffectAllowed?: () => Promise<void>,
    /** Undefined permits foreground live-history lookup; an empty array is authoritative. */
    recoveredEntries?: readonly SessionEntry[],
  ): Promise<MemoryExtractionOutputs | void>;
  /**
   * How many most-recent bounded session entries a durable post-turn handler
   * must snapshot for this extractor. Sized to the configured extraction
   * interval so every accepted interval (1-50) is actually reachable — a fixed
   * ten-entry window can never satisfy an interval above ten — and capped at the
   * extraction recovery window so coverage never advances past entries the
   * extractor's LLM prompt did not see.
   */
  getBoundedExtractionSnapshotLimit(): number;
  getPendingExtractionPromise?(channelId: string): Promise<void> | null;
  /** Canonical final-output seam; intermediate reflection turns never call it. */
  extractFinalReflection?(input: FinalReflectionExtractionInput): Promise<void>;
}
