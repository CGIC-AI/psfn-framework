import { MemoryWriter } from '../../memory/writer.js';
import type { EmbeddingService, LLMProvider } from '../../agent/contracts.js';
import type { MemoryStore } from '../../memory/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { SessionEntry } from '../../session/types.js';
import type { MemoryType, MemoryRedactionOperation } from '../../memory/types.js';
import {
  VALID_MEMORY_TYPES,
  VALID_MEMORY_REDACTION_OPERATIONS,
} from '../../memory/types.js';
import { classifyChannel, getAllowedSensitivities } from '../../trust/policy.js';
import type { ChannelVisibility, SensitivityLevel, TrustLevel } from '../../trust/types.js';
import type { ThinkEvidence } from '../types.js';
import { addEvidence, splitCsvTags, toTrimmedString } from './common.js';

const DEFAULT_SESSION_SEARCH_LIMIT = 8;
const MAX_SESSION_SEARCH_LIMIT = 25;
const SESSION_SEARCH_OVERSAMPLE_FACTOR = 4;
const SESSION_SEARCH_MAX_SUMMARY_MATCHES = 10;
const SESSION_SEARCH_MAX_SUMMARY_CONTEXT_CHARS = 4000;
const SESSION_SEARCH_MAX_SNIPPET_CHARS = 220;

const SESSION_SEARCH_SUMMARY_SYSTEM_PROMPT = [
  'You summarize keyword-search matches from archived chat transcripts.',
  'Use only the provided snippets.',
  'Name key topics and channel groupings.',
  'If evidence is sparse or ambiguous, state that explicitly.',
  'Keep the answer concise (3-5 sentences).',
].join(' ');

export interface SessionSearchOptions {
  channelId?: string;
  isDirectMessage?: boolean;
  trustLevel?: TrustLevel;
}

export interface SessionSearchHitResult {
  channelId: string;
  messageId: number;
  role: SessionEntry['role'];
  timestamp: number;
  channelVisibility: ChannelVisibility;
  score: number;
  snippet: string;
}

export interface SessionSearchResult {
  query: string;
  summary: string;
  totalHits: number;
  gatedOutCount: number;
  hits: SessionSearchHitResult[];
}

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
  memory_get_by_id: (id: string) => Record<string, unknown> | null;
}

interface CreateMemoryCapabilitiesOptions {
  llmProvider: LLMProvider;
  embeddingService: EmbeddingService | null;
  memoryStore: MemoryStore | null;
  sessionManager: SessionManager | null;
  pushEvidence: (entry: ThinkEvidence) => void;
}

