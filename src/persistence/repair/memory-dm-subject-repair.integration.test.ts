// psfn-framework-d5e0p.21: historical DM turn memories written with
// contact == trigger == routed contact and no subject classify `unattributed`
// and never reach the DM viewer. The repair must stamp only that DM's
// eligible rows, reclassify exactly those, and leave everything else
// byte-identical, on a real Postgres corpus written by the production store.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool, ensurePostgresSchema } from '../postgres.js';
import {
  POSTGRES_CONTACT_MIGRATIONS,
  POSTGRES_TRANSCRIPT_MIGRATIONS,
} from '../postgres/migrations.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresMemoryStoreFromPool } from '../../faculties/memory/postgres-store.js';
import { createSubjectAuthorizedMemoryStore } from '../../faculties/memory/subject-authorized-store.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { MemoryProvenance, PurrMemory } from '../../faculties/memory/types.js';
import { repairDirectMessageMemorySubjects } from './memory-dm-subject-repair.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const EMBEDDING = new Float32Array([0.4, 0.3, 0.2, 0.1]);
const DM = 'dm-ari';
const ROOM = 'room-harbor';
const ARI = 'contact-ari';
const BO = 'contact-bo';
const ECHO = 'contact-echo';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

async function withDatabase(handler: (pool: Pool, store: MemoryStorePort) => Promise<void>): Promise<void> {
  if (!harness) throw new Error('Postgres integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-dm-subject-repair-integration',
    allowExitOnIdle: true,
    max: 4,
  });
  try {
    await ensurePostgresSchema(pool, [...POSTGRES_CONTACT_MIGRATIONS, ...POSTGRES_TRANSCRIPT_MIGRATIONS]);
    const store = await createPostgresMemoryStoreFromPool(pool, EMBEDDING.length);
    await seedConversations(pool);
    await seedMemories(store);
    await handler(pool, store);
  } finally {
    await pool.end();
  }
}

async function seedConversations(pool: Pool): Promise<void> {
  for (const [id, name, machine] of [[ARI, 'Ari', false], [BO, 'Bo', false], [ECHO, 'Echo', true]] as const) {
    await pool.query(`
      INSERT INTO contacts (id, display_name, first_seen, last_seen, is_machine_intelligence)
      VALUES ($1, $2, '2026-07-01T00:00:00Z', '2026-09-01T00:00:00Z', $3)
    `, [id, name, machine]);
  }
  for (const [contactId, channelId] of [[ARI, DM], [ARI, ROOM], [BO, ROOM], [ECHO, 'dm-echo']]) {
    await pool.query(`
      INSERT INTO contact_channel_activity (contact_id, channel, channel_id, first_seen, last_seen)
      VALUES ($1, 'discord', $2, '2026-07-01T00:00:00Z', '2026-09-01T00:00:00Z')
    `, [contactId, channelId]);
  }
  const transcript: Array<[string, number, string, string | null, string]> = [
    [DM, 1, 'user', 'transport-ari', 'private'],
    [DM, 2, 'assistant', 'companion', 'private'],
    [DM, 3, 'user', 'transport-ari', 'private'],
    [ROOM, 1, 'user', 'transport-ari', 'invite_only'],
    [ROOM, 2, 'user', 'transport-bo', 'invite_only'],
    ['dm-echo', 1, 'user', 'transport-echo', 'private'],
  ];
  for (const [channelId, messageId, role, authorId, visibility] of transcript) {
    await pool.query(`
      INSERT INTO session_messages_projection (
        channel_id, message_id, role, author_id, author_name, content, timestamp, channel_visibility
      ) VALUES ($1, $2, $3, $4, $4, 'invented line', $2, $5)
    `, [channelId, messageId, role, authorId, visibility]);
  }
}

function turnSource(channelId: string, visibility = 'private'): string {
  return `${channelId}:extract|source:session|session:${channelId}|lines:1-3|turn:t-1|trigger:turn`
    + `|visibility:${visibility}|operation:extract`;
}

function dmProvenance(overrides: Partial<MemoryProvenance> = {}): MemoryProvenance {
  return {
    channelId: DM,
    triggerContactId: ARI,
    routedContactId: ARI,
    routingReason: 'single_speaker_transcript',
    addressMode: 'direct_to_companion',
    ...overrides,
  };
}

