import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import type { MemoryStorePort } from './memory-store-port.js';
import { MemoryRetriever } from './retrieval.js';
import type { PurrMemory } from './types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { WikiRetrievalService } from '../wiki/retrieval.js';
import { resolveEmbeddingProviderProvenanceFromConfig } from './embedding.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { Contact } from '../../core/contacts/types.js';

function makeMemory(id: string, text: string): PurrMemory & { similarity: number } {
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.8,
    sourceRef: `test:${id}`,
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 1,
    tags: [],
    sensitivity: 'public',
    consentFlags: {},
    similarity: 0.95,
  };
}

function makeStore(initialMemories: Array<PurrMemory & { similarity: number }>) {
  let corpusVersion = 1;
  let memories = initialMemories;
  const store = {
    getRetrievalCorpusVersion: vi.fn(() => corpusVersion),
    searchByEmbedding: vi.fn(async () => memories),
    searchByText: vi.fn(async () => []),
    updateMemory: vi.fn(async () => undefined),
    getContactProfile: vi.fn(async () => undefined),
    getById: vi.fn(async (id: string) => memories.find(memory => memory.id === id)),
    getMemoriesByContact: vi.fn(async () => []),
    getMemoriesByChannel: vi.fn(async () => []),
    getAllActiveMemories: vi.fn(async () => memories),
    listActiveMemories: vi.fn(async () => memories),
    recordEvolutionLink: vi.fn(async () => undefined),
    getEvolutionLinksForSourceMemory: vi.fn(async () => []),
    getEvolutionLinksForTargetMemory: vi.fn(async () => []),
  } as unknown as MemoryStorePort;

  return {
    store,
    bumpCorpusVersion(nextMemories = memories) {
      memories = nextMemories;
      corpusVersion += 1;
    },
  };
}

function makeEmbedding(): EmbeddingProviderPort {
  return {
    embed: vi.fn(async () => new Float32Array([0.25, 0.5, 0.75])),
    embedBatch: vi.fn(async () => []),
    dims: 3,
  };
}

function makeRuntimeConfig(): SubstrateConfig {
  return {
    defaultContextWindow: 128_000,
    modelRoster: {},
    memoryRetrievalBudgetPct: 2,
    embeddingProvider: 'api',
    embeddingApiModel: 'test-embedding-v1',
    embeddingApiDims: 3,
  } as unknown as SubstrateConfig;
}

