// ── Direct-message subject repair (psfn-framework-d5e0p.21) ──
// Turn memories extracted from a 1:1 DM before the forward fix were written
// with contact == trigger == routed == source contact and no subject. The
// subject classifier refuses a trigger/source contact as an implicit subject,
// so those rows classify `unattributed` and are never recall candidates in
// the DM they came from. This repair stamps provenance.subjectContactId with
// the DM's sole human counterparty and reclassifies exactly the stamped rows.
//
// Bounded and reviewed: the operator names one channel and one contact; the
// channel's whole transcript and contact activity must prove it is a private
// conversation with that one human; only that channel's turn-extraction rows
// that are currently `unattributed` and carry no other subject evidence are
// eligible; and apply refuses unless the operator passes the dry-run's
// planned count. Every stamped row records an l2_memory_patch_events row.

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { persistMemorySubjectProjection } from '../../faculties/memory/postgres-store/subject-projection.js';
import { MEMORY_SUBJECT_SELECT_COLUMNS } from '../../faculties/memory/postgres-store/subject-queries.js';
import {
  decodeEmbedding,
  parsePgNumber,
  tryFromMemoryRow,
  validateEmbeddingDimensions,
  type MemoryRow,
} from '../../faculties/memory/postgres-store/rows.js';
import { classifyMemorySubject } from '../../faculties/memory/subject-classification.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import { isRecord } from '../../shared/utils/types.js';

const PATCH_REASON = 'memory_dm_subject_repair';
const PRIVATE_VISIBILITY = 'private';
const PRIVATE_SOURCE_TOKEN = `|visibility:${PRIVATE_VISIBILITY}|`;
const REPAIRABLE_ROUTING_REASONS: ReadonlySet<string> = new Set([
  'single_speaker_transcript',
  'structured_source_metadata',
]);
const COMPANION_ROUTING_REASONS: ReadonlySet<string> = new Set([
  'conversational_companion',
  'self_directed_companion',
]);
const ROOM_SCOPE_TAGS: ReadonlySet<string> = new Set(['group_memory', 'room_context']);

const DM_SUBJECT_REPAIR_SKIP_REASONS = [
  'deleted',
  'superseded',
  'channel_mismatch',
  'not_private_source',
  'contact_mismatch',
  'has_subject',
  'companion_owned',
  'unsupported_routing_reason',
  'room_scoped',
  'not_unattributed',
] as const;

type DirectMessageSubjectRepairSkipReason = typeof DM_SUBJECT_REPAIR_SKIP_REASONS[number];

interface DirectMessageSubjectRepairOptions {
  channelId: string;
  contactId: string;
  dryRun: boolean;
  /** Apply only: must equal the planned count the reviewed dry-run reported. */
  expectedRepairCount?: number;
  embeddingDims?: number;
  now?: Date;
}

export interface DirectMessageSubjectRepairReport {
  dryRun: boolean;
  channelId: string;
  contactId: string;
  evidence: {
    transcriptMessages: number;
    humanAuthors: number;
    activityContacts: number;
  };
  scannedTurnMemories: number;
  plannedRepairs: number;
  repaired: number;
  memoryIds: string[];
  skipped: Record<DirectMessageSubjectRepairSkipReason, number>;
  /** Current subject classes of the channel's turn memories before the run. */
  subjectClassesBefore: Record<string, number>;
  /** After apply: stored classes. Dry-run: the projection of the plan. */
  subjectClassesAfter: Record<string, number>;
}

interface TurnMemoryRow extends MemoryRow {
  authorization_revision: string;
  subject_class: string | null;
  subject_status: string | null;
}

interface PlannedRepair {
  row: TurnMemoryRow;
  memory: PurrMemory;
  /** The stored provenance exactly as persisted; only subjectContactId is added. */
  storedProvenance: Record<string, unknown>;
}

