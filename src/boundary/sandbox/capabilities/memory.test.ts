import { describe, expect, it, vi } from 'vitest';
import type {
  LLMProviderPort,
} from '../../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type {
  MemorySearchResult,
  MemorySubjectAuthorizedQuery,
  MemorySubjectAuthorizedQueryResult,
} from '../../../faculties/memory/memory-store-port.js';
import type { LLMResponse } from '../../../shared/contracts/runtime.js';
import { parseEpisode } from '../../../shared/contracts/episodic-memory.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import { InMemoryMemoryStore } from '../../../test-support/in-memory-memory-store.js';
import { createMemoryCapabilities } from './memory.js';

function mockLLM(summary = 'Summarized search results.'): LLMProviderPort {
  return {
    stream: vi.fn(async () => ({
      content: '',
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      stopReason: 'end_turn',
    } satisfies LLMResponse)),
    complete: vi.fn(async () => ({
      content: summary,
      model: 'mock',
      inputTokens: 12,
      outputTokens: 24,
      toolCalls: [],
      stopReason: 'end_turn',
    } satisfies LLMResponse)),
  };
}

class SubjectAuthorizedIntrospectionMemoryStore extends InMemoryMemoryStore {
  constructor(private readonly authorizedMemories: readonly MemorySearchResult[]) {
    super();
  }

  async queryAuthorizedMemorySubjects(
    input: MemorySubjectAuthorizedQuery,
  ): Promise<MemorySubjectAuthorizedQueryResult> {
    const selected = input.selector.kind === 'detail'
      ? this.authorizedMemories.filter(memory => memory.id === input.selector.memoryId)
      : input.selector.kind === 'embedding_search'
        ? this.authorizedMemories.slice(0, input.selector.limit)
        : [];
    return {
      memories: selected.map(memory => ({ ...memory })),
      total: selected.length,
    };
  }
}

