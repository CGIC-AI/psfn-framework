import { fromAny } from '@total-typescript/shoehorn';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { TestingSessionMemoryWriteError } from './writer.js';
import {
  createMemoryTool,
  createMemoryWriteTool,
  createMemoryImportTool,
  createMemoryPatchTool,
  createMemoryRedactTool,
  createMemoryDeleteTool,
  createScratchpadTool,
  createUndoMemoryDeleteTool,
  createScratchpadReadTool,
  createScratchpadWriteTool,
} from './tools.js';
import type {
  MemoryDeleteVersion,
  MemoryStorePort,
} from './memory-store-port.js';
import type {
  MemoryWriter,
  WriteResult,
  BatchImportResult,
} from './writer.js';
import type { PurrMemory } from './types.js';
import type {
  MemoryDeletionApprovalPort,
  MemoryDeletionApprovalResult,
  MemoryDeletionProposal,
  MemoryDeletionProposalStorePort,
} from './deletion-proposals.js';
import {
  EPISODIC_CONTRACT_VERSION,
  type Episode,
  type EpisodeArc,
} from '../../shared/contracts/episodic-memory.js';
import type { EpisodicTimelineStore } from './retrieval/episodic.js';
import { createDefaultMemoryRetrievalPolicy } from '../../system/config/memory-retrieval-policy.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';

/** Extract text from AgentToolResult content array */
function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(c => c.text).join('');
}

function mockMemoryDeletionProposalStore() {
  return {
    createMemoryDeletionProposal:
      vi.fn<MemoryDeletionProposalStorePort['createMemoryDeletionProposal']>(),
    markMemoryDeletionPartnerAlerted:
      vi.fn<MemoryDeletionProposalStorePort['markMemoryDeletionPartnerAlerted']>(),
    approveMemoryDeletionProposal:
      vi.fn<MemoryDeletionProposalStorePort['approveMemoryDeletionProposal']>(),
    denyMemoryDeletionProposal:
      vi.fn<MemoryDeletionProposalStorePort['denyMemoryDeletionProposal']>(),
    getMemoryDeletionProposal:
      vi.fn<MemoryDeletionProposalStorePort['getMemoryDeletionProposal']>(),
    listPendingMemoryDeletionProposals:
      vi.fn<MemoryDeletionProposalStorePort['listPendingMemoryDeletionProposals']>(),
    listRecoverableMemoryDeletionProposals:
      vi.fn<MemoryDeletionProposalStorePort['listRecoverableMemoryDeletionProposals']>(),
    listMemoryDeletionAuditEvents:
      vi.fn<MemoryDeletionProposalStorePort['listMemoryDeletionAuditEvents']>(),
  } satisfies MemoryDeletionProposalStorePort;
}

function mockMemoryDeletionApprovalPort() {
  return {
    requestMemoryDeletionApproval:
      vi.fn<MemoryDeletionApprovalPort['requestMemoryDeletionApproval']>(),
  } satisfies MemoryDeletionApprovalPort;
}

// ── Mock MemoryWriter ──

function makeMemory(overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id: 'mem-001',
    text: 'Test memory',
    type: 'semantic',
    importance: 0.5,
    confidence: 0.8,
    emotionalValence: 0,
    salience: 0.5,
    sourceRef: 'tool:memory_write',
    extractedAt: Date.now(),
    lastAccessed: Date.now(),
    accessCount: 1,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  const id = overrides.id ?? 'episode-1';
  const startedAt = overrides.startedAt ?? '2026-03-30T10:00:00.000Z';
  const endedAt = overrides.endedAt ?? '2026-03-30T10:05:00.000Z';
  return {
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id,
    title: 'Morning planning check-in',
    landmark: 'They reviewed the next practical step and why it mattered.',
    startedAt,
    endedAt,
    threadId: 'thread-alpha',
    channelId: 'api:test',
    participantContactIds: ['contact:primary'],
    salience: { score: 0.76, novelty: 0.4, emotionalIntensity: 0.3 },
    affect: { valence: 0.2, arousal: 0.3, dominance: 0.4, labels: ['focused'] },
    themes: ['planning'],
    spanRefs: [{
      spanId: `span-${id}`,
      threadId: 'thread-alpha',
      channelId: 'api:test',
      startedAt,
      endedAt,
    }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: `span-${id}` }],
    createdAt: '2026-03-30T10:06:00.000Z',
    updatedAt: '2026-03-30T10:06:00.000Z',
    ...overrides,
  };
}

function makeEpisodeArc(overrides: Partial<EpisodeArc> = {}): EpisodeArc {
  return {
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id: 'arc-1',
    sourceEpisodeId: 'episode-root',
    targetEpisodeId: 'episode-linked',
    arcKind: 'continuation',
    salience: 0.8,
    confidence: 0.78,
    themes: ['planning'],
    spanRefs: [{ spanId: 'span-arc-1' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: 'span-arc-1' }],
    createdAt: '2026-03-30T10:06:00.000Z',
    updatedAt: '2026-03-30T10:06:00.000Z',
    ...overrides,
  };
}

function makeEpisodicTimelineStore(
  episodes: Episode[],
  arcs: EpisodeArc[] = [],
): EpisodicTimelineStore & {
  searchByTime: ReturnType<typeof vi.fn>;
  listEpisodes: ReturnType<typeof vi.fn>;
  getEpisode: ReturnType<typeof vi.fn>;
  listEpisodeArcsForEpisode: ReturnType<typeof vi.fn>;
} {
  return {
    searchByTime: vi.fn((options: { from?: string; to?: string; limit?: number; offset?: number } = {}) => {
      const filtered = episodes
        .filter(episode => (
          (options.from === undefined || episode.endedAt >= options.from)
          && (options.to === undefined || episode.startedAt <= options.to)
        ))
        .sort((left, right) => (
          left.startedAt.localeCompare(right.startedAt)
          || left.id.localeCompare(right.id)
        ));
      const offset = options.offset ?? 0;
      const limit = options.limit ?? filtered.length;
      return filtered.slice(offset, offset + limit);
    }),
    listEpisodes: vi.fn((options: { limit?: number; offset?: number } = {}) => {
      const sorted = [...episodes].sort((left, right) => (
        left.startedAt.localeCompare(right.startedAt)
        || left.id.localeCompare(right.id)
      ));
      const offset = options.offset ?? 0;
      const limit = options.limit ?? sorted.length;
      return sorted.slice(offset, offset + limit);
    }),
    getEpisode: vi.fn((id: string) => episodes.find(episode => episode.id === id)),
    listEpisodeArcsForEpisode: vi.fn((id: string) => arcs.filter(arc => (
      arc.sourceEpisodeId === id || arc.targetEpisodeId === id
    ))),
  };
}

function mockWriter(): {
  write: ReturnType<typeof vi.fn>;
  importBatch: ReturnType<typeof vi.fn>;
  patchMemory: ReturnType<typeof vi.fn>;
} {
  return {
    write: vi.fn(async (): Promise<WriteResult> => ({
      action: 'created',
      memory: makeMemory(),
    })),
    importBatch: vi.fn(async (): Promise<BatchImportResult> => ({
      written: 0,
      deduplicated: 0,
      superseded: 0,
      errors: 0,
      results: [],
    })),
    patchMemory: vi.fn(async () => ({
      memory: makeMemory(),
      patchEventId: 'patch-1',
      updatedFields: ['confidence'],
    })),
  };
}

