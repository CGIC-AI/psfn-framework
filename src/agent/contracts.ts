// ── Agent Contracts ──
// Shared interfaces used by agent, session, memory, gateway, and REPL modules.
// This module is intentionally dependency-light to avoid circular imports.

import type {
  CompletionPurpose,
  LLMRequestMetadata,
  LLMContext,
  LLMResponse,
  StreamCallbacks,
  TurnID,
} from '../types.js';
import type { TrustLevel } from '../trust/types.js';
import type { ChannelMeta } from '../trust/policy.js';
import type { TurnMemorySnapshot } from '../turns/snapshot.js';
import type { ContextBudgetTurnCharacteristics } from '../context-budget.js';

export interface LLMProvider {
  stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse>;
  complete(context: LLMContext, purpose: CompletionPurpose): Promise<LLMResponse>;
}

export type { LLMRequestMetadata };

export interface EmbeddingService {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dims: number;
}

export interface MemoryProvider {
  captureTurnMemorySnapshot?(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
  ): Promise<TurnMemorySnapshot>;
  retrieve(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnSnapshot?: TurnMemorySnapshot,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
  ): Promise<string>;
  retrieveProactiveRecall?(
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnSnapshot?: TurnMemorySnapshot,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
  ): Promise<string>;
}

export interface MemoryExtractor {
  maybeExtract(channelId: string, canonicalContactId?: string, turnId?: TurnID): Promise<void>;
}

export interface ScratchpadEntry {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScratchpadProvider {
  listScratchpadEntries(limit?: number): ScratchpadEntry[];
}
