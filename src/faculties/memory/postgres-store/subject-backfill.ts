import type { Pool, PoolClient } from 'pg';
import { MEMORY_SUBJECT_CLASSIFIER_VERSION } from '../../../shared/contracts/memory-subject.js';
import type {
  MemorySubjectBackfillOptions,
  MemorySubjectBackfillResult,
} from '../memory-store-port.js';
import {
  decodeEmbedding,
  fromMemoryRow,
  parsePgNumber,
  validateEmbeddingDimensions,
  type MemoryRow,
} from './rows.js';
import { persistMemorySubjectProjection } from './subject-projection.js';

export const MEMORY_SUBJECT_BACKFILL_ADVISORY_LOCK = [1_836_281_410, 17] as const;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

interface BackfillMemoryRow extends MemoryRow {
  authorization_revision: string;
}

interface BackfillCheckpointRow {
  cursor_memory_id: string | null;
  completed: boolean;
  processed_count: string;
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new Error(`Memory subject backfill batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return value;
}

function result(
  state: MemorySubjectBackfillResult['state'],
  processedCount: number,
  totalProcessedCount: number,
  reasonCounts: Record<string, number>,
  startedAt: number,
): MemorySubjectBackfillResult {
  return {
    state,
    processedCount,
    totalProcessedCount,
    classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    reasonCounts,
    durationMs: Math.max(0, performance.now() - startedAt),
  };
}

export async function backfillMemorySubjectClassifications(
  client: PoolClient,
  embeddingDims: number | undefined,
  options: MemorySubjectBackfillOptions = {},
): Promise<MemorySubjectBackfillResult> {
  const startedAt = performance.now();
  const batchSize = normalizeBatchSize(options.batchSize);
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Memory subject backfill now must be a non-negative safe integer');
  }
  const lock = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_xact_lock($1::integer, $2::integer) AS locked',
    [...MEMORY_SUBJECT_BACKFILL_ADVISORY_LOCK],
  );
  if (lock.rows[0]?.locked !== true) {
    return result('busy', 0, 0, {}, startedAt);
  }
  if (options.resetCheckpoint === true) {
    await client.query(
      'DELETE FROM l2_memory_subject_backfill_checkpoints WHERE classifier_version = $1',
      [MEMORY_SUBJECT_CLASSIFIER_VERSION],
    );
  }
  await client.query(`
    INSERT INTO l2_memory_subject_backfill_checkpoints (
      classifier_version, cursor_memory_id, completed, processed_count, updated_at
    ) VALUES ($1, NULL, FALSE, 0, $2)
    ON CONFLICT (classifier_version) DO NOTHING
  `, [MEMORY_SUBJECT_CLASSIFIER_VERSION, now]);
  const checkpointRows = await client.query<BackfillCheckpointRow>(`
    SELECT cursor_memory_id, completed, processed_count
    FROM l2_memory_subject_backfill_checkpoints
    WHERE classifier_version = $1
    FOR UPDATE
  `, [MEMORY_SUBJECT_CLASSIFIER_VERSION]);
  const checkpoint = checkpointRows.rows.at(0);
  if (!checkpoint) throw new Error('Memory subject backfill checkpoint could not be loaded');
  const totalBefore = parsePgNumber(checkpoint.processed_count, 'memory subject processed_count');
  if (checkpoint.completed) return result('complete', 0, totalBefore, {}, startedAt);

  const rows = await client.query<BackfillMemoryRow>(`
    SELECT
      id, text, type, importance, confidence, emotional_valence, formation_vad,
      salience, salience_decay_anchor_at, source_ref, source_type, provenance_json,
      extracted_at, last_accessed, access_count, superseded_by, tags,
      scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
      retention_class, sensitivity, consent_flags, contact_id, deleted_at,
      deleted_by, delete_reason, embedding::text AS embedding, authorization_revision
    FROM l2_memories
    WHERE ($1::text IS NULL OR id > $1)
    ORDER BY id
    LIMIT $2
    FOR UPDATE
  `, [checkpoint.cursor_memory_id, batchSize]);
  const reasonCounts: Record<string, number> = {};
  for (const row of rows.rows) {
    const memory = fromMemoryRow(row);
    const embedding = row.embedding ? decodeEmbedding(row.embedding) : undefined;
    if (embedding && embeddingDims !== undefined) {
      validateEmbeddingDimensions(embedding, embeddingDims, 'subject backfill');
    }
    const classification = await persistMemorySubjectProjection(
      client,
      memory,
      parsePgNumber(row.authorization_revision, 'authorization_revision'),
      embedding,
      now,
    );
    reasonCounts[classification.reasonClass] = (reasonCounts[classification.reasonClass] ?? 0) + 1;
  }
  const processedCount = rows.rows.length;
  const totalProcessedCount = totalBefore + processedCount;
  const completed = processedCount < batchSize;
  const cursor = rows.rows.at(-1)?.id ?? checkpoint.cursor_memory_id;
  await client.query(`
    UPDATE l2_memory_subject_backfill_checkpoints
    SET cursor_memory_id = $2, completed = $3, processed_count = $4, updated_at = $5
    WHERE classifier_version = $1
  `, [MEMORY_SUBJECT_CLASSIFIER_VERSION, cursor, completed, totalProcessedCount, now]);
  return result(processedCount > 0 ? 'processed' : 'complete', processedCount, totalProcessedCount, reasonCounts, startedAt);
}

/**
 * Drain the resumable classifier before a restored or upgraded corpus can be
 * consumed. Each batch owns a short transaction; a competing classifier is a
 * startup/restore failure, never a reason to expose an incompletely gated
 * corpus.
 */
export async function runMemorySubjectBackfillToCompletion(
  pool: Pool,
  embeddingDims?: number,
  options: MemorySubjectBackfillOptions = {},
): Promise<MemorySubjectBackfillResult> {
  let nextOptions = options;
  for (;;) {
    const client = await pool.connect();
    let batch: MemorySubjectBackfillResult;
    try {
      await client.query('BEGIN');
      batch = await backfillMemorySubjectClassifications(client, embeddingDims, nextOptions);
      if (batch.state === 'busy') {
        throw new Error('Memory subject backfill is already running');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (batch.state === 'complete') return batch;
    nextOptions = {
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  }
}
