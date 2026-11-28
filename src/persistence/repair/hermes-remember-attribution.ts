import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  EXTERNAL_MEMORY_REMEMBER_TOOL,
  externalMemoryNoteSourceRefPattern,
} from '../../shared/contracts/external-memory.js';
import { EXTERNAL_MEMORY_CHANNEL } from '../../shared/routing/external-memory-channel.js';
import { isRecord } from '../../shared/utils/types.js';
import { MEMORY_SUBJECT_SELECT_COLUMNS } from '../../faculties/memory/postgres-store/subject-queries.js';
import {
  decodeEmbedding,
  parsePgNumber,
  tryFromMemoryRow,
  validateEmbeddingDimensions,
  type MemoryRow,
} from '../../faculties/memory/postgres-store/rows.js';
import { persistMemorySubjectProjection } from '../../faculties/memory/postgres-store/subject-projection.js';

/**
 * psfn-framework-1meuc repair: before the fix, ExternalMemoryService wrote a
 * Hermes `remember` note with only `triggerContactId` (the credential's bound
 * contact, server-written from the durable binding), so the note classified
 * `unattributed` and its own contact could never recall it. This repair gives
 * exactly those rows the attribution the fixed writer now records
 * (`contactId` and `provenance.subjectContactId` = the trigger contact) and
 * reclassifies only the touched rows. Every other unattributed memory is left
 * alone: the selector requires the full server-written remember provenance,
 * a Hermes session room, no existing subject evidence, a current
 * `unattributed` classification and a live trigger contact.
 */

export interface HermesRememberAttributionOptions {
  dryRun: boolean;
  embeddingDims?: number;
  now?: Date;
}

interface HermesRememberAttributionPlan {
  memoryId: string;
  contactId: string;
}

export interface HermesRememberAttributionReport {
  dryRun: boolean;
  planned: HermesRememberAttributionPlan[];
  /** Candidate notes left unattributed because the trigger contact is archived or missing. */
  skippedUnavailableContact: number;
  updatedMemories: number;
}

interface CandidateRow extends MemoryRow {
  trigger_contact_id: string;
  contact_live: boolean;
}

const CANDIDATE_PREDICATE = `
  memory.source_ref LIKE $1
  AND memory.source_type = 'tool_write'
  AND memory.contact_id IS NULL
  AND memory.provenance_json->>'toolName' = $2
  AND memory.provenance_json->>'actor' = 'companion'
  AND memory.provenance_json->>'channelId' LIKE $3
  AND NULLIF(btrim(memory.provenance_json->>'triggerContactId'), '') IS NOT NULL
  AND NOT (memory.provenance_json ? 'subjectContactId')
  AND NOT (memory.provenance_json ? 'subjectContactIds')
  AND NOT (memory.provenance_json ? 'subjectName')
  AND NOT (memory.provenance_json ? 'routedContactId')
  AND NOT (memory.provenance_json ? 'sourceContactId')
  AND classification.subject_class = 'unattributed'
`;

async function loadCandidates(client: PoolClient): Promise<CandidateRow[]> {
  const rows = await client.query<CandidateRow>(`
    SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS},
      memory.provenance_json->>'triggerContactId' AS trigger_contact_id,
      EXISTS (
        SELECT 1 FROM contacts contact
        WHERE contact.id = memory.provenance_json->>'triggerContactId'
          AND contact.archived_at IS NULL
      ) AS contact_live
    FROM l2_memories memory
    JOIN l2_memory_subject_classifications classification
      ON classification.memory_id = memory.id
    WHERE ${CANDIDATE_PREDICATE}
    ORDER BY memory.id
    FOR UPDATE OF memory
  `, [externalMemoryNoteSourceRefPattern(), EXTERNAL_MEMORY_REMEMBER_TOOL, `${EXTERNAL_MEMORY_CHANNEL}:%`]);
  return rows.rows;
}

async function applyPlan(
  client: PoolClient,
  row: CandidateRow,
  embeddingDims: number | undefined,
  createdAt: number,
): Promise<void> {
  if (!isRecord(row.provenance_json)) {
    throw new Error(`Memory ${row.id} provenance_json must be an object`);
  }
  const contactId = row.trigger_contact_id;
  const previous = { contactId: row.contact_id, provenance: row.provenance_json };
  const next = { contactId, provenance: { ...row.provenance_json, subjectContactId: contactId } };
  const updated = await client.query<MemoryRow & { authorization_revision: string }>(`
    UPDATE l2_memories memory
    SET contact_id = $2, provenance_json = $3::jsonb
    WHERE memory.id = $1
    RETURNING ${MEMORY_SUBJECT_SELECT_COLUMNS}, memory.authorization_revision
  `, [row.id, contactId, JSON.stringify(next.provenance)]);
  const stored = updated.rows[0];
  const memory = stored ? tryFromMemoryRow(stored) : null;
  if (!stored || !memory) throw new Error(`Memory ${row.id} disappeared during Hermes note attribution`);
  await client.query(`
    INSERT INTO l2_memory_patch_events (
      id, memory_id, source_ref, source_type, provenance_json, reason,
      patch_json, previous_json, next_json, created_at
    ) VALUES (
      $1, $2, $3, 'tool_write', '{}'::jsonb, 'hermes_remember_attribution',
      $4::jsonb, $5::jsonb, $4::jsonb, $6
    )
  `, [
    randomUUID(), row.id, `maintenance:hermes-remember-attribution:${row.source_ref}`,
    JSON.stringify(next), JSON.stringify(previous), createdAt,
  ]);
  const embedding = stored.embedding ? decodeEmbedding(stored.embedding) : undefined;
  if (embedding && embeddingDims !== undefined) {
    validateEmbeddingDimensions(embedding, embeddingDims, 'Hermes note attribution');
  }
  const classification = await persistMemorySubjectProjection(
    client, memory, parsePgNumber(stored.authorization_revision, 'authorization_revision'), embedding, createdAt,
  );
  if (classification.subjectClass !== 'single_contact' || classification.subjectContactIds[0] !== contactId) {
    throw new Error(`Memory ${row.id} did not classify under its bound contact after attribution`);
  }
}

/** Dry-run first: `dryRun` must be explicit, and an apply runs in one transaction. */
export async function repairHermesRememberAttribution(
  pool: Pool,
  options: HermesRememberAttributionOptions,
): Promise<HermesRememberAttributionReport> {
  if (typeof options.dryRun !== 'boolean') {
    throw new Error('Hermes note attribution dryRun must be explicitly true or false');
  }
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Hermes note attribution now must be a valid date');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await loadCandidates(client);
    const live = candidates.filter(row => row.contact_live);
    if (!options.dryRun) {
      for (const row of live) await applyPlan(client, row, options.embeddingDims, now.getTime());
    }
    await client.query('COMMIT');
    return {
      dryRun: options.dryRun,
      planned: live.map(row => ({ memoryId: row.id, contactId: row.trigger_contact_id })),
      skippedUnavailableContact: candidates.length - live.length,
      updatedMemories: options.dryRun ? 0 : live.length,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
