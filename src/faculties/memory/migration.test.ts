import type { Pool, PoolClient, QueryResult } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import {
  migratePostgresMemoryEmbeddings,
  runRetrievalValidation,
} from './migration.js';

const postgresMocks = vi.hoisted(() => {
  const pool = {
    end: vi.fn(async () => undefined),
  };
  const clientQueries: Array<{ text: string; values: readonly unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
      clientQueries.push({ text, values });
      return {
        rows: [],
        command: 'OK',
        rowCount: 1,
        oid: 0,
        fields: [],
      } as QueryResult;
    }),
  };

  return {
    pool,
    client,
    clientQueries,
    createPostgresPool: vi.fn(() => pool),
    ensurePostgresSchema: vi.fn(async () => undefined),
    queryRows: vi.fn(async () => []),
    withPostgresClient: vi.fn(async (_pool: unknown, handler: (client: PoolClient) => Promise<unknown>) => (
      await handler(client as unknown as PoolClient)
    )),
  };
});

vi.mock('../../persistence/postgres.js', () => ({
  createPostgresPool: postgresMocks.createPostgresPool,
  ensurePostgresSchema: postgresMocks.ensurePostgresSchema,
  queryRows: postgresMocks.queryRows,
  withPostgresClient: postgresMocks.withPostgresClient,
}));

const TEST_DIMS = 2;

interface CountingEmbeddingServiceOptions {
  delayMs?: number;
}

class CountingEmbeddingService implements EmbeddingProviderPort {
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
      return texts.map(text => new Float32Array(this.encoder(text)));
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

function improvedEncoder(text: string): readonly number[] {
  return IMPROVED_VECTORS[classifySemanticKey(text)];
}

function readFloatVector(buffer: Buffer): number[] {
  const values: number[] = [];
  for (let index = 0; index < buffer.byteLength; index += Float32Array.BYTES_PER_ELEMENT) {
    values.push(buffer.readFloatLE(index));
  }
  return values;
}

beforeEach(() => {
  postgresMocks.pool.end.mockClear();
  postgresMocks.client.query.mockClear();
  postgresMocks.clientQueries.length = 0;
  postgresMocks.createPostgresPool.mockClear();
  postgresMocks.ensurePostgresSchema.mockClear();
  postgresMocks.queryRows.mockReset();
  postgresMocks.queryRows.mockResolvedValue([]);
  postgresMocks.withPostgresClient.mockClear();
});

describe('migratePostgresMemoryEmbeddings', () => {
  it('re-embeds all Postgres rows in configured batch sizes', async () => {
    postgresMocks.queryRows.mockResolvedValue([
      { id: 'm-1', text: 'cat purr memory' },
      { id: 'm-2', text: 'rocket telemetry memory' },
      { id: 'm-3', text: 'bread recipe memory' },
      { id: 'm-4', text: 'cat comfort memory' },
      { id: 'm-5', text: 'space station memory' },
    ]);
    const fresh = new CountingEmbeddingService(improvedEncoder);

    const result = await migratePostgresMemoryEmbeddings(' postgres://memory ', fresh, {
      batchSize: 2,
      parallelism: 1,
    });

    expect(postgresMocks.createPostgresPool).toHaveBeenCalledWith('postgres://memory', {
      applicationName: 'psfn-memory-embedding-migration',
      allowExitOnIdle: true,
    });
    expect(postgresMocks.ensurePostgresSchema).toHaveBeenCalledWith(
      postgresMocks.pool as unknown as Pool,
      expect.any(Array),
    );
    expect(postgresMocks.queryRows.mock.calls[0]?.[1]).toContain('WHERE deleted_at IS NULL');
    expect(result).toMatchObject({
      total: 5,
      processed: 5,
      updated: 5,
      failed: 0,
      batchSize: 2,
      parallelism: 1,
      failures: [],
    });
    expect(fresh.batches.map(batch => batch.length)).toEqual([2, 2, 1]);
    expect(postgresMocks.clientQueries).toHaveLength(5);
    expect(postgresMocks.clientQueries[0]).toMatchObject({
      values: ['m-1', '[1,0]'],
    });
    expect(postgresMocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it('caps worker concurrency to configured parallelism', async () => {
    postgresMocks.queryRows.mockResolvedValue([
      { id: 'm-a', text: 'cat memory one' },
      { id: 'm-b', text: 'cat memory two' },
      { id: 'm-c', text: 'cat memory three' },
      { id: 'm-d', text: 'cat memory four' },
      { id: 'm-e', text: 'cat memory five' },
      { id: 'm-f', text: 'cat memory six' },
    ]);
    const fresh = new CountingEmbeddingService(improvedEncoder, TEST_DIMS, {
      delayMs: 10,
    });

    const result = await migratePostgresMemoryEmbeddings('postgres://memory', fresh, {
      batchSize: 1,
      parallelism: 3,
    });

    expect(result.updated).toBe(6);
    expect(fresh.batches).toHaveLength(6);
    expect(fresh.maxConcurrent).toBeGreaterThan(1);
    expect(fresh.maxConcurrent).toBeLessThanOrEqual(3);
  });
});

describe('runRetrievalValidation', () => {
  it('summarizes retrieval hits from the prepared vector query', async () => {
    const embeddingService = new CountingEmbeddingService(improvedEncoder);
    const db = {
      prepare: () => ({
        all: (embedding: Buffer, topK: number) => {
          const [x, y] = readFloatVector(embedding);
          const memoryId = x === 1 ? 'm-cats' : y === 1 ? 'm-space' : 'm-other';
          return [{ memory_id: memoryId, distance: topK === 1 ? 0.1 : 0.2 }];
        },
      }),
    };

    const report = await runRetrievalValidation(db, embeddingService, [
      { query: 'cat memory recall', expectedMemoryIds: ['m-cats'] },
      { query: 'space launch memory recall', expectedMemoryIds: ['m-space'] },
    ], 1);

    expect(report).toMatchObject({
      status: 'ok',
      topK: 1,
      queryCount: 2,
      expectedQueryCount: 2,
      hitRate: 1,
      meanReciprocalRank: 1,
    });
    expect(report.details.map(detail => detail.topMemoryIds)).toEqual([
      ['m-cats'],
      ['m-space'],
    ]);
  });
});