describe('createMemoryTool', () => {
  let writer: ReturnType<typeof mockWriter>;

  function makeUnifiedDeleteVersion(overrides: Partial<MemoryDeleteVersion> = {}): MemoryDeleteVersion {
    return {
      deleteId: 'del-1',
      memoryId: 'mem-1',
      snapshot: makeMemory({ id: 'mem-1' }),
      deletedAt: Date.now(),
      deletedBy: 'tool:memory|action:delete',
      ...overrides,
    };
  }

  function mockUnifiedStore(memories: PurrMemory[] = []): {
    searchByText: ReturnType<typeof vi.fn>;
    listMemories: ReturnType<typeof vi.fn>;
    listActiveMemories: ReturnType<typeof vi.fn>;
    getAllActiveMemories: ReturnType<typeof vi.fn>;
    softDeleteMemory: ReturnType<typeof vi.fn>;
    undoSoftDelete: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
  } {
    const cloneMemories = (items: PurrMemory[]) => items.map(memory => ({ ...memory }));
    return {
      searchByText: vi.fn(),
      listMemories: vi.fn(async () => cloneMemories(memories)),
      listActiveMemories: vi.fn(async () => cloneMemories(memories.filter(memory => !memory.deletedAt && !memory.supersededBy))),
      getAllActiveMemories: vi.fn(async () => cloneMemories(memories.filter(memory => !memory.deletedAt && !memory.supersededBy))),
      softDeleteMemory: vi.fn(),
      undoSoftDelete: vi.fn(),
      getById: vi.fn(async (id: string) => cloneMemories(memories).find(memory => memory.id === id)),
    };
  }

  beforeEach(() => {
    writer = mockWriter();
  });

  it('returns a unified memory tool contract', () => {
    const tool = createMemoryTool(writer as unknown as MemoryWriter, mockUnifiedStore() as unknown as MemoryStorePort);

    expect(tool.name).toBe('memory');
    expect(tool.label).toBe('memory');
    expect(tool.description).toBe(CANONICAL_TOOL_SURFACE_DESCRIPTIONS.memory);
    expect(tool.parameters).toBeDefined();
  });

  it('writes through action=write with unified provenance', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    await tool.execute('memory-call-1', {
      action: 'write',
      text: '  V enjoys precise APIs  ',
      type: 'semantic',
      importance: 0.7,
      tags: 'Identity, Preference',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'V enjoys precise APIs',
      type: 'semantic',
      importance: 0.7,
      tags: ['identity', 'preference'],
      sourceRef: 'source:tool:memory|action:write|invocation:memory-call-1',
      sourceType: 'tool_write',
      // ca980: a live-turn write carries the conversation instant (now); the
      // write happens IN the conversation so wall-clock is the correct anchor.
      provenance: {
        toolName: 'memory',
        toolCallId: 'memory-call-1',
        sourceConversationAt: expect.any(Number),
      },
    }));
  });

  it('stamps the live-turn conversation instant on a fresh write, but not on a historical import (ca980)', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);
    const importTool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const before = Date.now();
    await tool.execute('memory-call-live', {
      action: 'write',
      text: 'V shipped the disclosure-epoch fix today',
      type: 'episodic',
    });
    const after = Date.now();

    const writeProvenance = writer.write.mock.calls[0][0].provenance as { sourceConversationAt?: number };
    expect(writeProvenance.sourceConversationAt).toBeGreaterThanOrEqual(before);
    expect(writeProvenance.sourceConversationAt).toBeLessThanOrEqual(after);

    // A bulk import restores HISTORICAL content — it must NOT claim now() as its
    // conversation time (that would over-share pre-demotion content), so the
    // import path leaves sourceConversationAt unstamped and fails closed.
    await importTool.execute('import-live', {
      records: [{ text: 'restored legacy memory', type: 'semantic', occurred_at: '2024-01-01T00:00:00Z' }],
    });
    const imported = writer.importBatch.mock.calls[0][0][0] as { provenance: { sourceConversationAt?: number } };
    expect(imported.provenance.sourceConversationAt).toBeUndefined();
  });

  it.each([
    [{ explanation: 'A source correction exists.' }, 'justification_category is required'],
    [{ justification_category: 'factually_incorrect' }, 'explanation is required'],
  ])('refuses a deletion proposal missing mandatory justification fields', async (fields, message) => {
    const store = mockUnifiedStore([makeMemory({ id: 'mem-1' })]);
    const proposalStore = mockMemoryDeletionProposalStore();
    const tool = createMemoryTool(
      writer as unknown as MemoryWriter,
      store as unknown as MemoryStorePort,
      {
        memoryDeletionProposalStore: proposalStore,
        memoryDeletionApprovalPort: mockMemoryDeletionApprovalPort(),
        memoryDeletionPolicy: {
          justificationCategories: [{
            id: 'factually_incorrect',
            label: 'Factually incorrect',
            eligible: true,
            explanationPatterns: ['source correction'],
          }],
        },
      },
    );

    const result = await tool.execute('memory-call-missing-justification', fromAny({
      action: 'delete',
      memory_id: 'mem-1',
      ...fields,
    }));

    expect(resultText(fromAny(result))).toContain(message);
    expect(result.details?.isError).toBe(true);
    expect(proposalStore.createMemoryDeletionProposal).not.toHaveBeenCalled();
    expect(store.softDeleteMemory).not.toHaveBeenCalled();
  });

  it('refuses negative valence alone using the settings-owned category reason', async () => {
    const store = mockUnifiedStore([makeMemory({ id: 'mem-1' })]);
    const proposalStore = mockMemoryDeletionProposalStore();
    const tool = createMemoryTool(
      writer as unknown as MemoryWriter,
      store as unknown as MemoryStorePort,
      {
        memoryDeletionProposalStore: proposalStore,
        memoryDeletionApprovalPort: mockMemoryDeletionApprovalPort(),
        memoryDeletionPolicy: {
          justificationCategories: [{
            id: 'negative_valence_only',
            label: 'Negative valence alone',
            eligible: false,
            explanationPatterns: ['dislike', 'embarrassed', 'discomfort', 'negative valence'],
            refusalReason: 'Dislike, embarrassment, discomfort, or negative valence alone are insufficient grounds for deletion.',
          }],
        },
      },
    );

    const result = await tool.execute('memory-call-negative-valence', {
      action: 'delete',
      memory_id: 'mem-1',
      justification_category: 'negative_valence_only',
      explanation: 'I feel embarrassed and dislike remembering this.',
    });

    const text = resultText(fromAny(result));
    expect(text).toContain('discomfort');
    expect(text).toContain('negative valence alone');
    expect(result.details?.isError).toBe(true);
    expect(proposalStore.createMemoryDeletionProposal).not.toHaveBeenCalled();
    expect(store.softDeleteMemory).not.toHaveBeenCalled();
  });

  it('refuses a negative-valence-only explanation mislabeled with an eligible category', async () => {
    const store = mockUnifiedStore([makeMemory({ id: 'mem-1' })]);
    const proposalStore = mockMemoryDeletionProposalStore();
    const tool = createMemoryTool(
      writer as unknown as MemoryWriter,
      store as unknown as MemoryStorePort,
      {
        memoryDeletionProposalStore: proposalStore,
        memoryDeletionApprovalPort: mockMemoryDeletionApprovalPort(),
        memoryDeletionPolicy: {
          justificationCategories: [
            {
              id: 'factually_incorrect',
              label: 'Factually incorrect',
              eligible: true,
              explanationPatterns: ['factually incorrect', 'source retracted'],
            },
            {
              id: 'negative_valence_only',
              label: 'Negative valence alone',
              eligible: false,
              explanationPatterns: ['dislike', 'embarrassed', 'discomfort', 'negative valence'],
              refusalReason: 'Dislike, embarrassment, discomfort, or negative valence alone are insufficient grounds for deletion.',
            },
          ],
        },
      },
    );

    const result = await tool.execute('memory-call-mislabeled-negative-valence', {
      action: 'delete',
      memory_id: 'mem-1',
      justification_category: 'factually_incorrect',
      explanation: 'I dislike remembering this and feel embarrassed.',
    });

    expect(resultText(result)).toMatch(/dislike.*embarrassment.*discomfort.*negative valence alone/iu);
    expect(result.details?.isError).toBe(true);
    expect(proposalStore.createMemoryDeletionProposal).not.toHaveBeenCalled();
    expect(store.softDeleteMemory).not.toHaveBeenCalled();
  });

  it('stamps request-context sessionId so a testing-session write is fenced', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);
    writer.write.mockRejectedValueOnce(
      new TestingSessionMemoryWriteError('api:operator:testing:harness'),
    );

    const result = await runWithRequestContext(
      { sessionId: 'api:operator:testing:harness', callType: 'chat', purpose: 'chat' },
      () => tool.execute('memory-call-testing', {
        action: 'write',
        text: 'testing-session memory that must not persist',
        type: 'semantic',
      }),
    );

    // The logical session id reaches the writer so its testing fence fires...
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      provenance: expect.objectContaining({
        toolName: 'memory',
        toolCallId: 'memory-call-testing',
        sessionId: 'api:operator:testing:harness',
      }),
    }));
    // ...and the tool surfaces the denial instead of swallowing it.
    expect(result.details?.isError).toBe(true);
  });

  it('normalizes JSON-array tag strings for unified writes', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    await tool.execute('memory-call-json-tags', {
      action: 'write',
      text: 'V likes clean tag metadata',
      type: 'semantic',
      tags: '["Identity", "Preference", 42, "  Hobby  "]',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['identity', 'preference', 'hobby'],
    }));
  });

  it('patches through action=patch with unified provenance', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const result = await tool.execute('memory-call-patch', {
      action: 'patch',
      memory_id: 'mem-patch',
      confidence: 0.92,
      append_tags: ' corrected, preference ',
      reason: 'operator correction',
    });

    expect(writer.patchMemory).toHaveBeenCalledWith(expect.objectContaining({
      memoryId: 'mem-patch',
      confidence: 0.92,
      appendTags: ['corrected', 'preference'],
      reason: 'operator correction',
      sourceRef: 'source:tool:memory|action:patch|invocation:memory-call-patch',
      sourceType: 'tool_write',
      provenance: {
        toolName: 'memory',
        toolCallId: 'memory-call-patch',
      },
    }));
    expect(resultText(fromAny(result))).toContain('Memory patched');
  });

  it('rejects retired helper action names on canonical memory', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const result = await tool.execute('memory-call-retired-alias', fromAny({
      action: 'memory_write',
      text: 'Alias write',
      type: 'semantic',
    }));

    expect(writer.write).not.toHaveBeenCalled();
    expect(resultText(fromAny(result))).toContain('invalid action');
    expect((fromAny(result.details)).isError).toBe(true);
  });

  it('describes required fields for model-facing memory actions', () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    expect(tool.description).toBe(CANONICAL_TOOL_SURFACE_DESCRIPTIONS.memory);
  });

  it('searches through action=search and formats results', async () => {
    const store = mockUnifiedStore();
    store.searchByText.mockResolvedValue([
      { ...makeMemory({ id: 'mem-search-1', text: 'V likes direct answers', sensitivity: 'public' }), similarity: 0.82 },
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const result = await tool.execute('memory-call-2', {
      action: 'search',
      query: 'direct answers',
      limit: 2,
    });

    expect(store.searchByText).toHaveBeenCalledWith('direct answers', 2);
    expect(resultText(fromAny(result))).toContain('Memory search results (1)');
    expect(resultText(fromAny(result))).toContain('mem-search-1');
    expect(resultText(fromAny(result))).toContain('similarity=0.82');
  });

  it('census reports public-channel visible counts and companion-readable withheld context without protected text', async () => {
    const store = mockUnifiedStore([
      makeMemory({
        id: 'mem-public-active',
        text: 'Public deploy plan is safe to mention',
        type: 'semantic',
        sensitivity: 'public',
        sourceType: 'turn',
        contactId: 'contact:primary',
      }),
      makeMemory({
        id: 'mem-public-archived',
        text: 'Archived public deploy note',
        type: 'episodic',
        sensitivity: 'public',
        sourceType: 'tool_write',
        deletedAt: 1_700_000_000_000,
        deletedBy: 'test',
      }),
      makeMemory({
        id: 'mem-secret',
        text: 'secret launch phrase must not leak',
        type: 'semantic',
        sensitivity: 'confidential',
        sourceType: 'turn',
      }),
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const result = await tool.execute('memory-call-census-public', {
      action: 'census',
      channel_id: 'api:public',
      trust_level: 'regular',
      channel_visibility: 'public',
    });

    const text = resultText(fromAny(result));
    expect(text).toContain('Memory census:');
    expect(text).toContain('Visible memories: 2');
    expect(text).toContain('By type: episodic: 1, semantic: 1.');
    expect(text).toContain('By sensitivity: public: 2.');
    expect(text).toContain('By state: active: 1, archived: 1.');
    expect(text).toContain('Withheld context: 1 candidate memory was present');
    expect(text).toContain('Withheld trust/privacy reasons: 1 trust ceiling.');
    expect(text).toContain('Withheld categories: semantic: 1.');
    expect(text).toContain('Withheld provenance classes: turn: 1.');
    expect(text).toContain('No memory text returned.');
    expect(text).not.toContain('secret launch phrase');
    expect(text).not.toContain('mem-secret');
  });

  it('exists answers contact-scoped topic checks without returning memory text', async () => {
    const store = mockUnifiedStore([
      makeMemory({
        id: 'mem-primary',
        text: 'Primary contact deployment plan prefers concise rollout summaries',
        type: 'semantic',
        sensitivity: 'personal',
        contactId: 'contact:primary',
        scopeRef: { kind: 'contact', id: 'contact:primary' },
        scopeTags: ['relationship'],
      }),
      makeMemory({
        id: 'mem-other',
        text: 'Other contact deployment plan has a different cadence',
        type: 'semantic',
        sensitivity: 'public',
        contactId: 'contact:other',
        scopeRef: { kind: 'contact', id: 'contact:other' },
      }),
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const result = await tool.execute('memory-call-exists-contact', {
      action: 'exists',
      query: 'deployment plan',
      contact_id: 'contact:primary',
      channel_id: 'api:private',
      trust_level: 'primary',
      channel_visibility: 'private',
      canonical_contact_id: 'contact:primary',
    });

    const text = resultText(fromAny(result));
    expect(text).toContain('Result: yes, 1 visible matching memory found.');
    expect(text).toContain('By contact scope: contact:primary: 1.');
    expect(text).toContain('By scope ref: contact:contact:primary: 1.');
    expect(text).toContain('No memory text returned.');
    expect(text).not.toContain('concise rollout summaries');
    expect(text).not.toContain('different cadence');
    expect(text).not.toContain('mem-primary');
  });

  it('exists reports withheld-only confidential matches on public channels without leaking text', async () => {
    const store = mockUnifiedStore([
      makeMemory({
        id: 'mem-hidden-topic',
        text: 'confidential garden protocol phrase',
        type: 'procedural',
        sensitivity: 'confidential',
        sourceType: 'tool_write',
      }),
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const result = await tool.execute('memory-call-exists-withheld', {
      action: 'exists',
      query: 'garden protocol',
      channel_id: 'api:public',
      trust_level: 'public',
      channel_visibility: 'public',
    });

    const text = resultText(fromAny(result));
    expect(text).toContain('Result: yes, matching memory exists, but none is visible in this channel.');
    expect(text).toContain('Withheld context: 1 candidate memory was present');
    expect(text).toContain('Withheld categories: procedural: 1.');
    expect(text).toContain('Withheld provenance classes: tool_write: 1.');
    expect(text).toContain('Withheld relevance bands: 1 high-match.');
    expect(text).not.toContain('confidential garden protocol phrase');
    expect(text).not.toContain('mem-hidden-topic');
  });

  it('exists returns a clear no-result answer without memory text', async () => {
    const store = mockUnifiedStore([
      makeMemory({
        id: 'mem-unrelated',
        text: 'Visible unrelated memory',
        type: 'semantic',
        sensitivity: 'public',
      }),
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const result = await tool.execute('memory-call-exists-empty', {
      action: 'exists',
      query: 'nonexistent lattice topic',
      channel_id: 'api:public',
      trust_level: 'public',
      channel_visibility: 'public',
    });

    const text = resultText(fromAny(result));
    expect(text).toContain('Result: no matching memories found for the requested topic and filters.');
    expect(text).toContain('No memory text returned.');
    expect(text).not.toContain('Visible unrelated memory');
  });

  it('returns date timeline episodes using inclusive range boundaries', async () => {
    const store = mockUnifiedStore();
    const episodicStore = makeEpisodicTimelineStore([
      makeEpisode({
        id: 'episode-previous-overlap',
        title: 'Midnight handoff',
        landmark: 'A previous-night episode ended exactly at the day boundary.',
        startedAt: '2026-03-29T23:50:00.000Z',
        endedAt: '2026-03-30T00:00:00.000Z',
      }),
      makeEpisode({
        id: 'episode-inside-day',
        title: 'Noon garden plan',
        landmark: 'They made the main plan during the requested day.',
        startedAt: '2026-03-30T12:00:00.000Z',
        endedAt: '2026-03-30T12:10:00.000Z',
      }),
      makeEpisode({
        id: 'episode-next-overlap',
        title: 'Late-day wrap',
        landmark: 'The episode started exactly at the end of the requested day.',
        startedAt: '2026-03-30T23:59:59.999Z',
        endedAt: '2026-03-31T00:05:00.000Z',
      }),
      makeEpisode({
        id: 'episode-outside',
        title: 'Next-day only',
        landmark: 'This episode starts after the requested day.',
        startedAt: '2026-03-31T00:00:00.000Z',
        endedAt: '2026-03-31T00:10:00.000Z',
      }),
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort, {
      episodicStore,
    });

    const result = await tool.execute('memory-call-timeline-date', {
      action: 'timeline',
      date: '2026-03-30',
      channel_id: 'api:test',
      trust_level: 'primary',
      channel_visibility: 'private',
      limit: 10,
    });

    expect(episodicStore.searchByTime).toHaveBeenCalledWith({
      from: '2026-03-30T00:00:00.000Z',
      to: '2026-03-30T23:59:59.999Z',
      limit: 200,
    });
    const text = resultText(fromAny(result));
    expect(text).toContain('Episodic timeline for date 2026-03-30');
    expect(text).toContain('Midnight handoff');
    expect(text).toContain('Noon garden plan');
    expect(text).toContain('Late-day wrap');
    expect(text).not.toContain('Next-day only');

    episodicStore.searchByTime.mockClear();
    const rangeResult = await tool.execute('memory-call-timeline-range', {
      action: 'timeline',
      after: '2026-03-30T11:00:00Z',
      before: '2026-03-30T13:00:00Z',
      channel_id: 'api:test',
      trust_level: 'primary',
      channel_visibility: 'private',
      limit: 10,
    });

    expect(episodicStore.searchByTime).toHaveBeenCalledWith({
      from: '2026-03-30T11:00:00.000Z',
      to: '2026-03-30T13:00:00.000Z',
      limit: 200,
    });
    const rangeText = resultText(fromAny(rangeResult));
    expect(rangeText).toContain('Noon garden plan');
    expect(rangeText).not.toContain('Midnight handoff');
    expect(rangeText).not.toContain('Late-day wrap');
  });

  it('marks meaning-less timeline episodes unreviewed so machine summaries never read as her settled past (h4fp.6)', async () => {
    const store = mockUnifiedStore();
    const episodicStore = makeEpisodicTimelineStore([
      makeEpisode({
        id: 'episode-authored',
        title: 'Authored evening',
        landmark: 'A machine-drafted landmark she has already reviewed.',
        startedAt: '2026-03-30T09:00:00.000Z',
        endedAt: '2026-03-30T09:10:00.000Z',
        meaning: {
          text: 'This is what that evening actually meant to me.',
          recordedAt: '2026-03-31T04:00:00.000Z',
          source: 'companion_dream_pass',
        },
      }),
      makeEpisode({
        id: 'episode-unreviewed',
        title: 'Unreviewed morning',
        landmark: 'A machine-drafted landmark awaiting her review.',
        startedAt: '2026-03-30T12:00:00.000Z',
        endedAt: '2026-03-30T12:10:00.000Z',
      }),
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort, {
      episodicStore,
    });

    const result = await tool.execute('memory-call-timeline-unreviewed', {
      action: 'timeline',
      date: '2026-03-30',
      channel_id: 'api:test',
      trust_level: 'primary',
      channel_visibility: 'private',
      limit: 10,
    });

    const lines = resultText(fromAny(result)).split('\n');
    // Exactly one marker: her authored episode keeps its meaning and gains no
    // marker, while the meaning-less one must never render as her lived past.
    const markerLines = lines.filter(line => line.includes('unreviewed: machine-drafted summary'));
    expect(markerLines).toHaveLength(1);

    const authoredIndex = lines.findIndex(line => line.includes('Authored evening'));
    const unreviewedIndex = lines.findIndex(line => line.includes('Unreviewed morning'));
    expect(authoredIndex).toBeGreaterThanOrEqual(0);
    expect(unreviewedIndex).toBeGreaterThan(authoredIndex);
    const authoredBlock = lines.slice(authoredIndex, unreviewedIndex).join('\n');
    expect(authoredBlock).toContain('Meaning: This is what that evening actually meant to me.');
    expect(authoredBlock).not.toContain('unreviewed: machine-drafted summary');
    expect(lines.slice(unreviewedIndex).join('\n')).toContain(
      '  (unreviewed: machine-drafted summary — you have not yet given this episode its meaning)',
    );
  });

  it('filters hidden off-channel timeline episodes by existing episodic visibility rules', async () => {
    const store = mockUnifiedStore();
    const episodicStore = makeEpisodicTimelineStore([
      makeEpisode({
        id: 'episode-visible',
        title: 'Visible same-channel episode',
        landmark: 'This same-channel episode can be shown.',
      }),
      makeEpisode({
        id: 'episode-hidden-confidential',
        title: 'Confidential off-channel episode',
        landmark: 'This off-channel episode should remain hidden at regular trust.',
        channelId: 'api:hidden',
        participantContactIds: ['contact:primary'],
      }),
      makeEpisode({
        id: 'episode-hidden-contact',
        title: 'Other contact hidden episode',
        landmark: 'This episode belongs to another contact and must not leak.',
        channelId: 'api:other',
        participantContactIds: ['contact:other'],
      }),
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort, {
      episodicStore,
    });

    const result = await tool.execute('memory-call-timeline-hidden', {
      action: 'timeline',
      date: '2026-03-30',
      channel_id: 'api:test',
      trust_level: 'regular',
      channel_visibility: 'public',
      canonical_contact_id: 'contact:primary',
      limit: 10,
    });

    const text = resultText(fromAny(result));
    expect(text).toContain('Visible same-channel episode');
    expect(text).not.toContain('Confidential off-channel episode');
    expect(text).not.toContain('Other contact hidden episode');
  });

  it('returns a clear no-results message for empty visible timeline ranges', async () => {
    const store = mockUnifiedStore();
    const episodicStore = makeEpisodicTimelineStore([
      makeEpisode({
        id: 'episode-other-day',
        title: 'Other day episode',
        startedAt: '2026-03-30T10:00:00.000Z',
        endedAt: '2026-03-30T10:10:00.000Z',
      }),
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort, {
      episodicStore,
    });

    const result = await tool.execute('memory-call-timeline-empty', {
      action: 'timeline',
      date: '2026-04-02',
      channel_id: 'api:test',
      trust_level: 'primary',
      channel_visibility: 'private',
    });

    expect(resultText(fromAny(result))).toBe('No visible episodic memories found for date 2026-04-02.');
  });

  it('includes visible graph-linked continuation episodes without leaking hidden linked episodes', async () => {
    const store = mockUnifiedStore();
    const root = makeEpisode({
      id: 'episode-root',
      title: 'Garden repair begins',
      landmark: 'They identified the first garden repair step.',
      startedAt: '2026-03-30T09:00:00.000Z',
      endedAt: '2026-03-30T09:10:00.000Z',
      themes: ['garden', 'repair'],
    });
    const linked = makeEpisode({
      id: 'episode-linked',
      title: 'Garden repair continues',
      landmark: 'The repair continued the next day with a visible follow-up.',
      startedAt: '2026-03-31T09:00:00.000Z',
      endedAt: '2026-03-31T09:15:00.000Z',
      themes: ['garden', 'repair'],
    });
    const hiddenLinked = makeEpisode({
      id: 'episode-hidden-linked',
      title: 'Hidden continuation detail',
      landmark: 'This linked episode is in a different contact scope.',
      startedAt: '2026-03-31T10:00:00.000Z',
      endedAt: '2026-03-31T10:15:00.000Z',
      channelId: 'api:hidden',
      participantContactIds: ['contact:other'],
      themes: ['garden', 'repair'],
    });
    const episodicStore = makeEpisodicTimelineStore([
      root,
      linked,
      hiddenLinked,
    ], [
      makeEpisodeArc({
        id: 'arc-visible-continuation',
        sourceEpisodeId: root.id,
        targetEpisodeId: linked.id,
        arcKind: 'continuation',
        confidence: 0.82,
      }),
      makeEpisodeArc({
        id: 'arc-hidden-continuation',
        sourceEpisodeId: root.id,
        targetEpisodeId: hiddenLinked.id,
        arcKind: 'continuation',
        confidence: 0.9,
      }),
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort, {
      episodicStore,
    });

    const result = await tool.execute('memory-call-timeline-linked', {
      action: 'timeline',
      date: '2026-03-30',
      channel_id: 'api:test',
      trust_level: 'trusted',
      channel_visibility: 'invite_only',
      canonical_contact_id: 'contact:primary',
      limit: 4,
    });

    const text = resultText(fromAny(result));
    expect(text).toContain('Garden repair begins');
    expect(text).toContain('Garden repair continues');
    expect(text).toContain('linked continuation episode');
    expect(text).toContain('outside requested range');
    expect(text).not.toContain('Hidden continuation detail');
  });

  it('applies operator-set timeline policy knobs to the episodic store (zet.2)', async () => {
    const store = mockUnifiedStore();
    const episodicStore = makeEpisodicTimelineStore([
      makeEpisode({
        id: 'episode-policy-inside-day',
        title: 'Policy-threaded episode',
        landmark: 'This episode exercises operator-set timeline knobs.',
        startedAt: '2026-03-30T12:00:00.000Z',
        endedAt: '2026-03-30T12:10:00.000Z',
      }),
    ]);

    // Distinct, dominating scan value proves the operator policy — not the
    // compiled DEFAULT_POLICY — reaches searchByTime. timelineScanLimit=517
    // dominates limit*4 (8*4=32), so scanLimit resolves to exactly 517.
    const policy = createDefaultMemoryRetrievalPolicy();
    policy.episodic.timelineScanLimit = 517;

    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort, {
      episodicStore,
      memoryRetrievalPolicy: policy,
    });

    const result = await tool.execute('memory-call-timeline-policy', {
      action: 'timeline',
      date: '2026-03-30',
      channel_id: 'api:test',
      trust_level: 'primary',
      channel_visibility: 'private',
    });

    expect(episodicStore.searchByTime).toHaveBeenCalledWith({
      from: '2026-03-30T00:00:00.000Z',
      to: '2026-03-30T23:59:59.999Z',
      limit: 517,
    });
    expect(resultText(fromAny(result))).toContain('Policy-threaded episode');
  });

  it('honors an explicit limit param over the policy timelineLimit (zet.2)', async () => {
    const store = mockUnifiedStore();
    const episodes = Array.from({ length: 6 }, (_, index) => makeEpisode({
      id: `episode-limit-${index}`,
      title: `Limited episode ${index}`,
      landmark: `Episode ${index} within the requested day.`,
      startedAt: `2026-03-30T0${index}:00:00.000Z`,
      endedAt: `2026-03-30T0${index}:10:00.000Z`,
    }));
    const episodicStore = makeEpisodicTimelineStore(episodes);

    // Policy default timelineLimit is 8; an explicit limit of 2 must win and
    // cap the returned entries regardless of the policy default.
    const policy = createDefaultMemoryRetrievalPolicy();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort, {
      episodicStore,
      memoryRetrievalPolicy: policy,
    });

    const result = await tool.execute('memory-call-timeline-explicit-limit', {
      action: 'timeline',
      date: '2026-03-30',
      channel_id: 'api:test',
      trust_level: 'primary',
      channel_visibility: 'private',
      limit: 2,
    });

    const text = resultText(fromAny(result));
    expect(text).toContain('Limited episode 0');
    expect(text).toContain('Limited episode 1');
    expect(text).not.toContain('Limited episode 2');
    // Explicit limit=2 drives scanLimit = max(timelineScanLimit=200, 2*4=8) = 200.
    expect(episodicStore.searchByTime).toHaveBeenCalledWith({
      from: '2026-03-30T00:00:00.000Z',
      to: '2026-03-30T23:59:59.999Z',
      limit: 200,
    });
  });

  it('imports through action=import with unified provenance qualifiers', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    await tool.execute('memory-call-3', {
      action: 'import',
      source: 'backup',
      records: [{ text: 'Imported fact', type: 'semantic', tags: 'archive' }],
    });

    expect(writer.importBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: 'Imported fact',
        sourceRef: 'source:tool:memory|action:import|import_source:backup|invocation:memory-call-3',
        sourceType: 'tool_write',
        provenance: {
          toolName: 'memory',
          toolCallId: 'memory-call-3',
        },
        tags: ['archive'],
      }),
    ]);
  });

  it('threads a historical occurred_at into extractedAt instead of stamping now (psfn-framework-n2z6)', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const historical = Date.parse('2021-06-15T08:30:00.000Z');
    await tool.execute('memory-call-occurred', {
      action: 'import',
      source: 'backup',
      records: [
        { text: 'Old fact', type: 'semantic', occurred_at: '2021-06-15T08:30:00.000Z' },
        { text: 'No date fact', type: 'semantic' },
      ],
    });

    const passed = writer.importBatch.mock.calls[0][0] as Array<{ extractedAt?: number }>;
    expect(passed[0].extractedAt).toBe(historical);
    // A record without occurred_at leaves extractedAt unset so the writer's
    // Date.now() default still applies.
    expect(passed[1].extractedAt).toBeUndefined();
  });

  it('fails closed on an unparseable occurred_at for action=import', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const result = await tool.execute('memory-call-bad-date', {
      action: 'import',
      records: [{ text: 'Bad date', type: 'semantic', occurred_at: 'not-a-date' }],
    });

    expect(resultText(fromAny(result))).toContain('invalid occurred_at');
    expect(result.details?.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('fails closed on a future occurred_at for action=import', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const result = await tool.execute('memory-call-future-date', {
      action: 'import',
      records: [{ text: 'Future fact', type: 'semantic', occurred_at: future }],
    });

    expect(resultText(fromAny(result))).toContain('is in the future');
    expect(result.details?.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('memory_import_batch standalone tool threads occurred_at into extractedAt', async () => {
    const importTool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const historical = Date.parse('2020-01-02T03:04:05.000Z');
    await importTool.execute('import-standalone', {
      records: [{ text: 'Archived', type: 'semantic', occurred_at: '2020-01-02T03:04:05.000Z' }],
    });

    const passed = writer.importBatch.mock.calls[0][0] as Array<{ extractedAt?: number }>;
    expect(passed[0].extractedAt).toBe(historical);
  });

  it('requires records, not a legacy entries field, for unified action=import', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const result = await tool.execute('memory-call-import-wrong-shape', fromAny({
      action: 'import',
      entries: [{ text: 'Legacy shape', type: 'semantic' }],
    }));

    expect(resultText(fromAny(result))).toContain('records must be a non-empty array for action=import');
    expect(result.details?.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('retires action=redact so it cannot bypass deletion proposals', async () => {
    const store = mockUnifiedStore();
    const redact = vi.fn().mockResolvedValue({
      operation: 'deleted',
      behavior: 'delete',
      sourceMemoryId: 'mem-7',
      deleteId: 'del-7',
    } satisfies MemoryRedactionResult);
    const tool = createMemoryTool(
      { ...writer, redact } as unknown as MemoryWriter,
      store as unknown as MemoryStorePort,
    );

    const result = await tool.execute('memory-call-4', {
      action: 'redact',
      memory_id: 'mem-7',
      operation: 'delete',
      reason: 'consent revoked',
    });

    expect(redact).not.toHaveBeenCalled();
    expect(resultText(fromAny(result))).toContain('action=redact is retired');
    expect(result.details?.isError).toBe(true);
  });

  it('creates a durable deletion proposal without soft-deleting through action=delete', async () => {
    const store = mockUnifiedStore([makeMemory({ id: 'mem-1' })]);
    const proposalStore = mockMemoryDeletionProposalStore();
    proposalStore.createMemoryDeletionProposal.mockResolvedValue({
      id: 'proposal-1',
      memoryId: 'mem-1',
      memoryAuthorizationRevision: 4,
      justificationCategory: 'factually_incorrect',
      explanation: 'The source was conclusively retracted.',
      status: 'pending_partner_alert',
      proposedAt: 123,
      proposedBy: 'Companion',
    } satisfies MemoryDeletionProposal);
    const approvalPort = mockMemoryDeletionApprovalPort();
    approvalPort.requestMemoryDeletionApproval.mockResolvedValue({
      status: 'approval_required',
      proposalId: 'proposal-1',
      approvalId: 'proposal-1',
      expiresAt: 999,
    } satisfies MemoryDeletionApprovalResult);
    const tool = createMemoryTool(
      writer as unknown as MemoryWriter,
      store as unknown as MemoryStorePort,
      {
        memoryDeletionProposalStore: proposalStore,
        memoryDeletionApprovalPort: approvalPort,
        memoryDeletionPolicy: {
          justificationCategories: [{
            id: 'factually_incorrect',
            label: 'Factually incorrect',
            eligible: true,
            explanationPatterns: ['source retracted'],
          }],
        },
      },
    );

    const proposed = await tool.execute('memory-call-5', {
      action: 'delete',
      memory_id: 'mem-1',
      justification_category: 'factually_incorrect',
      explanation: 'The source was conclusively retracted.',
    });
    expect(proposalStore.createMemoryDeletionProposal).toHaveBeenCalledWith({
      memoryId: 'mem-1',
      justificationCategory: 'factually_incorrect',
      explanation: 'The source was conclusively retracted.',
      proposedBy: 'Companion',
    });
    expect(approvalPort.requestMemoryDeletionApproval).toHaveBeenCalledWith({
      proposalId: 'proposal-1',
      memoryId: 'mem-1',
      justificationCategory: 'factually_incorrect',
      explanation: 'The source was conclusively retracted.',
    });
    expect(store.softDeleteMemory).not.toHaveBeenCalled();
    expect(resultText(fromAny(proposed))).toContain('proposal-1');
    expect(resultText(fromAny(proposed))).toContain('pending Operator validation');
    expect(resultText(fromAny(proposed))).toContain('memory remains active');
  });

  it('restores an approved proposal delete through action=restore', async () => {
    const store = mockUnifiedStore();
    store.undoSoftDelete.mockResolvedValue(makeUnifiedDeleteVersion({
      deleteId: 'del-unified',
      restoredBy: 'tool:memory|action:restore',
      restoredAt: Date.now(),
    }));
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const restored = await tool.execute('memory-call-6', {
      action: 'restore',
      delete_id: 'del-unified',
    });
    expect(store.undoSoftDelete).toHaveBeenCalledWith('del-unified', {
      restoredBy: 'tool:memory|action:restore',
      actorRole: 'Companion',
    });
    expect(resultText(fromAny(restored))).toContain('Memory restored');
  });

  it('accepts id alias for unified action=delete proposal', async () => {
    const store = mockUnifiedStore([makeMemory({ id: 'mem-alias' })]);
    const proposalStore = mockMemoryDeletionProposalStore();
    proposalStore.createMemoryDeletionProposal.mockResolvedValue({
      id: 'proposal-alias',
      memoryId: 'mem-alias',
      memoryAuthorizationRevision: 2,
      justificationCategory: 'factually_incorrect',
      explanation: 'The source was retracted.',
      status: 'pending_partner_alert',
      proposedAt: 123,
      proposedBy: 'Companion',
    } satisfies MemoryDeletionProposal);
    const approvalPort = mockMemoryDeletionApprovalPort();
    approvalPort.requestMemoryDeletionApproval.mockResolvedValue({
      status: 'approval_required',
      proposalId: 'proposal-alias',
      approvalId: 'approval-alias',
      expiresAt: 999,
    } satisfies MemoryDeletionApprovalResult);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort, {
      memoryDeletionProposalStore: proposalStore,
      memoryDeletionApprovalPort: approvalPort,
      memoryDeletionPolicy: {
        justificationCategories: [{
          id: 'factually_incorrect',
          label: 'Factually incorrect',
          eligible: true,
          explanationPatterns: ['source retracted'],
        }],
      },
    });

    const deleted = await tool.execute('memory-call-delete-alias', fromAny({
      action: 'delete',
      id: 'mem-alias',
      justification_category: 'factually_incorrect',
      explanation: 'The source was retracted.',
    }));

    expect(proposalStore.createMemoryDeletionProposal).toHaveBeenCalledWith({
      memoryId: 'mem-alias',
      justificationCategory: 'factually_incorrect',
      explanation: 'The source was retracted.',
      proposedBy: 'Companion',
    });
    expect(store.softDeleteMemory).not.toHaveBeenCalled();
    expect(resultText(fromAny(deleted))).toContain('proposal-alias');
  });

  it('accepts deleteId alias for unified action=restore', async () => {
    const store = mockUnifiedStore();
    store.undoSoftDelete.mockResolvedValue(makeUnifiedDeleteVersion({
      deleteId: 'del-alias',
      memoryId: 'mem-alias',
      restoredBy: 'tool:memory|action:restore',
      restoredAt: Date.now(),
    }));
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const restored = await tool.execute('memory-call-restore-alias', fromAny({
      action: 'restore',
      deleteId: 'del-alias',
    }));

    expect(store.undoSoftDelete).toHaveBeenCalledWith('del-alias', {
      restoredBy: 'tool:memory|action:restore',
      actorRole: 'Companion',
    });
    expect(resultText(fromAny(restored))).toContain('Memory restored');
  });

  it('accepts shard provenance overrides for unified write/import while redaction stays retired', async () => {
    const store = mockUnifiedStore();
    const redact = vi.fn().mockResolvedValue({
      operation: 'deleted',
      behavior: 'delete',
      sourceMemoryId: 'mem-8',
      deleteId: 'del-8',
    } satisfies MemoryRedactionResult);
    const tool = createMemoryTool(
      { ...writer, redact } as unknown as MemoryWriter,
      store as unknown as MemoryStorePort,
    );

    await tool.execute('memory-call-7', fromAny({
      action: 'write',
      text: 'Shard write',
      type: 'semantic',
      __psfnShardSource: 'shard:shard-1',
    }));
    await tool.execute('memory-call-8', fromAny({
      action: 'import',
      records: [{ text: 'Shard import', type: 'semantic' }],
      __psfnShardSource: 'shard:shard-1',
    }));
    const redaction = await tool.execute('memory-call-9', fromAny({
      action: 'redact',
      memory_id: 'mem-8',
      __psfnShardSource: 'shard:shard-1',
    }));

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'source:shard:shard-1|tool:memory|action:write|invocation:memory-call-7',
      sourceType: 'shard',
      provenance: {
        toolName: 'memory',
        toolCallId: 'memory-call-7',
        shardId: 'shard-1',
        actor: 'shard',
        sourceConversationAt: expect.any(Number),
      },
    }));
    expect(writer.importBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceRef: 'source:shard:shard-1|tool:memory|action:import|import_source:import|invocation:memory-call-8',
        sourceType: 'shard',
      }),
    ]);
    expect(redact).not.toHaveBeenCalled();
    expect(resultText(fromAny(redaction))).toContain('action=redact is retired');
  });

  it('preserves structured subagent provenance for unified writes and imports', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(
      writer as unknown as MemoryWriter,
      store as unknown as MemoryStorePort,
    );

    const subagentWrite = {
      action: 'write' as const,
      text: 'Subagent procedural write',
      type: 'procedural' as const,
      __psfnShardSource: 'subagent:subagent-42',
    };
    const subagentImport = {
      action: 'import' as const,
      records: [{ text: 'Subagent semantic import', type: 'semantic' as const }],
      __psfnShardSource: 'subagent:subagent-42',
    };
    await tool.execute('memory-call-subagent-write', subagentWrite);
    await tool.execute('memory-call-subagent-import', subagentImport);

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'source:subagent:subagent-42|tool:memory|action:write|invocation:memory-call-subagent-write',
      sourceType: 'subagent',
      provenance: {
        toolName: 'memory',
        toolCallId: 'memory-call-subagent-write',
        subagentId: 'subagent-42',
        actor: 'subagent',
        sourceConversationAt: expect.any(Number),
      },
    }));
    expect(writer.importBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceRef: 'source:subagent:subagent-42|tool:memory|action:import|import_source:import|invocation:memory-call-subagent-import',
        sourceType: 'subagent',
        provenance: {
          toolName: 'memory',
          toolCallId: 'memory-call-subagent-import',
          subagentId: 'subagent-42',
          actor: 'subagent',
        },
      }),
    ]);
  });

  it('fails closed on invalid or incomplete actions', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStorePort);

    const missingQuery = await tool.execute('memory-call-10', fromAny({ action: 'search' }));
    expect(resultText(fromAny(missingQuery))).toContain('query is required for action=search');
    expect(resultText(fromAny(missingQuery))).toContain('Missing required field "query"');
    expect(resultText(fromAny(missingQuery))).toContain('Minimal valid JSON: {"action":"search","query":"topic"}');
    expect(resultText(fromAny(missingQuery))).toContain('Do not retry action=search without a non-empty query');
    expect((fromAny(missingQuery.details)).isError).toBe(true);

    const blankQuery = await tool.execute('memory-call-10b', fromAny({ action: 'search', query: '   ' }));
    expect(resultText(fromAny(blankQuery))).toContain('Missing required field "query"');
    expect((fromAny(blankQuery.details)).isError).toBe(true);
    expect(store.searchByText).not.toHaveBeenCalled();

    const badAction = await tool.execute('memory-call-11', fromAny({ action: 'purge' }));
    expect(resultText(fromAny(badAction))).toContain('invalid action');
    expect((fromAny(badAction.details)).isError).toBe(true);
  });
});