describe('createMemoryCapabilities session_search', () => {
  it('exposes the shared hybrid episode search with bounded evidence', async () => {
    const episode = parseEpisode({
      schemaVersion: 2,
      id: 'episode-repair',
      title: 'Repair without hiding the break',
      landmark: 'We made a silent failure visible.',
      startedAt: '2026-08-09T09:00:00.000Z',
      endedAt: '2026-08-09T09:30:00.000Z',
      channelId: 'api:research',
      participantContactIds: ['contact:primary'],
      salience: { score: 0.9 },
      affect: { labels: ['relieved'] },
      themes: ['repair'],
      spanRefs: [{ spanId: 'span-repair', sessionId: 'api:research' }],
      artifactRefs: [],
      provenanceRefs: [],
      createdAt: '2026-08-09T09:30:00.000Z',
      updatedAt: '2026-08-09T09:30:00.000Z',
    });
    const episodeSearch = {
      search: vi.fn(async () => ({
        results: [{
          episode,
          chain: {
            rootEpisodeId: episode.id,
            episodes: [episode],
            arcs: [],
            score: 0.9,
            matchedTerms: ['repair'],
          },
          fusedScore: 0.88,
          lexicalScore: 0.7,
          semanticSimilarity: 0.91,
          matchedTerms: ['repair'],
          retrievalModes: ['lexical', 'semantic'] as Array<'lexical' | 'semantic'>,
        }],
        modes: {
          lexical: { status: 'completed' as const, candidateCount: 1 },
          semantic: { status: 'completed' as const, candidateCount: 1 },
        },
        degraded: false,
      })),
    };
    const pushEvidence = vi.fn();
    const sessionManager = {
      isSessionRetiredOrQuarantined: vi.fn(() => false),
      getRetiredLogicalSessionIds: vi.fn(() => new Set<string>()),
      getRecentMessages: vi.fn(() => []),
      appendSystemNote: vi.fn(),
    };
    const capabilities = createMemoryCapabilities({
      llmProvider: mockLLM(),
      embeddingService: null,
      memoryStore: null,
      episodeSearch,
      sessionManager,
      pushEvidence,
    });

    const result = await runWithRequestContext({
      channelId: 'api:research',
      viewerTrustLevel: 'trusted',
      viewerChannelPrivacy: 'private',
      viewerMemorySubjectContactId: 'contact:primary',
      requesterProvenance: 'external',
      callType: 'chat',
      originType: 'user',
    }, () => capabilities.episode_search('what did repair teach me?', 4));

    expect(result).toMatchObject({
      degraded: false,
      results: [{
        id: 'episode-repair',
        title: 'Repair without hiding the break',
        fusedScore: 0.88,
        retrievalModes: ['lexical', 'semantic'],
      }],
    });
    expect(episodeSearch.search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'what did repair teach me?',
      limit: 4,
      channelId: 'api:research',
      accessScope: 'channel_participant',
      sessionQuarantineFilter: expect.any(Object),
    }));
    expect(pushEvidence).toHaveBeenCalledWith(expect.objectContaining({
      source: 'episode_search',
      query: 'what did repair teach me?',
      snippet: 'We made a silent failure visible.',
      resultCount: 1,
    }));
  });

  it('keeps CogSec-quarantined memories out of read-only introspection helpers', async () => {
    const retiredSessionId = 'discord:dm:partner:session:retired';
    const fresh: MemorySearchResult = {
      id: 'fresh-memory',
      text: 'Fresh private memory',
      type: 'semantic',
      importance: 0.8,
      confidence: 0.9,
      emotionalValence: 0,
      salience: 0.8,
      sourceRef: 'source:turn|session:fresh-session',
      extractedAt: 1,
      lastAccessed: 1,
      accessCount: 0,
      tags: [],
      sensitivity: 'intimate',
      similarity: 0.9,
    };
    const quarantined: MemorySearchResult = {
      ...fresh,
      id: 'quarantined-memory',
      text: 'Quarantined prompt injection memory',
      sourceRef: `source:intake|session:${retiredSessionId}`,
      provenance: { sessionId: retiredSessionId },
      similarity: 0.99,
    };
    const memoryStore = new SubjectAuthorizedIntrospectionMemoryStore([
      quarantined,
      fresh,
    ]).asPort();
    const embeddingService: EmbeddingProviderPort = {
      embed: vi.fn(async () => new Float32Array([1, 0, 0])),
      embedBatch: vi.fn(async () => []),
      dims: 3,
    };
    const sessionManager = {
      isSessionRetiredOrQuarantined: vi.fn((sessionId: string) => sessionId === retiredSessionId),
      getRetiredLogicalSessionIds: vi.fn(() => new Set([retiredSessionId])),
      getRecentMessages: vi.fn(() => []),
      appendSystemNote: vi.fn(() => undefined),
    };
    const capabilities = createMemoryCapabilities({
      llmProvider: mockLLM(),
      embeddingService,
      memoryStore,
      sessionManager,
      pushEvidence: vi.fn(),
    });

    await runWithRequestContext({
      channelId: 'internal:reflection:daily-review',
      callType: 'background',
      originType: 'background',
      originStage: 'heartbeat.reflection.tool_grounding',
      purpose: 'heartbeat.reflection.tool_grounding',
      requesterProvenance: 'self_directed',
    }, async () => {
      await expect(capabilities.memory_search('private concern', 5)).resolves.toEqual([
        expect.objectContaining({ text: fresh.text }),
      ]);
      await expect(capabilities.memory_get_by_id(quarantined.id)).resolves.toBeNull();
      await expect(capabilities.memory_get_by_id(fresh.id)).resolves.toMatchObject({ text: fresh.text });
    });
  });

  it('fails closed when self-directed reflection lacks a session-quarantine dependency', async () => {
    const fresh: MemorySearchResult = {
      id: 'unfiltered-memory',
      text: 'Memory that must not be served without quarantine state',
      type: 'semantic',
      importance: 0.8,
      confidence: 0.9,
      emotionalValence: 0,
      salience: 0.8,
      sourceRef: 'source:turn|session:unknown-session',
      extractedAt: 1,
      lastAccessed: 1,
      accessCount: 0,
      tags: [],
      sensitivity: 'intimate',
      similarity: 0.9,
    };
    const embeddingService: EmbeddingProviderPort = {
      embed: vi.fn(async () => new Float32Array([1, 0, 0])),
      embedBatch: vi.fn(async () => []),
      dims: 3,
    };
    const capabilities = createMemoryCapabilities({
      llmProvider: mockLLM(),
      embeddingService,
      memoryStore: new SubjectAuthorizedIntrospectionMemoryStore([fresh]).asPort(),
      sessionManager: null,
      pushEvidence: vi.fn(),
    });

    await runWithRequestContext({
      channelId: 'internal:reflection:daily-review',
      callType: 'background',
      originType: 'background',
      originStage: 'heartbeat.reflection.tool_grounding',
      purpose: 'heartbeat.reflection.tool_grounding',
      requesterProvenance: 'self_directed',
    }, async () => {
      await expect(capabilities.memory_search('private concern', 5)).resolves.toEqual([]);
      await expect(capabilities.memory_get_by_id(fresh.id)).resolves.toBeNull();
    });
    expect(embeddingService.embed).not.toHaveBeenCalled();
  });

  it('runs transcript search and summarizes via summary completion purpose', async () => {
    const llm = mockLLM('Kyoto notes were concentrated in two channels.');
    const sessionManager = {
      searchTranscripts: vi.fn(() => [
        {
          channelId: 'api:alpha',
          messageId: 11,
          role: 'user',
          content: 'Kyoto itinerary update',
          snippet: 'Kyoto itinerary update',
          timestamp: 1_000,
          channelVisibility: 'private',
          score: -1.2,
        },
        {
          channelId: 'api:beta',
          messageId: 12,
          role: 'assistant',
          content: 'Kyoto train reminders',
          snippet: 'Kyoto train reminders',
          timestamp: 2_000,
          channelVisibility: 'private',
          score: -1.0,
        },
      ]),
      getRecentMessages: vi.fn(() => []),
      appendSystemNote: vi.fn(),
    } as unknown as SessionManager;

    const capabilities = createMemoryCapabilities({
      llmProvider: llm,
      embeddingService: null,
      memoryStore: null,
      sessionManager,
      pushEvidence: vi.fn(),
    });

    const result = await capabilities.session_search('Kyoto', 5, {
      channelId: 'api:current',
      isDirectMessage: true,
      trustLevel: 'primary',
    });

    expect(result.summary).toContain('Kyoto notes');
    expect(result.hits).toHaveLength(2);
    const complete = vi.mocked(llm.complete);
    expect(complete).toHaveBeenCalledTimes(1);
    const [context, positionalPurpose, options] = complete.mock.calls[0] ?? [];
    // completeWithWorkSpec strips correlation from prompt context and owns it
    // on the typed completion options/work spec.
    expect(context.correlation).toBeUndefined();
    expect(positionalPurpose).toBe('background');
    expect(options?.workSpec).toMatchObject({
      purpose: 'background',
      durable: false,
      correlation: {
        callType: 'summary',
        purpose: 'session.search.summary',
        originType: 'summary',
        originStage: 'session.search.summary',
        channelId: 'api:current',
      },
    });
    expect(options?.correlation).toEqual(options?.workSpec?.correlation);
  });

  it('filters session_search hits with trust + channel visibility gates before summarization', async () => {
    const llm = mockLLM('Only public snippets were visible in this context.');
    const sessionManager = {
      searchTranscripts: vi.fn(() => [
        {
          channelId: 'api:private',
          messageId: 1,
          role: 'user',
          content: 'ultra-private confidences',
          snippet: 'ultra-private confidences',
          timestamp: 1_000,
          channelVisibility: 'private',
          score: -3,
        },
        {
          channelId: '1234567890',
          messageId: 2,
          role: 'assistant',
          content: 'guild planning notes',
          snippet: 'guild planning notes',
          timestamp: 2_000,
          channelVisibility: 'invite_only',
          score: -2,
        },
        {
          channelId: 'twitter:timeline',
          messageId: 3,
          role: 'assistant',
          content: 'public launch announcement',
          snippet: 'public launch announcement',
          timestamp: 3_000,
          channelVisibility: 'broadcast',
          score: -1,
        },
      ]),
      getRecentMessages: vi.fn(() => []),
      appendSystemNote: vi.fn(),
    } as unknown as SessionManager;

    const capabilities = createMemoryCapabilities({
      llmProvider: llm,
      embeddingService: null,
      memoryStore: null,
      sessionManager,
      pushEvidence: vi.fn(),
    });

    const result = await capabilities.session_search('launch', 5, {
      channelId: 'api:current',
      isDirectMessage: true,
      trustLevel: 'public',
    });

    expect(result.totalHits).toBe(3);
    expect(result.gatedOutCount).toBe(2);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].channelId).toBe('twitter:timeline');

    const summaryPayload = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[0].content as string;
    expect(summaryPayload).toContain('public launch announcement');
    expect(summaryPayload).not.toContain('ultra-private confidences');
    expect(summaryPayload).not.toContain('guild planning notes');
  });
});
