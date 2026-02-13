import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { MemoryStore } from './store.js';
import { SalienceDecay } from './decay.js';
import { DECAY_HALFLIFE, MEMORY_CONFIG } from './types.js';
import type { PurrMemory, MemoryType } from './types.js';
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

  it('decays old memories', () => {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const mem = makeMemory({
      type: 'episodic',
      salience: 1.0,
      lastAccessed: oneWeekAgo,
    });
    store.insertMemory(mem, makeEmbedding());

    decay.run();

    const updated = store.getAllActiveMemories();
    expect(updated).toHaveLength(1);
    // Episodic half-life is 7 days, so after 7 days salience should be ~0.5
    expect(updated[0].salience).toBeCloseTo(0.5, 1);
  });

  it('never decays below floor', () => {
    const veryOld = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const mem = makeMemory({
      type: 'episodic',
      salience: 1.0,
      lastAccessed: veryOld,
    });
    store.insertMemory(mem, makeEmbedding());

    decay.run();

    const updated = store.getAllActiveMemories();
    expect(updated[0].salience).toBe(MEMORY_CONFIG.salienceFloor);
  });

  it('procedural memories decay slower than episodic', () => {
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

    decay.run();

    const all = store.getAllActiveMemories();
    const ep = all.find(m => m.id === 'ep')!;
    const pr = all.find(m => m.id === 'pr')!;

    expect(pr.salience).toBeGreaterThan(ep.salience);
  });

  it('does not update recently accessed memories', () => {
    const mem = makeMemory({
      salience: 0.8,
      lastAccessed: Date.now(),
    });
    store.insertMemory(mem, makeEmbedding());

    decay.run();

    const updated = store.getAllActiveMemories();
    // No meaningful change, salience should remain 0.8
    expect(updated[0].salience).toBe(0.8);
  });
});
