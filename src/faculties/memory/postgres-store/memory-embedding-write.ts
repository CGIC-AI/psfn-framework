import type { PoolClient } from 'pg';
import { MEMORY_SUBJECT_SELECT_COLUMNS } from './subject-queries.js';
import { encodeEmbeddingLiteral, parsePgNumber, tryFromMemoryRow, type MemoryRow } from './rows.js';
import { persistMemorySubjectProjection } from './subject-projection.js';

export type MemoryEmbeddingWriteOutcome = 'updated' | 'already_embedded';

/**
 * Store a (re)computed embedding for one L2 memory and re-project its subject
 * classification in the caller's transaction.
 *
 * The embedding is part of the subject evidence digest: the evidence-change
 * trigger bumps the row's authorization revision and invalidates its
 * classification on any embedding change, and subject-authorized reads then
 * drop the row. Re-projecting here keeps a repaired row exactly as visible as
 * it was — same subject class, contacts and room — with fresh evidence.
 *
 * With `onlyIfMissing`, a row whose embedding was filled concurrently is left
 * untouched and reported `already_embedded`, so a rerun never rewrites it.
 */
export async function persistMemoryEmbedding(
  client: PoolClient,
  memoryId: string,
  embedding: Float32Array,
  options: { onlyIfMissing: boolean },
): Promise<MemoryEmbeddingWriteOutcome> {
  const updated = await client.query<MemoryRow & { authorization_revision: string }>(`
    UPDATE l2_memories AS memory
    SET embedding = $2::vector
    WHERE memory.id = $1
      ${options.onlyIfMissing ? 'AND memory.embedding IS NULL' : ''}
    RETURNING ${MEMORY_SUBJECT_SELECT_COLUMNS}, memory.authorization_revision
  `, [memoryId, encodeEmbeddingLiteral(embedding)]);
  const row = updated.rows.at(0);
  if (!row) {
    if (options.onlyIfMissing) return 'already_embedded';
    throw new Error('Memory row disappeared before its embedding could be stored');
  }
  const memory = tryFromMemoryRow(row);
  if (!memory) {
    throw new Error('Memory row cannot be decoded, so its subject classification cannot be re-projected');
  }
  await persistMemorySubjectProjection(
    client,
    memory,
    parsePgNumber(row.authorization_revision, 'authorization_revision'),
    embedding,
  );
  return 'updated';
}