function requireId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function emptySkipCounts(): Record<DirectMessageSubjectRepairSkipReason, number> {
  return Object.fromEntries(
    DM_SUBJECT_REPAIR_SKIP_REASONS.map(reason => [reason, 0]),
  ) as Record<DirectMessageSubjectRepairSkipReason, number>;
}

function textField(provenance: Record<string, unknown>, field: string): string | undefined {
  const value = provenance[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`provenance_json.${field} must be a string`);
  return value.trim() || undefined;
}

/**
 * Why a turn memory of the named DM is not eligible, or undefined when it is.
 * Guards read the stored provenance, not its normalized projection, so an
 * unrecognized subject field can never be overwritten. The first failing
 * guard is the reported reason.
 */
function classifyDirectMessageSubjectRepair(
  memory: PurrMemory,
  provenance: Record<string, unknown>,
  currentSubjectClass: string | null,
  channelId: string,
  contactId: string,
): DirectMessageSubjectRepairSkipReason | undefined {
  if (memory.deletedAt !== undefined) return 'deleted';
  if (memory.supersededBy) return 'superseded';
  if (textField(provenance, 'channelId') !== channelId) return 'channel_mismatch';
  if (!memory.sourceRef.includes(PRIVATE_SOURCE_TOKEN)) return 'not_private_source';
  const routingReason = textField(provenance, 'routingReason');
  if (
    textField(provenance, 'actor') === 'companion'
    || textField(provenance, 'subjectScope') !== undefined
    || (routingReason !== undefined && COMPANION_ROUTING_REASONS.has(routingReason))
  ) {
    return 'companion_owned';
  }
  const source = textField(provenance, 'sourceContactId');
  if (
    memory.contactId !== contactId
    || textField(provenance, 'triggerContactId') !== contactId
    || textField(provenance, 'routedContactId') !== contactId
    || (source !== undefined && source !== contactId)
  ) {
    return 'contact_mismatch';
  }
  const subjectContactIds = provenance.subjectContactIds;
  if (
    textField(provenance, 'subjectContactId')
    || textField(provenance, 'subjectName')
    || (Array.isArray(subjectContactIds) && subjectContactIds.length > 0)
  ) {
    return 'has_subject';
  }
  if (routingReason === undefined || !REPAIRABLE_ROUTING_REASONS.has(routingReason)) {
    return 'unsupported_routing_reason';
  }
  if (
    (memory.scopeRef && !(memory.scopeRef.kind === 'contact' && memory.scopeRef.id === contactId))
    || (memory.scopeTags ?? []).some(tag => ROOM_SCOPE_TAGS.has(tag))
    || textField(provenance, 'addressMode') === 'overheard_room_context'
  ) {
    return 'room_scoped';
  }
  if (currentSubjectClass !== 'unattributed') return 'not_unattributed';
  return undefined;
}

function withSubject(memory: PurrMemory, contactId: string): PurrMemory {
  return { ...memory, provenance: { ...memory.provenance, subjectContactId: contactId } };
}