describe('createMemoryWriteTool', () => {
  let writer: ReturnType<typeof mockWriter>;

  beforeEach(() => {
    writer = mockWriter();
  });

  it('returns a valid AgentTool with correct name and schema', () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    expect(tool.name).toBe('memory_write');
    expect(tool.description).toBeTruthy();
    expect(tool.label).toBe('memory_write');
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('writes a memory and returns success content', async () => {
    const createdMemory = makeMemory({ id: 'mem-abc', type: 'episodic' });
    writer.write.mockResolvedValueOnce({
      action: 'created',
      memory: createdMemory,
    } satisfies WriteResult);

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-1', {
      text: 'V enjoys programming',
      type: 'episodic',
      importance: 0.7,
    });

    expect(resultText(result)).toContain('Memory created');
    expect(resultText(result)).toContain('mem-abc');
    expect(resultText(result)).toContain('episodic');
    expect(result.details?.isError).toBeUndefined();

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'V enjoys programming',
      type: 'episodic',
      importance: 0.7,
      sourceRef: 'source:tool:memory_write|invocation:call-1',
      sourceType: 'tool_write',
      provenance: {
        toolName: 'memory_write',
        toolCallId: 'call-1',
        sourceConversationAt: expect.any(Number),
      },
    }));
  });

  it('returns deduplicated message when duplicate detected', async () => {
    writer.write.mockResolvedValueOnce({
      action: 'deduplicated',
      memory: makeMemory(),
      existingId: 'existing-456',
    } satisfies WriteResult);

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-2', {
      text: 'Duplicate text',
      type: 'semantic',
    });

    expect(resultText(result)).toContain('Duplicate detected');
    expect(resultText(result)).toContain('existing-456');
    expect(result.details?.isError).toBeUndefined();
  });

  it('returns superseded message when contradiction resolved', async () => {
    writer.write.mockResolvedValueOnce({
      action: 'superseded',
      memory: makeMemory({ id: 'mem-new' }),
    } satisfies WriteResult);

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-3', {
      text: 'Corrected fact',
      type: 'semantic',
      confidence: 0.95,
    });

    expect(resultText(result)).toContain('superseding older conflicting memory');
    expect(resultText(result)).toContain('mem-new');
    expect(result.details?.isError).toBeUndefined();
  });

  it('handles errors gracefully and returns isError in details', async () => {
    writer.write.mockRejectedValueOnce(new Error('Database locked'));

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-4', {
      text: 'Will fail',
      type: 'semantic',
    });

    expect(resultText(result)).toContain('Error writing memory');
    expect(resultText(result)).toContain('Database locked');
    expect(result.details?.isError).toBe(true);
  });

  it('returns error for empty text', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-5', {
      text: '',
      type: 'semantic',
    });

    expect(resultText(result)).toContain('Error: text is required');
    expect(result.details?.isError).toBe(true);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('returns error for invalid type', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-6', {
      text: 'Some text',
      type: 'invalid_type',
    });

    expect(resultText(result)).toContain('Error: invalid type');
    expect(result.details?.isError).toBe(true);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('clamps importance to 0-1 range', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    // Test above max
    await tool.execute('call-7', { text: 'High importance', type: 'semantic', importance: 1.5 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      importance: 1.0,
    }));

    writer.write.mockClear();

    // Test below min
    await tool.execute('call-8', { text: 'Negative importance', type: 'semantic', importance: -0.3 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      importance: 0,
    }));
  });

  it('clamps emotional_valence to -1 to 1 range', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-9', { text: 'Extreme positive', type: 'emotional', emotional_valence: 5 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      emotionalValence: 1.0,
    }));

    writer.write.mockClear();

    await tool.execute('call-10', { text: 'Extreme negative', type: 'emotional', emotional_valence: -5 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      emotionalValence: -1.0,
    }));
  });

  it('clamps confidence to 0-1 range', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-11', { text: 'Over confident', type: 'semantic', confidence: 2 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      confidence: 1.0,
    }));
  });

  it('uses NaN midpoint for non-numeric importance', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-12', { text: 'NaN test', type: 'semantic', importance: 'not_a_number' });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      importance: 0.5, // midpoint of (0, 1)
    }));
  });

  it('adds tool:memory_write provenance with invocation id', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-13', { text: 'Source tag test', type: 'semantic' });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'source:tool:memory_write|invocation:call-13',
      sourceType: 'tool_write',
    }));
  });

  it('accepts internal shard provenance overrides for orchestration wrappers', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-13b', fromAny({
      text: 'Shard reintegration finding',
      type: 'semantic',
      __psfnShardSource: 'shard:shard-abc',
    }));

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'source:shard:shard-abc|tool:memory_write|invocation:call-13b',
      sourceType: 'shard',
      provenance: expect.objectContaining({
        shardId: 'shard-abc',
      }),
    }));
  });

  it('parses comma-separated tags', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-14', {
      text: 'Tagged memory',
      type: 'semantic',
      tags: ' Identity , Preference, HOBBY ',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['identity', 'preference', 'hobby'],
    }));
  });

  it('normalizes JSON-array tag strings for legacy memory_write', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-json-tags', {
      text: 'Tagged memory',
      type: 'semantic',
      tags: '["Identity", "Preference", false, "HOBBY"]',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['identity', 'preference', 'hobby'],
    }));
  });

  it('trims text before writing', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-15', {
      text: '  padded text  ',
      type: 'semantic',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'padded text',
    }));
  });

  it('normalizes malformed text/content payloads onto the exact memory text', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-15b', fromAny({
      text: ': "matrix-secret-2026-04-10T04-49-43-076Z", "type": "semantic", "sensitivity": "personal"}',
      content: 'matrix-secret-2026-04-10T04-49-43-076Z',
      type: 'semantic',
      sensitivity: 'personal',
    }));

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'matrix-secret-2026-04-10T04-49-43-076Z',
      sensitivity: 'personal',
    }));
  });

  it('normalizes placeholder text/step_text payloads onto the exact memory text', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-15c', fromAny({
      text: '.',
      step_text: 'matrix-secret-2026-04-10T05-00-06-862Z',
      type: 'semantic',
      sensitivity: 'personal',
    }));

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'matrix-secret-2026-04-10T05-00-06-862Z',
      sensitivity: 'personal',
    }));
  });

  it('omits optional fields when not provided', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-16', { text: 'Minimal memory', type: 'semantic' });

    const callArgs = writer.write.mock.calls[0][0];
    expect(callArgs.importance).toBeUndefined();
    expect(callArgs.emotionalValence).toBeUndefined();
    expect(callArgs.confidence).toBeUndefined();
    expect(callArgs.tags).toBeUndefined();
  });

  it('passes sensitivity through to writer.write()', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-17', {
      text: 'Confidential detail',
      type: 'semantic',
      sensitivity: 'confidential',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sensitivity: 'confidential',
    }));
  });

  it('omits sensitivity when not provided', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-18', { text: 'No sensitivity', type: 'semantic' });

    const callArgs = writer.write.mock.calls[0][0];
    expect(callArgs.sensitivity).toBeUndefined();
  });

  it('passes formationVAD from provider into writer.write()', async () => {
    const getFormationVAD = vi.fn(() => ({
      valence: 0.7,
      arousal: -0.35,
      dominance: 0.1,
    }));
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter, { getFormationVAD });

    await tool.execute('call-18b', { text: 'Mood-tagged memory', type: 'semantic' });

    expect(getFormationVAD).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      formationVAD: {
        valence: 0.7,
        arousal: -0.35,
        dominance: 0.1,
      },
    }));
  });
});

