import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryWriter } from './writer.js';
import type { MemoryWriteOptions } from './writer.js';
import type { EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from './store.js';
import type { PurrMemory } from './types.js';
import { DEDUP_THRESHOLD, MEMORY_CONFIG } from './types.js';

// ── Mock factories ──

function makeEmbedding(seed = 0): Float32Array {
  const arr = new Float32Array(4);
  arr[0] = 0.1 + seed * 0.01;
  arr[1] = 0.2 + seed * 0.01;
  arr[2] = 0.3 + seed * 0.01;
  arr[3] = 0.4 + seed * 0.01;
  return arr;
}

function mockEmbeddingService(): EmbeddingService {
  return {
    embed: vi.fn(async () => makeEmbedding()),
    embedBatch: vi.fn(async (texts: string[]) => texts.map((_, i) => makeEmbedding(i))),
    dims: 4,
  };
}

function mockMemoryStore(): {
  insertMemory: ReturnType<typeof vi.fn>;
  searchByEmbedding: ReturnType<typeof vi.fn>;
  updateMemory: ReturnType<typeof vi.fn>;
  getAllActiveMemories: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
  getMemoriesByChannel: ReturnType<typeof vi.fn>;
} {
  return {
    insertMemory: vi.fn(),
    searchByEmbedding: vi.fn(() => []),
    updateMemory: vi.fn(),
    getAllActiveMemories: vi.fn(() => []),
    getById: vi.fn(),
    getStats: vi.fn(() => ({ total: 0, byType: {}, avgSalience: 0 })),
    getMemoriesByChannel: vi.fn(() => []),
  };
}

function makeExistingMemory(overrides: Partial<PurrMemory & { similarity: number }> = {}): PurrMemory & { similarity: number } {
  return {
    id: 'existing-001',
    text: 'An existing memory',
    type: 'semantic',
    importance: 0.6,
    confidence: 0.7,
    emotionalValence: 0.1,
    salience: 0.6,
    sourceRef: 'test',
    extractedAt: Date.now() - 100_000,
    lastAccessed: Date.now() - 50_000,
    accessCount: 3,
    tags: ['old'],
    sensitivity: 'personal',
    similarity: 0.95,
    ...overrides,
  };
}

describe('MemoryWriter', () => {
  let store: ReturnType<typeof mockMemoryStore>;
  let embeddings: EmbeddingService;
  let writer: MemoryWriter;

  beforeEach(() => {
    store = mockMemoryStore();
    embeddings = mockEmbeddingService();
    writer = new MemoryWriter(store as unknown as MemoryStore, embeddings);
  });

  describe('write()', () => {
    it('inserts a new memory with correct fields', async () => {
      const opts: MemoryWriteOptions = {
        text: 'V loves cats',
        type: 'semantic',
        importance: 0.8,
        emotionalValence: 0.6,
        confidence: 0.9,
        tags: ['identity', 'preference'],
        sourceRef: 'test:manual',
      };

      const result = await writer.write(opts);

      expect(result.action).toBe('created');
      expect(result.memory.text).toBe('V loves cats');
      expect(result.memory.type).toBe('semantic');
      expect(result.memory.importance).toBe(0.8);
      expect(result.memory.emotionalValence).toBe(0.6);
      expect(result.memory.confidence).toBe(0.9);
      expect(result.memory.tags).toEqual(['identity', 'preference']);
      expect(result.memory.sourceRef).toBe('test:manual');
      expect(result.memory.salience).toBe(0.8); // Initial salience = importance
      expect(result.memory.accessCount).toBe(1);
      expect(result.memory.id).toBeDefined();

      // Verify embedding was fetched and memory was inserted
      expect(embeddings.embed).toHaveBeenCalledWith('V loves cats');
      expect(store.insertMemory).toHaveBeenCalledOnce();
      const [insertedMemory, insertedEmbedding] = store.insertMemory.mock.calls[0];
      expect(insertedMemory.text).toBe('V loves cats');
      expect(insertedEmbedding).toBeInstanceOf(Float32Array);
    });

    it('uses default values for optional fields', async () => {
      const result = await writer.write({ text: 'A simple fact', type: 'episodic' });

      expect(result.action).toBe('created');
      expect(result.memory.importance).toBe(0.5);
      expect(result.memory.emotionalValence).toBe(0);
      expect(result.memory.confidence).toBe(0.8);
      expect(result.memory.tags).toEqual([]);
      expect(result.memory.sourceRef).toBe('tool:memory_write');
    });

    it('returns the inserted memory with a UUID id', async () => {
      const result = await writer.write({ text: 'test', type: 'semantic' });

      expect(result.memory.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('marks memory durable when retentionClass is durable', async () => {
      const result = await writer.write({
        text: 'Our anniversary is on April 14',
        type: 'relational',
        retentionClass: 'durable',
      });

      expect(result.action).toBe('created');
      expect(result.memory.retentionClass).toBe('durable');
      expect(result.memory.tags).toContain('durable');

      const [insertedMemory] = store.insertMemory.mock.calls[0];
      expect(insertedMemory.retentionClass).toBe('durable');
      expect(insertedMemory.tags).toContain('durable');
    });

    it('auto-marks high-importance relational profile memories as durable', async () => {
      const result = await writer.write({
        text: 'V is my life partner',
        type: 'relational',
        importance: 0.9,
        tags: ['profile'],
      });

      expect(result.memory.retentionClass).toBe('durable');
      expect(result.memory.tags).toContain('profile');
      expect(result.memory.tags).toContain('durable');
    });

    it('throws on invalid memory type', async () => {
      await expect(
        writer.write({ text: 'test', type: 'invalid' as any }),
      ).rejects.toThrow('Invalid memory type: invalid');
    });

    it('deduplicates when embedding similarity exceeds type threshold', async () => {
      const existing = makeExistingMemory({
        type: 'semantic',
        salience: 0.6,
        accessCount: 3,
      });

      // First searchByEmbedding call (dedup check) returns a match
      store.searchByEmbedding.mockReturnValueOnce([existing]);

      const result = await writer.write({
        text: 'An existing memory (rephrased)',
        type: 'semantic',
      });

      expect(result.action).toBe('deduplicated');
      expect(result.existingId).toBe('existing-001');
      expect(result.memory.id).toBe('existing-001');

      // Should have bumped salience and access count
      expect(store.updateMemory).toHaveBeenCalledWith('existing-001', expect.objectContaining({
        accessCount: 4,
        salience: Math.min(1, 0.6 + MEMORY_CONFIG.salienceBumpOnAccess),
      }));

      // Should NOT have inserted a new memory
      expect(store.insertMemory).not.toHaveBeenCalled();
    });

    it('does not deduplicate across different canonical contacts', async () => {
      const existing = makeExistingMemory({
        type: 'semantic',
        contactId: 'contact-a',
      });
      store.searchByEmbedding.mockReturnValueOnce([existing]);
      store.searchByEmbedding.mockReturnValueOnce([]);

      const result = await writer.write({
        text: 'An existing memory (rephrased)',
        type: 'semantic',
        contactId: 'contact-b',
      });

      expect(result.action).toBe('created');
      expect(store.updateMemory).not.toHaveBeenCalled();
      expect(store.insertMemory).toHaveBeenCalledOnce();
      const [inserted] = store.insertMemory.mock.calls[0];
      expect(inserted.contactId).toBe('contact-b');
    });

    it('upgrades duplicate memory tags when durable write deduplicates', async () => {
      const existing = makeExistingMemory({
        type: 'relational',
        tags: ['relationship'],
      });

      store.searchByEmbedding.mockReturnValueOnce([existing]);

      const result = await writer.write({
        text: 'V is my partner',
        type: 'relational',
        importance: 0.95,
        tags: ['core_profile'],
      });

      expect(result.action).toBe('deduplicated');
      expect(store.updateMemory).toHaveBeenCalledWith('existing-001', expect.objectContaining({
        tags: expect.arrayContaining(['relationship', 'core_profile', 'durable']),
      }));
      expect(result.memory.tags).toEqual(expect.arrayContaining(['relationship', 'core_profile', 'durable']));
      expect(result.memory.retentionClass).toBe('durable');
    });

    it('skips dedup matches of a different type', async () => {
      const emotionalMatch = makeExistingMemory({
        type: 'emotional', // Different from the 'semantic' we'll write
        similarity: 0.96,
      });

      // Dedup check returns a match but of different type
      store.searchByEmbedding.mockReturnValueOnce([emotionalMatch]);
      // Contradiction check returns nothing
      store.searchByEmbedding.mockReturnValueOnce([]);

      const result = await writer.write({
        text: 'New semantic memory',
        type: 'semantic',
      });

      expect(result.action).toBe('created');
      expect(store.insertMemory).toHaveBeenCalledOnce();
    });

    it('supersedes old memory when new one has higher confidence', async () => {
      const oldMemory = makeExistingMemory({
        type: 'semantic',
        confidence: 0.6, // Lower confidence than the new one
      });

      // No exact duplicates
      store.searchByEmbedding.mockReturnValueOnce([]);
      // Broader contradiction search returns the old memory
      store.searchByEmbedding.mockReturnValueOnce([oldMemory]);

      const result = await writer.write({
        text: 'Updated fact with better confidence',
        type: 'semantic',
        confidence: 0.9, // Higher than old's 0.6
      });

      expect(result.action).toBe('superseded');
      // Old memory should have been marked superseded
      expect(store.updateMemory).toHaveBeenCalledWith('existing-001', expect.objectContaining({
        supersededBy: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
      }));
      // New memory should also have been inserted
      expect(store.insertMemory).toHaveBeenCalledOnce();
    });

    it('does not supersede when old memory has higher confidence', async () => {
      const oldMemory = makeExistingMemory({
        type: 'semantic',
        confidence: 0.95, // Higher than the new one
      });

      // No exact duplicates
      store.searchByEmbedding.mockReturnValueOnce([]);
      // Broader contradiction search returns the old memory
      store.searchByEmbedding.mockReturnValueOnce([oldMemory]);

      const result = await writer.write({
        text: 'Less confident update',
        type: 'semantic',
        confidence: 0.7, // Lower than old's 0.95
      });

      // Should create normally, not supersede
      expect(result.action).toBe('created');
      // updateMemory should NOT have been called for supersession
      expect(store.updateMemory).not.toHaveBeenCalled();
      expect(store.insertMemory).toHaveBeenCalledOnce();
    });

    it('calls searchByEmbedding with correct thresholds', async () => {
      store.searchByEmbedding.mockReturnValue([]);

      await writer.write({ text: 'test', type: 'episodic' });

      // First call: dedup threshold for episodic
      expect(store.searchByEmbedding).toHaveBeenCalledWith(
        expect.any(Float32Array),
        DEDUP_THRESHOLD.episodic,
        3,
      );

      // Second call: contradiction threshold (dedup - offset)
      expect(store.searchByEmbedding).toHaveBeenCalledWith(
        expect.any(Float32Array),
        DEDUP_THRESHOLD.episodic - MEMORY_CONFIG.contradictionThresholdOffset,
        5,
      );
    });

    it('sets extractedAt and lastAccessed to current time', async () => {
      const before = Date.now();
      const result = await writer.write({ text: 'time test', type: 'semantic' });
      const after = Date.now();

      expect(result.memory.extractedAt).toBeGreaterThanOrEqual(before);
      expect(result.memory.extractedAt).toBeLessThanOrEqual(after);
      expect(result.memory.lastAccessed).toBe(result.memory.extractedAt);
    });

    it('passes through sensitivity when specified', async () => {
      const result = await writer.write({
        text: 'Intimate secret',
        type: 'emotional',
        sensitivity: 'intimate',
      });

      expect(result.memory.sensitivity).toBe('intimate');
      const [insertedMemory] = store.insertMemory.mock.calls[0];
      expect(insertedMemory.sensitivity).toBe('intimate');
    });

    it('defaults sensitivity to personal when not specified', async () => {
      const result = await writer.write({ text: 'Default test', type: 'semantic' });

      expect(result.memory.sensitivity).toBe('personal');
      const [insertedMemory] = store.insertMemory.mock.calls[0];
      expect(insertedMemory.sensitivity).toBe('personal');
    });

    it('passes through consentFlags when specified', async () => {
      const result = await writer.write({
        text: 'Consent test',
        type: 'semantic',
        consentFlags: { allowRecall: false, deleteOnRequest: true },
      });

      expect(result.memory.consentFlags).toEqual({ allowRecall: false, deleteOnRequest: true });
      const [insertedMemory] = store.insertMemory.mock.calls[0];
      expect(insertedMemory.consentFlags).toEqual({ allowRecall: false, deleteOnRequest: true });
    });

    it('leaves consentFlags undefined when not specified', async () => {
      const result = await writer.write({ text: 'No consent', type: 'semantic' });

      expect(result.memory.consentFlags).toBeUndefined();
    });
  });

  describe('upsert()', () => {
    it('creates a new memory when no similar exists', async () => {
      const result = await writer.upsert({
        text: 'A brand new fact',
        type: 'semantic',
        importance: 0.7,
      });

      expect(result.action).toBe('created');
      expect(result.memory.text).toBe('A brand new fact');
      expect(result.memory.sourceRef).toBe('tool:memory_upsert');
      expect(store.insertMemory).toHaveBeenCalledOnce();
    });

    it('applies durable retention semantics during upsert', async () => {
      const result = await writer.upsert({
        text: 'Our first dance song is Clair de Lune',
        type: 'relational',
        retentionClass: 'durable',
      });

      expect(result.action).toBe('created');
      expect(result.memory.retentionClass).toBe('durable');
      expect(result.memory.tags).toContain('durable');
      const [insertedMemory] = store.insertMemory.mock.calls[0];
      expect(insertedMemory.tags).toContain('durable');
    });

    it('supersedes similar memory and creates new one', async () => {
      const existing = makeExistingMemory({ type: 'semantic', confidence: 0.7 });

      // Upsert searches at the broader threshold (dedup - offset)
      store.searchByEmbedding.mockReturnValueOnce([existing]);

      const result = await writer.upsert({
        text: 'Updated fact about V',
        type: 'semantic',
        importance: 0.8,
        confidence: 0.9,
      });

      expect(result.action).toBe('superseded');
      // Old memory should have been superseded
      expect(store.updateMemory).toHaveBeenCalledWith('existing-001', expect.objectContaining({
        supersededBy: expect.any(String),
      }));
      // New memory should have been inserted
      expect(store.insertMemory).toHaveBeenCalledOnce();
      expect(result.memory.text).toBe('Updated fact about V');
    });

    it('supersedes regardless of confidence (unlike write)', async () => {
      // In write(), low confidence wouldn't supersede. In upsert(), it always does.
      const existing = makeExistingMemory({ type: 'semantic', confidence: 0.95 });

      store.searchByEmbedding.mockReturnValueOnce([existing]);

      const result = await writer.upsert({
        text: 'Low confidence update',
        type: 'semantic',
        confidence: 0.3, // Lower than existing
      });

      expect(result.action).toBe('superseded');
      expect(store.updateMemory).toHaveBeenCalled();
      expect(store.insertMemory).toHaveBeenCalledOnce();
    });

    it('throws on invalid memory type', async () => {
      await expect(
        writer.upsert({ text: 'test', type: 'bogus' as any }),
      ).rejects.toThrow('Invalid memory type: bogus');
    });

    it('skips similar memories of different type', async () => {
      const emotional = makeExistingMemory({ type: 'emotional' });

      store.searchByEmbedding.mockReturnValueOnce([emotional]);

      const result = await writer.upsert({
        text: 'Semantic fact',
        type: 'semantic',
      });

      expect(result.action).toBe('created');
      expect(store.updateMemory).not.toHaveBeenCalled();
      expect(store.insertMemory).toHaveBeenCalledOnce();
    });
  });

  describe('importBatch()', () => {
    it('processes multiple records sequentially', async () => {
      const records: MemoryWriteOptions[] = [
        { text: 'Fact one', type: 'semantic', importance: 0.7 },
        { text: 'Event two', type: 'episodic', importance: 0.5 },
        { text: 'Feeling three', type: 'emotional', emotionalValence: 0.8 },
      ];

      const result = await writer.importBatch(records);

      expect(result.written).toBe(3);
      expect(result.deduplicated).toBe(0);
      expect(result.superseded).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.results).toHaveLength(3);

      // Each record should have been embedded and inserted
      expect(embeddings.embed).toHaveBeenCalledTimes(3);
      expect(store.insertMemory).toHaveBeenCalledTimes(3);
    });

    it('returns correct counts for mixed outcomes', async () => {
      const existingMemory = makeExistingMemory({ type: 'semantic' });

      // Record 1: no duplicates found → created
      store.searchByEmbedding.mockReturnValueOnce([]); // dedup
      store.searchByEmbedding.mockReturnValueOnce([]); // contradiction

      // Record 2: duplicate found → deduplicated
      store.searchByEmbedding.mockReturnValueOnce([existingMemory]); // dedup returns match

      // Record 3: no duplicates found → created
      store.searchByEmbedding.mockReturnValueOnce([]); // dedup
      store.searchByEmbedding.mockReturnValueOnce([]); // contradiction

      const records: MemoryWriteOptions[] = [
        { text: 'New fact', type: 'semantic' },
        { text: 'Duplicate fact', type: 'semantic' },
        { text: 'Another fact', type: 'semantic' },
      ];

      const result = await writer.importBatch(records);

      expect(result.written).toBe(2);
      expect(result.deduplicated).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.results).toHaveLength(3);
      expect(result.results[0].action).toBe('created');
      expect(result.results[1].action).toBe('deduplicated');
      expect(result.results[2].action).toBe('created');
    });

    it('counts errors without stopping the batch', async () => {
      // First record: success
      store.searchByEmbedding.mockReturnValueOnce([]);
      store.searchByEmbedding.mockReturnValueOnce([]);

      // Second record: embed throws
      (embeddings.embed as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeEmbedding()) // first record succeeds
        .mockRejectedValueOnce(new Error('embedding failed')) // second record fails
        .mockResolvedValueOnce(makeEmbedding()); // third record succeeds

      // Third record: success
      store.searchByEmbedding.mockReturnValueOnce([]);
      store.searchByEmbedding.mockReturnValueOnce([]);

      const records: MemoryWriteOptions[] = [
        { text: 'Good memory', type: 'semantic' },
        { text: 'Bad memory', type: 'semantic' },
        { text: 'Also good', type: 'semantic' },
      ];

      const result = await writer.importBatch(records);

      expect(result.written).toBe(2);
      expect(result.errors).toBe(1);
      expect(result.results).toHaveLength(2); // Only successful results
    });

    it('handles empty batch', async () => {
      const result = await writer.importBatch([]);

      expect(result.written).toBe(0);
      expect(result.deduplicated).toBe(0);
      expect(result.superseded).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.results).toHaveLength(0);
    });

    it('counts superseded records correctly', async () => {
      const oldMemory = makeExistingMemory({ type: 'semantic', confidence: 0.3 });

      // Record 1: no dup, but contradiction found → superseded
      store.searchByEmbedding.mockReturnValueOnce([]); // dedup: nothing
      store.searchByEmbedding.mockReturnValueOnce([oldMemory]); // contradiction: found

      const records: MemoryWriteOptions[] = [
        { text: 'Updated fact', type: 'semantic', confidence: 0.9 },
      ];

      const result = await writer.importBatch(records);

      expect(result.written).toBe(1); // superseded counts as written
      expect(result.superseded).toBe(1);
      expect(result.results[0].action).toBe('superseded');
    });
  });
});