describe('active-memory refresh cache', () => {
  it('returns the byte-identical snapshot without embedding or scanning when query and corpus are unchanged', async () => {
    const recalled = makeMemory('memory-1', 'V prefers oolong tea in the afternoon.');
    const { store } = makeStore([recalled]);
    const embedding = makeEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalBudgetPct: 0.1 });
    const request = {
      contextText: 'oolong tea',
      channelId: 'api:test',
      trustLevel: 'regular' as const,
    };

    const first = await retriever.refreshActiveMemoryContext(request);
    const second = await retriever.refreshActiveMemoryContext(request);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(embedding.embed).toHaveBeenCalledTimes(1);
    expect(store.searchByEmbedding).toHaveBeenCalledTimes(1);
  });

  it('reruns the pipeline and returns current results when the query or corpus changes', async () => {
    const firstMemory = makeMemory('memory-1', 'V prefers oolong tea.');
    const secondMemory = makeMemory('memory-2', 'V prefers jasmine tea.');
    const fixture = makeStore([firstMemory]);
    const embedding = makeEmbedding();
    const retriever = new MemoryRetriever(fixture.store, embedding, { retrievalBudgetPct: 0.1 });
    const request = {
      contextText: 'tea preference',
      channelId: 'api:test',
      trustLevel: 'regular' as const,
    };

    await retriever.refreshActiveMemoryContext(request);
    const changedQuery = await retriever.refreshActiveMemoryContext({
      ...request,
      contextText: 'which tea?',
    });
    fixture.bumpCorpusVersion([secondMemory]);
    const changedCorpus = await retriever.refreshActiveMemoryContext({
      ...request,
      contextText: 'which tea?',
    });

    expect(changedQuery?.contextBlock).toContain(firstMemory.text);
    expect(changedCorpus?.contextBlock).toContain(secondMemory.text);
    expect(changedCorpus?.selectedMemoryIds[0]).toBe(secondMemory.id);
    expect(changedCorpus?.manifestSeed?.compositionalMode).toBe('disabled_policy');
    expect(embedding.embed).toHaveBeenCalledTimes(3);
    expect(fixture.store.searchByEmbedding).toHaveBeenCalledTimes(3);
  });

  it('coalesces concurrent unchanged refreshes into one retrieval pipeline', async () => {
    const recalled = makeMemory('memory-1', 'V prefers oolong tea.');
    const { store } = makeStore([recalled]);
    const embedding = makeEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalBudgetPct: 0.1 });
    const request = {
      contextText: 'tea preference',
      channelId: 'api:test',
      trustLevel: 'regular' as const,
    };

    const [first, second] = await Promise.all([
      retriever.refreshActiveMemoryContext(request),
      retriever.refreshActiveMemoryContext(request),
    ]);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(embedding.embed).toHaveBeenCalledTimes(1);
    expect(store.searchByEmbedding).toHaveBeenCalledTimes(1);
  });

  it('does not cache an in-flight refresh across a concurrent corpus mutation', async () => {
    const oldMemory = makeMemory('memory-old', 'The old release train was blue.');
    const newMemory = makeMemory('memory-new', 'The current release train is green.');
    const fixture = makeStore([oldMemory]);
    let releaseFirstScan!: (value: Array<PurrMemory & { similarity: number }>) => void;
    const firstScan = new Promise<Array<PurrMemory & { similarity: number }>>(resolve => {
      releaseFirstScan = resolve;
    });
    vi.mocked(fixture.store.searchByEmbedding).mockImplementationOnce(async () => await firstScan);
    const embedding = makeEmbedding();
    const retriever = new MemoryRetriever(fixture.store, embedding, { retrievalBudgetPct: 0.1 });
    const request = {
      contextText: 'release train',
      channelId: 'api:test',
      trustLevel: 'regular' as const,
    };

    const inFlight = retriever.refreshActiveMemoryContext(request);
    await vi.waitFor(() => expect(fixture.store.searchByEmbedding).toHaveBeenCalledTimes(1));
    fixture.bumpCorpusVersion([newMemory]);
    releaseFirstScan([oldMemory]);
    const stale = await inFlight;
    const current = await retriever.refreshActiveMemoryContext(request);

    expect(stale?.contextBlock).toContain(oldMemory.text);
    expect(current?.contextBlock).toContain(newMemory.text);
    expect(current?.selectedMemoryIds[0]).toBe(newMemory.id);
    expect(embedding.embed).toHaveBeenCalledTimes(2);
    expect(fixture.store.searchByEmbedding).toHaveBeenCalledTimes(2);
  });

  it('reruns and withholds a consent-gated memory when disclosure consent is withdrawn', async () => {
    const gated = {
      ...makeMemory('memory-consent', 'The private launch phrase is blue heron.'),
      tags: ['consent_required'],
    };
    const { store } = makeStore([gated]);
    const embedding = makeEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalBudgetPct: 0.1 });
    const grantedRequest = {
      contextText: 'launch phrase',
      channelId: 'api:test',
      trustLevel: 'regular' as const,
      channelMeta: { disclosureConsentGranted: true },
    };

    const granted = await retriever.refreshActiveMemoryContext(grantedRequest);
    const withdrawn = await retriever.refreshActiveMemoryContext({
      ...grantedRequest,
      channelMeta: { disclosureConsentGranted: false },
    });

    expect(granted?.contextBlock).toContain(gated.text);
    expect(withdrawn?.contextBlock).not.toContain(gated.text);
    expect(withdrawn?.selectedMemoryIds).not.toContain(gated.id);
    expect(withdrawn?.manifestSeed?.policyRejectedReasonTags).toEqual({
      'boundary.consent_required': 1,
    });
    expect(embedding.embed).toHaveBeenCalledTimes(2);
    expect(store.searchByEmbedding).toHaveBeenCalledTimes(2);
  });

  it('reruns and withholds room-scoped memory when contact room visibility is withdrawn', async () => {
    const roomMemory = {
      ...makeMemory('memory-room', 'The blue room selected the copper release train.'),
      scopeRef: { kind: 'conversation' as const, id: 'discord:blue-room' },
      scopeTags: ['room_context'],
      provenance: { channelId: 'discord:blue-room' },
    };
    const { store } = makeStore([roomMemory]);
    const embedding = makeEmbedding();
    const visibleContact: Contact = {
      id: 'contact-a',
      displayName: 'A',
      trustLevel: 'regular',
      relationshipType: 'friend',
      firstSeen: '2026-07-01T00:00:00.000Z',
      lastSeen: '2026-07-14T00:00:00.000Z',
      conversationChannels: [{
        channel: 'discord',
        channelId: 'discord:blue-room',
        firstSeen: '2026-07-01T00:00:00.000Z',
        lastSeen: '2026-07-14T00:00:00.000Z',
      }],
    };
    let currentContact: Contact = visibleContact;
    const contactStore = {
      getById: vi.fn(async () => currentContact),
      getEmotionalSnapshot: vi.fn(async () => undefined),
      getSocialGraphEntityByContactId: vi.fn(async () => undefined),
    } as unknown as ContactStorePort;
    const retriever = new MemoryRetriever(
      store,
      embedding,
      { retrievalBudgetPct: 0.1 },
      undefined,
      contactStore,
    );
    const request = {
      contextText: 'release train',
      channelId: 'api:dm-a',
      trustLevel: 'regular' as const,
      channelMeta: { isDirectMessage: true },
      canonicalContactId: 'contact-a',
    };

    const visible = await retriever.refreshActiveMemoryContext(request);
    currentContact = { ...visibleContact, conversationChannels: [] };
    const withdrawn = await retriever.refreshActiveMemoryContext(request);

    expect(visible?.contextBlock).toContain(roomMemory.text);
    expect(withdrawn?.contextBlock).not.toContain(roomMemory.text);
    expect(withdrawn?.manifestSeed?.roomVisibilityRejectedCount).toBe(1);
    expect(embedding.embed).toHaveBeenCalledTimes(2);
    expect(store.searchByEmbedding).toHaveBeenCalledTimes(2);
  });

});

