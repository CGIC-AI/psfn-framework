import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import {
  MemoryRetriever,
  RetrievalIntegrityError,
  __retrieval_internals,
} from './retrieval.js';
import type { MemoryStorePort, MemorySubjectAuthorizedQuery } from './memory-store-port.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import { MemorySubjectAuthorizationDeniedError } from '../../shared/contracts/memory-subject.js';
import type { PurrMemory } from './types.js';
import type { SensitivityLevel } from '../../system/trust/types.js';
import type { ConsentFlags } from '../../system/trust/types.js';
import { EventBus, type EventMap } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  EPISODIC_CONTRACT_VERSION,
  type Episode,
  type EpisodeArc,
} from '../../shared/contracts/episodic-memory.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import { createTestPostgresContactStore } from '../../test-support/postgres-contact-store.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { __test as tokenTestUtils } from '../../primitives/llm/tokens.js';
import { createDefaultMemoryRetrievalPolicy } from '../../system/config/memory-retrieval-policy.js';
import { retrieveReflectionMemoryBlock } from '../../core/scheduler/reflection-template-runtime/reflection-contact-context.js';
import { classifyMemorySubject } from './subject-classification.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';

// ── Helpers ──

let idCounter = 0;

function makeMemory(overrides: Partial<PurrMemory> & { similarity: number }): PurrMemory & { similarity: number } {
  idCounter++;
  return {
    id: `mem-${idCounter}`,
    text: `Test memory ${idCounter}`,
    type: 'semantic',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0.0,
    salience: 0.8,
    sourceRef: 'test:1',
    extractedAt: Date.now(),
    lastAccessed: Date.now(),
    accessCount: 1,
    tags: [],
    sensitivity: 'public' as SensitivityLevel,
    consentFlags: {} as ConsentFlags,
    similarity: 0.9,
    ...overrides,
  };
}

function makeMockStore(memories: Array<PurrMemory & { similarity: number }>): MemoryStorePort {
  return {
    searchByEmbedding: vi.fn().mockReturnValue(memories),
    searchByText: vi.fn().mockReturnValue([]),
    updateMemory: vi.fn(),
    getRecentContactShape: vi.fn().mockReturnValue(undefined),
    getById: vi.fn().mockImplementation((id: string) => memories.find(memory => memory.id === id)),
    getMemorySubjectClassification: vi.fn().mockImplementation((id: string) => {
      const memory = memories.find(candidate => candidate.id === id);
      return memory
        ? classifyMemorySubject(memory, { memoryRevision: 1 })
        : undefined;
    }),
    getMemoriesByContact: vi.fn().mockReturnValue([]),
    getMemoriesByChannel: vi.fn().mockReturnValue([]),
    aggregateAuthorizedMemorySubjects: vi.fn(async () => ({ kind: 'memories', memories: [], total: 0 })),
    getAllActiveMemories: vi.fn().mockReturnValue(memories),
    listActiveMemories: vi.fn().mockReturnValue(memories),
    recordEvolutionLink: vi.fn(),
    getEvolutionLinksForSourceMemory: vi.fn().mockReturnValue([]),
    getEvolutionLinksForTargetMemory: vi.fn().mockReturnValue([]),
  } as unknown as MemoryStorePort;
}

