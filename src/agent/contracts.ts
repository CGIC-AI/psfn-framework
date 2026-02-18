// ── Agent Contracts ──
// Shared interfaces used by agent, session, memory, gateway, and REPL modules.
// This module is intentionally dependency-light to avoid circular imports.

import type {
  CompletionPurpose,
  LLMContext,
  LLMResponse,
  StreamCallbacks,
} from '../types.js';
import type { TrustLevel } from '../trust/types.js';
import type { ChannelMeta } from '../trust/policy.js';

export interface LLMProvider {
  stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse>;
  complete(context: LLMContext, purpose: CompletionPurpose): Promise<LLMResponse>;
}

export interface EmbeddingService {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dims: number;
}

export interface MemoryProvider {
  retrieve(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
  ): Promise<string>;
}

export interface MemoryExtractor {
  maybeExtract(channelId: string, canonicalContactId?: string): Promise<void>;
}