function memory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `invented memory ${id}`,
    type: 'semantic',
    importance: 0.6,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.5,
    sourceRef: turnSource(DM),
    extractedAt: 1_752_000_000_000,
    lastAccessed: 1_752_000_000_000,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    consentFlags: {},
    contactId: ARI,
    provenance: dmProvenance(),
    ...overrides,
  };
}

const TARGETS = ['dm-single-speaker', 'dm-structured-source'] as const;

async function seedMemories(store: MemoryStorePort): Promise<void> {
  const rows: PurrMemory[] = [
    memory('dm-single-speaker'),
    memory('dm-structured-source', {
      type: 'relational',
      provenance: dmProvenance({ routingReason: 'structured_source_metadata', sourceContactId: ARI }),
    }),
    memory('dm-already-subject', { provenance: dmProvenance({ subjectContactId: ARI }) }),
    memory('dm-named-subject', { provenance: dmProvenance({ subjectName: 'Ari\'s cousin' }) }),
    memory('dm-companion-owned', {
      contactId: undefined,
      provenance: { channelId: DM, actor: 'companion', subjectScope: 'companion_internal',
        routingReason: 'self_directed_companion' },
    }),
    memory('dm-room-scoped', { scopeTags: ['group_memory', 'room_context'] }),
    memory('dm-other-contact', {
      contactId: BO, provenance: dmProvenance({ triggerContactId: BO, routedContactId: BO }),
    }),
    memory('dm-other-routing', { provenance: dmProvenance({ routingReason: 'speaker_name_prefix' }) }),
    memory('dm-not-private', { sourceRef: turnSource(DM, 'invite_only') }),
    memory('dm-superseded', { supersededBy: 'dm-single-speaker' }),
    memory('dm-deleted'),
    memory('dm-sleeptime', { sourceRef: `sleeptime:${DM}:journal`, provenance: dmProvenance() }),
    memory('room-single-speaker', {
      sourceRef: turnSource(ROOM, 'invite_only'),
      provenance: dmProvenance({ channelId: ROOM }),
    }),
  ];
  for (const row of rows) await store.insertMemory(row, EMBEDDING);
  await store.softDeleteMemory('dm-deleted', { deleteId: 'delete-dm', deletedBy: 'tester' });
}

async function visibleIds(store: MemoryStorePort, viewerContactId: string): Promise<string[]> {
  const authorized = createSubjectAuthorizedMemoryStore(store, { viewerContactId });
  return (await authorized.listMemories()).map(item => item.id).sort();
}

async function snapshotUntouched(pool: Pool): Promise<string> {
  const rows = await pool.query<{ snapshot: string }>(`
    SELECT json_agg(row_to_json(snapshot) ORDER BY snapshot.id)::text AS snapshot FROM (
      SELECT memory.id, memory.provenance_json, memory.contact_id, memory.authorization_revision,
        memory.subject_evidence_digest, memory.deleted_at, memory.superseded_by,
        classification.subject_class, classification.status, classification.memory_revision,
        classification.evidence_digest, classification.updated_at
      FROM l2_memories memory
      LEFT JOIN l2_memory_subject_classifications classification ON classification.memory_id = memory.id
      WHERE memory.id <> ALL($1::text[])
    ) snapshot
  `, [[...TARGETS]]);
  return rows.rows[0]?.snapshot ?? '';
}

