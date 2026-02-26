import { MemoryWriter } from '../../memory/writer.js';
import type { EmbeddingService } from '../../agent-loop.js';
import type { MemoryStore } from '../../memory/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { MemoryType } from '../../memory/types.js';
import { VALID_MEMORY_TYPES } from '../../memory/types.js';
import type { ThinkEvidence } from '../types.js';
import { addEvidence, splitCsvTags } from './common.js';

export interface MemoryCapabilities {
  memory_search: (query: string, limit?: number) => Promise<Array<{ text: string; type: string; importance: number; similarity: number }>>;
  memory_count: () => number;
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
  session_messages: (channelId: string, limit?: number) => Array<{ role: string; content: string; timestamp: number }>;
  session_append_note: (channelId: string, note: string) => boolean;
  memory_get_by_id: (id: string) => Record<string, unknown> | null;
}

interface CreateMemoryCapabilitiesOptions {
  embeddingService: EmbeddingService | null;
  memoryStore: MemoryStore | null;
  sessionManager: SessionManager | null;
  pushEvidence: (entry: ThinkEvidence) => void;
}

function nextReplInvocationId(): string {
  return `repl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemoryCapabilities(options: CreateMemoryCapabilitiesOptions): MemoryCapabilities {
  const writer = (options.embeddingService && options.memoryStore)
    ? new MemoryWriter(options.memoryStore, options.embeddingService)
    : null;

  const memory_search = async (
    query: string,
    limit = 10,
  ): Promise<Array<{ text: string; type: string; importance: number; similarity: number }>> => {
    if (!options.embeddingService || !options.memoryStore) {
      return [];
    }

    const embedding = await options.embeddingService.embed(query);
    const results = options.memoryStore.searchByEmbedding(embedding, 0.3, limit);

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

  const memory_count = (): number => {
    if (!options.memoryStore) {
      return 0;
    }
    return options.memoryStore.getAllActiveMemories().length;
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

    const result = await writer.write({
      text,
      type: type as MemoryType,
      importance,
      emotionalValence,
      tags: splitCsvTags(tags),
      sourceRef: `source:repl|operation:memory_write|invocation:${nextReplInvocationId()}`,
    });
    return { action: result.action, id: result.memory.id };
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

  const session_append_note = (channelId: string, note: string): boolean => {
    if (!options.sessionManager) {
      return false;
    }
    options.sessionManager.appendSystemNote(channelId, note);
    return true;
  };

  const memory_get_by_id = (id: string): Record<string, unknown> | null => {
    if (!options.memoryStore) {
      return null;
    }

    const memory = options.memoryStore.getById(id);
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
    session_messages,
    session_append_note,
    memory_get_by_id,
  };
}