function countClasses(classes: Iterable<string | null>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const subjectClass of classes) {
    const key = subjectClass ?? 'unclassified';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function currentClass(row: Pick<TurnMemoryRow, 'subject_class' | 'subject_status'>): string | null {
  return row.subject_status === 'current' ? row.subject_class : null;
}

/** Fail closed unless the channel is a private conversation with exactly this one human. */
async function assertDirectMessageEvidence(
  client: PoolClient,
  channelId: string,
  contactId: string,
): Promise<DirectMessageSubjectRepairReport['evidence']> {
  const contact = await client.query<{ archived_at: string | null; is_machine_intelligence: boolean }>(
    'SELECT archived_at, is_machine_intelligence FROM contacts WHERE id = $1 FOR KEY SHARE',
    [contactId],
  );
  const contactRow = contact.rows.at(0);
  if (!contactRow) throw new Error(`Contact ${contactId} does not exist`);
  if (contactRow.archived_at !== null) throw new Error(`Contact ${contactId} is archived`);
  if (contactRow.is_machine_intelligence) throw new Error(`Contact ${contactId} is not a human contact`);

  const activity = await client.query<{ contact_id: string }>(
    'SELECT DISTINCT contact_id FROM contact_channel_activity WHERE channel_id = $1 ORDER BY contact_id',
    [channelId],
  );
  const activityContacts = activity.rows.map(row => row.contact_id);
  if (activityContacts.length !== 1 || activityContacts[0] !== contactId) {
    throw new Error(
      `Channel ${channelId} is not a direct conversation with ${contactId}: `
      + `${activityContacts.length} contacts have channel activity`,
    );
  }

  const transcript = await client.query<{
    messages: string;
    human_authors: string;
    missing_authors: string;
    non_private: string;
  }>(`
    SELECT
      COUNT(*) AS messages,
      COUNT(DISTINCT author_id) FILTER (WHERE role = 'user') AS human_authors,
      COUNT(*) FILTER (WHERE role = 'user' AND author_id IS NULL) AS missing_authors,
      COUNT(*) FILTER (WHERE channel_visibility <> $2) AS non_private
    FROM session_messages_projection
    WHERE channel_id = $1
  `, [channelId, PRIVATE_VISIBILITY]);
  const counts = transcript.rows[0];
  const messages = parsePgNumber(counts?.messages, 'transcript messages');
  const humanAuthors = parsePgNumber(counts?.human_authors, 'transcript human authors');
  if (
    messages === 0
    || humanAuthors !== 1
    || parsePgNumber(counts?.missing_authors, 'transcript missing authors') !== 0
    || parsePgNumber(counts?.non_private, 'transcript non-private messages') !== 0
  ) {
    throw new Error(
      `Channel ${channelId} transcript is not a private conversation with one human: `
      + `messages=${messages} humanAuthors=${humanAuthors} `
      + `missingAuthors=${counts?.missing_authors ?? 0} nonPrivate=${counts?.non_private ?? 0}`,
    );
  }
  return { transcriptMessages: messages, humanAuthors, activityContacts: activityContacts.length };
}

async function loadTurnMemories(client: PoolClient, channelId: string): Promise<TurnMemoryRow[]> {
  const prefix = `${channelId}:extract|`;
  const rows = await client.query<TurnMemoryRow>(`
    SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS}, memory.authorization_revision,
      classification.subject_class, classification.status AS subject_status
    FROM l2_memories memory
    LEFT JOIN l2_memory_subject_classifications classification
      ON classification.memory_id = memory.id
    WHERE left(memory.source_ref, length($1)) = $1
    ORDER BY memory.id
    FOR UPDATE OF memory
  `, [prefix]);
  return rows.rows;
}

function decodeRow(row: TurnMemoryRow): { memory: PurrMemory; storedProvenance: Record<string, unknown> } {
  const memory = tryFromMemoryRow(row);
  if (!memory) throw new Error(`Memory ${row.id} could not be decoded`);
  if (!isRecord(row.provenance_json)) throw new Error(`Memory ${row.id} provenance_json must be an object`);
  return { memory, storedProvenance: row.provenance_json };
}

async function applyRepair(
  client: PoolClient,
  planned: PlannedRepair,
  contactId: string,
  embeddingDims: number | undefined,
  now: number,
): Promise<string> {
  const previousProvenance = planned.storedProvenance;
  const nextProvenance = { ...previousProvenance, subjectContactId: contactId };
  const updated = await client.query<{ authorization_revision: string }>(`
    UPDATE l2_memories
    SET provenance_json = $3::jsonb
    WHERE id = $1 AND authorization_revision = $2
    RETURNING authorization_revision
  `, [planned.row.id, planned.row.authorization_revision, JSON.stringify(nextProvenance)]);
  const revisionRow = updated.rows.at(0);
  if (!revisionRow) throw new Error(`Memory ${planned.row.id} changed during DM subject repair`);
  await client.query(`
    INSERT INTO l2_memory_patch_events (
      id, memory_id, source_ref, source_type, provenance_json, reason,
      patch_json, previous_json, next_json, created_at
    ) VALUES ($1, $2, $3, 'tool_write', '{}'::jsonb, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
  `, [
    randomUUID(),
    planned.row.id,
    `maintenance:${PATCH_REASON}:${planned.row.source_ref}`,
    PATCH_REASON,
    JSON.stringify({ provenance: { subjectContactId: contactId } }),
    JSON.stringify({ provenance: previousProvenance }),
    JSON.stringify({ provenance: nextProvenance }),
    now,
  ]);
  const embedding = planned.row.embedding ? decodeEmbedding(planned.row.embedding) : undefined;
  if (embedding && embeddingDims !== undefined) {
    validateEmbeddingDimensions(embedding, embeddingDims, 'DM subject repair');
  }
  const classification = await persistMemorySubjectProjection(
    client,
    withSubject(planned.memory, contactId),
    parsePgNumber(revisionRow.authorization_revision, 'authorization_revision'),
    embedding,
    now,
  );
  if (
    classification.subjectClass !== 'single_contact'
    || classification.subjectContactIds.length !== 1
    || classification.subjectContactIds[0] !== contactId
  ) {
    throw new Error(
      `Memory ${planned.row.id} reclassified as ${classification.subjectClass}, not single_contact`,
    );
  }
  return classification.subjectClass;
}

export async function repairDirectMessageMemorySubjects(
  pool: Pool,
  options: DirectMessageSubjectRepairOptions,
): Promise<DirectMessageSubjectRepairReport> {
  if (typeof options.dryRun !== 'boolean') {
    throw new Error('DM subject repair dryRun must be explicitly true or false');
  }
  const channelId = requireId(options.channelId, 'channelId');
  const contactId = requireId(options.contactId, 'contactId');
  if (!options.dryRun && (
    options.expectedRepairCount === undefined
    || !Number.isSafeInteger(options.expectedRepairCount)
    || options.expectedRepairCount < 0
  )) {
    throw new Error('DM subject repair apply requires the reviewed dry-run planned count');
  }
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('DM subject repair now must be a valid date');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const evidence = await assertDirectMessageEvidence(client, channelId, contactId);
    const rows = await loadTurnMemories(client, channelId);
    const skipped = emptySkipCounts();
    const planned: PlannedRepair[] = [];
    for (const row of rows) {
      const { memory, storedProvenance } = decodeRow(row);
      const reason = classifyDirectMessageSubjectRepair(
        memory, storedProvenance, currentClass(row), channelId, contactId,
      );
      if (reason) skipped[reason] += 1;
      else planned.push({ row, memory, storedProvenance });
    }
    if (!options.dryRun && planned.length !== options.expectedRepairCount) {
      throw new Error(
        `DM subject repair planned ${planned.length} rows but the reviewed count is ${options.expectedRepairCount}`,
      );
    }
    const plannedIds = new Set(planned.map(item => item.row.id));
    const subjectClassesBefore = countClasses(rows.map(currentClass));
    const afterById = new Map<string, string | null>(rows.map(row => [row.id, currentClass(row)]));
    for (const item of planned) {
      const subjectClass = options.dryRun
        ? classifyMemorySubject(withSubject(item.memory, contactId), {
          memoryRevision: parsePgNumber(item.row.authorization_revision, 'authorization_revision'),
          validSubjectContactIds: new Set([contactId]),
        }).subjectClass
        : await applyRepair(client, item, contactId, options.embeddingDims, now.getTime());
      afterById.set(item.row.id, subjectClass);
    }
    await client.query('COMMIT');
    return {
      dryRun: options.dryRun,
      channelId,
      contactId,
      evidence,
      scannedTurnMemories: rows.length,
      plannedRepairs: planned.length,
      repaired: options.dryRun ? 0 : planned.length,
      memoryIds: [...plannedIds],
      skipped,
      subjectClassesBefore,
      subjectClassesAfter: countClasses(afterById.values()),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