function nextReplInvocationId(): string {
  return `repl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSessionSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SESSION_SEARCH_LIMIT;
  const normalized = Math.floor(limit);
  if (normalized <= 0) return DEFAULT_SESSION_SEARCH_LIMIT;
  return Math.min(normalized, MAX_SESSION_SEARCH_LIMIT);
}

function resolveTrustLevel(input?: TrustLevel): TrustLevel {
  switch (input) {
    case 'primary':
    case 'trusted':
    case 'regular':
    case 'public':
      return input;
    default:
      return 'regular';
  }
}

function resolveChannelVisibility(input: string | undefined, channelId: string): ChannelVisibility {
  switch (input) {
    case 'private':
    case 'semi_private':
    case 'public':
    case 'broadcast':
      return input;
    default:
      return classifyChannel(channelId);
  }
}

function visibilityToSensitivity(visibility: ChannelVisibility): SensitivityLevel {
  switch (visibility) {
    case 'private':
      return 'confidential';
    case 'semi_private':
      return 'personal';
    case 'public':
    case 'broadcast':
      return 'public';
  }
}

function resolveViewerVisibility(options: SessionSearchOptions | undefined): ChannelVisibility {
  if (options?.channelId) {
    return classifyChannel(options.channelId, {
      isDirectMessage: options.isDirectMessage,
    });
  }
  // Fail-closed: unknown caller context is treated as public.
  return 'public';
}

function truncateSnippet(content: string, maxChars = SESSION_SEARCH_MAX_SNIPPET_CHARS): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function fallbackSessionSearchSummary(query: string, hits: SessionSearchHitResult[]): string {
  if (hits.length === 0) {
    return `No transcript matches found for "${query}".`;
  }

  const channels = [...new Set(hits.map(hit => hit.channelId))];
  return `Found ${hits.length} transcript matches for "${query}" across ${channels.length} channel(s): ${channels.join(', ')}.`;
}

function buildSessionSearchSummaryPayload(
  query: string,
  hits: SessionSearchHitResult[],
): string {
  const lines = [
    `Search query: ${query}`,
    '',
    'Matched transcript snippets:',
  ];

  let budgetUsed = lines.join('\n').length;
  for (const hit of hits.slice(0, SESSION_SEARCH_MAX_SUMMARY_MATCHES)) {
    const timestampIso = new Date(hit.timestamp).toISOString();
    const line = `- [${timestampIso}] channel=${hit.channelId} role=${hit.role} visibility=${hit.channelVisibility} score=${hit.score.toFixed(3)} snippet=${truncateSnippet(hit.snippet)}`;
    if (budgetUsed + line.length > SESSION_SEARCH_MAX_SUMMARY_CONTEXT_CHARS) {
      break;
    }
    lines.push(line);
    budgetUsed += line.length + 1;
  }

  lines.push('');
  lines.push('Summarize what these snippets indicate and highlight the most relevant channels.');
  return lines.join('\n');
}

async function summarizeSessionSearch(
  llmProvider: LLMProvider,
  query: string,
  hits: SessionSearchHitResult[],
): Promise<string> {
  const fallback = fallbackSessionSearchSummary(query, hits);
  if (hits.length === 0) return fallback;

  const payload = buildSessionSearchSummaryPayload(query, hits);
  try {
    const response = await llmProvider.complete(
      {
        systemPrompt: SESSION_SEARCH_SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: payload }],
      },
      'summary',
    );
    const content = toTrimmedString(response.content);
    return content || fallback;
  } catch {
    return fallback;
  }
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

    const result = await writer.redact({
      memoryId: normalizedId,
      operation: normalizedOperation,
      reason: toTrimmedString(reason) || undefined,
      requestedBy: `source:repl|operation:memory_redact|invocation:${invocationId}`,
      sourceRef: `source:repl|operation:memory_redact|invocation:${invocationId}`,
    });

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
    limit = DEFAULT_SESSION_SEARCH_LIMIT,
    searchOptions?: SessionSearchOptions,
  ): Promise<SessionSearchResult> => {
    const normalizedQuery = toTrimmedString(query);
    if (!normalizedQuery || !options.sessionManager) {
      return {
        query: normalizedQuery,
        summary: normalizedQuery
          ? `No transcript matches found for "${normalizedQuery}".`
          : 'No transcript matches found.',
        totalHits: 0,
        gatedOutCount: 0,
        hits: [],
      };
    }

    const requestedLimit = normalizeSessionSearchLimit(limit);
    const rawHits = options.sessionManager.searchTranscripts(
      normalizedQuery,
      requestedLimit * SESSION_SEARCH_OVERSAMPLE_FACTOR,
    );
    const trustLevel = resolveTrustLevel(searchOptions?.trustLevel);
    const viewerVisibility = resolveViewerVisibility(searchOptions);
    const allowedSensitivities = new Set(
      getAllowedSensitivities(trustLevel, viewerVisibility),
    );
    const filteredHits = rawHits.filter(hit => {
      const visibility = resolveChannelVisibility(hit.channelVisibility, hit.channelId);
      return allowedSensitivities.has(visibilityToSensitivity(visibility));
    });

    const hits: SessionSearchHitResult[] = filteredHits
      .slice(0, requestedLimit)
      .map(hit => {
        const visibility = resolveChannelVisibility(hit.channelVisibility, hit.channelId);
        return {
          channelId: hit.channelId,
          messageId: hit.messageId,
          role: hit.role,
          timestamp: hit.timestamp,
          channelVisibility: visibility,
          score: hit.score,
          snippet: truncateSnippet(hit.snippet || hit.content),
        };
      });

    const summary = await summarizeSessionSearch(
      options.llmProvider,
      normalizedQuery,
      hits,
    );

    addEvidence(options.pushEvidence, {
      source: 'session_search',
      query: normalizedQuery,
      snippet: summary || hits[0]?.snippet || '',
      resultCount: hits.length,
    });

    return {
      query: normalizedQuery,
      summary,
      totalHits: rawHits.length,
      gatedOutCount: Math.max(0, rawHits.length - filteredHits.length),
      hits,
    };
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
    memory_redact,
    session_messages,
    session_search,
    session_append_note,
    memory_get_by_id,
  };
}
