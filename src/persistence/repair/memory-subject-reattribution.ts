import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  runMemorySubjectBackfillToCompletion,
} from '../../faculties/memory/postgres-store/subject-backfill.js';
import type {
  MemorySubjectBackfillResult,
} from '../../faculties/memory/memory-store-port.js';
import { isRecord } from '../../shared/utils/types.js';

const MEMORY_PROVENANCE_CONTACT_FIELDS = [
  'triggerContactId',
  'routedContactId',
  'sourceContactId',
  'subjectContactId',
] as const;

export interface MemorySubjectContactMapping {
  fromContactId: string;
  toContactId: string;
}

export interface MemorySubjectReattributionOptions {
  mappings: readonly MemorySubjectContactMapping[];
  dryRun: boolean;
  embeddingDims?: number;
  now?: Date;
}

export interface MemorySubjectReattributionReport {
  dryRun: boolean;
  mappings: MemorySubjectContactMapping[];
  plannedMemoryUpdates: number;
  plannedEpisodeUpdates: number;
  updatedMemories: number;
  updatedEpisodes: number;
  backfill: MemorySubjectBackfillResult | null;
}

interface MemoryContactEvidenceRow {
  id: string;
  source_ref: string;
  contact_id: string | null;
  provenance_json: unknown;
  scope_ref_kind: string | null;
  scope_ref_id: string | null;
  scope_tags: unknown;
}

interface EpisodeContactEvidenceRow {
  id: string;
  participant_contact_ids: unknown;
  episode_json: unknown;
}

interface PlannedMemoryUpdate {
  id: string;
  sourceRef: string;
  previous: {
    contactId: string | null;
    provenance: Record<string, unknown>;
    scopeRefId: string | null;
    scopeTags: string[];
  };
  next: {
    contactId: string | null;
    provenance: Record<string, unknown>;
    scopeRefId: string | null;
    scopeTags: string[];
  };
}

interface PlannedEpisodeUpdate {
  id: string;
  participantContactIds: string[];
  episodeJson: Record<string, unknown>;
}

function normalizeContactId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

export function normalizeMemorySubjectContactMappings(
  values: readonly MemorySubjectContactMapping[],
): MemorySubjectContactMapping[] {
  if (values.length === 0) {
    throw new Error('At least one contact mapping is required');
  }
  const mappings = new Map<string, string>();
  for (const [index, value] of values.entries()) {
    const fromContactId = normalizeContactId(
      value.fromContactId,
      `mappings[${index}].fromContactId`,
    );
    const toContactId = normalizeContactId(
      value.toContactId,
      `mappings[${index}].toContactId`,
    );
    if (fromContactId === toContactId) {
      throw new Error(`Contact mapping source and target must differ: ${fromContactId}`);
    }
    const existing = mappings.get(fromContactId);
    if (existing !== undefined && existing !== toContactId) {
      throw new Error(`Contact mapping source ${fromContactId} has multiple targets`);
    }
    mappings.set(fromContactId, toContactId);
  }
  for (const target of mappings.values()) {
    if (mappings.has(target)) {
      throw new Error(
        `Chained contact mappings are not supported: target ${target} is also a source`,
      );
    }
  }
  return [...mappings.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fromContactId, toContactId]) => ({ fromContactId, toContactId }));
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map(item => item.trim()).filter(Boolean);
}

function mapContactId(
  value: string | null,
  mapping: ReadonlyMap<string, string>,
): string | null {
  if (value === null) return null;
  return mapping.get(value) ?? value;
}

function mapContactIds(
  values: readonly string[],
  mapping: ReadonlyMap<string, string>,
): string[] {
  return [...new Set(values.map(value => mapping.get(value) ?? value))];
}

function recordsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function planMemoryUpdate(
  row: MemoryContactEvidenceRow,
  mapping: ReadonlyMap<string, string>,
): PlannedMemoryUpdate | undefined {
  if (!isRecord(row.provenance_json)) {
    throw new Error(`Memory ${row.id} provenance_json must be an object`);
  }
  const previousProvenance = { ...row.provenance_json };
  const nextProvenance = { ...previousProvenance };
  for (const field of MEMORY_PROVENANCE_CONTACT_FIELDS) {
    const value = nextProvenance[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new Error(`Memory ${row.id} provenance_json.${field} must be a string`);
    }
    nextProvenance[field] = mapping.get(value) ?? value;
  }
  if (nextProvenance.subjectContactIds !== undefined) {
    nextProvenance.subjectContactIds = mapContactIds(
      parseStringArray(
        nextProvenance.subjectContactIds,
        `Memory ${row.id} provenance_json.subjectContactIds`,
      ),
      mapping,
    );
  }
  const previousScopeTags = parseStringArray(row.scope_tags, `Memory ${row.id} scope_tags`);
  const nextScopeTags = previousScopeTags.map((tag) => {
    if (!tag.startsWith('contact:')) return tag;
    const contactId = tag.slice('contact:'.length);
    const mapped = mapping.get(contactId);
    return mapped ? `contact:${mapped}` : tag;
  });
  const nextContactId = mapContactId(row.contact_id, mapping);
  const nextScopeRefId = row.scope_ref_kind === 'contact'
    ? mapContactId(row.scope_ref_id, mapping)
    : row.scope_ref_id;
  if (
    nextContactId === row.contact_id
    && nextScopeRefId === row.scope_ref_id
    && recordsEqual(nextProvenance, previousProvenance)
    && recordsEqual(nextScopeTags, previousScopeTags)
  ) {
    return undefined;
  }
  return {
    id: row.id,
    sourceRef: row.source_ref,
    previous: {
      contactId: row.contact_id,
      provenance: previousProvenance,
      scopeRefId: row.scope_ref_id,
      scopeTags: previousScopeTags,
    },
    next: {
      contactId: nextContactId,
      provenance: nextProvenance,
      scopeRefId: nextScopeRefId,
      scopeTags: nextScopeTags,
    },
  };
}

function planEpisodeUpdate(
  row: EpisodeContactEvidenceRow,
  mapping: ReadonlyMap<string, string>,
  updatedAt: string,
): PlannedEpisodeUpdate | undefined {
  const storedParticipants = parseStringArray(
    row.participant_contact_ids,
    `Episode ${row.id} participant_contact_ids`,
  );
  if (!isRecord(row.episode_json)) {
    throw new Error(`Episode ${row.id} episode_json must be an object`);
  }
  const jsonParticipants = parseStringArray(
    row.episode_json.participantContactIds,
    `Episode ${row.id} episode_json.participantContactIds`,
  );
  const nextStored = mapContactIds(storedParticipants, mapping);
  const nextJson = mapContactIds(jsonParticipants, mapping);
  if (!recordsEqual(nextStored, nextJson)) {
    throw new Error(
      `Episode ${row.id} participant contact projections disagree after mapping`,
    );
  }
  if (
    recordsEqual(nextStored, storedParticipants)
    && recordsEqual(nextJson, jsonParticipants)
  ) {
    return undefined;
  }
  return {
    id: row.id,
    participantContactIds: nextStored,
    episodeJson: {
      ...row.episode_json,
      participantContactIds: nextJson,
      updatedAt,
    },
  };
}

async function assertTargetContactsExist(
  client: PoolClient,
  mappings: readonly MemorySubjectContactMapping[],
): Promise<void> {
  const targets = [...new Set(mappings.map(mapping => mapping.toContactId))].sort();
  const rows = await client.query<{ id: string }>(
    'SELECT id FROM contacts WHERE id = ANY($1::text[]) FOR KEY SHARE',
    [targets],
  );
  const found = new Set(rows.rows.map(row => row.id));
  const missing = targets.filter(target => !found.has(target));
  if (missing.length > 0) {
    throw new Error(`Target contacts do not exist: ${missing.join(', ')}`);
  }
}

async function loadPlans(
  client: PoolClient,
  mappings: readonly MemorySubjectContactMapping[],
  updatedAt: string,
): Promise<{
  memoryUpdates: PlannedMemoryUpdate[];
  episodeUpdates: PlannedEpisodeUpdate[];
}> {
  const mapping = new Map(mappings.map(value => [value.fromContactId, value.toContactId]));
  const sources = [...mapping.keys()];
  const memoryRows = await client.query<MemoryContactEvidenceRow>(`
    SELECT
      id, source_ref, contact_id, provenance_json,
      scope_ref_kind, scope_ref_id, scope_tags
    FROM l2_memories
    WHERE contact_id = ANY($1::text[])
      OR (scope_ref_kind = 'contact' AND scope_ref_id = ANY($1::text[]))
      OR provenance_json->>'triggerContactId' = ANY($1::text[])
      OR provenance_json->>'routedContactId' = ANY($1::text[])
      OR provenance_json->>'sourceContactId' = ANY($1::text[])
      OR provenance_json->>'subjectContactId' = ANY($1::text[])
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(provenance_json->'subjectContactIds') = 'array'
              THEN provenance_json->'subjectContactIds'
            ELSE '[]'::jsonb
          END
        ) AS subject_contact(value)
        WHERE subject_contact.value = ANY($1::text[])
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(scope_tags) AS scope_tag(value)
        WHERE scope_tag.value = ANY($2::text[])
      )
    ORDER BY id
    FOR UPDATE
  `, [sources, sources.map(source => `contact:${source}`)]);
  const episodeRows = await client.query<EpisodeContactEvidenceRow>(`
    SELECT id, participant_contact_ids, episode_json
    FROM l01_episodes
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(participant_contact_ids) AS participant(value)
      WHERE participant.value = ANY($1::text[])
    )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(episode_json->'participantContactIds') = 'array'
              THEN episode_json->'participantContactIds'
            ELSE '[]'::jsonb
          END
        ) AS participant(value)
        WHERE participant.value = ANY($1::text[])
      )
    ORDER BY id
    FOR UPDATE
  `, [sources]);
  return {
    memoryUpdates: memoryRows.rows.flatMap((row) => {
      const planned = planMemoryUpdate(row, mapping);
      return planned ? [planned] : [];
    }),
    episodeUpdates: episodeRows.rows.flatMap((row) => {
      const planned = planEpisodeUpdate(row, mapping, updatedAt);
      return planned ? [planned] : [];
    }),
  };
}

