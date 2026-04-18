// ── Agent Contracts ──
// Shared interfaces used by agent, session, memory, gateway, and REPL modules.
// This module is intentionally dependency-light to avoid circular imports.

import type { CompletionPurpose, LLMRequestMetadata, LLMContext, LLMResponse, StreamCallbacks, TurnID } from '../../shared/contracts/runtime.js';
import type { TrustLevel } from '../../system/trust/types.js';
import type { ChannelMeta } from '../../system/trust/policy.js';
import type { TurnMemorySnapshot } from '../turns/snapshot.js';
import type { ContextBudgetTurnCharacteristics } from '../../shared/context-budget.js';
import type {
  MemoryScopeQuery,
  RetrievalCallerContext,
  RetrievalModeInput,
} from '../../faculties/memory/types.js';
export type { ScratchpadEntry, ScratchpadProvider } from './scratchpad-port.js';

export interface LLMProviderPort {
  stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse>;
  complete(context: LLMContext, purpose: CompletionPurpose): Promise<LLMResponse>;
}

export function createLLMProviderPort(provider: LLMProviderPort): LLMProviderPort {
  return {
    stream: (context, callbacks) => provider.stream(context, callbacks),
    complete: (context, purpose) => provider.complete(context, purpose),
  };
}

export type { LLMRequestMetadata };

export interface EmbeddingProviderPort {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dims: number;
}

export interface RetrievalVADInput {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface MemoryProvider {
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
  maybeExtract(channelId: string, canonicalContactId?: string, turnId?: TurnID): Promise<void>;
}
