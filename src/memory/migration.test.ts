import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingService } from '../agent/contracts.js';
import { MemoryStore } from './store.js';
import { migrateMemoryEmbeddings } from './migration.js';
import type { PurrMemory } from './types.js';

const TEST_DIMS = 2;

interface CountingEmbeddingServiceOptions {
  delayMs?: number;
}

class CountingEmbeddingService implements EmbeddingService {
  readonly dims: number;
  readonly batches: string[][] = [];
  maxConcurrent = 0;

  private inFlight = 0;
  private delayMs: number;
  private encoder: (text: string) => readonly number[];

  constructor(
    encoder: (text: string) => readonly number[],
    dims: number = TEST_DIMS,
    options: CountingEmbeddingServiceOptions = {},
  ) {
    this.encoder = encoder;
    this.dims = dims;
    this.delayMs = options.delayMs ?? 0;
  }

  async embed(text: string): Promise<Float32Array> {
    const [embedded] = await this.embedBatch([text]);
    return embedded;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.batches.push([...texts]);
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      if (this.delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.delayMs));
      }
      return texts.map(text => {
        const vector = this.encoder(text);
        return new Float32Array(vector);
      });
    } finally {
      this.inFlight -= 1;
    }
  }
}

function classifySemanticKey(text: string): 'cats' | 'space' | 'bread' | 'other' {
  const normalized = text.toLowerCase();
  if (normalized.includes('cat')) return 'cats';
  if (normalized.includes('rocket') || normalized.includes('space')) return 'space';
  if (normalized.includes('bread') || normalized.includes('bake')) return 'bread';
  return 'other';
}

const IMPROVED_VECTORS: Record<ReturnType<typeof classifySemanticKey>, readonly [number, number]> = {
  cats: [1, 0],
  space: [0, 1],
  bread: [-1, 0],
  other: [0, -1],
};

const LEGACY_VECTORS: Record<ReturnType<typeof classifySemanticKey>, readonly [number, number]> = {
  cats: [0, 1],
  space: [-1, 0],
  bread: [1, 0],
  other: [0, -1],
};

function improvedEncoder(text: string): readonly number[] {
  return IMPROVED_VECTORS[classifySemanticKey(text)];
}

function legacyEncoder(text: string): readonly number[] {
  return LEGACY_VECTORS[classifySemanticKey(text)];
}

function makeMemory(id: string, text: string): PurrMemory {
  const now = Date.now();
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.7,
    confidence: 0.8,
    emotionalValence: 0,
    salience: 0.7,
    sourceRef: 'test:memory-migration',
    extractedAt: now,
    lastAccessed: now,
    accessCount: 1,
    tags: ['migration-test'],
    sensitivity: 'personal',
  };
}

function readEmbedding(db: Database.Database, memoryId: string): Float32Array {
  const row = db.prepare(`
    SELECT embedding
    FROM l2_memory_embeddings
    WHERE memory_id = ?
    LIMIT 1
  `).get(memoryId) as { embedding: Buffer } | undefined;
  if (!row) {
    throw new Error(`Missing embedding row for memory ${memoryId}`);
  }

  const data = row.embedding;
  const out = new Float32Array(data.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (let idx = 0; idx < out.length; idx++) {
    out[idx] = data.readFloatLE(idx * Float32Array.BYTES_PER_ELEMENT);
  }
  return out;
}

describe('migrateMemoryEmbeddings', () => {
  let db: Database.Database;
  let store: MemoryStore;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    store = new MemoryStore(db, TEST_DIMS);
  });

  afterEach(() => {
    db.close();
  });

  it('re-embeds all rows in configured batch sizes', async () => {
    const legacy = new CountingEmbeddingService(legacyEncoder);
    const fresh = new CountingEmbeddingService(improvedEncoder);

    const records = [
      makeMemory('m-1', 'cat purr memory'),
      makeMemory('m-2', 'rocket telemetry memory'),
      makeMemory('m-3', 'bread recipe memory'),
      makeMemory('m-4', 'cat comfort memory'),
      makeMemory('m-5', 'space station memory'),
    ];

    for (const memory of records) {
      store.insertMemory(memory, await legacy.embed(memory.text));
    }

    const result = await migrateMemoryEmbeddings(db, fresh, {
      batchSize: 2,
      parallelism: 1,
    });

    expect(result.total).toBe(5);
    expect(result.processed).toBe(5);
    expect(result.updated).toBe(5);
    expect(result.failed).toBe(0);
    expect(fresh.batches.map(batch => batch.length)).toEqual([2, 2, 1]);

    const migrated = Array.from(readEmbedding(db, 'm-1'));
    expect(migrated).toEqual([1, 0]);
  });

  it('caps worker concurrency to configured parallelism', async () => {
    const legacy = new CountingEmbeddingService(legacyEncoder);
    const fresh = new CountingEmbeddingService(improvedEncoder, TEST_DIMS, {
      delayMs: 10,
    });

    const records = [
      makeMemory('m-a', 'cat memory one'),
      makeMemory('m-b', 'cat memory two'),
      makeMemory('m-c', 'cat memory three'),
      makeMemory('m-d', 'cat memory four'),
      makeMemory('m-e', 'cat memory five'),
      makeMemory('m-f', 'cat memory six'),
    ];

    for (const memory of records) {
      store.insertMemory(memory, await legacy.embed(memory.text));
    }

    const result = await migrateMemoryEmbeddings(db, fresh, {
      batchSize: 1,
      parallelism: 3,
    });

    expect(result.updated).toBe(6);
    expect(fresh.batches).toHaveLength(6);
    expect(fresh.maxConcurrent).toBeGreaterThan(1);
    expect(fresh.maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('runs pre/post retrieval validation for test queries', async () => {
    const legacy = new CountingEmbeddingService(legacyEncoder);
    const improved = new CountingEmbeddingService(improvedEncoder);

    const records = [
      makeMemory('m-cats', 'cat purr profile'),
      makeMemory('m-space', 'rocket launch profile'),
      makeMemory('m-bread', 'bread baking profile'),
    ];

    for (const memory of records) {
      store.insertMemory(memory, await legacy.embed(memory.text));
    }

    const result = await migrateMemoryEmbeddings(db, improved, {
      batchSize: 2,
      parallelism: 2,
      validationTopK: 1,
      validationQueries: [
        { query: 'cat memory recall', expectedMemoryIds: ['m-cats'] },
        { query: 'space launch memory recall', expectedMemoryIds: ['m-space'] },
        { query: 'bread baking memory recall', expectedMemoryIds: ['m-bread'] },
      ],
    });

    expect(result.validation).toBeDefined();
    expect(result.validation?.pre.status).toBe('ok');
    expect(result.validation?.post.status).toBe('ok');
    expect(result.validation?.pre.hitRate).toBe(0);
    expect(result.validation?.post.hitRate).toBe(1);
    expect(result.validation?.pre.meanReciprocalRank).toBe(0);
    expect(result.validation?.post.meanReciprocalRank).toBe(1);
  });
});