describe('createMemoryImportTool', () => {
  let writer: ReturnType<typeof mockWriter>;

  beforeEach(() => {
    writer = mockWriter();
  });

  it('returns a valid AgentTool with correct name and schema', () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    expect(tool.name).toBe('memory_import_batch');
    expect(tool.description).toBeTruthy();
    expect(tool.label).toBe('memory_import_batch');
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('processes batch and returns summary content', async () => {
    writer.importBatch.mockResolvedValueOnce({
      written: 3,
      deduplicated: 1,
      superseded: 0,
      errors: 0,
      results: [],
    } satisfies BatchImportResult);

    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-1', {
      records: [
        { text: 'Fact one', type: 'semantic' },
        { text: 'Fact two', type: 'semantic' },
        { text: 'Fact three', type: 'semantic' },
        { text: 'Duplicate', type: 'semantic' },
      ],
    });

    expect(resultText(result)).toContain('Import complete');
    expect(resultText(result)).toContain('3 written');
    expect(resultText(result)).toContain('1 deduplicated');
    expect(resultText(result)).toContain('0 superseded');
    expect(resultText(result)).toContain('0 errors');
    expect(resultText(result)).toContain('4 total');
    expect(result.details?.isError).toBeUndefined();
  });

  it('adds tool:memory_import:<source> provenance tag', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-2', {
      records: [
        { text: 'Voxta memory', type: 'semantic' },
      ],
      source: 'voxta',
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sourceRef).toBe('source:tool:memory_import:voxta|invocation:call-2');
    expect(importedRecords[0].sourceType).toBe('tool_write');
  });

  it('uses "import" as default source when not specified', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-3', {
      records: [
        { text: 'Default source', type: 'semantic' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sourceRef).toBe('source:tool:memory_import:import|invocation:call-3');
  });

  it('accepts internal shard provenance for imported memory batches', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-3b', fromAny({
      records: [{ text: 'from shard', type: 'semantic' }],
      __psfnShardSource: 'shard:shard-xyz',
    }));

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sourceRef).toBe(
      'source:shard:shard-xyz|tool:memory_import:import|invocation:call-3b',
    );
    expect(importedRecords[0].sourceType).toBe('shard');
  });

  it('returns error for empty records array', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute('call-4', { records: [] });

    expect(resultText(result)).toContain('Error: records must be a non-empty array');
    expect(result.details?.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('returns error for missing records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute('call-5', fromAny({}));

    expect(resultText(result)).toContain('Error: records must be a non-empty array');
    expect(result.details?.isError).toBe(true);
  });

  it('validates individual records have text', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute('call-6', {
      records: [
        { text: 'Good record', type: 'semantic' },
        { text: '', type: 'semantic' }, // Empty text
      ],
    });

    expect(resultText(result)).toContain('Error: record[1] has empty text');
    expect(result.details?.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('validates individual records have valid type', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute('call-7', fromAny({
      records: [
        { text: 'Valid', type: 'semantic' },
        { text: 'Invalid type', type: 'bogus' },
      ],
    }));

    expect(resultText(result)).toContain('Error: record[1] has invalid type "bogus"');
    expect(result.details?.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('clamps values in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-8', {
      records: [
        {
          text: 'Clamped record',
          type: 'semantic',
          importance: 5.0,
          emotional_valence: -10,
          confidence: 99,
        },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].importance).toBe(1.0);
    expect(importedRecords[0].emotionalValence).toBe(-1.0);
    expect(importedRecords[0].confidence).toBe(1.0);
  });

  it('parses tags in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-9', {
      records: [
        { text: 'Tagged import', type: 'semantic', tags: 'Identity, PREFERENCE' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].tags).toEqual(['identity', 'preference']);
  });

  it('normalizes JSON-array tag strings in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-json-import-tags', {
      records: [
        { text: 'Tagged import', type: 'semantic', tags: '["Identity", "PREFERENCE", null]' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].tags).toEqual(['identity', 'preference']);
  });

  it('handles errors gracefully and returns isError in details', async () => {
    writer.importBatch.mockRejectedValueOnce(new Error('Storage full'));

    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-10', {
      records: [
        { text: 'Will fail', type: 'semantic' },
      ],
    });

    expect(resultText(result)).toContain('Error importing memories');
    expect(resultText(result)).toContain('Storage full');
    expect(result.details?.isError).toBe(true);
  });

  it('trims text in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-11', {
      records: [
        { text: '  spaces around  ', type: 'semantic' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].text).toBe('spaces around');
  });

  it('passes sensitivity through for imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-12', {
      records: [
        { text: 'Public fact', type: 'semantic', sensitivity: 'public' },
        { text: 'Intimate fact', type: 'emotional', sensitivity: 'intimate' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sensitivity).toBe('public');
    expect(importedRecords[1].sensitivity).toBe('intimate');
  });

  it('omits sensitivity when not provided in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-13', {
      records: [
        { text: 'No sensitivity', type: 'semantic' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sensitivity).toBeUndefined();
  });
});

describe('createMemoryPatchTool', () => {
  let writer: ReturnType<typeof mockWriter>;

  beforeEach(() => {
    writer = mockWriter();
  });

  it('patches a memory and returns audit details', async () => {
    const tool = createMemoryPatchTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-patch-1', {
      memory_id: 'mem-1',
      confidence: 0.9,
      append_tags: 'belief-corrected, source-retracted',
      reason: 'corrected source',
    });

    expect(resultText(fromAny(result))).toContain('Memory patched');
    expect(resultText(fromAny(result))).toContain('patch-1');
    expect(writer.patchMemory).toHaveBeenCalledWith(expect.objectContaining({
      memoryId: 'mem-1',
      confidence: 0.9,
      appendTags: ['belief-corrected', 'source-retracted'],
      reason: 'corrected source',
      sourceRef: 'source:tool:memory_patch|invocation:call-patch-1',
      sourceType: 'tool_write',
    }));
  });

  it('normalizes JSON-array tag strings when patching tags', async () => {
    const tool = createMemoryPatchTool(writer as unknown as MemoryWriter);
    await tool.execute('call-patch-json-tags', {
      memory_id: 'mem-1',
      tags: '["Belief-Corrected", "Source-Retracted", 7]',
      reason: 'corrected tags',
    });

    expect(writer.patchMemory).toHaveBeenCalledWith(expect.objectContaining({
      memoryId: 'mem-1',
      tags: ['belief-corrected', 'source-retracted'],
      reason: 'corrected tags',
    }));
  });

  it('rejects conflicting tag patch modes', async () => {
    const tool = createMemoryPatchTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-patch-2', {
      memory_id: 'mem-1',
      tags: 'a,b',
      append_tags: 'c',
    });

    expect(resultText(fromAny(result))).toContain('either tags or append_tags');
    expect((fromAny(result.details)).isError).toBe(true);
    expect(writer.patchMemory).not.toHaveBeenCalled();
  });
});

