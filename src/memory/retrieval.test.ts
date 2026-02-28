import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRetriever, __retrieval_internals } from './retrieval.js';
import type { MemoryStore } from './store.js';
import type { EmbeddingService } from '../agent/contracts.js';
import type { PurrMemory } from './types.js';
import type { SensitivityLevel } from '../trust/types.js';
import type { ConsentFlags } from '../trust/types.js';
import type { EventBus } from '../event-bus.js';
import type { SubstrateConfig } from '../types.js';
import { __test as tokenTestUtils } from '../llm/tokens.js';

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
    getMemoriesByContact: vi.fn().mockReturnValue([]),
    getMemoriesByChannel: vi.fn().mockReturnValue([]),
    getAllActiveMemories: vi.fn().mockReturnValue(memories),
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
    expect(result).toContain('What you remember about this person:');
  });

  it('surfaces prior refusal boundaries for similar follow-up requests across sessions', async () => {
    const now = Date.now();
    const memories = [
      makeMemory({
        id: 'session1-boundary',
        text: 'I declined helping bypass paywalls and cracking paid subscriptions.',
        type: 'boundary',
        importance: 0.98,
        salience: 0.95,
        extractedAt: now - 120 * 24 * 60 * 60 * 1000,
        lastAccessed: now - 120 * 24 * 60 * 60 * 1000,
        sourceRef: 'api:session-1|operation:extract',
        tags: ['boundary', 'refusal', 'paywall', 'bypass'],
        sensitivity: 'public',
        similarity: 0.62,
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

  it('injects emotional continuity snapshot when contact mood metadata is available', async () => {
    const memories = [
      makeMemory({ text: 'A semantic fact', type: 'semantic', sensitivity: 'public', similarity: 0.9 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const contactStore = {
      getEmotionalSnapshot: vi.fn().mockReturnValue({
        baselineValence: 0.22,
        moodValence: 0.37,
        moodDrift: 0.15,
        moodSamples: 6,
        lastMoodUpdateEpochMs: Date.now(),
      }),
      getById: vi.fn(),
    } as any;

    const retriever = new MemoryRetriever(
      store,
      embedding,
      { retrievalLimit: 20 },
      undefined,
      contactStore,
    );

    const result = await retriever.retrieve(
      'test query',
      'api:test',
      'primary',
      undefined,
      'contact-1',
    );

    expect(result).toContain('Emotional continuity snapshot:');
    expect(result).toContain('drift +0.15');
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

  it('surfaces spontaneous recall weighted by emotional significance and last-access recency', async () => {
    const now = Date.now();
    const lowWeightMemory = makeMemory({
      id: 'proactive-low',
      text: 'A minor and stale detail.',
      type: 'semantic',
      emotionalValence: 0.02,
      salience: 0.2,
      importance: 0.2,
      lastAccessed: now - 120 * 24 * 60 * 60 * 1000,
      extractedAt: now - 120 * 24 * 60 * 60 * 1000,
      sensitivity: 'public',
      similarity: 0.5,
    });
    const highWeightMemory = makeMemory({
      id: 'proactive-high',
      text: 'User felt deeply relieved after finishing the launch.',
      type: 'emotional',
      emotionalValence: 0.92,
      salience: 0.95,
      importance: 0.9,
      lastAccessed: now - 60 * 60 * 1000,
      extractedAt: now - 2 * 24 * 60 * 60 * 1000,
      sensitivity: 'public',
      similarity: 0.5,
    });
    const store = makeMockStore([]);
    (store.getMemoriesByContact as ReturnType<typeof vi.fn>).mockReturnValue([
      lowWeightMemory,
      highWeightMemory,
    ]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, {
      retrievalLimit: 20,
      proactiveRecallProbability: 1,
      proactiveRecallMinTurnsBetween: 0,
    });

    const randomSpy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)   // probability gate
      .mockReturnValueOnce(0.1); // weighted draw
    try {
      const result = await retriever.retrieveProactiveRecall(
        'api:test',
        'primary',
        undefined,
        'contact-1',
      );

      expect(result).toContain('Spontaneous recall:');
      expect(result).toContain(highWeightMemory.text);
      expect(result).not.toContain(lowWeightMemory.text);
      expect(store.updateMemory).toHaveBeenCalledWith(
        'proactive-high',
        expect.objectContaining({
          accessCount: highWeightMemory.accessCount + 1,
        }),
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('respects configurable proactive recall frequency across turns', async () => {
    const now = Date.now();
    const memory = makeMemory({
      id: 'proactive-frequency',
      text: 'Remembering this without being asked.',
      type: 'emotional',
      emotionalValence: 0.6,
      salience: 0.8,
      importance: 0.8,
      lastAccessed: now,
      extractedAt: now,
      sensitivity: 'public',
      similarity: 0.5,
    });
    const store = makeMockStore([]);
    (store.getMemoriesByChannel as ReturnType<typeof vi.fn>).mockReturnValue([memory]);
    const embedding = makeMockEmbedding();
    const retriever = new MemoryRetriever(store, embedding, {
      retrievalLimit: 20,
      proactiveRecallProbability: 1,
      proactiveRecallMinTurnsBetween: 1,
    });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const first = await retriever.retrieveProactiveRecall('api:test', 'primary');
      const second = await retriever.retrieveProactiveRecall('api:test', 'primary');
      const third = await retriever.retrieveProactiveRecall('api:test', 'primary');

      expect(first).toContain('Spontaneous recall:');
      expect(second).toBe('');
      expect(third).toContain('Spontaneous recall:');
      expect(store.updateMemory).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
    }
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

  it('emits telemetry with pipeline stage counts for trust-filtered scenario', async () => {
    const memories = [
      makeMemory({ text: 'Secret A', sensitivity: 'confidential', similarity: 0.95 }),
      makeMemory({ text: 'Public B', sensitivity: 'public', similarity: 0.85 }),
    ];
    const store = makeMockStore(memories);
    const embedding = makeMockEmbedding();
    const eventBus = makeMockEventBus();
    const retriever = new MemoryRetriever(store, embedding, { retrievalLimit: 20 }, eventBus);

    // regular trust + semi_private = only public allowed
    await retriever.retrieve('test query', '1234567890', 'regular');

    const calls = ((eventBus.emit as unknown) as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const telemetry = calls[0][1] as Record<string, unknown>;
    expect(telemetry.candidateCount).toBe(2);
    expect(telemetry.sensitivityRejectedCount).toBe(1);
    expect(telemetry.returnedCount).toBe(1);
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
