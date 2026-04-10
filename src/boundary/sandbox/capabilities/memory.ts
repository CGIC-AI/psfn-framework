import { MemoryWriter } from '../../../faculties/memory/writer.js';
import type { EmbeddingProviderPort, LLMProviderPort } from '../../../core/agent/contracts.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { MemoryType, MemoryRedactionOperation } from '../../../faculties/memory/types.js';
import {
  VALID_MEMORY_TYPES,
  VALID_MEMORY_REDACTION_OPERATIONS,
} from '../../../faculties/memory/types.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { ThinkEvidence } from '../../../core/tools/think/types.js';
import { addEvidence, splitCsvTags, toTrimmedString } from './common.js';
import {
  runSessionSearch,
  type SessionSearchResult,
  type SessionSearchViewerContext,
} from '../../../core/session/search-runtime.js';

export interface SessionSearchOptions {
  channelId?: SessionSearchViewerContext['channelId'];
  isDirectMessage?: SessionSearchViewerContext['isDirectMessage'];
  trustLevel?: TrustLevel;
}

export interface MemoryCapabilities {
  memory_search: (query: string, limit?: number) => Promise<Array<{ text: string; type: string; importance: number; similarity: number }>>;
  memory_count: () => Promise<number> | number;
  memory_write: (
    text: string,
    type: string,
    importance?: number,
    emotionalValence?: number,
    tags?: string,
  ) => Promise<{ action: string; id: string }>;
  memory_import_batch: (
    records: Array<{ text: string; type: string; importance?: number; emotional_valence?: number; tags?: string }>,
  ) => Promise<{ written: number; deduplicated: number; errors: number }>;
  memory_upsert: (
    text: string,
    type: string,
    importance?: number,
    emotionalValence?: number,
    tags?: string,
  ) => Promise<{ action: string; id: string; superseded: boolean }>;
  memory_redact: (
    memoryId: string,
    operation?: MemoryRedactionOperation,
    reason?: string,
  ) => Promise<{
    operation: string;
    sourceId: string;
    deleteId?: string;
    abstractedId?: string;
    provenanceRef?: string;
  }>;
  session_messages: (channelId: string, limit?: number) => Array<{ role: string; content: string; timestamp: number }>;
  session_search: (
    query: string,
    limit?: number,
    options?: SessionSearchOptions,
  ) => Promise<SessionSearchResult>;
  session_append_note: (channelId: string, note: string) => boolean;
  memory_get_by_id: (id: string) => Promise<Record<string, unknown> | null>;
}

interface CreateMemoryCapabilitiesOptions {
  llmProvider: LLMProviderPort;
  embeddingService: EmbeddingProviderPort | null;
  memoryStore: MemoryStorePort | null;
  sessionManager: SessionManager | null;
  pushEvidence: (entry: ThinkEvidence) => void;
}

