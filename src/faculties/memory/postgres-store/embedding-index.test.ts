import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  L2_EMBEDDING_ANN_INDEX_BASE_NAME,
  buildL2EmbeddingAnnIndexConcurrently,
  buildL2EmbeddingAnnIndexCreateStatement,
  embeddingAnnOrderExpression,
  l2EmbeddingAnnIndexName,
} from './embedding-index.js';

describe('L2 embedding ANN index naming (a27w.2 remediation)', () => {
  it('bakes the runtime dimension into the index name', () => {
    expect(l2EmbeddingAnnIndexName(768)).toBe(`${L2_EMBEDDING_ANN_INDEX_BASE_NAME}_d768`);
    expect(l2EmbeddingAnnIndexName(1024)).toBe(`${L2_EMBEDDING_ANN_INDEX_BASE_NAME}_d1024`);
  });

  it('mints a distinct name per dimension so a dimension change cannot collide', () => {
    // The whole point: CREATE INDEX IF NOT EXISTS collides on NAME only, never on
    // the indexed expression. Different dimensions must yield different names.
    expect(l2EmbeddingAnnIndexName(768)).not.toBe(l2EmbeddingAnnIndexName(1024));
  });

  it('rejects a non-positive-integer dimension fail-closed', () => {
    expect(() => l2EmbeddingAnnIndexName(0)).toThrow(/positive integer/);
    expect(() => l2EmbeddingAnnIndexName(-4)).toThrow(/positive integer/);
    expect(() => l2EmbeddingAnnIndexName(3.5)).toThrow(/positive integer/);
  });
});

describe('L2 embedding ANN index build statement', () => {
  it('emits a plain CREATE INDEX by default', () => {
    const statement = buildL2EmbeddingAnnIndexCreateStatement(4);
    expect(statement).toContain('CREATE INDEX IF NOT EXISTS idx_l2_memories_embedding_hnsw_cosine_d4');
    expect(statement).not.toContain('CONCURRENTLY');
    expect(statement).toContain('USING hnsw ((embedding::vector(4)) vector_cosine_ops)');
    expect(statement).toContain('WHERE embedding IS NOT NULL');
  });

  it('emits CREATE INDEX CONCURRENTLY when requested (must run outside a txn)', () => {
    const statement = buildL2EmbeddingAnnIndexCreateStatement(8, { concurrent: true });
    expect(statement).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_l2_memories_embedding_hnsw_cosine_d8');
    expect(statement).toContain('::vector(8)');
  });
});

describe('L2 embedding ANN index background build', () => {
  it('reports degraded instead of rejecting when connection acquisition fails', async () => {
    const connectionError = new Error('database unavailable');
    const pool = {
      connect: vi.fn().mockRejectedValue(connectionError),
    } as unknown as Pool;

    await expect(buildL2EmbeddingAnnIndexConcurrently(pool, 4)).resolves.toMatchObject({
      status: 'degraded',
      indexName: `${L2_EMBEDDING_ANN_INDEX_BASE_NAME}_d4`,
      droppedIndexes: [],
      error: connectionError,
    });
  });
});

describe('embeddingAnnOrderExpression', () => {
  it('casts both operands to the runtime dimension so the plan matches the index', () => {
    expect(embeddingAnnOrderExpression('embedding', '$1', 4)).toBe(
      'embedding::vector(4) <=> $1::vector(4)',
    );
  });
});