async function applyMemoryUpdates(
  client: PoolClient,
  updates: readonly PlannedMemoryUpdate[],
  createdAt: number,
): Promise<number> {
  let updated = 0;
  for (const update of updates) {
    const result = await client.query(`
      UPDATE l2_memories
      SET contact_id = $2,
          provenance_json = $3::jsonb,
          scope_ref_id = $4,
          scope_tags = $5::jsonb
      WHERE id = $1
      RETURNING id
    `, [
      update.id,
      update.next.contactId,
      JSON.stringify(update.next.provenance),
      update.next.scopeRefId,
      JSON.stringify(update.next.scopeTags),
    ]);
    if (result.rowCount !== 1) {
      throw new Error(`Memory ${update.id} disappeared during re-attribution`);
    }
    await client.query(`
      INSERT INTO l2_memory_patch_events (
        id, memory_id, source_ref, source_type, provenance_json, reason,
        patch_json, previous_json, next_json, created_at
      ) VALUES (
        $1, $2, $3, 'tool_write', '{}'::jsonb, 'memory_subject_reattribution',
        $4::jsonb, $5::jsonb, $6::jsonb, $7
      )
    `, [
      randomUUID(),
      update.id,
      `maintenance:memory-subject-reattribution:${update.sourceRef}`,
      JSON.stringify(update.next),
      JSON.stringify(update.previous),
      JSON.stringify(update.next),
      createdAt,
    ]);
    updated += 1;
  }
  return updated;
}

async function applyEpisodeUpdates(
  client: PoolClient,
  updates: readonly PlannedEpisodeUpdate[],
  updatedAt: string,
): Promise<number> {
  let updated = 0;
  for (const update of updates) {
    const result = await client.query(`
      UPDATE l01_episodes
      SET participant_contact_ids = $2::jsonb,
          episode_json = $3::jsonb,
          updated_at = $4
      WHERE id = $1
      RETURNING id
    `, [
      update.id,
      JSON.stringify(update.participantContactIds),
      JSON.stringify(update.episodeJson),
      updatedAt,
    ]);
    if (result.rowCount !== 1) {
      throw new Error(`Episode ${update.id} disappeared during re-attribution`);
    }
    updated += 1;
  }
  return updated;
}

export async function reattributePostgresMemorySubjects(
  pool: Pool,
  options: MemorySubjectReattributionOptions,
): Promise<MemorySubjectReattributionReport> {
  if (typeof options.dryRun !== 'boolean') {
    throw new Error('Re-attribution dryRun must be explicitly true or false');
  }
  const mappings = normalizeMemorySubjectContactMappings(options.mappings);
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Re-attribution now must be a valid date');
  const updatedAt = now.toISOString();
  const client = await pool.connect();
  let memoryUpdates: PlannedMemoryUpdate[] = [];
  let episodeUpdates: PlannedEpisodeUpdate[] = [];
  let updatedMemories = 0;
  let updatedEpisodes = 0;
  try {
    await client.query('BEGIN');
    await assertTargetContactsExist(client, mappings);
    ({ memoryUpdates, episodeUpdates } = await loadPlans(client, mappings, updatedAt));
    if (!options.dryRun) {
      updatedMemories = await applyMemoryUpdates(client, memoryUpdates, now.getTime());
      updatedEpisodes = await applyEpisodeUpdates(client, episodeUpdates, updatedAt);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const backfill = options.dryRun
    ? null
    : await runMemorySubjectBackfillToCompletion(pool, options.embeddingDims, {
      resetCheckpoint: true,
      now: now.getTime(),
    });
  return {
    dryRun: options.dryRun,
    mappings,
    plannedMemoryUpdates: memoryUpdates.length,
    plannedEpisodeUpdates: episodeUpdates.length,
    updatedMemories,
    updatedEpisodes,
    backfill,
  };
}