describe('createMemoryRedactTool', () => {
  function mockRedactWriter(): { redact: ReturnType<typeof vi.fn> } {
    return {
      redact: vi.fn(),
    };
  }

  it('is retired and never invokes the immediate redaction writer path', async () => {
    const writer = mockRedactWriter();
    const tool = createMemoryRedactTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-1', {
      memory_id: 'mem-1',
      operation: 'auto',
      reason: 'consent request',
    });

    expect(resultText(fromAny(result))).toContain('memory_redact is retired');
    expect((fromAny(result.details)).isError).toBe(true);
    expect(writer.redact).not.toHaveBeenCalled();
  });
});

describe('memory_delete and undo_memory_delete tools', () => {
  function makeDeleteVersion(overrides: Partial<MemoryDeleteVersion> = {}): MemoryDeleteVersion {
    return {
      deleteId: 'del-1',
      memoryId: 'mem-1',
      snapshot: makeMemory({ id: 'mem-1' }),
      deletedAt: Date.now(),
      deletedBy: 'tool:memory_delete',
      ...overrides,
    };
  }

  function mockStore(): {
    softDeleteMemory: ReturnType<typeof vi.fn>;
    undoSoftDelete: ReturnType<typeof vi.fn>;
  } {
    return {
      softDeleteMemory: vi.fn(),
      undoSoftDelete: vi.fn(),
    };
  }

  it('is retired and cannot soft-delete memory', async () => {
    const store = mockStore();
    store.softDeleteMemory.mockReturnValue(makeDeleteVersion({
      deleteId: 'del-abc',
      memoryId: 'mem-abc',
    }));

    const tool = createMemoryDeleteTool(store as unknown as MemoryStorePort);
    const result = await tool.execute('call-1', {
      memory_id: 'mem-abc',
      reason: 'stale',
    });

    expect(resultText(fromAny(result))).toContain('memory_delete is retired');
    expect(resultText(fromAny(result))).toContain('Partner-alerted proposal');
    expect(store.softDeleteMemory).not.toHaveBeenCalled();
  });

  it('returns error when memory_id is missing', async () => {
    const store = mockStore();
    const tool = createMemoryDeleteTool(store as unknown as MemoryStorePort);

    const result = await tool.execute('call-2', {
      memory_id: '   ',
    });

    expect(resultText(fromAny(result))).toContain('memory_delete is retired');
    expect((fromAny(result.details)).isError).toBe(true);
    expect(store.softDeleteMemory).not.toHaveBeenCalled();
  });

  it('does not probe memory existence through the retired alias', async () => {
    const store = mockStore();
    store.softDeleteMemory.mockReturnValue(null);
    const tool = createMemoryDeleteTool(store as unknown as MemoryStorePort);

    const result = await tool.execute('call-3', { memory_id: 'missing' });
    expect(resultText(fromAny(result))).toContain('memory_delete is retired');
    expect((fromAny(result.details)).isError).toBe(true);
    expect(store.softDeleteMemory).not.toHaveBeenCalled();
  });

  it('restores deleted memory from delete_id', async () => {
    const store = mockStore();
    store.undoSoftDelete.mockReturnValue(makeDeleteVersion({
      deleteId: 'del-restore',
      memoryId: 'mem-restore',
      restoredAt: Date.now(),
      restoredBy: 'tool:undo_memory_delete',
    }));
    const tool = createUndoMemoryDeleteTool(store as unknown as MemoryStorePort);

    const result = await tool.execute('call-4', { delete_id: 'del-restore' });
    expect(resultText(fromAny(result))).toContain('Memory restored');
    expect(resultText(fromAny(result))).toContain('mem-restore');
    expect(store.undoSoftDelete).toHaveBeenCalledWith('del-restore', {
      restoredBy: 'tool:undo_memory_delete',
    });
  });

  it('returns error when delete checkpoint is missing', async () => {
    const store = mockStore();
    store.undoSoftDelete.mockReturnValue(null);
    const tool = createUndoMemoryDeleteTool(store as unknown as MemoryStorePort);

    const result = await tool.execute('call-5', { delete_id: 'unknown' });
    expect(resultText(fromAny(result))).toContain('Delete checkpoint not found');
    expect((fromAny(result.details)).isError).toBe(true);
  });
});