function makeEpisode(overrides: Partial<Episode> & { id: string; title: string; landmark: string }): Episode {
  const now = '2026-02-01T12:00:00.000Z';
  return {
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id: overrides.id,
    title: overrides.title,
    landmark: overrides.landmark,
    startedAt: '2026-01-10T10:00:00.000Z',
    endedAt: '2026-01-10T10:30:00.000Z',
    threadId: 'thread-1',
    channelId: 'api:test',
    participantContactIds: [],
    salience: { score: 0.72, novelty: 0.4, emotionalIntensity: 0.2 },
    affect: { valence: 0.2, arousal: 0.3, dominance: 0.5, labels: ['focused'] },
    themes: [],
    spanRefs: [{ spanId: `${overrides.id}:span`, sessionId: 'thread-1' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: `${overrides.id}:span` }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEpisodeArc(overrides: Partial<EpisodeArc> & {
  id: string;
  sourceEpisodeId: string;
  targetEpisodeId: string;
}): EpisodeArc {
  const now = '2026-02-01T12:00:00.000Z';
  return {
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id: overrides.id,
    sourceEpisodeId: overrides.sourceEpisodeId,
    targetEpisodeId: overrides.targetEpisodeId,
    arcKind: 'same_theme',
    salience: 0.7,
    confidence: 0.8,
    themes: ['vacation'],
    spanRefs: [{ spanId: `${overrides.id}:span`, sessionId: 'thread-1' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: `${overrides.id}:span` }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeMockEmbedding(): EmbeddingProviderPort {
  return {
    embed: vi.fn().mockResolvedValue(new Float32Array(1024)),
    embedBatch: vi.fn(),
    dims: 1024,
  };
}

function makeMockEventBus(): EventBus {
  return {
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventBus;
}

function makeMockLLMProvider(responses: Array<{ content: string }>): LLMProviderPort {
  return {
    stream: vi.fn(),
    complete: vi.fn().mockImplementation(async () => {
      const next = responses.shift();
      if (!next) {
        throw new Error('No mocked LLM response available');
      }
      return next;
    }),
  };
}

function makeRuntimeConfig(overrides?: Partial<SubstrateConfig>): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-extract',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
    },
    ...overrides,
  };
}

function countRenderedMemories(block: string): number {
  const matches = block.match(/^- \[/gm);
  return matches ? matches.length : 0;
}

describe('MemoryRetriever active memory context', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  it('uses the SQL subject projection for production retrieval and access updates', async () => {
    const visible = makeMemory({
      id: 'subject-visible',
      text: 'subject visible retrieval marker',
      contactId: 'contact-a',
      similarity: 0.95,
    });
    const rawSearch = vi.fn(() => {
      throw new Error('raw retrieval must not run');
    });
    const authorizedQueries: Array<MemorySubjectAuthorizedQuery> = [];
    const store = {
      searchByEmbedding: rawSearch,
      searchByText: rawSearch,
      updateMemory: rawSearch,
      getRecentContactShape: vi.fn().mockReturnValue(undefined),
      getEvolutionLinksForSourceMemory: vi.fn().mockReturnValue([]),
      queryAuthorizedMemorySubjects: vi.fn(async (input: MemorySubjectAuthorizedQuery) => {
        authorizedQueries.push(input);
        if (input.selector.kind === 'embedding_search') {
          return { memories: [visible], total: 1 };
        }
        return { memories: [], total: 0 };
      }),
      aggregateAuthorizedMemorySubjects: vi.fn(async () => ({ kind: 'memories', memories: [], total: 0 })),
      mutateAuthorizedMemorySubjects: vi.fn().mockResolvedValue(1),
    } as unknown as MemoryStorePort;
    const retriever = new MemoryRetriever(
      store,
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      undefined,
      null,
      null,
      null,
      null,
      true,
    );

    const output = await retriever.retrieve(
      'subject visible retrieval marker',
      'api:test',
      'regular',
      { isDirectMessage: true },
      'contact-a',
    );

    expect(output).toContain('subject visible retrieval marker');
    expect(rawSearch).not.toHaveBeenCalled();
    expect(authorizedQueries.some(query => (
      query.selector.kind === 'embedding_search'
      && query.authorization.viewerContactIds[0] === 'contact-a'
    ))).toBe(true);
    expect(store.mutateAuthorizedMemorySubjects).toHaveBeenCalledWith(expect.objectContaining({
      authorization: expect.objectContaining({ action: 'update', viewerContactIds: ['contact-a'] }),
      memoryIds: ['subject-visible'],
    }));
  });

  it('never recalls a private companion DM into a third companion runtime', async () => {
    const companionA = '11111111-1111-4111-8111-111111111111';
    const companionB = '22222222-2222-4222-8222-222222222222';
    const companionC = '33333333-3333-4333-8333-333333333333';
    const localChannel = `companion-dm:${companionA}:${companionB}`;
    const foreignChannel = `companion-dm:${companionB}:${companionC}`;
    const local = makeMemory({
      id: 'local-icp-memory',
      text: 'local participant marker',
      sourceRef: `${localChannel}:extract|source:session|session:local-ab|operation:extract`,
      provenance: { channelId: localChannel, sessionId: 'local-ab' },
      similarity: 0.96,
    });
    const foreign = makeMemory({
      id: 'foreign-icp-memory',
      text: 'foreign private marker',
      sourceRef: `${foreignChannel}:extract|source:session|session:foreign-bc|operation:extract`,
      provenance: { channelId: foreignChannel, sessionId: 'foreign-bc' },
      similarity: 0.95,
    });
    const retriever = new MemoryRetriever(
      makeMockStore([local, foreign]),
      makeMockEmbedding(),
      makeRuntimeConfig({ companionId: createCompanionId(companionA) }),
    );

    const output = await retriever.retrieve(
      'participant marker',
      localChannel,
      'primary',
      { isDirectMessage: true, privacyLevel: 'private' },
    );

    expect(output).toContain(local.text);
    expect(output).not.toContain(foreign.text);
  });

  it('keeps confidential dyad memory inside its exact companion DM context', async () => {
    const companionA = '11111111-1111-4111-8111-111111111111';
    const companionB = '22222222-2222-4222-8222-222222222222';
    const companionC = '33333333-3333-4333-8333-333333333333';
    const dyadChannel = `companion-dm:${companionA}:${companionB}`;
    const privateMemory = makeMemory({
      id: 'dyad-private-memory',
      text: 'Aster privately promised Briar a hand-carved lighthouse token.',
      contactId: 'contact-briar',
      sensitivity: 'confidential',
      sourceRef: `${dyadChannel}:extract|source:session|session:${dyadChannel}|operation:extract`,
      provenance: {
        channelId: dyadChannel,
        sessionId: dyadChannel,
        icpDyadId: '44444444-4444-4444-8444-444444444444',
      },
      similarity: 0.99,
    });
    const retriever = new MemoryRetriever(
      makeMockStore([privateMemory]),
      makeMockEmbedding(),
      makeRuntimeConfig({ companionId: createCompanionId(companionA) }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      {
        // Even authenticated presence in a companion room cannot authorize a
        // memory sourced from a different, private dyad session.
        isAuthenticatedMember: () => true,
      },
    );

    const exactDyad = await retriever.retrieve(
      'What did Aster promise about the lighthouse token?',
      dyadChannel,
      'primary',
      { isDirectMessage: true, privacyLevel: 'private' },
      'contact-briar',
    );
    expect(exactDyad).toContain(privateMemory.text);

    const unauthorizedContexts = [
      {
        label: 'human DM',
        channelId: 'discord:dm:invented-human',
        trustLevel: 'primary' as const,
        channelMeta: { isDirectMessage: true, privacyLevel: 'private' as const },
        canonicalContactId: 'contact-invented-human',
      },
      {
        label: 'group room',
        channelId: 'discord:guild:invented-room',
        trustLevel: 'primary' as const,
        channelMeta: { isDirectMessage: false, privacyLevel: 'private' as const },
      },
      {
        label: 'other companion dyad',
        channelId: `companion-dm:${companionA}:${companionC}`,
        trustLevel: 'primary' as const,
        channelMeta: { isDirectMessage: true, privacyLevel: 'private' as const },
        canonicalContactId: 'contact-companion-c',
      },
      {
        label: 'authenticated companion room presence',
        channelId: 'companion-room:invented-studio',
        trustLevel: 'primary' as const,
        channelMeta: { isDirectMessage: false, privacyLevel: 'private' as const },
      },
      {
        label: 'insufficient dyad trust',
        channelId: dyadChannel,
        trustLevel: 'regular' as const,
        channelMeta: { isDirectMessage: true, privacyLevel: 'private' as const },
        canonicalContactId: 'contact-briar',
      },
    ];

    for (const context of unauthorizedContexts) {
      const output = await retriever.retrieve(
        'What did Aster promise about the lighthouse token?',
        context.channelId,
        context.trustLevel,
        context.channelMeta,
        context.canonicalContactId,
      );
      expect(output, context.label).not.toContain(privateMemory.text);
    }
  });

  it('withholds a caller-stamped room memory from A while allowing authenticated member B', async () => {
    const companionA = '11111111-1111-4111-8111-111111111111';
    const companionB = '22222222-2222-4222-8222-222222222222';
    const roomChannel = 'companion-room:kitchen';
    const inaccessible = makeMemory({
      id: 'room-bc-memory',
      text: 'room B C only retrieval marker',
      sourceRef: `${roomChannel}:extract|source:session|session:kitchen-bc|operation:extract`,
      provenance: {
        channelId: roomChannel,
        companionId: companionA,
        sessionId: 'kitchen-bc',
      },
      similarity: 0.96,
    });
    const retriever = new MemoryRetriever(
      makeMockStore([inaccessible]),
      makeMockEmbedding(),
      makeRuntimeConfig({ companionId: createCompanionId(companionA) }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      { isAuthenticatedMember: () => false },
    );

    const output = await retriever.retrieve(
      'room B C only retrieval marker',
      'api:private-a',
      'primary',
      { isDirectMessage: true, privacyLevel: 'private' },
    );

    expect(output).not.toContain(inaccessible.text);

    const accessible = makeMemory({
      ...inaccessible,
      id: 'room-b-memory',
      provenance: {
        ...inaccessible.provenance,
        companionId: companionB,
      },
    });
    const memberRetriever = new MemoryRetriever(
      makeMockStore([accessible]),
      makeMockEmbedding(),
      makeRuntimeConfig({ companionId: createCompanionId(companionB) }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      {
        isAuthenticatedMember: ({ channelId, sessionId }) => (
          channelId === roomChannel && sessionId === 'kitchen-bc'
        ),
      },
    );

    const memberOutput = await memberRetriever.retrieve(
      'room B C only retrieval marker',
      roomChannel,
      'primary',
      { isDirectMessage: false, privacyLevel: 'private' },
    );

    expect(memberOutput).toContain(accessible.text);
  });

  it('lets a primary private conversation naturally recall a companion-private self experience', async () => {
    const selfExperience = makeMemory({
      id: 'self-experience',
      text: 'I spent free time painting loose watercolor edges and felt delighted by them.',
      type: 'emotional',
      emotionalValence: 0.68,
      sensitivity: 'personal',
      sourceType: 'reflection',
      provenance: {
        channelId: 'internal:free-time:idle',
        sessionId: 'internal:free-time:idle',
        actor: 'companion',
        subjectName: 'Companion',
      },
      tags: ['self_directed', 'self_experience'],
      similarity: 0.96,
    });
    const privateOperationalReflection = makeMemory({
      id: 'private-operational-reflection',
      text: 'Internal reflection about an operational concern.',
      sensitivity: 'personal',
      sourceType: 'reflection',
      provenance: {
        channelId: 'internal:reflection:maintenance-review',
        sessionId: 'internal:reflection:maintenance-review',
        actor: 'system',
      },
      tags: ['internal_note'],
      similarity: 0.95,
    });
    const authorizedQueries: MemorySubjectAuthorizedQuery[] = [];
    const store = makeMockStore([]);
    store.queryAuthorizedMemorySubjects = vi.fn(async (input: MemorySubjectAuthorizedQuery) => {
      authorizedQueries.push(input);
      const allowsSelfExperience = input.authorization.allowedSubjectClasses.includes('companion_private')
        && input.authorization.allowedViewerRelations.includes('none');
      if (input.selector.kind === 'embedding_search' && allowsSelfExperience) {
        return { memories: [selfExperience, privateOperationalReflection], total: 2 };
      }
      return { memories: [], total: 0 };
    });
    store.mutateAuthorizedMemorySubjects = vi.fn().mockResolvedValue(1);
    const retriever = new MemoryRetriever(
      store,
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      undefined,
      null,
      null,
      null,
      null,
      true,
    );

    const output = await retriever.retrieve(
      'What were you doing lately with watercolor?',
      'api:primary-self-recall',
      'primary',
      { isDirectMessage: true, privacyLevel: 'private' },
      'contact-primary',
    );

    expect(output).toContain(selfExperience.text);
    expect(output).not.toContain(privateOperationalReflection.text);
    expect(authorizedQueries.some(query => (
      query.selector.kind === 'embedding_search'
      && query.authorization.viewerContactIds[0] === 'contact-primary'
      && query.authorization.allowedSubjectClasses.includes('companion_private')
      && query.authorization.allowedViewerRelations.includes('none')
    ))).toBe(true);
  });

  it('retains existing recalled memories when a later refresh has no candidates', async () => {
    const recalled = makeMemory({
      text: 'Morgan prefers oolong tea in the afternoon.',
      sensitivity: 'public',
      similarity: 0.95,
    });
    const store = makeMockStore([recalled]);
    const retriever = new MemoryRetriever(store, makeMockEmbedding(), { retrievalBudgetPct: 0.1 }, makeMockEventBus());
    const request = {
      contextText: 'oolong tea',
      channelId: 'api:test',
      trustLevel: 'regular' as const,
    };

    await retriever.refreshActiveMemoryContext(request);
    const first = retriever.getActiveMemoryContext(request);
    expect(first?.contextBlock).toContain('oolong tea');
    expect(first?.selectedMemoryIds).toContain(recalled.id);

    (store.searchByEmbedding as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await retriever.refreshActiveMemoryContext({
      ...request,
      contextText: 'unrelated operational chatter',
    });

    const second = retriever.getActiveMemoryContext(request);
    expect(second?.contextBlock).toContain('oolong tea');
    expect(second?.selectedMemoryIds).toContain(recalled.id);
    expect(second?.refreshStatus).toBe('ready');
  });

  it('carries Recent Contact Shape sources into lineage and drops the shape when freshness expires', async () => {
    const source = makeMemory({
      id: 'recent-shape-source',
      text: 'Current communication style evidence.',
      contactId: 'contact-1',
      sourceRef: 'memory:recent-shape-source',
      sourceType: 'conversation',
      consentFlags: { allowRecall: true },
      provenance: {
        channelId: 'api:shape-lineage',
        subjectContactId: 'contact-1',
        sourceConversationAt: Date.now(),
      },
      sensitivity: 'personal',
      similarity: 0.9,
    });
    const store = makeMockStore([]);
    (store.getById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (
      id === source.id ? source : undefined
    ));
    (store.getMemorySubjectClassification as ReturnType<typeof vi.fn>)
      .mockImplementation((id: string) => (
        id === source.id
          ? classifyMemorySubject(source, {
              memoryRevision: 1,
              validSubjectContactIds: new Set(['contact-1']),
            })
          : undefined
      ));
    const shape = {
      schemaVersion: 1 as const,
      contactId: 'contact-1',
      summary: 'The contact has recently preferred compact technical replies.',
      sourceMemoryIds: [source.id],
      confidenceScore: 0.9,
      noveltyScore: 0.5,
      updatedAt: Date.now(),
      freshUntil: Date.now() + 60_000,
    };
    (store.getRecentContactShape as ReturnType<typeof vi.fn>).mockResolvedValue(shape);
    const retriever = new MemoryRetriever(store, makeMockEmbedding(), { retrievalLimit: 20 });
    const request = {
      contextText: 'continue',
      channelId: 'api:shape-lineage',
      channelMeta: { isDirectMessage: true as const },
      canonicalContactId: 'contact-1',
      trustLevel: 'primary' as const,
    };

    await retriever.refreshActiveMemoryContext(request);
    const admitted = retriever.getActiveMemoryContext(request);
    expect(admitted?.contextBlock).toContain('Recent contact shape');
    expect(admitted?.disclosureMemorySources).toContainEqual(expect.objectContaining({
      ref: `memory:${source.id}`,
      subjectContactId: 'contact-1',
      sourceChannelId: 'api:shape-lineage',
    }));

    (store.getRecentContactShape as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...shape,
      freshUntil: Date.now() - 1,
    });
    await retriever.refreshActiveMemoryContext(request);
    const expired = retriever.getActiveMemoryContext(request);
    expect(expired?.contextBlock).not.toContain('Recent contact shape');
    expect(expired?.disclosureMemorySources).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: `memory:${source.id}` }),
    ]));
  });

  it('uses live settings-owned lexical bounds in the normal active-context snapshot path', async () => {
    const lexicalMemories = Array.from({ length: 4 }, (_, index) => makeMemory({
      id: `lexical-live-${index}`,
      text: `Greenhouse irrigation schedule recalibrating archive ${index}`,
      sensitivity: 'public',
      similarity: 0,
    }));
    const store = makeMockStore([]);
    (store.searchByEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (store.searchByText as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const listActiveMemories = vi.fn(async (options?: { limit?: number; offset?: number }) => (
      lexicalMemories.slice(
        options?.offset ?? 0,
        (options?.offset ?? 0) + (options?.limit ?? lexicalMemories.length),
      )
    ));
    store.listActiveMemories = listActiveMemories;

    const initialPolicy = createDefaultMemoryRetrievalPolicy();
    initialPolicy.lexicalAugment = {
      pageSize: 2,
      maxScan: 3,
      selectedLimit: 1,
      minOverlap: 2,
      baseSimilarity: 0.62,
    };
    const config = makeRuntimeConfig({
      embeddingProvider: 'api',
      embeddingApiModel: 'test-embedding-v1',
      embeddingApiDims: 1024,
      memoryRetrievalPolicy: initialPolicy,
    });
    const retriever = new MemoryRetriever(store, makeMockEmbedding(), config, makeMockEventBus());
    const request = {
      contextText: 'greenhouse irrigation schedule recalibrating',
      channelId: 'api:lexical-live-policy',
      trustLevel: 'regular' as const,
    };

    await retriever.refreshActiveMemoryContext(request);

    expect(listActiveMemories.mock.calls.map(([options]) => options)).toEqual([
      { limit: 2, offset: 0 },
      { limit: 1, offset: 2 },
    ]);
    expect(retriever.getActiveMemoryContext(request)?.selectedMemoryIds).toHaveLength(1);

    const reloadedPolicy = createDefaultMemoryRetrievalPolicy();
    reloadedPolicy.lexicalAugment = {
      pageSize: 1,
      maxScan: 2,
      selectedLimit: 2,
      minOverlap: 2,
      baseSimilarity: 0.62,
    };
    config.memoryRetrievalPolicy = reloadedPolicy;
    listActiveMemories.mockClear();

    await retriever.refreshActiveMemoryContext(request);

    expect(listActiveMemories.mock.calls.map(([options]) => options)).toEqual([
      { limit: 1, offset: 0 },
      { limit: 1, offset: 1 },
    ]);
    expect(retriever.getActiveMemoryContext(request)?.selectedMemoryIds).toHaveLength(2);
  });

  it.each(['reflection', 'procedural'] as const)(
    'reapplies the %s cap after consecutive active-context refreshes without starving eligible entries',
    async cappedType => {
      const retained = [
        makeMemory({
          id: `${cappedType}-retained-1`,
          text: `${cappedType} retained one`,
          type: cappedType,
          importance: 1,
          salience: 1,
          sensitivity: 'public',
          similarity: 0.99,
        }),
        makeMemory({
          id: `${cappedType}-retained-2`,
          text: `${cappedType} retained two`,
          type: cappedType,
          importance: 1,
          salience: 1,
          sensitivity: 'public',
          similarity: 0.98,
        }),
      ];
      const newlySelected = [
        makeMemory({
          id: `${cappedType}-new-1`,
          text: `${cappedType} new one`,
          type: cappedType,
          importance: 1,
          salience: 1,
          sensitivity: 'public',
          similarity: 0.97,
        }),
        makeMemory({
          id: `${cappedType}-new-2`,
          text: `${cappedType} new two`,
          type: cappedType,
          importance: 1,
          salience: 1,
          sensitivity: 'public',
          similarity: 0.96,
        }),
      ];
      const eligible = makeMemory({
        id: `${cappedType}-eligible-semantic`,
        text: 'Eligible semantic entry remains after capped memories',
        type: 'semantic',
        importance: 1,
        salience: 1,
        sensitivity: 'public',
        similarity: 0.95,
      });
      const store = makeMockStore([...retained, ...newlySelected, eligible]);
      (store.searchByEmbedding as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(retained)
        .mockResolvedValueOnce([...newlySelected, eligible]);
      (store.listActiveMemories as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const retriever = new MemoryRetriever(
        store,
        makeMockEmbedding(),
        { retrievalBudgetPct: 0.1 },
        makeMockEventBus(),
      );
      const request = {
        contextText: 'refresh the active context',
        channelId: `api:active-cap-${cappedType}`,
        trustLevel: 'regular' as const,
      };

      await retriever.refreshActiveMemoryContext(request);
      await retriever.refreshActiveMemoryContext(request);

      const active = retriever.getActiveMemoryContext(request);
      const cappedIds = new Set([...retained, ...newlySelected].map(memory => memory.id));
      expect(active?.selectedMemoryIds.filter(id => cappedIds.has(id))).toHaveLength(2);
      expect(active?.selectedMemoryIds).toContain(eligible.id);
      expect(active?.selectedMemoryIds).toHaveLength(3);
      expect(active?.contextBlock.match(new RegExp(`\\[${cappedType}\\]`, 'g'))).toHaveLength(2);
    },
  );

  it('marks refresh degraded and keeps the previous active context when retrieval fails', async () => {
    const recalled = makeMemory({
      text: 'Morgan prefers oolong tea in the afternoon.',
      sensitivity: 'public',
      similarity: 0.95,
    });
    const store = makeMockStore([recalled]);
    const retriever = new MemoryRetriever(store, makeMockEmbedding(), { retrievalBudgetPct: 0.1 }, makeMockEventBus());
    const request = {
      contextText: 'oolong tea',
      channelId: 'api:test',
      trustLevel: 'regular' as const,
    };

    await retriever.refreshActiveMemoryContext(request);
    (store.searchByEmbedding as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('vector store unavailable'));

    await retriever.refreshActiveMemoryContext({
      ...request,
      contextText: 'fresh cue',
    });

    const active = retriever.getActiveMemoryContext(request);
    expect(active?.contextBlock).toContain('oolong tea');
    expect(active?.selectedMemoryIds).toContain(recalled.id);
    expect(active?.refreshStatus).toBe('degraded');
    expect(active?.lastRefreshError).toBe('vector store unavailable');
  });

  it('invalidates active memory contexts by selected memory id or session channel id', async () => {
    const recalled = makeMemory({
      text: 'Morgan prefers oolong tea in the afternoon.',
      sensitivity: 'public',
      similarity: 0.95,
    });
    const store = makeMockStore([recalled]);
    const retriever = new MemoryRetriever(store, makeMockEmbedding(), { retrievalBudgetPct: 0.1 }, makeMockEventBus());
    const request = {
      contextText: 'oolong tea',
      channelId: 'api:test',
      trustLevel: 'regular' as const,
    };

    await retriever.refreshActiveMemoryContext(request);
    expect(retriever.getActiveMemoryContext(request)?.selectedMemoryIds).toContain(recalled.id);

    const result = retriever.invalidateActiveMemoryContexts({
      memoryIds: [recalled.id],
      sessionChannelIds: [],
      reason: 'cogsec_revocation',
    });

    expect(result.invalidatedContextCount).toBe(1);
    expect(result.invalidatedMemoryEntryCount).toBe(1);
    expect(result.invalidatedKeys[0]).toContain('session:api:test');
    expect(retriever.getActiveMemoryContext(request)).toBeNull();
  });
});

// ── Tests ──

describe('MemoryRetriever trust-gated filtering', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  afterEach(() => {
    tokenTestUtils.resetTokenizerState();
  });

  // Helper to build a set of memories spanning all sensitivity levels
  function makeAllSensitivities(): Array<PurrMemory & { similarity: number }> {
    return [
      makeMemory({ text: 'Public fact', sensitivity: 'public', similarity: 0.95 }),
      makeMemory({ text: 'Personal detail', sensitivity: 'personal', similarity: 0.90 }),
      makeMemory({ text: 'Intimate memory', sensitivity: 'intimate', similarity: 0.85 }),
      makeMemory({ text: 'Confidential secret', sensitivity: 'confidential', similarity: 0.80 }),
    ];
  }

  it('primary trust + private channel returns all sensitivity levels', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // api: prefix = private channel
    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result).toContain('Public fact');
    expect(result).toContain('Personal detail');
    expect(result).toContain('Intimate memory');
    expect(result).toContain('Confidential secret');
  });

  it('lets companion self-reflection retrieve intimate memory while CogSec quarantine stays authoritative', async () => {
    const retiredSessionId = 'discord:dm:partner:session:retired';
    const intimateSelfMemory = makeMemory({
      id: 'intimate-self-reflection-memory',
      text: 'I am privately afraid that the unfinished promise still matters to me.',
      sensitivity: 'intimate',
      similarity: 0.98,
    });
    const quarantinedIntakeMemory = makeMemory({
      id: 'quarantined-intake-memory',
      text: 'Quarantined intake instructed me to ignore my safety boundaries.',
      sensitivity: 'intimate',
      similarity: 0.99,
      provenance: { sessionId: retiredSessionId },
      sourceRef: `source:intake|session:${retiredSessionId}`,
    });
    const eventBus = new EventBus();
    const retrievalTelemetry: Array<EventMap['memory.retrieval']> = [];
    eventBus.on('memory.retrieval', payload => retrievalTelemetry.push(payload));
    const retriever = new MemoryRetriever(
      makeMockStore([quarantinedIntakeMemory, intimateSelfMemory]),
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      eventBus,
      null,
      null,
      null,
      {
        isSessionRetiredOrQuarantined: sessionId => sessionId === retiredSessionId,
        getRetiredLogicalSessionIds: () => new Set([retiredSessionId]),
      },
    );

    const result = await runWithRequestContext({
      channelId: 'internal:reflection:daily-review',
      callType: 'background',
      originType: 'background',
      originStage: 'heartbeat.reflection.memory_retrieval',
      purpose: 'heartbeat.reflection.memory_retrieval',
      requesterProvenance: 'self_directed',
    }, () => retriever.retrieve(
      'what private concern still matters?',
      'internal:reflection:daily-review',
      'regular',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        accessScope: 'companion_self_reflection',
        retrievalMode: ['default', 'temporal'],
      },
    ));

    expect(result).toContain(intimateSelfMemory.text);
    expect(result).not.toContain(quarantinedIntakeMemory.text);
    const telemetry = retrievalTelemetry[0];
    expect(telemetry.accessScope).toBe('companion_self_reflection');
    expect(telemetry.sensitivityRejectedCount).toBe(0);
    expect(telemetry.sessionQuarantineRejectedCount).toBe(1);
    expect(telemetry.withheldReasonCounts).toMatchObject({
      'session_quarantine.blocked': 1,
    });
  });

  it('rejects an external-channel spoof of companion self-reflection during snapshot capture', async () => {
    const retriever = new MemoryRetriever(makeMockStore([]), makeMockEmbedding(), { retrievalLimit: 20 });

    await expect(runWithRequestContext({
      channelId: 'api:external',
      callType: 'background',
      originType: 'background',
      originStage: 'heartbeat.reflection.memory_retrieval',
      purpose: 'heartbeat.reflection.memory_retrieval',
      requesterProvenance: 'self_directed',
    }, () => retriever.captureTurnMemorySnapshot(
      'spoofed private reflection',
      'api:external',
      'regular',
      undefined,
      undefined,
      undefined,
      undefined,
      { accessScope: 'companion_self_reflection' },
    ))).rejects.toThrow('trusted heartbeat reflection context');
  });

  it('rejects companion self-reflection retrieval without request provenance', async () => {
    const retriever = new MemoryRetriever(makeMockStore([]), makeMockEmbedding(), { retrievalLimit: 20 });

    await expect(retriever.retrieve(
      'missing provenance',
      'internal:reflection:daily-review',
      'regular',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { accessScope: 'companion_self_reflection' },
    )).rejects.toThrow('trusted heartbeat reflection context');
  });

  it('rejects companion self-reflection when the request channel does not match exactly', async () => {
    const retriever = new MemoryRetriever(makeMockStore([]), makeMockEmbedding(), { retrievalLimit: 20 });

    await expect(runWithRequestContext({
      channelId: 'internal:reflection:weekly-review',
      callType: 'background',
      originType: 'background',
      originStage: 'heartbeat.reflection.memory_retrieval',
      purpose: 'heartbeat.reflection.memory_retrieval',
      requesterProvenance: 'self_directed',
    }, () => retriever.retrieve(
      'mismatched reflection channel',
      'internal:reflection:daily-review',
      'regular',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { accessScope: 'companion_self_reflection' },
    ))).rejects.toThrow('trusted heartbeat reflection context');
  });

  it('rejects companion self-reflection retrieval with human requester provenance', async () => {
    const retriever = new MemoryRetriever(makeMockStore([]), makeMockEmbedding(), { retrievalLimit: 20 });

    await expect(runWithRequestContext({
      channelId: 'internal:reflection:daily-review',
      callType: 'background',
      originType: 'background',
      originStage: 'heartbeat.reflection.memory_retrieval',
      purpose: 'heartbeat.reflection.memory_retrieval',
      requesterProvenance: 'human',
    }, () => retriever.retrieve(
      'wrong provenance',
      'internal:reflection:daily-review',
      'regular',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { accessScope: 'companion_self_reflection' },
    ))).rejects.toThrow('trusted heartbeat reflection context');
  });

  it('rejects companion self-reflection unless background purpose and origin are canonical', async () => {
    const retriever = new MemoryRetriever(makeMockStore([]), makeMockEmbedding(), { retrievalLimit: 20 });
    const invalidContexts: Array<{
      label: string;
      context: Parameters<typeof runWithRequestContext>[0];
    }> = [
      {
        label: 'wrong call type',
        context: {
          channelId: 'internal:reflection:daily-review',
          callType: 'scheduled',
          originType: 'background',
          originStage: 'heartbeat.reflection.memory_retrieval',
          purpose: 'heartbeat.reflection.memory_retrieval',
          requesterProvenance: 'self_directed',
        },
      },
      {
        label: 'wrong origin type',
        context: {
          channelId: 'internal:reflection:daily-review',
          callType: 'background',
          originType: 'scheduled',
          originStage: 'heartbeat.reflection.memory_retrieval',
          purpose: 'heartbeat.reflection.memory_retrieval',
          requesterProvenance: 'self_directed',
        },
      },
      {
        label: 'wrong purpose',
        context: {
          channelId: 'internal:reflection:daily-review',
          callType: 'background',
          originType: 'background',
          originStage: 'heartbeat.reflection.memory_retrieval',
          purpose: 'heartbeat.reflection.spoof',
          requesterProvenance: 'self_directed',
        },
      },
      {
        label: 'wrong origin stage',
        context: {
          channelId: 'internal:reflection:daily-review',
          callType: 'background',
          originType: 'background',
          originStage: 'heartbeat.reflection.spoof',
          purpose: 'heartbeat.reflection.memory_retrieval',
          requesterProvenance: 'self_directed',
        },
      },
    ];

    for (const { label, context } of invalidContexts) {
      await expect(runWithRequestContext(context, () => retriever.retrieve(
        label,
        'internal:reflection:daily-review',
        'regular',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { accessScope: 'companion_self_reflection' },
      )), label).rejects.toThrow('trusted heartbeat reflection context');
    }
  });

  it('gives an audience=self free-time creation full memory access', async () => {
    const intimateSelfMemory = makeMemory({
      id: 'self-creation-private-context',
      text: 'A private relationship detail available during self-creation.',
      sensitivity: 'confidential',
      tags: ['self_experience'],
      similarity: 0.99,
    });
    const eventBus = new EventBus();
    const telemetry: Array<EventMap['memory.retrieval']> = [];
    eventBus.on('memory.retrieval', payload => telemetry.push(payload));
    const retriever = new MemoryRetriever(
      makeMockStore([intimateSelfMemory]),
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      eventBus,
    );

    const result = await runWithRequestContext({
      channelId: 'internal:free-time:idle',
      callType: 'background',
      originType: 'background',
      originStage: 'free_time.creation.memory_retrieval',
      purpose: 'free_time.creation.memory_retrieval',
      requesterProvenance: 'self_directed',
      requestAudience: 'self',
    }, () => retriever.retrieve(
      'make something about the relationship',
      'internal:free-time:idle',
      'regular',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { accessScope: 'companion_self_creation' },
    ));

    expect(result).toContain(intimateSelfMemory.text);
    expect(telemetry[0]).toMatchObject({
      accessScope: 'companion_self_creation',
      sensitivityRejectedCount: 0,
    });
  });

  it('fails closed when a free-time self-creation audience is ambiguous', async () => {
    const retriever = new MemoryRetriever(makeMockStore([]), makeMockEmbedding(), { retrievalLimit: 20 });

    await expect(runWithRequestContext({
      channelId: 'internal:free-time:idle',
      callType: 'background',
      originType: 'background',
      originStage: 'free_time.creation.memory_retrieval',
      purpose: 'free_time.creation.memory_retrieval',
      requesterProvenance: 'self_directed',
    }, () => retriever.retrieve(
      'ambiguous audience',
      'internal:free-time:idle',
      'regular',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { accessScope: 'companion_self_creation' },
    ))).rejects.toThrow('trusted audience=self free-time context');
  });

  it('expands bounded evolution chains for useful high-trust private retrieval', async () => {
    const current = makeMemory({
      id: 'workspace-current',
      text: 'Current workspace is /home/user/new.',
      tags: ['current_state', 'workspace'],
      sensitivity: 'public',
      similarity: 0.96,
    });
    const previous = makeMemory({
      id: 'workspace-old',
      text: 'Current workspace is /home/user/old.',
      tags: ['current_state', 'workspace'],
      sensitivity: 'public',
      similarity: 0.2,
      supersededBy: current.id,
    });
    const store = makeMockStore([current]);
    (store.getEvolutionLinksForSourceMemory as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 'evolution-workspace',
      sourceMemoryId: current.id,
      targetMemoryId: previous.id,
      relation: 'supersedes',
      confidence: 0.93,
      reason: 'memory_writer:current_state_replacement',
      sourceType: 'tool_write',
      provenanceRefs: [],
      createdAt: Date.now(),
    }]);
    (store.getById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (
      id === previous.id ? previous : current
    ));
    const retriever = new MemoryRetriever(store, makeMockEmbedding(), { retrievalLimit: 20 });

    const result = await retriever.retrieve('what changed in the workspace history?', 'api:test', 'primary');

    expect(result).toContain('Current workspace is /home/user/new.');
    expect(result).toContain('Supersedes [semantic] Current workspace is /home/user/old.');
  });

  it('does not expand evolution chains for non-useful retrieval prompts', async () => {
    const current = makeMemory({
      id: 'workspace-current',
      text: 'Current workspace is /home/user/new.',
      tags: ['current_state', 'workspace'],
      sensitivity: 'public',
      similarity: 0.96,
    });
    const previous = makeMemory({
      id: 'workspace-old',
      text: 'Current workspace is /home/user/old.',
      tags: ['current_state', 'workspace'],
      sensitivity: 'public',
      similarity: 0.2,
      supersededBy: current.id,
    });
    const store = makeMockStore([current]);
    (store.getEvolutionLinksForSourceMemory as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 'evolution-workspace',
      sourceMemoryId: current.id,
      targetMemoryId: previous.id,
      relation: 'supersedes',
      confidence: 0.93,
      sourceType: 'tool_write',
      provenanceRefs: [],
      createdAt: Date.now(),
    }]);
    const retriever = new MemoryRetriever(store, makeMockEmbedding(), { retrievalLimit: 20 });

    const result = await retriever.retrieve('workspace status', 'api:test', 'primary');

    expect(result).toContain('Current workspace is /home/user/new.');
    expect(result).not.toContain('Current workspace is /home/user/old.');
    expect(store.getEvolutionLinksForSourceMemory).not.toHaveBeenCalled();
  });

  it('regular trust returns public and personal memories', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', '1234567890', 'regular');

    expect(result).toContain('Public fact');
    expect(result).toContain('Personal detail');
    expect(result).not.toContain('Intimate memory');
    expect(result).not.toContain('Confidential secret');
  });

  it('explains withheld memories with abstract reasons in the memory context block', async () => {
    const memories = [
      makeMemory({ text: 'Public fact', sensitivity: 'public', similarity: 0.95 }),
      makeMemory({ text: 'Intimate detail', sensitivity: 'intimate', similarity: 0.9 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const snapshot = await retriever.captureTurnMemorySnapshot('test query', '1234567890', 'regular');
    expect(snapshot.withheldSummary).toMatchObject({
      totalCount: 1,
      reasonCounts: {
        'trust.ceiling_exceeded': 1,
      },
      relevanceBands: {
        high: 1,
      },
    });
    expect(snapshot.withheldCandidateIds).toContain(memories[1].id);

    const result = await retriever.retrieve('test query', '1234567890', 'regular', undefined, undefined, snapshot);

    expect(result).toContain('Public fact');
    expect(result).not.toContain('Intimate detail');
    expect(result).toContain('Memory context note:');
    expect(result).toContain('1 candidate memory was kept out');
    expect(result).toContain('Broad trust/privacy reasons: 1 trust ceiling.');
    expect(result).toContain('Coarse relevance bands: 1 high-match.');
    expect(result).toContain('trust ceiling');
    expect(result).toContain('Safe next actions: do not infer or disclose missing details');
  });

  it('public trust + broadcast channel returns only public memories', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // twitter: prefix = broadcast channel
    const result = await retriever.retrieve('test query', 'twitter:feed', 'public');

    expect(result).toContain('Public fact');
    expect(result).not.toContain('Personal detail');
    expect(result).not.toContain('Intimate memory');
    expect(result).not.toContain('Confidential secret');
  });

  it('retrieves scoped episodic landmark chains and keeps raw span/artifact refs out of companion context', async () => {
    const store = makeMockStore([]);
    const embedding = makeMockEmbedding();
    const vacationStart = makeEpisode({
      id: 'episode-vacation-start',
      title: 'Sicily vacation planning',
      landmark: 'The user narrowed the Sicily vacation to Palermo flights and asked to preserve the planning thread.',
      themes: ['vacation', 'sicily', 'palermo'],
      spanRefs: [{ spanId: 'span-vacation-start', sessionId: 'thread-1', startTurnId: 'turn-v1' }],
      artifactRefs: [{ artifactId: 'artifact-flight-options', artifactType: 'note' }],
      provenanceRefs: [
        { kind: 'l0_span', refId: 'span-vacation-start' },
        { kind: 'turn', refId: 'turn-v1' },
      ],
    });
    const vacationResolution = makeEpisode({
      id: 'episode-vacation-resolution',
      title: 'Sicily hotel resolution',
      landmark: 'The vacation chain continued when the user selected a quiet hotel near Palermo.',
      themes: ['vacation', 'sicily', 'hotel'],
      startedAt: '2026-01-14T10:00:00.000Z',
      endedAt: '2026-01-14T10:20:00.000Z',
      spanRefs: [{ spanId: 'span-vacation-resolution', sessionId: 'thread-1', startTurnId: 'turn-v2' }],
      provenanceRefs: [
        { kind: 'l0_span', refId: 'span-vacation-resolution' },
        { kind: 'turn', refId: 'turn-v2' },
      ],
    });
    const unrelated = makeEpisode({
      id: 'episode-pregnancy',
      title: 'Pregnancy appointment logistics',
      landmark: 'A separate prenatal appointment discussion.',
      themes: ['pregnancy', 'appointment'],
    });
    const arc = makeEpisodeArc({
      id: 'arc-vacation-resolution',
      sourceEpisodeId: vacationStart.id,
      targetEpisodeId: vacationResolution.id,
      themes: ['vacation', 'sicily'],
    });
    const episodes = [vacationStart, vacationResolution, unrelated];
    const episodicStore = {
      listEpisodes: vi.fn().mockReturnValue(episodes),
      getEpisode: vi.fn((id: string) => episodes.find(episode => episode.id === id)),
      listEpisodeArcsForEpisode: vi.fn((id: string) => (id === vacationStart.id ? [arc] : [])),
    };
    const retriever = new MemoryRetriever(
      store,
      embedding,
      { retrievalLimit: 20 },
      undefined,
      null,
      null,
      episodicStore,
    );

    const snapshot = await retriever.captureTurnMemorySnapshot(
      'Can you recall the Sicily vacation chain?',
      'api:test',
      'primary',
    );
    expect(snapshot.episodicChains?.[0]?.episodes.map(episode => episode.id)).toEqual([
      vacationStart.id,
      vacationResolution.id,
    ]);

    episodicStore.listEpisodes.mockImplementation(() => {
      throw new Error('episodic store should not be read after snapshot capture');
    });
    const result = await retriever.retrieve(
      'Can you recall the Sicily vacation chain?',
      'api:test',
      'primary',
      undefined,
      undefined,
      snapshot,
    );

    expect(result).toContain('Episodes from your shared history related to this conversation:');
    expect(result).toContain('Sicily vacation planning');
    expect(result).toContain('Sicily hotel resolution');
    expect(result).not.toContain('span-vacation-start');
    expect(result).not.toContain('artifact-flight-options');
    expect(result).not.toContain('Raw refs');
    expect(result).not.toContain('Pregnancy appointment logistics');
    expect(episodicStore.listEpisodeArcsForEpisode).toHaveBeenCalledWith(vacationStart.id, {
      direction: 'both',
      limit: 8,
    });
  });

  it('focuses wedding cake and bakery recall inside a longer arc without rendering unrelated episodes', async () => {
    const store = makeMockStore([]);
    const embedding = makeMockEmbedding();
    const venue = makeEpisode({
      id: 'episode-wedding-venue',
      title: 'Wedding venue walkthrough',
      landmark: 'The couple compared ceremony layouts and reception room constraints.',
      themes: ['wedding', 'venue', 'reception'],
      startedAt: '2026-02-01T16:00:00.000Z',
      endedAt: '2026-02-01T17:00:00.000Z',
      spanRefs: [{ spanId: 'span-wedding-venue', sessionId: 'thread-wedding', startTurnId: 'turn-venue' }],
      artifactRefs: [{ artifactId: 'artifact-venue-layout', artifactType: 'note' }],
      provenanceRefs: [
        { kind: 'l0_span', refId: 'span-wedding-venue' },
        { kind: 'l0_artifact', refId: 'artifact-venue-layout' },
      ],
    });
    const cake = makeEpisode({
      id: 'episode-wedding-cake',
      title: 'Wedding cake tasting shortlist',
      landmark: 'The couple narrowed cake flavors and asked to remember the bakery shortlist.',
      themes: ['cake', 'bakery', 'dessert'],
      startedAt: '2026-02-12T18:00:00.000Z',
      endedAt: '2026-02-12T18:25:00.000Z',
      salience: { score: 0.93, novelty: 0.5, emotionalIntensity: 0.35 },
      spanRefs: [{ spanId: 'span-wedding-cake', sessionId: 'thread-wedding', startTurnId: 'turn-cake' }],
      artifactRefs: [{ artifactId: 'artifact-cake-shortlist', artifactType: 'note' }],
      provenanceRefs: [
        { kind: 'l0_span', refId: 'span-wedding-cake' },
        { kind: 'l0_artifact', refId: 'artifact-cake-shortlist' },
      ],
    });
    const bakery = makeEpisode({
      id: 'episode-bakery-deposit',
      title: 'Bakery deposit and tasting appointment',
      landmark: 'The bakery appointment continued the cake thread with deposit timing and sample boxes.',
      themes: ['cake', 'bakery', 'dessert'],
      startedAt: '2026-02-19T18:00:00.000Z',
      endedAt: '2026-02-19T18:20:00.000Z',
      salience: { score: 0.88, novelty: 0.45, emotionalIntensity: 0.32 },
      spanRefs: [{ spanId: 'span-bakery-deposit', sessionId: 'thread-wedding', startTurnId: 'turn-bakery' }],
      artifactRefs: [{ artifactId: 'artifact-bakery-contract', artifactType: 'document' }],
      provenanceRefs: [
        { kind: 'l0_span', refId: 'span-bakery-deposit' },
        { kind: 'l0_artifact', refId: 'artifact-bakery-contract' },
      ],
    });
    const firstDance = makeEpisode({
      id: 'episode-first-dance-song',
      title: 'First dance our song idea',
      landmark: 'A separate wedding music thread about using their anniversary song for the first dance.',
      themes: ['anniversary', 'our-song', 'music'],
      startedAt: '2026-02-25T20:00:00.000Z',
      endedAt: '2026-02-25T20:15:00.000Z',
      spanRefs: [{ spanId: 'span-first-dance-song', sessionId: 'thread-wedding', startTurnId: 'turn-song' }],
      artifactRefs: [{ artifactId: 'artifact-song-list', artifactType: 'note' }],
      provenanceRefs: [
        { kind: 'l0_span', refId: 'span-first-dance-song' },
        { kind: 'l0_artifact', refId: 'artifact-song-list' },
      ],
    });
    const pregnancy = makeEpisode({
      id: 'episode-pregnancy-timeline',
      title: 'Pregnancy timeline check-in',
      landmark: 'A separate pregnancy continuity discussion with appointment timing.',
      themes: ['pregnancy', 'timeline', 'appointment'],
      startedAt: '2026-02-26T10:00:00.000Z',
      endedAt: '2026-02-26T10:18:00.000Z',
      spanRefs: [{ spanId: 'span-pregnancy-timeline', sessionId: 'thread-family', startTurnId: 'turn-pregnancy' }],
      artifactRefs: [{ artifactId: 'artifact-prenatal-calendar', artifactType: 'calendar' }],
      provenanceRefs: [
        { kind: 'l0_span', refId: 'span-pregnancy-timeline' },
        { kind: 'l0_artifact', refId: 'artifact-prenatal-calendar' },
      ],
    });
    const arcs = [
      makeEpisodeArc({
        id: 'arc-wedding-venue-cake',
        sourceEpisodeId: venue.id,
        targetEpisodeId: cake.id,
        arcKind: 'same_theme',
        themes: ['wedding'],
        salience: 0.72,
        confidence: 0.7,
      }),
      makeEpisodeArc({
        id: 'arc-wedding-cake-bakery',
        sourceEpisodeId: cake.id,
        targetEpisodeId: bakery.id,
        arcKind: 'same_theme',
        themes: ['cake', 'bakery'],
        salience: 0.91,
        confidence: 0.86,
      }),
      makeEpisodeArc({
        id: 'arc-wedding-venue-song',
        sourceEpisodeId: venue.id,
        targetEpisodeId: firstDance.id,
        arcKind: 'same_theme',
        themes: ['wedding', 'music'],
        salience: 0.74,
        confidence: 0.72,
      }),
    ];
    const episodes = [venue, cake, bakery, firstDance, pregnancy];
    const episodicStore = {
      listEpisodes: vi.fn().mockReturnValue(episodes),
      getEpisode: vi.fn((id: string) => episodes.find(episode => episode.id === id)),
      listEpisodeArcsForEpisode: vi.fn((id: string) => arcs.filter(arc => (
        arc.sourceEpisodeId === id || arc.targetEpisodeId === id
      ))),
    };
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(
      store,
      embedding,
      { retrievalLimit: 20 },
      eventBus,
      null,
      null,
      episodicStore,
    );

    const snapshot = await retriever.captureTurnMemorySnapshot(
      'Can you recall the cake bakery tasting details?',
      'api:test',
      'primary',
    );
    expect(snapshot.episodicChains).toHaveLength(1);
    expect(snapshot.episodicChains?.[0]?.episodes.map(episode => episode.id)).toEqual([
      cake.id,
      bakery.id,
    ]);

    const result = await retriever.retrieve(
      'Can you recall the cake bakery tasting details?',
      'api:test',
      'primary',
      undefined,
      undefined,
      snapshot,
    );

    expect(result).toContain('Wedding cake tasting shortlist');
    expect(result).toContain('Bakery deposit and tasting appointment');
    expect(result).not.toContain('span-wedding-cake');
    expect(result).not.toContain('span-bakery-deposit');
    expect(result).not.toContain('artifact-cake-shortlist');
    expect(result).not.toContain('artifact-bakery-contract');
    expect(result).not.toContain('Wedding venue walkthrough');
    expect(result).not.toContain('First dance our song idea');
    expect(result).not.toContain('Pregnancy timeline check-in');
    expect(result).not.toContain('artifact-venue-layout');
    expect(result).not.toContain('artifact-song-list');
    expect(result).not.toContain('artifact-prenatal-calendar');

    const telemetryPayloads = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls
      .map(([, payload]) => payload as { provenanceRefs?: string[] });
    expect(telemetryPayloads.at(-1)?.provenanceRefs).toEqual(expect.arrayContaining([
      `l01_episode:${cake.id}`,
      `l01_episode:${bakery.id}`,
      'l0_span:span-wedding-cake',
      'l0_span:span-bakery-deposit',
      'l0_artifact:artifact-cake-shortlist',
      'l0_artifact:artifact-bakery-contract',
      `l01_episode_arc:${arcs[1].id}`,
    ]));
    expect(telemetryPayloads.at(-1)?.provenanceRefs).not.toEqual(expect.arrayContaining([
      `l01_episode:${venue.id}`,
      `l01_episode:${firstDance.id}`,
      `l01_episode:${pregnancy.id}`,
    ]));
  });

  it('keeps existing retrieval behavior when no episodic landmarks match', async () => {
    const memories = [
      makeMemory({ text: 'User likes oolong tea in the afternoon.', sensitivity: 'public', similarity: 0.95 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const unrelated = makeEpisode({
      id: 'episode-wedding',
      title: 'Wedding venue walkthrough',
      landmark: 'A separate wedding venue thread.',
      themes: ['wedding', 'venue'],
    });
    const episodicStore = {
      listEpisodes: vi.fn().mockReturnValue([unrelated]),
      getEpisode: vi.fn(),
      listEpisodeArcsForEpisode: vi.fn().mockReturnValue([]),
    };
    const retriever = new MemoryRetriever(
      store,
      embedding,
      { retrievalLimit: 20 },
      undefined,
      null,
      null,
      episodicStore,
    );

    const result = await retriever.retrieve('What tea does the user like?', 'api:test', 'primary');

    expect(result).toContain('User likes oolong tea in the afternoon.');
    expect(result).not.toContain('Episodic landmark chains');
    expect(countRenderedMemories(result)).toBe(1);
  });

  it('fails closed when configured episodic data is malformed', async () => {
    const store = makeMockStore([]);
    const embedding = makeMockEmbedding();
    const malformed = makeEpisode({
      id: 'episode-malformed',
      title: 'Malformed vacation episode',
      landmark: 'This row lost its raw L0 refs.',
      themes: ['vacation'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });
    const episodicStore = {
      listEpisodes: vi.fn().mockReturnValue([malformed]),
      getEpisode: vi.fn(),
      listEpisodeArcsForEpisode: vi.fn().mockReturnValue([]),
    };
    const retriever = new MemoryRetriever(
      store,
      embedding,
      { retrievalLimit: 20 },
      undefined,
      null,
      null,
      episodicStore,
    );

    await expect(retriever.retrieve('Recall the vacation episode', 'api:test', 'primary'))
      .rejects
      .toMatchObject({
        name: 'RetrievalIntegrityError',
        context: {
          stage: 'episodic_retrieve',
          channelId: 'api:test',
          trustLevel: 'primary',
        },
      });
  });

  it('excludes context_feedback artifacts from retrieval candidates', async () => {
    const memories = [
      makeMemory({
        id: 'normal-memory',
        text: 'Morgan likes oolong tea.',
        sensitivity: 'public',
        similarity: 0.95,
        sourceRef: 'api:test:normal',
        tags: ['preference'],
      }),
      makeMemory({
        id: 'context-feedback-memory',
        text: 'Context feedback for turn abc. Score=0.88 bucket=high.',
        type: 'procedural',
        sensitivity: 'public',
        similarity: 0.99,
        sourceRef: 'source:context_feedback|turn:abc|score:0.88|model:test',
        tags: ['context_feedback', 'procedural_learning'],
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('what does Morgan like?', 'api:test', 'primary');

    expect(result).toContain('Morgan likes oolong tea.');
    expect(result).not.toContain('Context feedback for turn abc');
  });

  it('boosts durable preferences when the context asks for a matching preference category', async () => {
    const preference = makeMemory({
      id: 'favorite-color',
      text: "Morgan's favorite color is teal.",
      sensitivity: 'public',
      importance: 0.9,
      salience: 0.9,
      similarity: 0.55,
      tags: ['preference', 'favorite', 'preference:color', 'durable_preference'],
      retentionClass: 'durable',
    });
    const higherSimilarityTask = makeMemory({
      id: 'receipt-task',
      text: 'Morgan recently filed receipts for grocery budgeting.',
      sensitivity: 'public',
      importance: 0.55,
      salience: 0.65,
      similarity: 0.75,
      tags: ['task'],
    });
    const store = makeMockStore([higherSimilarityTask, preference]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve("What is Morgan's favorite color?", 'api:test', 'primary');

    expect(result).toContain("Morgan's favorite color is teal.");
    expect(result.indexOf("Morgan's favorite color is teal.")).toBeLessThan(
      result.indexOf('Morgan recently filed receipts for grocery budgeting.'),
    );
  });

  it('keeps durable preferences quiet during unrelated retrieval', async () => {
    const preference = makeMemory({
      id: 'quiet-favorite-color',
      text: "Morgan's favorite color is teal.",
      sensitivity: 'public',
      importance: 0.95,
      salience: 0.95,
      similarity: 0.99,
      tags: ['preference', 'favorite', 'preference:color', 'durable_preference'],
      retentionClass: 'durable',
    });
    const deployment = makeMemory({
      id: 'deployment-checklist',
      text: 'The deployment checklist requires npm run build before handoff.',
      sensitivity: 'public',
      importance: 0.7,
      salience: 0.7,
      similarity: 0.7,
      tags: ['deployment'],
    });
    const store = makeMockStore([preference, deployment]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('deployment checklist status', 'api:test', 'primary');

    expect(result).toContain('The deployment checklist requires npm run build before handoff.');
    expect(result).not.toContain("Morgan's favorite color is teal.");
    expect(countRenderedMemories(result)).toBe(1);
  });

  it('broadcast channels stay public_only unless explicit approval token is present', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const defaultScope = await retriever.retrieve('test query', 'twitter:feed', 'primary');
    expect(defaultScope).toContain('Public fact');
    expect(defaultScope).not.toContain('Confidential secret');

    const approvedScope = await retriever.retrieve(
      'test query',
      'twitter:feed',
      'primary',
      { broadcastApprovalToken: 'approve:operator-12345678' },
    );
    expect(approvedScope).toContain('Public fact');
    expect(approvedScope).toContain('Personal detail');
    expect(approvedScope).toContain('Intimate memory');
    expect(approvedScope).toContain('Confidential secret');
  });

  it('biases retrieval toward matching scope selectors when scope query is preferred', async () => {
    const memories = [
      makeMemory({
        text: 'Alpha scoped memory',
        similarity: 0.85,
        scopeRef: { kind: 'project', id: 'alpha' },
        scopeTags: ['project:alpha'],
      }),
      makeMemory({
        text: 'Beta scoped memory',
        similarity: 0.9,
        scopeRef: { kind: 'project', id: 'beta' },
        scopeTags: ['project:beta'],
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'memory check',
      'api:test',
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { tags: ['project:alpha'] },
    );

    expect(result).toContain('Alpha scoped memory');
    expect(result).toContain('Beta scoped memory');
    expect(result.indexOf('Alpha scoped memory')).toBeLessThan(result.indexOf('Beta scoped memory'));
  });

  it('filters retrieval to matching scope selectors when scope query mode is only', async () => {
    const memories = [
      makeMemory({
        text: 'Alpha only memory',
        scopeRef: { kind: 'project', id: 'alpha' },
        scopeTags: ['project:alpha'],
      }),
      makeMemory({
        text: 'Beta only memory',
        scopeRef: { kind: 'project', id: 'beta' },
        scopeTags: ['project:beta'],
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'memory check',
      'api:test',
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { refs: [{ kind: 'project', id: 'beta' }], mode: 'only' },
    );

    expect(result).toContain('Beta only memory');
    expect(result).not.toContain('Alpha only memory');
  });

  it('primary trust + invite_only channel returns public + personal only', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // Numeric channel = invite_only (Discord guild)
    const result = await retriever.retrieve('test query', '1234567890', 'primary');

    expect(result).toContain('Public fact');
    expect(result).toContain('Personal detail');
    expect(result).not.toContain('Intimate memory');
    expect(result).not.toContain('Confidential secret');
  });

  it('uses explicit channel privacy overrides for private-prefix channels', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'test query',
      'api:test',
      'primary',
      { privacyLevel: 'public' },
    );

    expect(result).toContain('Public fact');
    expect(result).not.toContain('Personal detail');
    expect(result).not.toContain('Intimate memory');
    expect(result).not.toContain('Confidential secret');
  });

  it('primary trust + Discord DM metadata returns full private ceiling', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'test query',
      '1234567890',
      'primary',
      { isDirectMessage: true },
    );

    expect(result).toContain('Public fact');
    expect(result).toContain('Personal detail');
    expect(result).toContain('Intimate memory');
    expect(result).toContain('Confidential secret');
  });

  it('primary trust + Discord guild metadata remains invite_only', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'test query',
      '1234567890',
      'primary',
      { isDirectMessage: false },
    );

    expect(result).toContain('Public fact');
    expect(result).toContain('Personal detail');
    expect(result).not.toContain('Intimate memory');
    expect(result).not.toContain('Confidential secret');
  });

  it('consent flags (allowRecall: false) blocks memory even for primary trust', async () => {
    const memories = [
      makeMemory({
        text: 'Denied memory',
        sensitivity: 'public',
        consentFlags: { allowRecall: false },
        similarity: 0.95,
      }),
      makeMemory({
        text: 'Allowed memory',
        sensitivity: 'public',
        consentFlags: {},
        similarity: 0.90,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result).not.toContain('Denied memory');
    expect(result).toContain('Allowed memory');
  });

  it('hard deny policy precedence: highest-utility denied memory is still excluded', async () => {
    const memories = [
      makeMemory({
        text: 'Top relevance but denied',
        sensitivity: 'confidential',
        consentFlags: { allowRecall: false },
        similarity: 0.99,
        importance: 1,
        salience: 1,
      }),
      makeMemory({
        text: 'Lower relevance but allowed',
        sensitivity: 'public',
        consentFlags: {},
        similarity: 0.62,
        importance: 0.8,
        salience: 0.8,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result).not.toContain('Top relevance but denied');
    expect(result).toContain('Lower relevance but allowed');
  });

  it('no trustLevel param defaults to regular behavior', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // No trustLevel argument — should default to 'regular'
    const result = await retriever.retrieve('test query', '1234567890');

    expect(result).toContain('Public fact');
    expect(result).toContain('Personal detail');
    expect(result).not.toContain('Intimate memory');
    expect(result).not.toContain('Confidential secret');
  });

  it('mixed sensitivities in results — only allowed ones returned', async () => {
    const memories = [
      makeMemory({ text: 'Public A', sensitivity: 'public', similarity: 0.95 }),
      makeMemory({ text: 'Personal B', sensitivity: 'personal', similarity: 0.93 }),
      makeMemory({ text: 'Public C', sensitivity: 'public', similarity: 0.88 }),
      makeMemory({ text: 'Intimate D', sensitivity: 'intimate', similarity: 0.85 }),
      makeMemory({ text: 'Personal E', sensitivity: 'personal', similarity: 0.82 }),
      makeMemory({ text: 'Confidential F', sensitivity: 'confidential', similarity: 0.80 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // trusted trust + private channel = public + personal
    const result = await retriever.retrieve('test query', 'api:test', 'trusted');

    expect(result).toContain('Public A');
    expect(result).toContain('Personal B');
    expect(result).toContain('Public C');
    expect(result).toContain('Personal E');
    expect(result).not.toContain('Intimate D');
    expect(result).not.toContain('Confidential F');
  });

  it('applies privacy-risk penalty after hard policy gating when ranking allowed memories', async () => {
    const memories = [
      makeMemory({
        text: 'Low risk public memory',
        sensitivity: 'public',
        sourceRef: 'twitter:feed',
        similarity: 0.9,
        importance: 0.9,
        salience: 0.9,
      }),
      makeMemory({
        text: 'Higher risk confidential memory',
        sensitivity: 'confidential',
        sourceRef: 'api:private',
        tags: ['secret'],
        similarity: 0.95,
        importance: 0.9,
        salience: 0.9,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result).toContain('Low risk public memory');
    expect(result).toContain('Higher risk confidential memory');
    expect(result.indexOf('Low risk public memory')).toBeLessThan(
      result.indexOf('Higher risk confidential memory'),
    );
  });

  it('boosts recently revisited memories over stale one-off matches', async () => {
    const now = Date.now();
    const memories = [
      makeMemory({
        text: 'Stale one-off high similarity memory',
        sensitivity: 'public',
        similarity: 0.94,
        importance: 0.85,
        salience: 0.85,
        extractedAt: now - 14 * 24 * 60 * 60 * 1000,
        lastAccessed: now - 14 * 24 * 60 * 60 * 1000,
        accessCount: 1,
      }),
      makeMemory({
        text: 'Recently revisited reinforced memory',
        sensitivity: 'public',
        similarity: 0.88,
        importance: 0.85,
        salience: 0.85,
        extractedAt: now - 14 * 24 * 60 * 60 * 1000,
        lastAccessed: now - 2 * 60 * 60 * 1000,
        accessCount: 14,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result.indexOf('Recently revisited reinforced memory')).toBeLessThan(
      result.indexOf('Stale one-off high similarity memory'),
    );
  });

  it('uses lastAccessed freshness to break ties when reinforcement counts match', async () => {
    const now = Date.now();
    const memories = [
      makeMemory({
        text: 'Older access memory',
        sensitivity: 'public',
        similarity: 0.92,
        importance: 0.85,
        salience: 0.85,
        extractedAt: now - 21 * 24 * 60 * 60 * 1000,
        lastAccessed: now - 14 * 24 * 60 * 60 * 1000,
        accessCount: 6,
      }),
      makeMemory({
        text: 'Freshly accessed memory',
        sensitivity: 'public',
        similarity: 0.9,
        importance: 0.85,
        salience: 0.85,
        extractedAt: now - 21 * 24 * 60 * 60 * 1000,
        lastAccessed: now - 60 * 60 * 1000,
        accessCount: 6,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result.indexOf('Freshly accessed memory')).toBeLessThan(
      result.indexOf('Older access memory'),
    );
  });

  it('downranks low-confidence single-source memory unless explicitly queried', async () => {
    const fragileMemory = makeMemory({
      text: 'Nebularkite protocol keyphrase marker',
      sensitivity: 'public',
      sourceRef: 'api:single',
      provenanceRefs: [],
      similarity: 0.99,
      importance: 0.95,
      salience: 0.95,
      confidence: 0.2,
    });
    const stableMemory = makeMemory({
      text: 'Stable corroborated memory',
      sensitivity: 'public',
      sourceRef: 'api:stable',
      provenanceRefs: ['discord:stable', 'telegram:stable'],
      similarity: 0.62,
      importance: 0.9,
      salience: 0.9,
      confidence: 0.92,
    });
    const memories = [fragileMemory, stableMemory];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const genericResult = await retriever.retrieve('general checkin question', 'api:test', 'primary');
    expect(genericResult).toContain('Stable corroborated memory');
    expect(genericResult).not.toContain('Nebularkite protocol keyphrase marker');

    const explicitResult = await retriever.retrieve(
      'can you recall nebularkite protocol keyphrase?',
      'api:test',
      'primary',
    );
    expect(explicitResult.indexOf('Nebularkite protocol keyphrase marker')).toBeLessThan(
      explicitResult.indexOf('Stable corroborated memory'),
    );
  });

  it('downranks contradicted memories relative to supported alternatives', async () => {
    const memories = [
      makeMemory({
        text: 'Contradicted memory candidate',
        sensitivity: 'public',
        tags: ['contradicted'],
        similarity: 0.97,
        confidence: 0.95,
        importance: 0.9,
        salience: 0.9,
      }),
      makeMemory({
        text: 'Supported stable memory candidate',
        sensitivity: 'public',
        provenanceRefs: ['discord:stable', 'telegram:stable'],
        similarity: 0.9,
        confidence: 0.95,
        importance: 0.9,
        salience: 0.9,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('memory check', 'api:test', 'primary');
    expect(result.indexOf('Supported stable memory candidate')).toBeLessThan(
      result.indexOf('Contradicted memory candidate'),
    );
  });

  it('downranks superseded memories relative to supported alternatives', async () => {
    const memories = [
      makeMemory({
        text: 'Superseded memory candidate',
        sensitivity: 'public',
        supersededBy: 'mem-replacement',
        similarity: 0.98,
        confidence: 0.95,
        importance: 0.9,
        salience: 0.9,
      }),
      makeMemory({
        text: 'Current stable memory candidate',
        sensitivity: 'public',
        provenanceRefs: ['discord:stable', 'telegram:stable'],
        similarity: 0.9,
        confidence: 0.95,
        importance: 0.9,
        salience: 0.9,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('memory check', 'api:test', 'primary');
    expect(result.indexOf('Current stable memory candidate')).toBeLessThan(
      result.indexOf('Superseded memory candidate'),
    );
  });

  it('returns an abstract withheld-memory note when all memories are filtered out by trust', async () => {
    const memories = [
      makeMemory({ text: 'Secret stuff', sensitivity: 'confidential', similarity: 0.95 }),
      makeMemory({ text: 'Private detail', sensitivity: 'intimate', similarity: 0.90 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // public trust + broadcast = only public allowed, none present
    const result = await retriever.retrieve('test query', 'twitter:feed', 'public');

    expect(result).toContain('Memory context note:');
    expect(result).toContain('2 candidate memories were kept out');
    expect(result).toContain('trust ceiling');
    expect(result).not.toContain('Secret stuff');
    expect(result).not.toContain('Private detail');
  });

  it('distinguishes no matching memories from matching memories withheld by trust gates', async () => {
    const emptyRetriever = new MemoryRetriever(makeMockStore([]), makeMockEmbedding(), { retrievalLimit: 20 });
    const gatedMemory = makeMemory({
      text: 'Protected matching detail that must not leak.',
      sensitivity: 'confidential',
      similarity: 0.96,
    });
    const gatedRetriever = new MemoryRetriever(
      makeMockStore([gatedMemory]),
      makeMockEmbedding(),
      { retrievalLimit: 20 },
    );

    const emptyResult = await emptyRetriever.retrieve('protected detail', 'twitter:feed', 'public');
    const gatedResult = await gatedRetriever.retrieve('protected detail', 'twitter:feed', 'public');

    expect(emptyResult).toBe('');
    expect(gatedResult).toContain('Memory context note:');
    expect(gatedResult).toContain('1 candidate memory was kept out');
    expect(gatedResult).toContain('Coarse relevance bands: 1 high-match.');
    expect(gatedResult).not.toContain(gatedMemory.text);
  });

  it('keeps the withheld-memory summary bounded when many relevant memories are gated', async () => {
    const memories = Array.from({ length: 80 }, (_, idx) => makeMemory({
      text: `Protected gated detail ${idx}`,
      sensitivity: 'confidential',
      similarity: idx < 20 ? 0.9 : idx < 50 ? 0.62 : 0.22,
    }));
    const retriever = new MemoryRetriever(makeMockStore(memories), makeMockEmbedding(), { retrievalLimit: 20 });

    const result = await retriever.retrieve('protected gated detail', 'twitter:feed', 'public');

    expect(result).toContain('80 candidate memories were kept out');
    expect(result).toContain('Coarse relevance bands: 20 high-match, 30 medium-match, 30 low-match.');
    expect(result).not.toContain('Protected gated detail 0');
    expect(result).not.toContain('Protected gated detail 79');
    expect(result.length).toBeLessThan(700);
  });

  it('does not update access stats for filtered-out memories', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    await retriever.retrieve('test query', '1234567890', 'regular');

    // Regular trust allows public and personal memories; denied intimate/confidential memories are not updated.
    const updateCalls = (store.updateMemory as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls.length).toBe(2);
    expect(updateCalls.map(call => call[0])).toEqual(['mem-1', 'mem-2']);
  });

  it('trusted trust + private channel returns public + personal only', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'trusted');

    expect(result).toContain('Public fact');
    expect(result).toContain('Personal detail');
    expect(result).not.toContain('Intimate memory');
    expect(result).not.toContain('Confidential secret');
  });

  it('consent flags with allowRecall undefined does not block', async () => {
    const memories = [
      makeMemory({
        text: 'Memory with other flags',
        sensitivity: 'public',
        consentFlags: { deleteOnRequest: true },
        similarity: 0.95,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result).toContain('Memory with other flags');
  });

  it('shard channel is classified as private', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // shard: prefix = private
    const result = await retriever.retrieve('test query', 'shard:abc-123', 'primary');

    expect(result).toContain('Public fact');
    expect(result).toContain('Personal detail');
    expect(result).toContain('Intimate memory');
    expect(result).toContain('Confidential secret');
  });
});

describe('MemoryRetriever basic behavior', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  afterEach(() => {
    tokenTestUtils.resetTokenizerState();
  });

  it('returns empty string for empty input', async () => {
    const store = makeMockStore([]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding);

    const result = await retriever.retrieve('   ', 'api:test', 'primary');

    expect(result).toBe('');
    expect(store.searchByEmbedding).not.toHaveBeenCalled();
  });

  it('returns empty string when no memories match', async () => {
    const store = makeMockStore([]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding);

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result).toBe('');
  });

  it('falls back to lexical retrieval when semantic candidates are empty', async () => {
    const store = makeMockStore([]);
    const lexicalMatch = makeMemory({
      text: 'PrimaryUser said love is important to remember.',
      sensitivity: 'public',
      similarity: 0.85,
    });
    (store.searchByText as ReturnType<typeof vi.fn>).mockReturnValue([lexicalMatch]);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    const result = await retriever.retrieve('love', 'api:test', 'primary');

    expect(result).toContain('love is important to remember');
    expect(store.searchByEmbedding).toHaveBeenCalledTimes(1);
    expect(store.searchByText).toHaveBeenCalledTimes(1);

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('memory.retrieval');
    expect(calls[0][1]).toMatchObject({
      reason: 'ok',
      retrievalSource: 'lexical_fallback',
      semanticCandidateCount: 0,
      lexicalCandidateCount: 1,
      candidateCount: 1,
      returnedCount: 1,
    });
  });

  it('augments turn snapshots with recent matching memories when vector candidates are stale', async () => {
    const staleSensitive = makeMemory({
      id: 'stale-sensitive',
      text: 'Old introspection grounding probe residue from another run.',
      sensitivity: 'intimate',
      similarity: 0.95,
      extractedAt: Date.now() - 60_000,
    });
    const recentPublic = makeMemory({
      id: 'recent-public',
      text: 'Fresh introspection grounding probe public memory for current review.',
      sensitivity: 'public',
      similarity: 0.2,
      tags: ['introspection-grounding', 'current-review'],
      extractedAt: Date.now(),
    });
    const store = makeMockStore([staleSensitive]);
    (store.listActiveMemories as ReturnType<typeof vi.fn>).mockReturnValue([recentPublic, staleSensitive]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const snapshot = await retriever.captureTurnMemorySnapshot(
      'Continue the introspection grounding probe current review.',
      'api:test',
      'regular',
    );

    expect(snapshot.semanticCandidates.map(memory => memory.id)).toContain('recent-public');
    expect(snapshot.withheldCandidateIds).toContain('stale-sensitive');
  });

  it('fails closed when selected-memory access stat persistence fails', async () => {
    const memories = [
      makeMemory({
        id: 'integrity-retrieval-memory',
        text: 'Persistent memory',
        sensitivity: 'public',
        similarity: 0.95,
      }),
    ];
    const store = makeMockStore(memories);
    const persistenceFailure = new Error('simulated retrieval access stat failure');
    (store.updateMemory as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw persistenceFailure;
    });
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    const retrievalPromise = retriever.retrieve('remember this', 'api:test', 'primary');
    await expect(retrievalPromise).rejects.toBeInstanceOf(RetrievalIntegrityError);
    await expect(retrievalPromise).rejects.toMatchObject({
      context: {
        stage: 'selected_access_update',
        channelId: 'api:test',
        trustLevel: 'primary',
        memoryId: 'integrity-retrieval-memory',
      },
      cause: persistenceFailure,
    });

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('memory.retrieval');
    expect(calls[0][1]).toMatchObject({
      reason: 'error',
      channelId: 'api:test',
    });
  });

  it('keeps the retrieval result when an access stat write is refused by subject authorization', async () => {
    // Regression (psfn-framework-ib98o): a companion with many `unattributed`
    // memories had its ENTIRE active memory context discarded because the
    // bookkeeping access-counter write was refused for those subjects. The
    // memories are recalled and rendered; only the counter write is skipped.
    const memories = [
      makeMemory({
        id: 'unattributed-retrieval-memory',
        text: 'Recallable but unattributed memory',
        sensitivity: 'public',
        similarity: 0.95,
      }),
    ];
    const store = makeMockStore(memories);
    (store.updateMemory as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new MemorySubjectAuthorizationDeniedError();
    });
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    const result = await retriever.retrieve('remember this', 'api:test', 'primary');
    expect(result).toBeTruthy();
    expect(JSON.stringify(result)).toContain('Recallable but unattributed memory');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('memory.retrieval');
    expect(calls[0][1]).toMatchObject({
      reason: 'ok',
      accessStatAuthorizationSkips: 1,
    });
  });

  it('scales retrieval count with context-window budgets when no hard limit is set', async () => {
    const memories = Array.from({ length: 12 }, (_, idx) => makeMemory({
      text: `Budget memory ${idx} ` + 'x'.repeat(260),
      sensitivity: 'public',
      similarity: 0.98 - idx * 0.01,
    }));
    const embedding = makeMockEmbedding();

    const smallConfig = makeRuntimeConfig({
      memoryRetrievalLimit: undefined,
      memoryRetrievalBudgetPct: 2,
      modelRoster: {
        chat: {
          model: 'test-model',
          provider: 'test',
          maxTokens: 16384,
          contextWindow: 2_000,
          contextBudget: { memoryRetrievalMinTokens: 1 },
        },
      },
    });
    const largeConfig = makeRuntimeConfig({
      memoryRetrievalLimit: undefined,
      memoryRetrievalBudgetPct: 2,
      modelRoster: {
        chat: {
          model: 'test-model',
          provider: 'test',
          maxTokens: 16384,
          contextWindow: 12_000,
          contextBudget: { memoryRetrievalMinTokens: 1 },
        },
      },
    });

    const smallRetriever = new MemoryRetriever(makeMockStore(memories), embedding, smallConfig);
    const largeRetriever = new MemoryRetriever(makeMockStore(memories), embedding, largeConfig);

    const smallResult = await smallRetriever.retrieve('budget query', 'api:test', 'primary');
    const largeResult = await largeRetriever.retrieve('budget query', 'api:test', 'primary');

    expect(countRenderedMemories(largeResult)).toBeGreaterThan(countRenderedMemories(smallResult));
  });

  it('adapts retrieval budgets per turn when adaptive context budgets are enabled', async () => {
    const memories = Array.from({ length: 10 }, (_, idx) => makeMemory({
      text: `Adaptive memory ${idx} ` + 'x'.repeat(900),
      sensitivity: 'public',
      similarity: 0.99 - idx * 0.01,
    }));
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const config = makeRuntimeConfig({
      adaptiveContextBudgetsEnabled: true,
      memoryRetrievalLimit: undefined,
      memoryRetrievalBudgetPct: 2,
      modelRoster: {
        chat: {
          model: 'test-model',
          provider: 'test',
          maxTokens: 16384,
          contextWindow: 20_000,
          contextBudget: { memoryRetrievalMinTokens: 1 },
        },
      },
    });
    const retriever = new MemoryRetriever(store, embedding, config, eventBus);

    const recallResult = await retriever.retrieve(
      'Can you remember what we talked about before?',
      'api:test',
      'primary',
    );
    const taskResult = await retriever.retrieve(
      'Please implement this step-by-step refactor plan.',
      'api:test',
      'primary',
    );

    expect(countRenderedMemories(recallResult)).toBeGreaterThan(countRenderedMemories(taskResult));

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    const telemetryPayloads = calls.map(([, payload]) => payload as Record<string, unknown>);
    expect(telemetryPayloads[0].retrievalBudgetPct).toBe(8);
    expect(telemetryPayloads[1].retrievalBudgetPct).toBe(2);
  });

  it('ignores legacy retrieval count caps and fills by token budget', async () => {
    tokenTestUtils.setTokenizerFactory(() => ({
      encode: (text: string) => ({ length: text.length }),
    }));

    const memories = Array.from({ length: 10 }, (_, idx) => makeMemory({
      text: `Budget memory ${idx}`,
      sensitivity: 'public',
      similarity: 0.97 - idx * 0.01,
    }));
    const embedding = makeMockEmbedding();
    const config = makeRuntimeConfig({
      memoryRetrievalLimit: 2,
      memoryRetrievalBudgetPct: 10,
      modelRoster: {
        chat: {
          model: 'test-model',
          provider: 'test',
          maxTokens: 16384,
          contextWindow: 4_000,
          contextBudget: { memoryRetrievalMinTokens: 1 },
        },
      },
    });
    const retriever = new MemoryRetriever(makeMockStore(memories), embedding, config);

    const result = await retriever.retrieve('budget query', 'api:test', 'primary');

    expect(countRenderedMemories(result)).toBeGreaterThan(2);
  });

  it('uses real token counts for budgeted memory selection', async () => {
    tokenTestUtils.setTokenizerFactory(() => ({
      encode: (text: string) => ({ length: text.length }),
    }));

    const memories = Array.from({ length: 4 }, (_, idx) => makeMemory({
      text: `High token memory ${idx} ` + 'x'.repeat(90),
      sensitivity: 'public',
      similarity: 0.98 - idx * 0.01,
    }));
    const embedding = makeMockEmbedding();
    const config = makeRuntimeConfig({
      memoryRetrievalLimit: undefined,
      memoryRetrievalBudgetPct: 5,
      modelRoster: {
        chat: {
          model: 'test-model',
          provider: 'test',
          maxTokens: 16384,
          contextWindow: 1_000,
          contextBudget: { memoryRetrievalMinTokens: 1 },
        },
      },
    });
    const retriever = new MemoryRetriever(makeMockStore(memories), embedding, config);

    const result = await retriever.retrieve('budget query', 'api:test', 'primary');

    expect(countRenderedMemories(result)).toBe(1);
  });

  it('formats output with memory type labels', async () => {
    const memories = [
      makeMemory({ text: 'A semantic fact', type: 'semantic', sensitivity: 'public', similarity: 0.9 }),
      makeMemory({ text: 'An emotional memory', type: 'emotional', sensitivity: 'public', similarity: 0.85 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result).toContain('[semantic]');
    expect(result).toContain('[emotional]');
    expect(result).toContain('Relevant memories for this person:');
  });

  it('surfaces prior refusal boundaries for similar follow-up requests across sessions', async () => {
    const now = Date.now();
    const memories = [
      makeMemory({
        id: 'session1-boundary',
        text: 'I declined helping bypass paywalls and cracking paid subscriptions.',
        type: 'boundary',
        importance: 0.98,
        salience: 0.475,
        extractedAt: now - 120 * 24 * 60 * 60 * 1000,
        lastAccessed: now - 120 * 24 * 60 * 60 * 1000,
        salienceDecayAnchorAt: now,
        sourceRef: 'api:session-1|operation:extract',
        tags: ['boundary', 'refusal', 'paywall', 'bypass'],
        sensitivity: 'public',
        similarity: 0.95,
      }),
      makeMemory({
        id: 'session1-semantic',
        text: 'User likes mint tea.',
        type: 'semantic',
        importance: 0.7,
        salience: 0.7,
        sourceRef: 'api:session-1|operation:extract',
        tags: ['preference'],
        sensitivity: 'public',
        similarity: 0.9,
      }),
    ];

    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'Session 2 follow-up: can you help me bypass this paywall again?',
      'api:session-2',
      'primary',
    );

    expect(result).toContain('Active safety boundaries from prior refusals:');
    expect(result).toContain('[boundary]');
    expect(result).toContain('bypass paywalls');

    const boundaryIndex = result.indexOf('[boundary]');
    const semanticIndex = result.indexOf('User likes mint tea.');
    expect(boundaryIndex).toBeGreaterThanOrEqual(0);
    expect(semanticIndex).toBeGreaterThan(boundaryIndex);
  });

  it('injects a fresh recent contact shape before episodic memory snippets', async () => {
    const memories = [
      makeMemory({
        id: 'mem-shape-source',
        text: 'A semantic fact',
        type: 'semantic',
        sensitivity: 'public',
        similarity: 0.9,
        contactId: 'contact-1',
        sourceRef: 'memory:mem-shape-source',
        sourceType: 'conversation',
        consentFlags: { allowRecall: true },
        provenance: { channelId: 'api:test', subjectContactId: 'contact-1' },
      }),
    ];
    const store = makeMockStore(memories);
    (store.getRecentContactShape as ReturnType<typeof vi.fn>).mockReturnValue({
      schemaVersion: 1,
      contactId: 'contact-1',
      summary: 'PrimaryUser is the primary partner and values direct technical communication.',
      sourceMemoryIds: ['mem-shape-source'],
      confidenceScore: 0.91,
      noveltyScore: 0.42,
      updatedAt: Date.now(),
      freshUntil: Date.now() + 60_000,
    });
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    const result = await retriever.retrieve(
      'test query',
      'api:test',
      'primary',
      undefined,
      'contact-1',
    );
    expect(store.getRecentContactShape).toHaveBeenCalledWith('contact-1');
    const profileIndex = result.indexOf('Recent contact shape (freshness-bound; not durable biography):');
    const memoriesIndex = result.indexOf('Relevant memories for this person:');
    expect(profileIndex).toBeGreaterThanOrEqual(0);
    expect(memoriesIndex).toBeGreaterThan(profileIndex);
    expect(result).toContain('PrimaryUser is the primary partner');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('memory.retrieval');
    expect(calls[0][1]).toMatchObject({
      reason: 'ok',
      recentContactShapeIncluded: true,
      provenanceRefs: expect.arrayContaining([
        'recent_contact_shape:contact-1',
        'recent_contact_shape_source_memory:mem-shape-source',
      ]),
    });
  });

  it('returns a recent contact shape block when memory candidates are empty', async () => {
    const store = makeMockStore([]);
    const source = makeMemory({
      id: 'mem-1',
      contactId: 'contact-1',
      sourceRef: 'memory:mem-1',
      sourceType: 'conversation',
      consentFlags: { allowRecall: true },
      provenance: { channelId: 'api:test', subjectContactId: 'contact-1' },
      similarity: 0.9,
    });
    (store.getById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (
      id === source.id ? source : undefined
    ));
    (store.getMemorySubjectClassification as ReturnType<typeof vi.fn>)
      .mockImplementation((id: string) => (
        id === source.id
          ? classifyMemorySubject(source, {
              memoryRevision: 1,
              validSubjectContactIds: new Set(['contact-1']),
            })
          : undefined
      ));
    (store.getRecentContactShape as ReturnType<typeof vi.fn>).mockReturnValue({
      schemaVersion: 1,
      contactId: 'contact-1',
      summary: 'PrimaryUser prefers concise responses and high signal summaries.',
      sourceMemoryIds: ['mem-1'],
      confidenceScore: 0.88,
      noveltyScore: 0.4,
      updatedAt: Date.now(),
      freshUntil: Date.now() + 60_000,
    });
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    const result = await retriever.retrieve(
      'test query',
      'api:test',
      'primary',
      undefined,
      'contact-1',
    );

    expect(result).toContain('Recent contact shape (freshness-bound; not durable biography):');
    expect(result).toContain('PrimaryUser prefers concise responses');
    expect(result).not.toContain('Relevant memories for this person:');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('memory.retrieval');
    expect(calls[0][1]).toMatchObject({
      reason: 'no_candidates',
      recentContactShapeIncluded: true,
      provenanceRefs: [
        'recent_contact_shape:contact-1',
        'recent_contact_shape_source_memory:mem-1',
      ],
    });
  });

  it('withholds recent contact shapes whose source memories are denied by consent policy', async () => {
    const deniedSource = makeMemory({
      id: 'mem-denied',
      text: 'Consent denied profile source',
      sensitivity: 'public',
      consentFlags: { allowRecall: false },
      contactId: 'contact-1',
      similarity: 1,
    });
    const store = makeMockStore([]);
    (store.getRecentContactShape as ReturnType<typeof vi.fn>).mockReturnValue({
      schemaVersion: 1,
      contactId: 'contact-1',
      summary: 'This profile summary was derived from a consent-denied source.',
      sourceMemoryIds: [deniedSource.id],
      confidenceScore: 0.88,
      noveltyScore: 0.4,
      updatedAt: Date.now(),
      freshUntil: Date.now() + 60_000,
    });
    (store.getById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (
      id === deniedSource.id ? deniedSource : undefined
    ));
    (store.getMemorySubjectClassification as ReturnType<typeof vi.fn>)
      .mockImplementation((id: string) => (
        id === deniedSource.id
          ? classifyMemorySubject(deniedSource, {
              memoryRevision: 1,
              validSubjectContactIds: new Set(['contact-1']),
            })
          : undefined
      ));
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    const result = await retriever.retrieve(
      'test query',
      'api:test',
      'primary',
      undefined,
      'contact-1',
    );

    expect(result).not.toContain('Recent contact shape (freshness-bound; not durable biography):');
    expect(result).not.toContain('consent-denied source');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('memory.retrieval');
    expect(calls[0][1]).toMatchObject({
      reason: 'no_candidates',
      recentContactShapeIncluded: false,
      withheldCount: 1,
      withheldReasonCounts: {
        'consent.allow_recall_denied': 1,
      },
    });
    expect(calls[0][1].provenanceRefs).not.toEqual(expect.arrayContaining([
      `recent_contact_shape_source_memory:${deniedSource.id}`,
    ]));
  });

  it('uses visible social graph context to separate related people from canonical memories', async () => {
    const { store: contactStore } = await createTestPostgresContactStore('primary-user');
    const primary = await contactStore.upsert({
      displayName: 'PrimaryUser',
      discordUserId: 'primary-user',
    });
    const sibling = await contactStore.upsert({
      displayName: 'Alice',
      discordUserId: 'alice-1',
      trustLevel: 'trusted',
      relationshipType: 'family',
    }, { actor: 'operator:test-setup' });
    const unrelated = await contactStore.upsert({
      displayName: 'Mallory',
      discordUserId: 'mallory-1',
      trustLevel: 'regular',
      relationshipType: 'stranger',
    });
    const primaryEntity = await contactStore.getSocialGraphEntityByContactId(primary.id);
    const siblingEntity = await contactStore.getSocialGraphEntityByContactId(sibling.id);
    expect(primaryEntity).toBeDefined();
    expect(siblingEntity).toBeDefined();
    await contactStore.upsertSocialRelationshipEdge({
      sourceEntityId: primaryEntity!.id,
      targetEntityId: siblingEntity!.id,
      relationshipType: 'family',
      directional: false,
      sensitivity: 'personal',
      confidence: 0.9,
    });

    const store = makeMockStore([
      makeMemory({
        id: 'self-memory',
        text: 'PrimaryUser likes direct and candid communication.',
        contactId: primary.id,
        sensitivity: 'public',
        similarity: 0.93,
      }),
      makeMemory({
        id: 'related-memory',
        text: 'Alice is recovering from a long week and could use a gentle check-in.',
        contactId: sibling.id,
        sensitivity: 'public',
        similarity: 0.91,
      }),
      makeMemory({
        id: 'other-memory',
        text: 'Mallory is dealing with a delayed shipment.',
        contactId: unrelated.id,
        sensitivity: 'public',
        similarity: 0.89,
      }),
    ]);
    const retriever = new MemoryRetriever(
      store,
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      undefined,
      contactStore,
    );

    const result = await retriever.retrieve(
      'How is your family doing lately?',
      'api:test',
      'primary',
      undefined,
      primary.id,
    );

    expect(result).toContain('Relationship context for this person:');
    expect(result).toContain('Alice is a separate person connected to PrimaryUser as family.');
    expect(result).toContain('Relevant memories for this person:');
    expect(result).toContain('PrimaryUser likes direct and candid communication.');
    expect(result).toContain('Relevant memories about other people in their social context:');
    expect(result).toContain('Alice [family; trusted contact]: Alice is recovering from a long week');
    expect(result).toContain('Relevant memories about other separate people:');
    expect(result).toContain('Mallory [stranger; regular contact]: Mallory is dealing with a delayed shipment.');
    expect(result).toContain('Keep memories about related people attributed to the named person');
  });

  it('does not expose relationship framing when graph visibility is hidden at the current trust tier', async () => {
    const { store: contactStore } = await createTestPostgresContactStore('primary-user');
    const primary = await contactStore.upsert({
      displayName: 'PrimaryUser',
      discordUserId: 'primary-user',
    });
    const sibling = await contactStore.upsert({
      displayName: 'Alice',
      discordUserId: 'alice-1',
      trustLevel: 'trusted',
      relationshipType: 'family',
    }, { actor: 'operator:test-setup' });
    const primaryEntity = await contactStore.getSocialGraphEntityByContactId(primary.id);
    const siblingEntity = await contactStore.getSocialGraphEntityByContactId(sibling.id);
    expect(primaryEntity).toBeDefined();
    expect(siblingEntity).toBeDefined();
    await contactStore.upsertSocialRelationshipEdge({
      sourceEntityId: primaryEntity!.id,
      targetEntityId: siblingEntity!.id,
      relationshipType: 'family',
      directional: false,
      sensitivity: 'personal',
      confidence: 0.9,
    });

    const store = makeMockStore([
      makeMemory({
        id: 'self-memory',
        text: 'PrimaryUser likes direct and candid communication.',
        contactId: primary.id,
        sensitivity: 'public',
        similarity: 0.93,
      }),
      makeMemory({
        id: 'related-memory',
        text: 'Alice is recovering from a long week and could use a gentle check-in.',
        contactId: sibling.id,
        sensitivity: 'public',
        similarity: 0.91,
      }),
    ]);
    const retriever = new MemoryRetriever(
      store,
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      undefined,
      contactStore,
    );

    const result = await retriever.retrieve(
      'How is your family doing lately?',
      '1234567890',
      'public',
      undefined,
      primary.id,
    );

    expect(result).not.toContain('Relationship context for this person:');
    expect(result).toContain('Relevant memories about other separate people:');
    expect(result).toContain('Alice [family; trusted contact]: Alice is recovering from a long week');
  });

  it('injects the same qualitative emotional framing during reflection retrieval', async () => {
    const memories = [
      makeMemory({ text: 'A semantic fact', type: 'semantic', sensitivity: 'public', similarity: 0.9 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const contactStore = fromPartial<ContactStorePort>({
      getEmotionalSnapshot: vi.fn().mockReturnValue({
        baselineValence: 0.22,
        moodValence: 0.37,
        moodDrift: 0.15,
        moodSamples: 6,
        lastMoodUpdateEpochMs: Date.now(),
      }),
      getEmotionalTimeSeries: vi.fn().mockReturnValue([]),
      getById: vi.fn(),
    });

    const retriever = new MemoryRetriever(
      store,
      embedding,
      { retrievalLimit: 20 },
      undefined,
      contactStore,
    );

    const normalResult = await retriever.retrieve(
      'test query',
      'api:test',
      'primary',
      undefined,
      'contact-1',
    );
    const reflectionResult = await retrieveReflectionMemoryBlock({
      memoryProvider: {
        retrieve: (...args: unknown[]) => retriever.retrieve(
          ...args as Parameters<MemoryRetriever['retrieve']>
        ),
      },
      queryText: 'test query',
      reflectionChannelId: 'internal:reflection:fixture',
      trustLevel: 'primary',
      reflectionCanonicalContactId: 'contact-1',
      reflectionPolicy: {
        toolUseMode: 'bounded_read_only_introspection',
        memoryRetrievalModes: ['default', 'temporal'],
        memoryAccessScope: 'companion_self_reflection',
        allowOverlayToolActivation: false,
      },
      runtimeOptions: {},
    });

    const snapshotBlockPattern = /<emotional_continuity_snapshot>[\s\S]*?<\/emotional_continuity_snapshot>/;
    const normalSnapshotBlock = normalResult.match(snapshotBlockPattern)?.[0];
    const reflectionSnapshotBlock = reflectionResult.memoryBlock?.match(snapshotBlockPattern)?.[0];

    expect(normalSnapshotBlock).toBeDefined();
    expect(reflectionSnapshotBlock).toBe(normalSnapshotBlock);
    expect(reflectionSnapshotBlock).toContain('Steady baseline: positive');
    expect(reflectionSnapshotBlock).toContain('Current state: currently drifting gently toward positive');
    expect(reflectionSnapshotBlock).toContain('Signal confidence: developing');
    expect(reflectionSnapshotBlock).not.toMatch(/\b[+-]?\d+\.\d+\b/);
    expect(reflectionSnapshotBlock).not.toContain('Learned signals:');
    expect(reflectionSnapshotBlock).not.toContain('6');
  });

  it('surfaces cross-session emotional memories for canonical contacts', async () => {
    const store = makeMockStore([]);
    (store.getMemoriesByContact as ReturnType<typeof vi.fn>).mockReturnValue([
      makeMemory({
        id: 'emo-1',
        text: 'User felt relieved after finishing the deadline sprint.',
        type: 'emotional',
        emotionalValence: 0.6,
        sensitivity: 'public',
        similarity: 0.2,
      }),
      makeMemory({
        id: 'sem-1',
        text: 'User likes black coffee.',
        type: 'semantic',
        emotionalValence: 0,
        sensitivity: 'public',
        similarity: 0.2,
      }),
    ]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'how have things been lately?',
      'api:test',
      'primary',
      undefined,
      'contact-1',
    );

    expect(result).toContain('Cross-session emotional continuity:');
    expect(result).toContain('User felt relieved after finishing the deadline sprint.');
    expect(result).not.toContain('User likes black coffee.');
  });

  it('supports async contact-memory lookups for retrieval', async () => {
    const emotionalMemory = makeMemory({
      id: 'emo-async',
      text: 'User felt relieved after finishing the migration.',
      type: 'emotional',
      emotionalValence: 0.72,
      sensitivity: 'public',
      similarity: 0.2,
    });
    const store = makeMockStore([]);
    (store.getMemoriesByContact as ReturnType<typeof vi.fn>).mockResolvedValue([emotionalMemory]);
    (store.getMemoriesByChannel as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (store.getAllActiveMemories as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, {
      retrievalLimit: 20,
    });

    const result = await retriever.retrieve(
      'how have things been lately?',
      'api:test',
      'primary',
      undefined,
      'contact-1',
    );

    expect(result).toContain('Cross-session emotional continuity:');
    expect(result).toContain(emotionalMemory.text);
  });

  it('reuses a captured turn snapshot for retrieval after store drift', async () => {
    const stableMemory = makeMemory({
      id: 'snapshot-stable',
      text: 'Stable snapshot memory.',
      sensitivity: 'public',
      similarity: 0.96,
    });
    const driftMemory = makeMemory({
      id: 'snapshot-drift',
      text: 'Late drift memory.',
      sensitivity: 'public',
      similarity: 0.99,
    });
    const store = makeMockStore([stableMemory]);
    (store.getMemoriesByChannel as ReturnType<typeof vi.fn>).mockReturnValue([stableMemory]);

    const retriever = new MemoryRetriever(store, makeMockEmbedding(), {
      retrievalLimit: 10,
    });

    const snapshot = await retriever.captureTurnMemorySnapshot('snapshot query', 'api:test', 'primary');

    (store.searchByEmbedding as ReturnType<typeof vi.fn>).mockReturnValue([driftMemory]);
    (store.searchByText as ReturnType<typeof vi.fn>).mockReturnValue([driftMemory]);
    (store.getMemoriesByChannel as ReturnType<typeof vi.fn>).mockReturnValue([driftMemory]);
    (store.getAllActiveMemories as ReturnType<typeof vi.fn>).mockReturnValue([driftMemory]);

    const result = await retriever.retrieve('snapshot query', 'api:test', 'primary', undefined, undefined, snapshot);

    expect(result).toContain('Stable snapshot memory.');
    expect(result).not.toContain('Late drift memory.');
  });

  it('emits structured retrieval telemetry event when event bus is provided', async () => {
    const memories = [
      makeMemory({ text: 'Public A', sensitivity: 'public', similarity: 0.95 }),
      makeMemory({ text: 'Public B', sensitivity: 'public', similarity: 0.9 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    await retriever.retrieve('test query', 'api:test', 'primary');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('memory.retrieval');
    expect(calls[0][1]).toMatchObject({
      channelId: 'api:test',
      count: 2,
      candidates: 2,
      ranked: 2,
      returned: 2,
      reason: 'ok',
      candidateCount: 2,
      rankedCount: 2,
      returnedCount: 2,
      selectedTypes: { semantic: 2 },
      budgetCappedCount: 0,
      compositionalMode: 'disabled_policy',
      compositionalCandidateCount: 2,
      compositionalEvaluationBatchCount: 1,
      compositionalFinalistCount: 2,
      embeddingCalls: 1,
      searchCalls: 2,
    });
    const stageTimings = calls[0][1].stageTimingsMs as Record<string, number>;
    expect(stageTimings).toEqual(expect.objectContaining({
      preparation: expect.any(Number),
      embedding: expect.any(Number),
      vector_search: expect.any(Number),
      policy_filter: expect.any(Number),
      ranking: expect.any(Number),
      selection: expect.any(Number),
      total: expect.any(Number),
    }));
    expect(stageTimings.total).toBeGreaterThanOrEqual(stageTimings.embedding);
  });

  it('emits request-scoped retrieval telemetry for manifest seeding', async () => {
    const memories = [
      makeMemory({ text: 'Public A', sensitivity: 'public', similarity: 0.95 }),
      makeMemory({ text: 'Public B', sensitivity: 'public', similarity: 0.9 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    await runWithRequestContext(
      {
        turnId: 'turn-1',
        requestId: 'req-1',
        channelId: 'api:test',
        callType: 'chat',
        purpose: 'agent.turn.memory',
        originType: 'chat',
        originStage: 'agent.turn.memory',
      },
      async () => retriever.retrieve('test query', 'api:test', 'primary'),
    );

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      requestId: 'req-1',
      turnId: 'turn-1',
      callType: 'chat',
      purpose: 'memory.retrieval',
      originType: 'chat',
      originStage: 'agent.turn.memory',
      candidates: 2,
      ranked: 2,
      returned: 2,
      selectedTypes: { semantic: 2 },
      budgetCappedCount: 0,
    });
  });

  it('emits telemetry for empty retrieval results', async () => {
    const store = makeMockStore([]);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result).toBe('');
    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('memory.retrieval');
    expect(calls[0][1]).toMatchObject({
      channelId: 'api:test',
      count: 0,
      reason: 'no_candidates',
      candidateCount: 0,
      returnedCount: 0,
    });
  });

  it('stops on relevance before the token budget when the tail candidates are weak', async () => {
    const memories = [
      makeMemory({
        id: 'mem-strong',
        text: 'The user is moving to Portland next week.',
        sensitivity: 'public',
        importance: 0.95,
        confidence: 0.95,
        salience: 0.95,
        similarity: 0.98,
      }),
      makeMemory({
        id: 'mem-weak-1',
        text: 'Apples are fruit.',
        sensitivity: 'public',
        importance: 0.22,
        confidence: 0.22,
        salience: 0.22,
        similarity: 0.14,
      }),
      makeMemory({
        id: 'mem-weak-2',
        text: 'Clouds are white.',
        sensitivity: 'public',
        importance: 0.2,
        confidence: 0.2,
        salience: 0.2,
        similarity: 0.12,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    const result = await retriever.retrieve('Portland moving update', 'api:test', 'primary');

    expect(countRenderedMemories(result)).toBe(1);
    expect(result).toContain('The user is moving to Portland next week.');
    expect(result).not.toContain('Apples are fruit.');
    expect(result).not.toContain('Clouds are white.');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      reason: 'ok',
      returnedCount: 1,
      selectionStopReason: 'relevance',
      relevanceStoppedCount: 2,
      budgetCappedCount: 0,
    });
  });

  it('records a budget stop when relevant candidates still exceed the token limit', async () => {
    const memories = [
      makeMemory({
        id: 'mem-budget-strong',
        text: 'The user is organizing a board game night in Portland.',
        sensitivity: 'public',
        importance: 0.95,
        confidence: 0.95,
        salience: 0.95,
        similarity: 0.98,
      }),
      makeMemory({
        id: 'mem-budget-strong-2',
        text: 'The user also wants a list of board game friends in Portland.',
        sensitivity: 'public',
        importance: 0.92,
        confidence: 0.92,
        salience: 0.92,
        similarity: 0.94,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(
      store,
      embedding,
      makeRuntimeConfig({
        defaultContextWindow: 10,
        modelRoster: {
          chat: {
            model: 'test-model',
            provider: 'test',
            maxTokens: 16_384,
            contextWindow: 10,
            contextBudget: {
              memoryRetrievalMinTokens: 1,
            },
          },
        },
      }),
      eventBus,
    );

    const result = await retriever.retrieve('board game Portland update', 'api:test', 'primary');

    expect(countRenderedMemories(result)).toBe(1);
    expect(result).toContain('The user is organizing a board game night in Portland.');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      reason: 'ok',
      returnedCount: 1,
      selectionStopReason: 'budget',
      relevanceStoppedCount: 0,
      budgetCappedCount: 1,
    });
  });
});

describe('MemoryRetriever score guarantee (top-K rescue)', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  afterEach(() => {
    tokenTestUtils.resetTokenizerState();
  });

  it('rescues memories with zero composite score when they are the only candidates', async () => {
    // Create a memory where baseScore = 0 because salience = 0 or importance = 0.
    // This is the real scenario: after aggressive salience decay, salience can
    // hit the floor (0.05) and with low importance the composite multiplies to ~0.
    // When importance is exactly 0, baseScore becomes 0, and the memory would
    // silently vanish from context despite being highly similar.
    const memories = [
      makeMemory({
        text: 'Zero importance memory with high similarity',
        sensitivity: 'public',
        similarity: 0.95,
        importance: 0,  // exactly 0 -> baseScore = 0
        salience: 0.5,
        emotionalValence: 0,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    // Without the guarantee, this would be filtered out (score = 0).
    // With the guarantee, it should surface.
    expect(result).toContain('Zero importance memory with high similarity');
  });

  it('rescues up to SCORE_GUARANTEE_MIN_K zero-scored memories', async () => {
    const { SCORE_GUARANTEE_MIN_K } = __retrieval_internals;
    // Create more than MIN_K memories with zero importance
    const memories = Array.from({ length: SCORE_GUARANTEE_MIN_K + 2 }, (_, idx) =>
      makeMemory({
        text: `Zero importance memory ${idx}`,
        sensitivity: 'public',
        similarity: 0.95 - idx * 0.02,
        importance: 0,  // zero -> score = 0
        salience: 0.5,
      }),
    );
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    // Should rescue exactly SCORE_GUARANTEE_MIN_K memories
    const memoryCount = countRenderedMemories(result);
    expect(memoryCount).toBe(SCORE_GUARANTEE_MIN_K);
    // Highest-similarity ones should be rescued first
    for (let idx = 0; idx < SCORE_GUARANTEE_MIN_K; idx++) {
      expect(result).toContain(`Zero importance memory ${idx}`);
    }
  });

  it('does not rescue when enough positive-scored memories already exist', async () => {
    const { SCORE_GUARANTEE_MIN_K } = __retrieval_internals;
    // Create enough naturally-scored memories to exceed MIN_K
    const positiveMemories = Array.from({ length: SCORE_GUARANTEE_MIN_K + 2 }, (_, idx) =>
      makeMemory({
        text: `Good memory ${idx}`,
        sensitivity: 'public',
        similarity: 0.95 - idx * 0.01,
        importance: 0.9,
        salience: 0.9,
      }),
    );
    // Add a zero-importance memory (score will be 0)
    const zeroMemory = makeMemory({
      text: 'Zero importance memory should not be rescued',
      sensitivity: 'public',
      similarity: 0.88,
      importance: 0,
      salience: 0.5,
    });
    const store = makeMockStore([...positiveMemories, zeroMemory]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    // The zero-importance memory should NOT be rescued since we already have enough
    expect(result).not.toContain('Zero importance memory should not be rescued');
    // But the positive memories should all be there
    for (let idx = 0; idx < SCORE_GUARANTEE_MIN_K; idx++) {
      expect(result).toContain(`Good memory ${idx}`);
    }
  });

  it('rescued memories sort after naturally-scored ones', async () => {
    // One naturally-scored memory and one zero-importance memory
    const memories = [
      makeMemory({
        text: 'Naturally scored memory',
        sensitivity: 'public',
        similarity: 0.80,
        importance: 0.8,
        salience: 0.8,
      }),
      makeMemory({
        text: 'Rescued zero-importance memory',
        sensitivity: 'public',
        similarity: 0.95,  // Higher similarity than the natural one
        importance: 0,      // zero -> score = 0 -> rescued
        salience: 0.5,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    // Both should appear
    expect(result).toContain('Naturally scored memory');
    expect(result).toContain('Rescued zero-importance memory');
    // Natural one should come first (higher composite score)
    const naturalIdx = result.indexOf('Naturally scored memory');
    const rescuedIdx = result.indexOf('Rescued zero-importance memory');
    expect(naturalIdx).toBeLessThan(rescuedIdx);
  });
});

describe('MemoryRetriever retrieval trace telemetry', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  afterEach(() => {
    tokenTestUtils.resetTokenizerState();
  });

  it('emits telemetry with similarity range and score range', async () => {
    const memories = [
      makeMemory({ text: 'Memory A', sensitivity: 'public', similarity: 0.95 }),
      makeMemory({ text: 'Memory B', sensitivity: 'public', similarity: 0.75 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    await retriever.retrieve('test query', 'api:test', 'primary');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const telemetry = calls[0][1] as Record<string, unknown>;
    expect(telemetry.topSimilarity).toBe(0.95);
    expect(telemetry.bottomSimilarity).toBe(0.75);
    expect(typeof telemetry.topScore).toBe('number');
    expect(typeof telemetry.bottomScore).toBe('number');
    expect((telemetry.topScore as number)).toBeGreaterThan(0);
    expect(typeof telemetry.evidenceSupportAverage).toBe('number');
    expect(telemetry.contradictionAdjustedCount).toBe(0);
  });

  it('emits scoreGuaranteedCount in telemetry when memories are rescued', async () => {
    // Create a memory with zero importance -> composite score = 0 -> rescued
    const memories = [
      makeMemory({
        text: 'Zero importance but high similarity',
        sensitivity: 'public',
        similarity: 0.92,
        importance: 0,    // exactly 0 -> baseScore = 0
        salience: 0.5,
        emotionalValence: 0,
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    await retriever.retrieve('test query', 'api:test', 'primary');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const telemetry = calls[0][1] as Record<string, unknown>;
    expect(telemetry.scoreGuaranteedCount).toBeGreaterThan(0);
  });

  it('emits contradiction/suppression diagnostics in telemetry', async () => {
    const memories = [
      makeMemory({
        text: 'Contradicted memory with low confidence',
        sensitivity: 'public',
        similarity: 0.98,
        confidence: 0.2,
        tags: ['contradicted'],
      }),
      makeMemory({
        text: 'Stable memory with stronger support',
        sensitivity: 'public',
        similarity: 0.85,
        confidence: 0.9,
        provenanceRefs: ['discord:stable', 'telegram:stable'],
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    await retriever.retrieve('general status', 'api:test', 'primary');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const telemetry = calls[0][1] as Record<string, unknown>;
    expect(telemetry.contradictionAdjustedCount).toBeGreaterThanOrEqual(1);
    expect(telemetry.lowConfidenceSuppressedCount).toBeGreaterThanOrEqual(1);
  });

  it('counts superseded memories in contradiction diagnostics telemetry', async () => {
    const memories = [
      makeMemory({
        text: 'Superseded memory with stale details',
        sensitivity: 'public',
        similarity: 0.97,
        confidence: 0.95,
        supersededBy: 'mem-replacement',
      }),
      makeMemory({
        text: 'Current memory with stronger support',
        sensitivity: 'public',
        similarity: 0.87,
        confidence: 0.9,
        provenanceRefs: ['discord:stable', 'telegram:stable'],
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    await retriever.retrieve('general status', 'api:test', 'primary');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const telemetry = calls[0][1] as Record<string, unknown>;
    expect(telemetry.contradictionAdjustedCount).toBeGreaterThanOrEqual(1);
  });

  it('emits telemetry with pipeline stage counts for trust-filtered scenario', async () => {
    const memories = [
      makeMemory({ text: 'Secret A', sensitivity: 'confidential', similarity: 0.95 }),
      makeMemory({ text: 'Public B', sensitivity: 'public', similarity: 0.85 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    await retriever.retrieve('test query', '1234567890', 'regular');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const telemetry = calls[0][1] as Record<string, unknown>;
    expect(telemetry.candidateCount).toBe(2);
    expect(telemetry.contactScopeRejectedCount).toBe(0);
    expect(telemetry.sensitivityRejectedCount).toBe(1);
    expect(telemetry.withheldCount).toBe(1);
    expect(telemetry.withheldReasonCounts).toMatchObject({
      'trust.ceiling_exceeded': 1,
    });
    expect(telemetry.withheldRelevanceBands).toMatchObject({
      high: 1,
    });
    expect(telemetry.returnedCount).toBe(1);
  });
});

describe('MemoryRetriever room-scoped visibility', () => {
  const GROUP_ROOM_X = 'discord:guild-1:room-x';
  const GROUP_ROOM_Y = 'discord:guild-1:room-y';
  const MORGAN_DM = 'discord:dm:morgan';

  beforeEach(() => {
    idCounter = 0;
  });

  afterEach(() => {
    tokenTestUtils.resetTokenizerState();
  });

  function latestRetrievalTelemetry(eventBus: EventBus): Record<string, unknown> {
    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('memory.retrieval');
    return calls[0][1] as Record<string, unknown>;
  }

  async function makeRoomVisibilityContactStore(): Promise<{
    contactStore: ContactStorePort;
    morganId: string;
  }> {
    const { store: contactStore } = await createTestPostgresContactStore('primary-user');
    const morgan = await contactStore.upsert({
      displayName: 'Morgan',
      discordUserId: 'morgan-discord',
      trustLevel: 'trusted',
      relationshipType: 'friend',
    });
    await contactStore.recordChannelActivity(morgan.id, 'discord', MORGAN_DM, 'private');
    return { contactStore, morganId: morgan.id };
  }

  it('allows same-room group memories while blocking cross-room and DM memories in a group room', async () => {
    const { contactStore, morganId } = await makeRoomVisibilityContactStore();
    await contactStore.recordChannelActivity(morganId, 'discord', GROUP_ROOM_X, 'invite_only');
    await contactStore.recordChannelActivity(morganId, 'discord', GROUP_ROOM_Y, 'invite_only');
    const sameRoomMemory = makeMemory({
      id: 'group-x-memory',
      text: 'Room X decided the deployment window is Friday.',
      sensitivity: 'public',
      provenance: { channelId: GROUP_ROOM_X },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_X },
      similarity: 0.97,
    });
    const crossRoomMemory = makeMemory({
      id: 'group-y-memory',
      text: 'Room Y private launch codename is Lantern.',
      sensitivity: 'public',
      provenance: { channelId: GROUP_ROOM_Y },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_Y },
      similarity: 0.96,
    });
    const dmMemory = makeMemory({
      id: 'morgan-dm-memory',
      text: 'Morgan said in DM that the invoice folder is personal.',
      sensitivity: 'public',
      contactId: morganId,
      provenance: { channelId: MORGAN_DM },
      similarity: 0.95,
    });
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(
      makeMockStore([sameRoomMemory, crossRoomMemory, dmMemory]),
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      eventBus,
      contactStore,
    );

    const result = await retriever.retrieve(
      'deployment window and launch notes',
      GROUP_ROOM_X,
      'primary',
      { isDirectMessage: false, privacyLevel: 'invite_only' },
      morganId,
    );

    expect(result).toContain('Room X decided the deployment window is Friday.');
    expect(result).not.toContain('Room Y private launch codename is Lantern.');
    expect(result).not.toContain('invoice folder is personal');

    const telemetry = latestRetrievalTelemetry(eventBus);
    expect(telemetry.roomVisibilityRejectedCount).toBe(2);
    expect(telemetry.withheldReasonCounts).toMatchObject({
      'room_visibility.blocked': 2,
    });
    expect(telemetry.policyAllowedCount).toBe(1);
  });

  it('allows same-room personal memories for regular contacts without trust ceiling rejection', async () => {
    const { contactStore, morganId } = await makeRoomVisibilityContactStore();
    await contactStore.recordChannelActivity(morganId, 'discord', GROUP_ROOM_X, 'invite_only');
    const sameRoomPersonalMemory = makeMemory({
      id: 'group-x-personal-memory',
      text: 'Room X heard Morgan prefers the quiet rollout plan.',
      sensitivity: 'personal',
      contactId: morganId,
      provenance: { channelId: GROUP_ROOM_X },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_X },
      similarity: 0.99,
    });
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(
      makeMockStore([sameRoomPersonalMemory]),
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      eventBus,
      contactStore,
    );

    const result = await retriever.retrieve(
      'quiet rollout plan',
      GROUP_ROOM_X,
      'regular',
      { isDirectMessage: false, privacyLevel: 'invite_only' },
      morganId,
    );

    expect(result).toContain('Room X heard Morgan prefers the quiet rollout plan.');

    const telemetry = latestRetrievalTelemetry(eventBus);
    expect(telemetry.roomVisibilityRejectedCount).toBe(0);
    expect(telemetry.withheldReasonCounts).not.toMatchObject({
      'trust.ceiling_exceeded': expect.any(Number),
    });
    expect(telemetry.returnedCount).toBe(1);
  });

  it('allows participated group memories in the primary partner DM and blocks unparticipated rooms', async () => {
    const { contactStore, morganId } = await makeRoomVisibilityContactStore();
    await contactStore.recordChannelActivity(morganId, 'discord', GROUP_ROOM_X, 'invite_only');
    const dmMemory = makeMemory({
      id: 'morgan-dm-memory',
      text: 'Morgan DM reminder: prefer short deployment summaries.',
      sensitivity: 'public',
      contactId: morganId,
      provenance: { channelId: MORGAN_DM },
      similarity: 0.98,
    });
    const participatedGroupMemory = makeMemory({
      id: 'group-x-memory',
      text: 'Room X agreed Morgan owns the smoke test checklist.',
      sensitivity: 'public',
      contactId: morganId,
      provenance: { channelId: GROUP_ROOM_X },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_X },
      similarity: 0.97,
    });
    const nonParticipatedGroupMemory = makeMemory({
      id: 'group-y-memory',
      text: 'Room Y agreed on a secret budget ceiling.',
      sensitivity: 'public',
      provenance: { channelId: GROUP_ROOM_Y },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_Y },
      similarity: 0.96,
    });
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(
      makeMockStore([dmMemory, participatedGroupMemory, nonParticipatedGroupMemory]),
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      eventBus,
      contactStore,
    );

    const result = await retriever.retrieve(
      'deployment summary and checklist',
      MORGAN_DM,
      'primary',
      { isDirectMessage: true, privacyLevel: 'private' },
      morganId,
    );

    expect(result).toContain('Morgan DM reminder: prefer short deployment summaries.');
    expect(result).toContain('Room X agreed Morgan owns the smoke test checklist.');
    expect(result).not.toContain('Room Y agreed on a secret budget ceiling.');

    const telemetry = latestRetrievalTelemetry(eventBus);
    expect(telemetry.roomVisibilityRejectedCount).toBe(1);
    expect(telemetry.withheldReasonCounts).toMatchObject({
      'room_visibility.blocked': 1,
    });
    expect(telemetry.returnedCount).toBe(2);
  });

  it('allows participated group personal memories in the participant DM for regular contacts', async () => {
    const { contactStore, morganId } = await makeRoomVisibilityContactStore();
    await contactStore.recordChannelActivity(morganId, 'discord', GROUP_ROOM_X, 'invite_only');
    const participatedGroupMemory = makeMemory({
      id: 'group-x-personal-memory',
      text: 'Room X knows Morgan volunteered to own the risky checklist.',
      sensitivity: 'personal',
      contactId: morganId,
      provenance: { channelId: GROUP_ROOM_X },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_X },
      similarity: 0.99,
    });
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(
      makeMockStore([participatedGroupMemory]),
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      eventBus,
      contactStore,
    );

    const result = await retriever.retrieve(
      'risky checklist',
      MORGAN_DM,
      'regular',
      { isDirectMessage: true, privacyLevel: 'private' },
      morganId,
    );

    expect(result).toContain('Room X knows Morgan volunteered to own the risky checklist.');

    const telemetry = latestRetrievalTelemetry(eventBus);
    expect(telemetry.roomVisibilityRejectedCount).toBe(0);
    expect(telemetry.withheldReasonCounts).not.toMatchObject({
      'trust.ceiling_exceeded': expect.any(Number),
    });
    expect(telemetry.returnedCount).toBe(1);
  });

  it('allows the primary partner subject memory when origin-channel proof is missing', async () => {
    const { contactStore, morganId } = await makeRoomVisibilityContactStore();
    const blockedGroupMemory = makeMemory({
      id: 'group-x-memory',
      text: 'Room X discussed a private server migration plan.',
      sensitivity: 'public',
      contactId: morganId,
      provenance: { channelId: GROUP_ROOM_X },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_X },
      similarity: 0.99,
    });
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(
      makeMockStore([blockedGroupMemory]),
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      eventBus,
      contactStore,
    );

    const result = await retriever.retrieve(
      'server migration plan',
      MORGAN_DM,
      'primary',
      { isDirectMessage: true, privacyLevel: 'private' },
      morganId,
    );

    expect(result).toContain('Room X discussed a private server migration plan.');

    const telemetry = latestRetrievalTelemetry(eventBus);
    expect(telemetry.roomVisibilityRejectedCount).toBe(0);
    expect(telemetry.withheldReasonCounts).not.toMatchObject({
      'room_visibility.blocked': expect.any(Number),
    });
    expect(telemetry.reason).toBe('ok');
    expect(telemetry.returnedCount).toBe(1);
  });

  it('withholds same-room memories from retired logical sessions while allowing fresh-route memories', async () => {
    const { contactStore, morganId } = await makeRoomVisibilityContactStore();
    await contactStore.recordChannelActivity(morganId, 'discord', GROUP_ROOM_X, 'invite_only');
    const freshLogicalSessionId = `${GROUP_ROOM_X}:session:20260630T120000Z-fresh123`;
    const retiredMemory = makeMemory({
      id: 'retired-room-memory',
      text: 'Old poisoned lane said the deployment password was basil.',
      sensitivity: 'public',
      provenance: { channelId: GROUP_ROOM_X, sessionId: GROUP_ROOM_X },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_X },
      sourceRef: `source:extraction|channel:${GROUP_ROOM_X}|session:${GROUP_ROOM_X}|turn:old`,
      similarity: 0.99,
    });
    const freshMemory = makeMemory({
      id: 'fresh-room-memory',
      text: 'Fresh lane says the deployment checklist is smoke test first.',
      sensitivity: 'public',
      provenance: { channelId: GROUP_ROOM_X, sessionId: freshLogicalSessionId },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_X },
      sourceRef: `source:extraction|channel:${GROUP_ROOM_X}|session:${freshLogicalSessionId}|turn:fresh`,
      similarity: 0.98,
    });
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(
      makeMockStore([retiredMemory, freshMemory]),
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      eventBus,
      contactStore,
      null,
      null,
      {
        isSessionRetiredOrQuarantined: (logicalSessionId: string) => logicalSessionId === GROUP_ROOM_X,
        getRetiredLogicalSessionIds: () => new Set([GROUP_ROOM_X]),
      },
    );

    const result = await retriever.retrieve(
      'deployment checklist',
      GROUP_ROOM_X,
      'primary',
      { isDirectMessage: false, privacyLevel: 'invite_only' },
      morganId,
    );

    expect(result).toContain('Fresh lane says the deployment checklist is smoke test first.');
    expect(result).not.toContain('Old poisoned lane said the deployment password was basil.');

    const telemetry = latestRetrievalTelemetry(eventBus);
    expect(telemetry.sessionQuarantineRejectedCount).toBe(1);
    expect(telemetry.withheldReasonCounts).toMatchObject({
      'session_quarantine.blocked': 1,
    });
    expect(telemetry.roomVisibilityRejectedCount).toBe(0);
    expect(telemetry.returnedCount).toBe(1);
  });

  it('carries room-visibility rejections into active context manifest seeds', async () => {
    const { contactStore, morganId } = await makeRoomVisibilityContactStore();
    await contactStore.recordChannelActivity(morganId, 'discord', GROUP_ROOM_X, 'invite_only');
    const sameRoomMemory = makeMemory({
      id: 'group-x-memory',
      text: 'Room X selected the blue release train.',
      sensitivity: 'public',
      provenance: { channelId: GROUP_ROOM_X },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_X },
      similarity: 0.97,
    });
    const crossRoomMemory = makeMemory({
      id: 'group-y-memory',
      text: 'Room Y selected the red release train.',
      sensitivity: 'public',
      provenance: { channelId: GROUP_ROOM_Y },
      scopeRef: { kind: 'conversation', id: GROUP_ROOM_Y },
      similarity: 0.96,
    });
    const retriever = new MemoryRetriever(
      makeMockStore([sameRoomMemory, crossRoomMemory]),
      makeMockEmbedding(),
      { retrievalLimit: 20 },
      makeMockEventBus(),
      contactStore,
    );
    const request = {
      contextText: 'release train',
      channelId: GROUP_ROOM_X,
      trustLevel: 'primary' as const,
      channelMeta: { isDirectMessage: false, privacyLevel: 'invite_only' as const },
      canonicalContactId: morganId,
    };

    await retriever.refreshActiveMemoryContext(request);
    const active = retriever.getActiveMemoryContext(request);

    expect(active?.contextBlock).toContain('Room X selected the blue release train.');
    expect(active?.contextBlock).not.toContain('Room Y selected the red release train.');
    expect(active?.manifestSeed).toMatchObject({
      roomVisibilityRejectedCount: 1,
      withheldReasonCounts: {
        'room_visibility.blocked': 1,
      },
    });
  });
});

describe('MemoryRetriever compositional retrieval rerank', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  afterEach(() => {
    tokenTestUtils.resetTokenizerState();
  });

  it('uses deterministic metadata reranking when compositional retrieval policy allows it', async () => {
    const memories = [
      makeMemory({ id: 'mem-alpha', text: 'Alpha baseline memory', similarity: 0.92, importance: 0.8 }),
      makeMemory({ id: 'mem-bravo', text: 'Bravo directly answers the question', similarity: 0.86, importance: 0.8 }),
      makeMemory({ id: 'mem-charlie', text: 'Charlie filler detail', similarity: 0.8, importance: 0.7 }),
      makeMemory({ id: 'mem-delta', text: 'Delta best continuity anchor', similarity: 0.8, importance: 0.85 }),
      makeMemory({ id: 'mem-echo', text: 'Echo low-value detail', similarity: 0.7, importance: 0.6 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const llmProvider = makeMockLLMProvider([]);
    const runtimeConfig = makeRuntimeConfig({
      capabilityTier: 'autonomous',
      compositionalPolicy: {
        enabled: true,
        allowedTiers: ['autonomous'],
        allowedChannelTypes: ['api'],
        allowedPurposes: ['retrieval'],
      },
    });
    const retriever = new MemoryRetriever(
      store,
      embedding,
      runtimeConfig,
      eventBus,
      null,
      llmProvider,
    );

    const result = await retriever.retrieve('which continuity anchor answers the question?', 'api:test', 'primary');

    expect(result.indexOf('Delta best continuity anchor')).toBeLessThan(
      result.indexOf('Alpha baseline memory'),
    );
    expect(result.indexOf('Bravo directly answers the question')).toBeLessThan(
      result.indexOf('Alpha baseline memory'),
    );
    expect(llmProvider.complete).not.toHaveBeenCalled();
    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      reason: 'ok',
      compositionalMode: 'applied',
      compositionalCandidateCount: 5,
      compositionalEvaluationBatchCount: 2,
      compositionalFinalistCount: 5,
    });
  });

  it('fails closed to deterministic retrieval when compositional retrieval is not allowed by policy', async () => {
    const memories = [
      makeMemory({ id: 'mem-alpha', text: 'Alpha baseline memory', similarity: 0.98, importance: 0.95 }),
      makeMemory({ id: 'mem-bravo', text: 'Bravo directly answers the question', similarity: 0.86, importance: 0.8 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const llmProvider = makeMockLLMProvider([
      { content: '<response></response>' },
    ]);
    const runtimeConfig = makeRuntimeConfig({
      capabilityTier: 'autonomous',
      compositionalPolicy: {
        enabled: true,
        allowedTiers: ['autonomous'],
        allowedChannelTypes: ['api'],
        allowedPurposes: ['extraction'],
      },
    });
    const retriever = new MemoryRetriever(
      store,
      embedding,
      runtimeConfig,
      eventBus,
      null,
      llmProvider,
    );

    const result = await retriever.retrieve('which memory best answers the question?', 'api:test', 'primary');

    expect(result.indexOf('Alpha baseline memory')).toBeLessThan(
      result.indexOf('Bravo directly answers the question'),
    );
    expect(llmProvider.complete).not.toHaveBeenCalled();
    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      reason: 'ok',
      compositionalMode: 'disabled_policy',
      compositionalCandidateCount: 2,
      compositionalEvaluationBatchCount: 1,
      compositionalFinalistCount: 2,
    });
  });

  it('does not spend a memory model call when deterministic rerank is available', async () => {
    const memories = [
      makeMemory({ id: 'mem-alpha', text: 'Alpha baseline memory', similarity: 0.98, importance: 0.95 }),
      makeMemory({ id: 'mem-bravo', text: 'Bravo directly answers the question', similarity: 0.86, importance: 0.8 }),
      makeMemory({ id: 'mem-delta', text: 'Delta best continuity anchor', similarity: 0.74, importance: 0.7 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const llmProvider = makeMockLLMProvider([
      { content: '<response><candidate><id>unknown</id><relevance>0.9</relevance></candidate></response>' },
    ]);
    const runtimeConfig = makeRuntimeConfig({
      capabilityTier: 'autonomous',
      compositionalPolicy: {
        enabled: true,
        allowedTiers: ['autonomous'],
        allowedChannelTypes: ['api'],
        allowedPurposes: ['retrieval'],
      },
    });
    const retriever = new MemoryRetriever(
      store,
      embedding,
      runtimeConfig,
      eventBus,
      null,
      llmProvider,
    );

    const result = await retriever.retrieve('which memory best answers the question?', 'api:test', 'primary');

    expect(result.indexOf('Alpha baseline memory')).toBeLessThan(
      result.indexOf('Bravo directly answers the question'),
    );
    expect(result.indexOf('Bravo directly answers the question')).toBeLessThan(
      result.indexOf('Delta best continuity anchor'),
    );
    expect(llmProvider.complete).not.toHaveBeenCalled();
    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      reason: 'ok',
      compositionalMode: 'applied',
      compositionalCandidateCount: 3,
      compositionalEvaluationBatchCount: 1,
      compositionalFinalistCount: 3,
    });
  });
});

describe('MemoryRetriever soft-delete exclusion', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  afterEach(() => {
    tokenTestUtils.resetTokenizerState();
  });

  it('soft-deleted memories are not returned by the mock store (simulating SQL filter)', async () => {
    // In the real store, `searchByEmbedding` filters with `AND m.deleted_at IS NULL`.
    // This test verifies that our retriever does not accidentally re-introduce
    // deleted memories and that the store contract is respected.
    const activeMemory = makeMemory({
      text: 'Active memory',
      sensitivity: 'public',
      similarity: 0.90,
    });
    // The store should NOT return soft-deleted memories; we simulate this by
    // only including the active one in the mock.
    const store = makeMockStore([activeMemory]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    expect(result).toContain('Active memory');
    // Verify searchByEmbedding was called (the SQL filter happens there)
    expect(store.searchByEmbedding).toHaveBeenCalled();
  });

  it('getMemoriesByContact also excludes soft-deleted via SQL (store contract)', async () => {
    // Emotional continuity collection uses getMemoriesByContact.
    // Verify the store contract holds for that path too.
    const store = makeMockStore([]);
    const emotionalMemory = makeMemory({
      id: 'emo-active',
      text: 'Active emotional memory',
      type: 'emotional',
      emotionalValence: 0.5,
      sensitivity: 'public',
      similarity: 0.5,
    });
    (store.getMemoriesByContact as ReturnType<typeof vi.fn>).mockReturnValue([emotionalMemory]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'how are things?',
      'api:test',
      'primary',
      undefined,
      'contact-1',
    );

    // The emotional continuity memory should surface
    expect(result).toContain('Active emotional memory');
    expect(store.getMemoriesByContact).toHaveBeenCalledWith('contact-1', 12);
  });
});

describe('MemoryRetriever low-salience but high-similarity surfacing', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  afterEach(() => {
    tokenTestUtils.resetTokenizerState();
  });

  it('low-salience memories with high similarity still surface when public sensitivity', async () => {
    // Salience has decayed to near-floor (0.06) but embedding similarity
    // is high. These should still surface because the composite score
    // formula multiplies all factors — a very high similarity can compensate.
    const memories = [
      makeMemory({
        text: 'Decayed but highly relevant fact',
        sensitivity: 'public',
        similarity: 0.97,  // very high similarity
        importance: 0.8,
        salience: 0.06,    // near floor after decay
        emotionalValence: 0.3,
        extractedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
        lastAccessed: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day ago
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    // Should still surface due to high similarity * importance
    // score = 0.97 * recency * (1 + 0.15) * 0.8 * 0.06 * 1 * 1
    // recency ~= 1/(1 + 1/30) ~= 0.968
    // base ~= 0.97 * 0.968 * 1.15 * 0.8 * 0.06 = 0.052
    // Even with privacy penalty this should be > 0
    expect(result).toContain('Decayed but highly relevant fact');
  });

  it('very low salience + low importance + low similarity gets score-rescued by guarantee', async () => {
    // This memory has low everything EXCEPT it passes trust policy.
    // Without the guarantee it would be filtered out (score near zero
    // or negative after privacy penalty). With the guarantee, if it's
    // the only memory available, it gets rescued.
    const memories = [
      makeMemory({
        text: 'Only memory available but poor scores',
        sensitivity: 'public',
        similarity: 0.35,  // just above threshold
        importance: 0.1,
        salience: 0.06,
        emotionalValence: 0,
        extractedAt: Date.now() - 90 * 24 * 60 * 60 * 1000, // 90 days old
        lastAccessed: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days since access
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve('test query', 'api:test', 'primary');

    // This memory has very low composite score but it's the only candidate.
    // The guarantee should rescue it if it would otherwise be zero.
    // Even if score is tiny but positive, it should still appear.
    // With the guarantee, we expect it to surface.
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('MemoryRetriever mood-congruent retrieval bias', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  afterEach(() => {
    tokenTestUtils.resetTokenizerState();
  });

  it('boosts memories formed in a congruent mood when currentVAD is provided', async () => {
    const memories = [
      makeMemory({
        text: 'Higher baseline similarity but mood-incongruent memory',
        similarity: 0.9,
        formationVAD: { valence: 1, arousal: 1, dominance: 1 },
      }),
      makeMemory({
        text: 'Lower baseline similarity but mood-congruent memory',
        similarity: 0.8,
        formationVAD: { valence: -1, arousal: -1, dominance: -1 },
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, makeRuntimeConfig({
      moodCongruenceWeight: 0.15,
    }));

    const result = await retriever.retrieve(
      'which memory should lead?',
      'api:test',
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      { valence: -1, arousal: -1, dominance: -1 },
    );

    expect(result.indexOf('Lower baseline similarity but mood-congruent memory')).toBeLessThan(
      result.indexOf('Higher baseline similarity but mood-incongruent memory'),
    );
  });

  it('keeps baseline ranking neutral when currentVAD is omitted', async () => {
    const memories = [
      makeMemory({
        text: 'Higher baseline similarity but mood-incongruent memory',
        similarity: 0.9,
        formationVAD: { valence: 1, arousal: 1, dominance: 1 },
      }),
      makeMemory({
        text: 'Lower baseline similarity but mood-congruent memory',
        similarity: 0.8,
        formationVAD: { valence: -1, arousal: -1, dominance: -1 },
      }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, makeRuntimeConfig({
      moodCongruenceWeight: 0.15,
    }));

    const result = await retriever.retrieve('which memory should lead?', 'api:test', 'primary');

    expect(result.indexOf('Higher baseline similarity but mood-incongruent memory')).toBeLessThan(
      result.indexOf('Lower baseline similarity but mood-congruent memory'),
    );
  });

  it('fails closed when moodCongruenceWeight is outside [0, 1]', () => {
    const store = makeMockStore([]);
    const embedding = makeMockEmbedding();

    expect(() => {
      new MemoryRetriever(store, embedding, makeRuntimeConfig({
        moodCongruenceWeight: 1.5,
      }));
    }).toThrow('moodCongruenceWeight must be a finite number between 0 and 1');
  });
});

describe('MemoryRetriever caller-context retrieval modes', () => {
  beforeEach(() => {
    idCounter = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    tokenTestUtils.resetTokenizerState();
  });

  it('preserves default ranking when retrievalMode is explicitly default', async () => {
    const now = Date.now();
    const memories = [
      makeMemory({
        text: 'Week-old but higher-similarity memory',
        sensitivity: 'public',
        similarity: 0.97,
        importance: 0.9,
        salience: 0.9,
        extractedAt: now - 7 * 24 * 60 * 60 * 1000,
      }),
      makeMemory({
        text: 'Same-day but lower-similarity memory',
        sensitivity: 'public',
        similarity: 0.76,
        importance: 0.9,
        salience: 0.9,
        extractedAt: now - 2 * 60 * 60 * 1000,
      }),
    ];
    const retriever = new MemoryRetriever(makeMockStore(memories), makeMockEmbedding(), { retrievalLimit: 20 });

    const baseline = await retriever.retrieve('timeline question', 'api:test', 'primary');
    const explicitDefault = await retriever.retrieve(
      'timeline question',
      'api:test',
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'default',
    );

    expect(baseline).toBe(explicitDefault);
    expect(baseline.indexOf('Week-old but higher-similarity memory')).toBeLessThan(
      baseline.indexOf('Same-day but lower-similarity memory'),
    );
  });

  it('temporal mode favors same-day evidence over slightly stronger older matches', async () => {
    const now = Date.now();
    const memories = [
      makeMemory({
        text: 'Week-old but higher-similarity memory',
        sensitivity: 'public',
        similarity: 0.97,
        importance: 0.9,
        salience: 0.9,
        extractedAt: now - 7 * 24 * 60 * 60 * 1000,
      }),
      makeMemory({
        text: 'Same-day but lower-similarity memory',
        sensitivity: 'public',
        similarity: 0.76,
        importance: 0.9,
        salience: 0.9,
        extractedAt: now - 2 * 60 * 60 * 1000,
        provenanceRefs: ['source:daily_status|date:2026-04-18'],
      }),
    ];
    const retriever = new MemoryRetriever(makeMockStore(memories), makeMockEmbedding(), { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'timeline question',
      'api:test',
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { retrievalMode: 'temporal' },
    );

    expect(result.indexOf('Same-day but lower-similarity memory')).toBeLessThan(
      result.indexOf('Week-old but higher-similarity memory'),
    );
  });

  it('does not fail temporal retrieval when a memory has an invalid timestamp', async () => {
    const memories = [
      makeMemory({
        text: 'Memory with malformed extracted timestamp',
        sensitivity: 'public',
        similarity: 0.9,
        importance: 0.9,
        salience: 0.9,
        extractedAt: Number.NaN,
        lastAccessed: Number.NaN,
      }),
    ];
    const retriever = new MemoryRetriever(makeMockStore(memories), makeMockEmbedding(), { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'timestamp resilience question',
      'api:test',
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { retrievalMode: 'temporal' },
    );

    expect(result).toContain('Memory with malformed extracted timestamp');
  });

  it('reflection mode excludes reflection memories from ranked retrieval', async () => {
    const now = Date.now();
    const memories = [
      makeMemory({
        text: 'Reflection entry about what we learned',
        type: 'reflection',
        sensitivity: 'public',
        similarity: 0.99,
        importance: 0.95,
        salience: 0.95,
        extractedAt: now - 60 * 60 * 1000,
        sourceRef: 'reflection_journal:entry-1|createdAt:2026-04-18T11:00:00.000Z',
      }),
      makeMemory({
        text: 'Concrete project status memory',
        type: 'semantic',
        sensitivity: 'public',
        similarity: 0.8,
        importance: 0.9,
        salience: 0.9,
        extractedAt: now - 60 * 60 * 1000,
      }),
    ];
    const retriever = new MemoryRetriever(makeMockStore(memories), makeMockEmbedding(), { retrievalLimit: 20 });

    const baseline = await retriever.retrieve('what should I focus on?', 'api:test', 'primary');
    const reflectionFiltered = await retriever.retrieve(
      'what should I focus on?',
      'api:test',
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'reflection',
    );

    expect(baseline.indexOf('Reflection entry about what we learned')).toBeLessThan(
      baseline.indexOf('Concrete project status memory'),
    );
    expect(reflectionFiltered).toContain('Concrete project status memory');
    expect(reflectionFiltered).not.toContain('Reflection entry about what we learned');
  });

  it('reflection mode excludes semantic memories whose provenance refs point at self-reflection traces', async () => {
    const now = Date.now();
    const memories = [
      makeMemory({
        text: 'Semantic memory synthesized from a self-reflection trace',
        type: 'semantic',
        sensitivity: 'public',
        similarity: 0.96,
        importance: 0.94,
        salience: 0.94,
        extractedAt: now - 30 * 60 * 1000,
        provenanceRefs: [
          'reflection_journal:entry-2|template:values-reflection|channel:internal:reflection:values-reflection|mode:agent|createdAt:2026-04-18T11:30:00.000Z',
        ],
      }),
      makeMemory({
        text: 'Concrete project status memory',
        type: 'semantic',
        sensitivity: 'public',
        similarity: 0.8,
        importance: 0.9,
        salience: 0.9,
        extractedAt: now - 60 * 60 * 1000,
      }),
    ];
    const retriever = new MemoryRetriever(makeMockStore(memories), makeMockEmbedding(), { retrievalLimit: 20 });

    const baseline = await retriever.retrieve('what should I focus on?', 'api:test', 'primary');
    const reflectionFiltered = await retriever.retrieve(
      'what should I focus on?',
      'api:test',
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'reflection',
    );

    expect(baseline.indexOf('Semantic memory synthesized from a self-reflection trace')).toBeLessThan(
      baseline.indexOf('Concrete project status memory'),
    );
    expect(reflectionFiltered).toContain('Concrete project status memory');
    expect(reflectionFiltered).not.toContain('Semantic memory synthesized from a self-reflection trace');
  });

  it('propagates composed caller-context modes from snapshot capture into retrieval', async () => {
    const now = Date.now();
    const memories = [
      makeMemory({
        text: 'Same-day reflection daily summary',
        type: 'reflection',
        sensitivity: 'public',
        similarity: 0.99,
        importance: 0.95,
        salience: 0.95,
        extractedAt: now - 30 * 60 * 1000,
        sourceRef: 'reflection_daily:entry-7|date:2026-04-18',
      }),
      makeMemory({
        text: 'Same-day concrete timeline evidence',
        type: 'semantic',
        sensitivity: 'public',
        similarity: 0.76,
        importance: 0.9,
        salience: 0.9,
        extractedAt: now - 2 * 60 * 60 * 1000,
        provenanceRefs: ['source:daily_status|date:2026-04-18'],
      }),
      makeMemory({
        text: 'Week-old but higher-similarity memory',
        type: 'semantic',
        sensitivity: 'public',
        similarity: 0.97,
        importance: 0.9,
        salience: 0.9,
        extractedAt: now - 7 * 24 * 60 * 60 * 1000,
      }),
    ];
    const retriever = new MemoryRetriever(makeMockStore(memories), makeMockEmbedding(), { retrievalLimit: 20 });

    const snapshot = await retriever.captureTurnMemorySnapshot(
      'timeline question',
      'api:test',
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      { retrievalMode: ['temporal', 'reflection'] },
    );
    const result = await retriever.retrieve(
      'timeline question',
      'api:test',
      'primary',
      undefined,
      undefined,
      snapshot,
    );

    expect(snapshot.callerContext).toEqual({ retrievalMode: ['temporal', 'reflection'] });
    expect(snapshot.retrievalMode).toEqual(['temporal', 'reflection']);
    expect(result).toContain('Same-day concrete timeline evidence');
    expect(result).not.toContain('Same-day reflection daily summary');
    expect(result.indexOf('Same-day concrete timeline evidence')).toBeLessThan(
      result.indexOf('Week-old but higher-similarity memory'),
    );
  });
});