describe('DM subject repair over a real Postgres corpus (d5e0p.21)', () => {
  it('stamps only the eligible DM rows and makes them DM recall candidates', async () => {
    await withDatabase(async (pool, store) => {
      expect(await visibleIds(store, ARI)).toEqual(['dm-already-subject']);
      const untouchedBefore = await snapshotUntouched(pool);

      const dryRun = await repairDirectMessageMemorySubjects(pool, {
        channelId: DM, contactId: ARI, dryRun: true, embeddingDims: EMBEDDING.length,
      });
      expect(dryRun).toMatchObject({
        dryRun: true,
        evidence: { transcriptMessages: 3, humanAuthors: 1, activityContacts: 1 },
        scannedTurnMemories: 11,
        plannedRepairs: 2,
        repaired: 0,
        memoryIds: [...TARGETS],
        skipped: {
          deleted: 1, superseded: 1, channel_mismatch: 0, not_private_source: 1, contact_mismatch: 1,
          has_subject: 2, companion_owned: 1, unsupported_routing_reason: 1, room_scoped: 1,
          not_unattributed: 0,
        },
      });
      expect(dryRun.subjectClassesBefore.unattributed).toBe(8);
      expect(dryRun.subjectClassesAfter.unattributed).toBe(6);
      expect(dryRun.subjectClassesAfter.single_contact).toBe(dryRun.subjectClassesBefore.single_contact! + 2);
      expect(await visibleIds(store, ARI)).toEqual(['dm-already-subject']);
      expect(await snapshotUntouched(pool)).toBe(untouchedBefore);

      await expect(repairDirectMessageMemorySubjects(pool, {
        channelId: DM, contactId: ARI, dryRun: false, expectedRepairCount: 3,
      })).rejects.toThrow(/planned 2 rows but the reviewed count is 3/u);
      expect(await visibleIds(store, ARI)).toEqual(['dm-already-subject']);

      const applied = await repairDirectMessageMemorySubjects(pool, {
        channelId: DM, contactId: ARI, dryRun: false, expectedRepairCount: 2, embeddingDims: EMBEDDING.length,
      });
      expect(applied).toMatchObject({ dryRun: false, plannedRepairs: 2, repaired: 2 });
      expect(applied.subjectClassesAfter).toEqual(dryRun.subjectClassesAfter);

      expect(await visibleIds(store, ARI)).toEqual(['dm-already-subject', ...TARGETS].sort());
      expect(await visibleIds(store, BO)).toEqual([]);
      expect(await snapshotUntouched(pool)).toBe(untouchedBefore);

      const stamped = await pool.query<{
        id: string; subject: string; revision: string; memory_revision: string; status: string; subject_class: string;
      }>(`
        SELECT memory.id, memory.provenance_json->>'subjectContactId' AS subject,
          memory.authorization_revision AS revision, classification.memory_revision,
          classification.status, classification.subject_class
        FROM l2_memories memory
        JOIN l2_memory_subject_classifications classification ON classification.memory_id = memory.id
        WHERE memory.id = ANY($1::text[]) ORDER BY memory.id
      `, [[...TARGETS]]);
      for (const row of stamped.rows) {
        expect(row).toMatchObject({ subject: ARI, status: 'current', subject_class: 'single_contact' });
        expect(row.memory_revision).toBe(row.revision);
      }
      const patches = await pool.query<{ memory_id: string }>(
        "SELECT memory_id FROM l2_memory_patch_events WHERE reason = 'memory_dm_subject_repair' ORDER BY memory_id",
      );
      expect(patches.rows.map(row => row.memory_id)).toEqual([...TARGETS]);

      const rerun = await repairDirectMessageMemorySubjects(pool, {
        channelId: DM, contactId: ARI, dryRun: false, expectedRepairCount: 0,
      });
      expect(rerun).toMatchObject({ plannedRepairs: 0, repaired: 0, skipped: { has_subject: 4 } });
      expect(await snapshotUntouched(pool)).toBe(untouchedBefore);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('refuses channels that are not a private conversation with exactly that human', async () => {
    await withDatabase(async (pool) => {
      const untouchedBefore = await snapshotUntouched(pool);
      await expect(repairDirectMessageMemorySubjects(pool, {
        channelId: ROOM, contactId: ARI, dryRun: true,
      })).rejects.toThrow(/not a direct conversation with contact-ari: 2 contacts/u);
      await expect(repairDirectMessageMemorySubjects(pool, {
        channelId: DM, contactId: BO, dryRun: true,
      })).rejects.toThrow(/not a direct conversation with contact-bo/u);
      await expect(repairDirectMessageMemorySubjects(pool, {
        channelId: 'dm-echo', contactId: ECHO, dryRun: true,
      })).rejects.toThrow(/not a human contact/u);
      await pool.query(`
        INSERT INTO session_messages_projection (
          channel_id, message_id, role, author_id, author_name, content, timestamp, channel_visibility
        ) VALUES ($1, 9, 'user', 'transport-stranger', 'Stranger', 'invented line', 9, 'private')
      `, [DM]);
      await expect(repairDirectMessageMemorySubjects(pool, {
        channelId: DM, contactId: ARI, dryRun: true,
      })).rejects.toThrow(/humanAuthors=2/u);
      await expect(repairDirectMessageMemorySubjects(pool, {
        channelId: DM, contactId: ARI, dryRun: false,
      })).rejects.toThrow(/requires the reviewed dry-run planned count/u);
      expect(await snapshotUntouched(pool)).toBe(untouchedBefore);
    });
  }, INTEGRATION_TIMEOUT_MS);
});