describe('scratchpad tools', () => {
  function mockScratchpadStore(): {
    listScratchpadEntries: ReturnType<typeof vi.fn>;
    addScratchpadEntry: ReturnType<typeof vi.fn>;
    replaceScratchpadEntry: ReturnType<typeof vi.fn>;
    appendScratchpadEntry: ReturnType<typeof vi.fn>;
    removeScratchpadEntry: ReturnType<typeof vi.fn>;
  } {
    return {
      listScratchpadEntries: vi.fn(),
      addScratchpadEntry: vi.fn(),
      replaceScratchpadEntry: vi.fn(),
      appendScratchpadEntry: vi.fn(),
      removeScratchpadEntry: vi.fn(),
    };
  }

  it('scratchpad unified tool defaults to list and supports append', async () => {
    const store = mockScratchpadStore();
    store.listScratchpadEntries.mockReturnValue([
      {
        id: 'sp-1',
        content: 'Working note',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
      },
    ]);
    store.appendScratchpadEntry.mockResolvedValue({
      id: 'sp-1',
      content: 'Working note\nextra detail',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_200_000,
    });
    const tool = createScratchpadTool(store as unknown as MemoryStorePort);

    const listed = await tool.execute('scratchpad-list', { action: 'list' });
    expect(resultText(fromAny(listed))).toContain('24h ephemeral working context');
    expect(resultText(fromAny(listed))).toContain('durable reminders');
    expect(store.listScratchpadEntries).toHaveBeenCalledWith(20);

    const appended = await tool.execute('scratchpad-append', {
      action: 'append',
      id: 'sp-1',
      content: 'extra detail',
    });
    expect(resultText(fromAny(appended))).toContain('Scratchpad entry appended');
    expect(store.appendScratchpadEntry).toHaveBeenCalledWith('sp-1', 'extra detail');
  });

  it('scratchpad unified tool validates required action params', async () => {
    const store = mockScratchpadStore();
    const tool = createScratchpadTool(store as unknown as MemoryStorePort);

    const missingAddContent = await tool.execute('scratchpad-add', fromAny({ action: 'add' }));
    expect(resultText(fromAny(missingAddContent))).toContain('content is required for action=add');
    expect((fromAny(missingAddContent.details)).isError).toBe(true);

    const missingAppendId = await tool.execute('scratchpad-append', fromAny({
      action: 'append',
      content: 'x',
    }));
    expect(resultText(fromAny(missingAppendId))).toContain('id is required for action=append');
    expect((fromAny(missingAppendId.details)).isError).toBe(true);
  });

  it('rejects retired read helper action names on canonical scratchpad', async () => {
    const store = mockScratchpadStore();
    store.listScratchpadEntries.mockReturnValue([]);
    const tool = createScratchpadTool(store as unknown as MemoryStorePort);

    const result = await tool.execute('scratchpad-read-alias', fromAny({
      action: 'scratchpad_read',
      limit: 4,
    }));

    expect(resultText(fromAny(result))).toContain('invalid action');
    expect((fromAny(result.details)).isError).toBe(true);
    expect(store.listScratchpadEntries).not.toHaveBeenCalled();
  });

  it('scratchpad_read returns empty-state message', async () => {
    const store = mockScratchpadStore();
    store.listScratchpadEntries.mockReturnValue([]);
    const tool = createScratchpadReadTool(store as unknown as MemoryStorePort);

    const result = await tool.execute('call-1', {});
    expect(resultText(fromAny(result))).toContain('Scratchpad is empty');
    expect(store.listScratchpadEntries).toHaveBeenCalledWith(20);
  });

  it('scratchpad_read returns formatted notes with timestamps', async () => {
    const store = mockScratchpadStore();
    store.listScratchpadEntries.mockReturnValue([
      {
        id: 'sp-1',
        content: 'Remember to check weekly backup integrity.',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
      },
    ]);
    const tool = createScratchpadReadTool(store as unknown as MemoryStorePort);

    const result = await tool.execute('call-2', { limit: 3 });
    const text = resultText(fromAny(result));
    expect(text).toContain('Scratchpad entries (1)');
    expect(text).toContain('sp-1');
    expect(text).toContain('2023-11-14T22:15:00.000Z');
    expect(text).toContain('Remember to check weekly backup integrity.');
    expect(store.listScratchpadEntries).toHaveBeenCalledWith(3);
  });

  it('scratchpad_write add creates a note', async () => {
    const store = mockScratchpadStore();
    store.addScratchpadEntry.mockReturnValue({
      entry: {
        id: 'sp-1',
        content: 'Take a breath before responding',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      evictedIds: [],
    });
    const tool = createScratchpadWriteTool(store as unknown as MemoryStorePort);

    const result = await tool.execute('call-3', {
      operation: 'add',
      content: 'Take a breath before responding',
    });
    expect(resultText(fromAny(result))).toContain('Scratchpad entry added');
    expect(store.addScratchpadEntry).toHaveBeenCalledWith('Take a breath before responding');
  });

  it('scratchpad_write replace updates existing note', async () => {
    const store = mockScratchpadStore();
    store.replaceScratchpadEntry.mockReturnValue({
      id: 'sp-2',
      content: 'Updated note',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const tool = createScratchpadWriteTool(store as unknown as MemoryStorePort);

    const result = await tool.execute('call-4', {
      operation: 'replace',
      id: 'sp-2',
      content: 'Updated note',
    });
    expect(resultText(fromAny(result))).toContain('Scratchpad entry replaced');
    expect(store.replaceScratchpadEntry).toHaveBeenCalledWith('sp-2', 'Updated note');
  });

  it('scratchpad_write remove deletes note', async () => {
    const store = mockScratchpadStore();
    store.removeScratchpadEntry.mockReturnValue(true);
    const tool = createScratchpadWriteTool(store as unknown as MemoryStorePort);

    const result = await tool.execute('call-5', {
      operation: 'remove',
      id: 'sp-3',
    });
    expect(resultText(fromAny(result))).toContain('Scratchpad entry removed');
    expect(store.removeScratchpadEntry).toHaveBeenCalledWith('sp-3');
  });

  it('scratchpad_write validates required params per operation', async () => {
    const store = mockScratchpadStore();
    const tool = createScratchpadWriteTool(store as unknown as MemoryStorePort);

    const missingAddContent = await tool.execute('call-6', { operation: 'add' });
    expect(resultText(fromAny(missingAddContent))).toContain('content is required for add');
    expect((fromAny(missingAddContent.details)).isError).toBe(true);

    const missingReplaceId = await tool.execute('call-7', {
      operation: 'replace',
      content: 'x',
    });
    expect(resultText(fromAny(missingReplaceId))).toContain('id is required for replace');
    expect((fromAny(missingReplaceId.details)).isError).toBe(true);

    const missingRemoveId = await tool.execute('call-8', {
      operation: 'remove',
    });
    expect(resultText(fromAny(missingRemoveId))).toContain('id is required for remove');
    expect((fromAny(missingRemoveId.details)).isError).toBe(true);
  });
});
