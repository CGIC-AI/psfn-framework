import type Database from 'better-sqlite3';
import { normalizeMemoryScopeQuery, type MemoryScopeQuery } from '../types.js';
import {
  embeddingToBuffer,
  l2DistanceToCosineSimilarity,
  validateEmbeddingDimensions,
} from './embeddings.js';
import { mapMemoryRow } from './mappers.js';
import { buildScopeQuerySql } from './trust-filters.js';
import type { MemoryRow, MemorySearchResult } from './types.js';

export function searchByEmbedding(
  db: Database.Database,
  embeddingDims: number,
  embedding: Float32Array,
  threshold: number,
  limit: number,
  scopeQuery?: MemoryScopeQuery,
): MemorySearchResult[] {
  validateEmbeddingDimensions(embedding, embeddingDims, 'search');

  const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
  const scopeSql = buildScopeQuerySql(normalizedScopeQuery);
  const stmt = db.prepare(`
    SELECT
      m.*,
      v.distance
    FROM l2_memory_embeddings v
    JOIN l2_memories m ON m.id = v.memory_id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND m.superseded_by IS NULL
      AND m.deleted_at IS NULL
      ${scopeSql.clause}
    ORDER BY v.distance ASC
  `);

  const rows = stmt.all(
    embeddingToBuffer(embedding),
    limit * 2,
    ...scopeSql.params,
  ) as Array<MemoryRow & {
    distance: number;
  }>;

  return rows
    .map(row => {
      const similarity = l2DistanceToCosineSimilarity(row.distance);
      if (similarity < threshold) return null;
      return { ...mapMemoryRow(row), similarity };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .slice(0, limit);
}
