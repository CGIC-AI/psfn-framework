import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import type { MemoryStorePort } from './memory-store-port.js';
import { MemoryRetriever } from './retrieval.js';
import type { PurrMemory } from './types.js';

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
});