function nextReplInvocationId(): string {
  return `repl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createCompatibleMemoryStore(memoryStore: MemoryStorePort | null): MemoryStorePort | null {
  if (!memoryStore) {
    return null;
  }

  const store = memoryStore as MemoryStorePort & {
    countActiveMemories?: MemoryStorePort['countActiveMemories'];
    persistMemoryWrite?: MemoryStorePort['persistMemoryWrite'];
  };

  if (
    typeof store.countActiveMemories === 'function'
    && typeof store.persistMemoryWrite === 'function'
  ) {
    return memoryStore;
  }

  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'countActiveMemories') {
        return async (): Promise<number> => {
          if (typeof target.countActiveMemories === 'function') {
            return target.countActiveMemories();
          }
          return (await target.getAllActiveMemories()).length;
        };
      }

      if (prop === 'persistMemoryWrite') {
        return async (
          input: Parameters<MemoryStorePort['persistMemoryWrite']>[0],
        ): Promise<void> => {
          if (typeof target.persistMemoryWrite === 'function') {
            await target.persistMemoryWrite(input);
            return;
          }

          if (typeof target.insertMemory !== 'function') {
            throw new Error('memory store missing persistMemoryWrite/insertMemory');
          }

          const commit = async (): Promise<void> => {
            await target.insertMemory(input.memory, input.embedding);

            if (input.supersededMemoryIds?.length) {
              if (typeof target.updateMemory !== 'function') {
                throw new Error('memory store missing updateMemory for superseded writes');
              }
              for (const memoryId of input.supersededMemoryIds) {
                await target.updateMemory(memoryId, { supersededBy: input.memory.id });
              }
            }
          };

          if (typeof target.runInTransaction === 'function') {
            await target.runInTransaction(() => commit());
            return;
          }

          await commit();
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as MemoryStorePort;
}

export function createMemoryCapabilities(options: CreateMemoryCapabilitiesOptions): MemoryCapabilities {
  const memoryStore = createCompatibleMemoryStore(options.memoryStore);
  const writer = (options.embeddingService && memoryStore)
    ? new MemoryWriter(memoryStore, options.embeddingService)
    : null;

  const memory_search = async (
    query: string,
    limit = 10,
  ): Promise<Array<{ text: string; type: string; importance: number; similarity: number }>> => {
    if (!options.embeddingService || !memoryStore) {
      return [];
    }

    const embedding = await options.embeddingService.embed(query);
    const results = await memoryStore.searchByEmbedding(embedding, 0.3, limit);

    addEvidence(options.pushEvidence, {
      source: 'memory_search',
      query,
      snippet: results[0]?.text ?? '',
      resultCount: results.length,
    });

    return results.map(memory => ({
      text: memory.text,
      type: memory.type,
      importance: memory.importance,
      similarity: memory.similarity,
    }));
  };

  const memory_count = (): Promise<number> | number => {
    if (!memoryStore) {
      return 0;
    }
    return memoryStore.countActiveMemories();
  };

  const memory_write = async (
    text: string,
    type: string,
    importance?: number,
    emotionalValence?: number,
    tags?: string,
  ): Promise<{ action: string; id: string }> => {
    if (!writer) {
      return { action: 'error', id: 'no memory system' };
    }
    if (!VALID_MEMORY_TYPES.includes(type as MemoryType)) {
      return { action: 'error', id: `invalid type: ${type}` };
    }

    try {
      const result = await writer.write({
        text,
        type: type as MemoryType,
        importance,
        emotionalValence,
        tags: splitCsvTags(tags),
        sourceRef: `source:repl|operation:memory_write|invocation:${nextReplInvocationId()}`,
      });
      return { action: result.action, id: result.memory.id };
    } catch (error) {
      return { action: 'error', id: toTrimmedString((error as Error).message) || 'memory write failed' };
    }
  };

  const memory_import_batch = async (
    records: Array<{ text: string; type: string; importance?: number; emotional_valence?: number; tags?: string }>,
  ): Promise<{ written: number; deduplicated: number; errors: number }> => {
    if (!writer) {
      return { written: 0, deduplicated: 0, errors: 0 };
    }

    const invocationId = nextReplInvocationId();
    const opts = records.map(record => ({
      text: record.text,
      type: record.type as MemoryType,
      importance: record.importance,
      emotionalValence: record.emotional_valence,
      tags: splitCsvTags(record.tags),
      sourceRef: `source:repl|operation:memory_import_batch|invocation:${invocationId}`,
    }));

    const result = await writer.importBatch(opts);
    return {
      written: result.written,
      deduplicated: result.deduplicated,
      errors: result.errors,
    };
  };

  const memory_upsert = async (
    text: string,
    type: string,
    importance?: number,
    emotionalValence?: number,
    tags?: string,
  ): Promise<{ action: string; id: string; superseded: boolean }> => {
    if (!writer) {
      return { action: 'error', id: 'no memory system', superseded: false };
    }
    if (!VALID_MEMORY_TYPES.includes(type as MemoryType)) {
      return { action: 'error', id: `invalid type: ${type}`, superseded: false };
    }

    try {
      const result = await writer.upsert({
        text,
        type: type as MemoryType,
        importance,
        emotionalValence,
        tags: splitCsvTags(tags),
        sourceRef: `source:repl|operation:memory_upsert|invocation:${nextReplInvocationId()}`,
      });

      return {
        action: result.action,
        id: result.memory.id,
        superseded: result.action === 'superseded',
      };
    } catch (error) {
      return {
        action: 'error',
        id: toTrimmedString((error as Error).message) || 'memory upsert failed',
        superseded: false,
      };
    }
  };

  const memory_redact = async (
    memoryId: string,
    operation: MemoryRedactionOperation = 'auto',
    reason?: string,
  ): Promise<{
    operation: string;
    sourceId: string;
    deleteId?: string;
    abstractedId?: string;
    provenanceRef?: string;
  }> => {
    if (!writer) {
      return { operation: 'error', sourceId: 'no memory system' };
    }

    const normalizedId = toTrimmedString(memoryId);
    if (!normalizedId) {
      return { operation: 'error', sourceId: 'memory id is required' };
    }

    const normalizedOperation = VALID_MEMORY_REDACTION_OPERATIONS.includes(operation)
      ? operation
      : 'auto';
    const invocationId = nextReplInvocationId();

    let result;
    try {
      result = await writer.redact({
        memoryId: normalizedId,
        operation: normalizedOperation,
        reason: toTrimmedString(reason) || undefined,
        requestedBy: `source:repl|operation:memory_redact|invocation:${invocationId}`,
        sourceRef: `source:repl|operation:memory_redact|invocation:${invocationId}`,
      });
    } catch (error) {
      return {
        operation: 'error',
        sourceId: toTrimmedString((error as Error).message) || 'memory redact failed',
      };
    }

    if (!result) {
      return { operation: 'error', sourceId: 'memory not found' };
    }

    return {
      operation: result.operation,
      sourceId: result.sourceMemoryId,
      deleteId: result.deleteId,
      abstractedId: result.abstractedMemoryId,
      provenanceRef: result.externalProvenanceRef,
    };
  };

  const session_messages = (
    channelId: string,
    limit = 20,
  ): Array<{ role: string; content: string; timestamp: number }> => {
    if (!options.sessionManager) {
      return [];
    }

    const entries = options.sessionManager.getRecentMessages(channelId, limit);
    addEvidence(options.pushEvidence, {
      source: 'session_messages',
      query: channelId,
      snippet: entries[0]?.content ?? '',
      resultCount: entries.length,
    });

    return entries.map(entry => ({
      role: entry.role,
      content: entry.content,
      timestamp: entry.timestamp,
    }));
  };

  const session_search = async (
    query: string,
    limit = 8,
    searchOptions?: SessionSearchOptions,
  ): Promise<SessionSearchResult> => {
    const normalizedQuery = toTrimmedString(query);
    const result = await runSessionSearch({
      sessionManager: options.sessionManager,
      llmProvider: options.llmProvider,
      query: normalizedQuery,
      limit,
      summarize: true,
      viewer: searchOptions,
    });

    addEvidence(options.pushEvidence, {
      source: 'session_search',
      query: normalizedQuery,
      snippet: result.summary || result.hits[0]?.snippet || '',
      resultCount: result.hits.length,
    });

    return result;
  };

  const session_append_note = (channelId: string, note: string): boolean => {
    if (!options.sessionManager) {
      return false;
    }
    options.sessionManager.appendSystemNote(channelId, note);
    return true;
  };

  const memory_get_by_id = async (id: string): Promise<Record<string, unknown> | null> => {
    if (!memoryStore) {
      return null;
    }

    const memory = await memoryStore.getById(id);
    if (!memory) {
      return null;
    }

    addEvidence(options.pushEvidence, {
      source: 'memory_get_by_id',
      query: id,
      snippet: memory.text,
      resultCount: 1,
    });

    return {
      id: memory.id,
      text: memory.text,
      type: memory.type,
      importance: memory.importance,
      confidence: memory.confidence,
      emotionalValence: memory.emotionalValence,
      salience: memory.salience,
      sourceRef: memory.sourceRef,
      tags: memory.tags,
    };
  };

  return {
    memory_search,
    memory_count,
    memory_write,
    memory_import_batch,
    memory_upsert,
    memory_redact,
    session_messages,
    session_search,
    session_append_note,
    memory_get_by_id,
  };
}