describe('shared per-turn retrieval embedding', () => {
  it('shares one query embedding between memory and wiki without changing either result', async () => {
    const recalled = makeMemory('memory-1', 'V prefers oolong tea.');
    const sharedFixture = makeStore([recalled]);
    const sharedEmbedding = makeEmbedding();
    const config = makeRuntimeConfig();
    const sharedRetriever = new MemoryRetriever(sharedFixture.store, sharedEmbedding, config);
    const queryText = 'tea preference';
    const sharedValue = sharedRetriever.createTurnRetrievalQueryEmbedding({
      turnId: 'turn-1',
      requestId: 'request-1',
      companionId: 'companion-a',
      channelId: 'api:test',
      canonicalContactId: 'contact-a',
      queryText,
    });
    const wikiMatches = [{
        documentId: 'tea-guide',
        title: 'Tea Guide',
        path: 'documents/tea-guide.md',
        sourceClass: 'companion_authored_note' as const,
        sensitivity: 'personal' as const,
        scope: 'personal' as const,
        chunkIndex: 0,
        chunkText: 'Oolong is partially oxidized.',
        score: 0.9,
      }];
    const sharedProjection = {
      search: vi.fn(async () => wikiMatches),
    };
    const sharedWiki = new WikiRetrievalService({
      projection: sharedProjection,
      embedding: sharedEmbedding,
      embeddingProvenance: resolveEmbeddingProviderProvenanceFromConfig(config, sharedEmbedding.dims),
      getSettings: () => ({
        enabled: true,
        chatTokenCap: 1000,
        groupTokenCap: 400,
        focusTokenCap: 2000,
        similarityThreshold: 0.6,
        groupSimilarityThreshold: 0.78,
      }),
    });
    const memoryRequest = {
      contextText: queryText,
      channelId: 'api:test',
      trustLevel: 'regular' as const,
      canonicalContactId: 'contact-a',
      turnId: 'turn-1',
      requestId: 'request-1',
      companionId: 'companion-a',
      retrievalQueryEmbedding: sharedValue,
    };
    const wikiRequest = {
      channelId: 'api:test',
      queryText,
      isDirectMessage: true,
      focusActive: false,
      turnId: 'turn-1',
      requestId: 'request-1',
      companionId: 'companion-a',
      canonicalContactId: 'contact-a',
      retrievalQueryEmbedding: sharedValue,
    };

    const [sharedMemoryResult, sharedWikiResult] = await Promise.all([
      sharedRetriever.refreshActiveMemoryContext(memoryRequest),
      sharedWiki.retrieveContextBlock(wikiRequest),
    ]);

    const baselineFixture = makeStore([recalled]);
    const baselineEmbedding = makeEmbedding();
    const baselineRetriever = new MemoryRetriever(baselineFixture.store, baselineEmbedding, config);
    const baselineProjection = { search: vi.fn(async () => wikiMatches) };
    const baselineWiki = new WikiRetrievalService({
      projection: baselineProjection,
      embedding: baselineEmbedding,
      getSettings: () => ({
        enabled: true,
        chatTokenCap: 1000,
        groupTokenCap: 400,
        focusTokenCap: 2000,
        similarityThreshold: 0.6,
        groupSimilarityThreshold: 0.78,
      }),
    });
    const [baselineMemoryResult, baselineWikiResult] = await Promise.all([
      baselineRetriever.refreshActiveMemoryContext({
        contextText: queryText,
        channelId: 'api:test',
        trustLevel: 'regular',
        canonicalContactId: 'contact-a',
      }),
      baselineWiki.retrieveContextBlock({
        channelId: 'api:test',
        queryText,
        isDirectMessage: true,
        focusActive: false,
      }),
    ]);

    expect(sharedEmbedding.embed).toHaveBeenCalledTimes(1);
    expect(sharedFixture.store.searchByEmbedding).toHaveBeenCalledTimes(1);
    expect(sharedProjection.search).toHaveBeenCalledTimes(1);
    expect(sharedProjection.search.mock.calls[0]?.[0]).not.toBe(
      vi.mocked(sharedFixture.store.searchByEmbedding).mock.calls[0]?.[0],
    );
    expect(Array.from(sharedProjection.search.mock.calls[0]![0])).toEqual(
      Array.from(vi.mocked(sharedFixture.store.searchByEmbedding).mock.calls[0]![0]),
    );
    expect(sharedMemoryResult?.contextBlock).toBe(baselineMemoryResult?.contextBlock);
    expect(sharedMemoryResult?.selectedMemoryIds).toEqual(baselineMemoryResult?.selectedMemoryIds);
    expect(sharedWikiResult).toBe(baselineWikiResult);
    expect(baselineEmbedding.embed).toHaveBeenCalledTimes(2);
  });
});
