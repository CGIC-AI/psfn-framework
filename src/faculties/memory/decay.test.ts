import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { MemoryStore } from './store.js';
import { SalienceDecay } from './decay.js';
import { MEMORY_CONFIG } from './types.js';
import type { PurrMemory } from './types.js';
import type { MemoryStorePort } from './memory-store-port.js';
import { DEFAULT_EMBEDDING_CONFIG } from './embedding.js';

const EMBEDDING_DIMS = DEFAULT_EMBEDDING_CONFIG.dims;

function makeMemory(overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id: `mem-${Math.random().toString(36).slice(2)}`,
    text: 'Test memory',
    type: 'semantic',
    importance: 0.7,
    confidence: 0.9,
    emotionalValence: 0.0,
    salience: 1.0,
    sourceRef: 'ch1:1000',
    extractedAt: Date.now(),
    lastAccessed: Date.now(),
    accessCount: 1,
    tags: [],
    ...overrides,
  };
}

function makeEmbedding(): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) arr[i] = Math.random() - 0.5;
  return arr;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('SalienceDecay', () => {
  let db: Database.Database;
  let store: MemoryStore;
  let decay: SalienceDecay;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    store = new MemoryStore(db);
    decay = new SalienceDecay(store);
  });

  afterEach(() => {
    decay.stop();
    db.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('decays old memories', async () => {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const mem = makeMemory({
      type: 'episodic',
      salience: 1.0,
      lastAccessed: oneWeekAgo,
    });
    store.insertMemory(mem, makeEmbedding());

    await decay.run();

    const updated = store.getAllActiveMemories();
    expect(updated).toHaveLength(1);
    // Episodic half-life is 7 days, so after 7 days salience should be ~0.5
    expect(updated[0].salience).toBeCloseTo(0.5, 1);
  });

  it('never decays below floor', async () => {
    const veryOld = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const mem = makeMemory({
      type: 'episodic',
      salience: 1.0,
      lastAccessed: veryOld,
    });
    store.insertMemory(mem, makeEmbedding());

    await decay.run();

    const updated = store.getAllActiveMemories();
    expect(updated[0].salience).toBe(MEMORY_CONFIG.salienceFloor);
  });

  it('procedural memories decay slower than episodic', async () => {
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

    const episodic = makeMemory({
      id: 'ep',
      type: 'episodic',
      salience: 1.0,
      lastAccessed: twoWeeksAgo,
    });
    const procedural = makeMemory({
      id: 'pr',
      type: 'procedural',
      salience: 1.0,
      lastAccessed: twoWeeksAgo,
    });

    store.insertMemory(episodic, makeEmbedding());
    store.insertMemory(procedural, makeEmbedding());

    await decay.run();

    const all = store.getAllActiveMemories();
    const ep = all.find(m => m.id === 'ep')!;
    const pr = all.find(m => m.id === 'pr')!;

    expect(pr.salience).toBeGreaterThan(ep.salience);
  });

  it('retains high-intensity memories longer than medium and low-intensity memories', async () => {
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

    const lowIntensity = makeMemory({
      id: 'low-intensity',
      type: 'emotional',
      salience: 1.0,
      emotionalValence: 0,
      lastAccessed: twoWeeksAgo,
    });
    const mediumIntensity = makeMemory({
      id: 'medium-intensity',
      type: 'emotional',
      salience: 1.0,
      emotionalValence: 0.4,
      formationVAD: { valence: 0.4, arousal: 0.2, dominance: 0 },
      lastAccessed: twoWeeksAgo,
    });
    const highIntensity = makeMemory({
      id: 'high-intensity',
      type: 'emotional',
      salience: 1.0,
      emotionalValence: 1,
      formationVAD: { valence: 1, arousal: 1, dominance: 0.2 },
      lastAccessed: twoWeeksAgo,
    });

    store.insertMemory(lowIntensity, makeEmbedding());
    store.insertMemory(mediumIntensity, makeEmbedding());
    store.insertMemory(highIntensity, makeEmbedding());

    await decay.run();

    const all = store.getAllActiveMemories();
    const low = all.find(m => m.id === 'low-intensity')!;
    const medium = all.find(m => m.id === 'medium-intensity')!;
    const high = all.find(m => m.id === 'high-intensity')!;

    expect(low.salience).toBeLessThan(medium.salience);
    expect(medium.salience).toBeLessThan(high.salience);
    expect(low.salience).toBeCloseTo(0.5, 1);
  });

  it('composes emotional intensity persistence with durable retention multipliers', async () => {
    const twoYearsAgo = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;

    const standardLowIntensity = makeMemory({
      id: 'standard-low-intensity',
      type: 'relational',
      salience: 1.0,
      emotionalValence: 0,
      lastAccessed: twoYearsAgo,
      tags: [],
    });
    const durableLowIntensity = makeMemory({
      id: 'durable-low-intensity',
      type: 'relational',
      salience: 1.0,
      emotionalValence: 0,
      lastAccessed: twoYearsAgo,
      tags: ['core_profile'],
    });
    const durableHighIntensity = makeMemory({
      id: 'durable-high-intensity',
      type: 'relational',
      salience: 1.0,
      emotionalValence: 0.95,
      formationVAD: { valence: 0.9, arousal: 1, dominance: 0.2 },
      lastAccessed: twoYearsAgo,
      tags: ['core_profile'],
    });

    store.insertMemory(standardLowIntensity, makeEmbedding());
    store.insertMemory(durableLowIntensity, makeEmbedding());
    store.insertMemory(durableHighIntensity, makeEmbedding());

    await decay.run();

    const all = store.getAllActiveMemories();
    const standardLow = all.find(m => m.id === 'standard-low-intensity')!;
    const durableLow = all.find(m => m.id === 'durable-low-intensity')!;
    const durableHigh = all.find(m => m.id === 'durable-high-intensity')!;

    expect(standardLow.salience).toBe(MEMORY_CONFIG.salienceFloor);
    expect(durableLow.salience).toBeGreaterThan(standardLow.salience);
    expect(durableHigh.salience).toBeGreaterThan(durableLow.salience);
  });

  it('preserves durable core profile memories better than transient memories', async () => {
    const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;

    const durable = makeMemory({
      id: 'durable-rel',
      type: 'relational',
      salience: 1.0,
      lastAccessed: oneYearAgo,
      tags: ['core_profile'],
    });
    const transient = makeMemory({
      id: 'transient-rel',
      type: 'relational',
      salience: 1.0,
      lastAccessed: oneYearAgo,
      tags: [],
    });

    store.insertMemory(durable, makeEmbedding());
    store.insertMemory(transient, makeEmbedding());

    await decay.run();

    const all = store.getAllActiveMemories();
    const durableUpdated = all.find(m => m.id === 'durable-rel')!;
    const transientUpdated = all.find(m => m.id === 'transient-rel')!;

    expect(transientUpdated.salience).toBe(MEMORY_CONFIG.salienceFloor);
    expect(durableUpdated.salience).toBeGreaterThan(transientUpdated.salience);
    expect(durableUpdated.salience).toBeGreaterThan(MEMORY_CONFIG.durableSalienceFloor);
  });

  it('retains durable preference memories longer than ordinary durable memories', async () => {
    const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;

    const preference = makeMemory({
      id: 'durable-preference',
      text: 'My favorite color is teal.',
      type: 'semantic',
      salience: 1.0,
      lastAccessed: oneYearAgo,
      tags: ['preference', 'favorite', 'preference:color'],
      retentionClass: 'durable',
    });
    const durable = makeMemory({
      id: 'durable-standard',
      text: 'Durable profile memory',
      type: 'semantic',
      salience: 1.0,
      lastAccessed: oneYearAgo,
      tags: ['durable'],
      retentionClass: 'durable',
    });
    const standard = makeMemory({
      id: 'standard-semantic',
      text: 'Standard semantic memory',
      type: 'semantic',
      salience: 1.0,
      lastAccessed: oneYearAgo,
      tags: [],
    });

    store.insertMemory(preference, makeEmbedding());
    store.insertMemory(durable, makeEmbedding());
    store.insertMemory(standard, makeEmbedding());

    await decay.run();

    const all = store.getAllActiveMemories();
    const preferenceUpdated = all.find(m => m.id === 'durable-preference')!;
    const durableUpdated = all.find(m => m.id === 'durable-standard')!;
    const standardUpdated = all.find(m => m.id === 'standard-semantic')!;

    expect(preferenceUpdated.salience).toBeGreaterThan(durableUpdated.salience);
    expect(durableUpdated.salience).toBeGreaterThan(standardUpdated.salience);
    expect(preferenceUpdated.salience).toBeGreaterThan(MEMORY_CONFIG.preferenceDurableSalienceFloor);
  });

  it('never decays durable memories below durable floor', async () => {
    const veryOld = Date.now() - 20 * 365 * 24 * 60 * 60 * 1000;
    const mem = makeMemory({
      type: 'relational',
      salience: 1.0,
      lastAccessed: veryOld,
      tags: ['core_relationship'],
    });
    store.insertMemory(mem, makeEmbedding());

    await decay.run();

    const updated = store.getAllActiveMemories();
    expect(updated[0].salience).toBe(MEMORY_CONFIG.durableSalienceFloor);
  });

  it('does not update recently accessed memories', async () => {
    const mem = makeMemory({
      salience: 0.8,
      lastAccessed: Date.now(),
    });
    store.insertMemory(mem, makeEmbedding());

    await decay.run();

    const updated = store.getAllActiveMemories();
    // No meaningful change, salience should remain 0.8
    expect(updated[0].salience).toBe(0.8);
  });

  it('batches eligible salience updates instead of updating each memory individually', async () => {
    const updateSpy = vi.spyOn(store, 'updateMemory');
    const bulkSpy = vi.spyOn(store, 'bulkUpdateSalience');
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    store.insertMemory(makeMemory({
      id: 'tx-check',
      type: 'episodic',
      salience: 1.0,
      lastAccessed: oneWeekAgo,
    }), makeEmbedding());

    await decay.run();

    expect(updateSpy).not.toHaveBeenCalled();
    expect(bulkSpy).toHaveBeenCalledTimes(1);
    expect(bulkSpy).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'tx-check', salience: expect.any(Number) }),
    ]);
  });

  it('uses provided maintenance interval when starting timer', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    decay.start(12_345);

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 12_345);
  });

  it('uses default maintenance interval when no override is provided', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    decay.start();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MEMORY_CONFIG.maintenanceIntervalMs);
  });

  it('stops an in-flight run before reading the next batch', async () => {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const firstBatchWriteStarted = createDeferred();
    const firstBatchWriteRelease = createDeferred();
    const firstBatch = makeMemory({
      id: 'cancel-page-0',
      type: 'episodic',
      salience: 1.0,
      lastAccessed: oneWeekAgo,
    });
    const secondBatch = makeMemory({
      id: 'cancel-page-1',
      type: 'episodic',
      salience: 1.0,
      lastAccessed: oneWeekAgo,
    });
    const listActiveMemories = vi.fn(async (options?: { limit?: number; offset?: number }) => (
      options?.offset === 0 ? [firstBatch] : [secondBatch]
    ));
    const bulkUpdateSalience = vi.fn(async () => {
      firstBatchWriteStarted.resolve();
      await firstBatchWriteRelease.promise;
    });
    const cancellableDecay = new SalienceDecay({
      listActiveMemories,
      bulkUpdateSalience,
    } as unknown as MemoryStorePort, { batchSize: 1 });

    const runPromise = cancellableDecay.run();
    await firstBatchWriteStarted.promise;

    cancellableDecay.stop();
    firstBatchWriteRelease.resolve();
    await runPromise;

    expect(listActiveMemories).toHaveBeenCalledTimes(1);
    expect(listActiveMemories).toHaveBeenCalledWith({ limit: 1, offset: 0 });
    expect(bulkUpdateSalience).toHaveBeenCalledTimes(1);
  });

  it('processes salience decay across multiple pages of active memories', async () => {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const baseExtractedAt = Date.now();
    const pagedDecay = new SalienceDecay(store, { batchSize: 2 });
    const bulkSpy = vi.spyOn(store, 'bulkUpdateSalience');

    for (let i = 0; i < 5; i += 1) {
      store.insertMemory(makeMemory({
        id: `batch-${i}`,
        type: 'episodic',
        salience: 1.0,
        extractedAt: baseExtractedAt - i,
        lastAccessed: oneWeekAgo,
      }), makeEmbedding());
    }

    await pagedDecay.run();

    const updated = store.getAllActiveMemories(100);
    expect(updated).toHaveLength(5);
    for (const memory of updated) {
      expect(memory.salience).toBeCloseTo(0.5, 1);
    }
    expect(bulkSpy).toHaveBeenCalledTimes(3);
    expect(bulkSpy.mock.calls.map(([updates]) => updates.length)).toEqual([2, 2, 1]);
    expect(bulkSpy.mock.calls.map(([updates]) => updates.map(update => update.id))).toEqual([
      ['batch-0', 'batch-1'],
      ['batch-2', 'batch-3'],
      ['batch-4'],
    ]);
  });

  it('uses paginated reads while decaying active memories', async () => {
    const pagedDecay = new SalienceDecay(store, { batchSize: 2 });
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i += 1) {
      store.insertMemory(makeMemory({
        id: `offset-${i}`,
        type: 'episodic',
        salience: 1.0,
        lastAccessed: oneWeekAgo,
      }), makeEmbedding());
    }

    const listSpy = vi.spyOn(store, 'listActiveMemories');
    await pagedDecay.run();

    expect(listSpy).toHaveBeenCalledWith({ limit: 2, offset: 0 });
    expect(listSpy).toHaveBeenCalledWith({ limit: 2, offset: 2 });
    expect(listSpy).toHaveBeenCalledWith({ limit: 2, offset: 4 });
  });

  it('propagates salience batch write failures without reading later pages', async () => {
    const pagedDecay = new SalienceDecay(store, { batchSize: 2 });
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 4; i += 1) {
      store.insertMemory(makeMemory({
        id: `failure-${i}`,
        type: 'episodic',
        salience: 1.0,
        extractedAt: Date.now() - i,
        lastAccessed: oneWeekAgo,
      }), makeEmbedding());
    }

    const listSpy = vi.spyOn(store, 'listActiveMemories');
    vi.spyOn(store, 'bulkUpdateSalience').mockImplementation(() => {
      throw new Error('simulated salience batch failure');
    });

    await expect(pagedDecay.run()).rejects.toThrow('simulated salience batch failure');
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(store.getById('failure-0')?.salience).toBe(1.0);
    expect(store.getById('failure-1')?.salience).toBe(1.0);
  });

  it('yields to the event loop between salience decay pages', async () => {
    const pagedDecay = new SalienceDecay(store, { batchSize: 1 });
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const baseExtractedAt = Date.now();
    for (let i = 0; i < 2; i += 1) {
      store.insertMemory(makeMemory({
        id: `yield-${i}`,
        type: 'episodic',
        salience: 1.0,
        extractedAt: baseExtractedAt - i,
        lastAccessed: oneWeekAgo,
      }), makeEmbedding());
    }

    let immediateRan = false;
    let yieldedBeforeSecondPage = false;
    const listActiveMemories = store.listActiveMemories.bind(store);
    vi.spyOn(store, 'listActiveMemories').mockImplementation((options) => {
      if (options?.offset === 1) {
        yieldedBeforeSecondPage = immediateRan;
      }
      return listActiveMemories(options);
    });

    const runPromise = pagedDecay.run();
    setImmediate(() => {
      immediateRan = true;
    });
    await runPromise;

    expect(yieldedBeforeSecondPage).toBe(true);
  });
});
