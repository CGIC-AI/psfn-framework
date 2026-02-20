import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRetriever } from './retrieval.js';
import type { MemoryStore } from './store.js';
import type { EmbeddingService } from '../agent-loop.js';
import type { PurrMemory } from './types.js';
import type { SensitivityLevel } from '../trust/types.js';
import type { ConsentFlags } from '../trust/types.js';
import type { EventBus } from '../event-bus.js';
import type { SubstrateConfig } from '../types.js';

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

function makeMockStore(memories: Array<PurrMemory & { similarity: number }>): MemoryStore {
  return {
    searchByEmbedding: vi.fn().mockReturnValue(memories),
    updateMemory: vi.fn(),
    getContactProfile: vi.fn().mockReturnValue(undefined),
  } as unknown as MemoryStore;
}

function makeMockEmbedding(): EmbeddingService {
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
    memoryBudgetPct: 20,
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

// ── Tests ──

describe('MemoryRetriever trust-gated filtering', () => {
  beforeEach(() => {
    idCounter = 0;
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

  it('regular trust returns only public memories', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // Regular trust, semi_private channel (numeric Discord ID)
    const result = await retriever.retrieve('test query', '1234567890', 'regular');

    expect(result).toContain('Public fact');
    expect(result).not.toContain('Personal detail');
    expect(result).not.toContain('Intimate memory');
    expect(result).not.toContain('Confidential secret');
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

  it('primary trust + semi_private channel returns public + personal only', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // Numeric channel = semi_private (Discord guild)
    const result = await retriever.retrieve('test query', '1234567890', 'primary');

    expect(result).toContain('Public fact');
    expect(result).toContain('Personal detail');
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

  it('primary trust + Discord guild metadata remains semi_private', async () => {
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

  it('no trustLevel param defaults to regular behavior', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // No trustLevel argument — should default to 'regular'
    const result = await retriever.retrieve('test query', '1234567890');

    // regular trust + semi_private = public only
    expect(result).toContain('Public fact');
    expect(result).not.toContain('Personal detail');
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

  it('returns empty string when all memories are filtered out by trust', async () => {
    const memories = [
      makeMemory({ text: 'Secret stuff', sensitivity: 'confidential', similarity: 0.95 }),
      makeMemory({ text: 'Private detail', sensitivity: 'intimate', similarity: 0.90 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    // public trust + broadcast = only public allowed, none present
    const result = await retriever.retrieve('test query', 'twitter:feed', 'public');

    expect(result).toBe('');
  });

  it('does not update access stats for filtered-out memories', async () => {
    const memories = makeAllSensitivities();
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    await retriever.retrieve('test query', '1234567890', 'regular');

    // Only the public memory (mem-1) should have updateMemory called
    const updateCalls = (store.updateMemory as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][0]).toBe('mem-1'); // The public memory ID
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
        chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 2_000 },
      },
    });
    const largeConfig = makeRuntimeConfig({
      memoryRetrievalLimit: undefined,
      memoryRetrievalBudgetPct: 2,
      modelRoster: {
        chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 12_000 },
      },
    });

    const smallRetriever = new MemoryRetriever(makeMockStore(memories), embedding, smallConfig);
    const largeRetriever = new MemoryRetriever(makeMockStore(memories), embedding, largeConfig);

    const smallResult = await smallRetriever.retrieve('budget query', 'api:test', 'primary');
    const largeResult = await largeRetriever.retrieve('budget query', 'api:test', 'primary');

    expect(countRenderedMemories(largeResult)).toBeGreaterThan(countRenderedMemories(smallResult));
  });

  it('uses hard retrieval limit override when provided', async () => {
    const memories = Array.from({ length: 10 }, (_, idx) => makeMemory({
      text: `Hard limit memory ${idx} ` + 'x'.repeat(240),
      sensitivity: 'public',
      similarity: 0.97 - idx * 0.01,
    }));
    const embedding = makeMockEmbedding();
    const config = makeRuntimeConfig({
      memoryRetrievalLimit: 2,
      memoryRetrievalBudgetPct: 25,
      modelRoster: {
        chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 256_000 },
      },
    });
    const retriever = new MemoryRetriever(makeMockStore(memories), embedding, config);

    const result = await retriever.retrieve('budget query', 'api:test', 'primary');

    expect(countRenderedMemories(result)).toBe(2);
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
    expect(result).toContain('What you remember about this person:');
  });

  it('injects canonical profile before episodic memory snippets', async () => {
    const memories = [
      makeMemory({ text: 'A semantic fact', type: 'semantic', sensitivity: 'public', similarity: 0.9 }),
    ];
    const store = makeMockStore(memories);
    (store.getContactProfile as ReturnType<typeof vi.fn>).mockReturnValue({
      contactId: 'contact-1',
      summary: 'Vega is the primary partner and values direct technical communication.',
      sourceMemoryIds: ['mem-1'],
      confidenceScore: 0.91,
      noveltyScore: 0.42,
      updatedAt: Date.now(),
    });
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'test query',
      'api:test',
      'primary',
      undefined,
      'contact-1',
    );

    const profileIndex = result.indexOf('Core profile for this person:');
    const memoriesIndex = result.indexOf('What you remember about this person:');
    expect(profileIndex).toBeGreaterThanOrEqual(0);
    expect(memoriesIndex).toBeGreaterThan(profileIndex);
    expect(result).toContain('Vega is the primary partner');
  });

  it('returns profile block when memory candidates are empty', async () => {
    const store = makeMockStore([]);
    (store.getContactProfile as ReturnType<typeof vi.fn>).mockReturnValue({
      contactId: 'contact-1',
      summary: 'Vega prefers concise responses and high signal summaries.',
      sourceMemoryIds: ['mem-1'],
      confidenceScore: 0.88,
      noveltyScore: 0.4,
      updatedAt: Date.now(),
    });
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 });

    const result = await retriever.retrieve(
      'test query',
      'api:test',
      'primary',
      undefined,
      'contact-1',
    );

    expect(result).toContain('Core profile for this person:');
    expect(result).toContain('Vega prefers concise responses');
    expect(result).not.toContain('What you remember about this person:');
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
      reason: 'ok',
      candidateCount: 2,
      rankedCount: 2,
      returnedCount: 2,
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
});
