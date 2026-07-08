// ── Agent Contracts ──
// Shared interfaces used by agent, session, memory, gateway, and REPL modules.
// This module is intentionally dependency-light to avoid circular imports.

import type { CompletionPurpose, CorrelationMetadata, LLMModelHint, LLMRequestMetadata, LLMContext, LLMResponse, StreamCallbacks, TurnID } from '../../shared/contracts/runtime.js';
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
import type { ConversationScope } from '../session/conversation-scope.js';
export type { ScratchpadEntry, ScratchpadProvider } from './scratchpad-port.js';

export interface LLMProviderPort {
  stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse>;
  complete(context: LLMContext, purpose: CompletionPurpose, options?: LLMProviderCompletionOptions): Promise<LLMResponse>;
}

export interface LLMProviderCompletionOptions {
  signal?: AbortSignal;
  modelHint?: LLMModelHint;
  correlation?: Partial<CorrelationMetadata>;
}

export function createLLMProviderPort(provider: LLMProviderPort): LLMProviderPort {
  return {
    stream: (context, callbacks) => provider.stream(context, callbacks),
    complete: (context, purpose, options) => provider.complete(context, purpose, options),
  };
}

export type { LLMRequestMetadata };

export interface EmbeddingProviderPort {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dims: number;
}

/**
 * E8.3: supplemental wiki RAG surface consumed by turn execution. Held on the
 * agent as an optional provider (null until wired); pre-turn assembly calls it
 * AFTER memory context is resolved and appends the returned block as its own
 * labeled section. Implementations fail closed (return '') rather than throw.
 */
export interface WikiRetrievalPort {
  retrieveContextBlock(request: {
    channelId: string;
    queryText: string;
    isDirectMessage: boolean | undefined;
    focusActive: boolean;
    /**
     * W5b: companion's current site (from the situated place seam). Consulted
     * only under multi-companion mode to add the site's shared-world scope.
     */
    currentSiteId?: string | undefined;
    correlation?: Partial<CorrelationMetadata>;
  }): Promise<string>;
}

export interface RetrievalVADInput {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface MemoryProvider {
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
  retrieveProactiveRecall?(
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnSnapshot?: TurnMemorySnapshot,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<string>;
}

export interface MemoryExtractor {
  maybeExtract(
    channelId: string,
    canonicalContactId?: string,
    turnId?: TurnID,
    placeId?: string,
  ): Promise<void>;
  getPendingExtractionPromise?(channelId: string): Promise<void> | null;
}
