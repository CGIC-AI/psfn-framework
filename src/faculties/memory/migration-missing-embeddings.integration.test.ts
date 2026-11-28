import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPostgresPool, ensurePostgresSchemaExists, withPostgresClient } from '../../persistence/postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import type { MemoryStorePort } from './memory-store-port.js';
import { migratePostgresMemoryEmbeddings } from './migration.js';
import { createPostgresMemoryStoreFromPool } from './postgres-store.js';
import { persistMemoryEmbedding } from './postgres-store/memory-embedding-write.js';
import { decodeEmbedding } from './postgres-store/rows.js';
import { inspectMemorySubjectClassificationCoverage } from './postgres-store/subject-coverage.js';
import type { PurrMemory } from './types.js';

// Real Postgres + pgvector, the real memory store (insert, subject classifier,
// evidence triggers) and the real backfill. The embedding provider is a
// deterministic text hash so each repaired vector can be checked exactly.

const DIMS = 16;
const SCHEMA = 'companion_fixture';
const OTHER_SCHEMA = 'companion_other';
const DM_CONTACT_ID = 'contact-dm-fixture';
const ROOM_CONTACT_ID = 'contact-room-fixture';

function textEmbedding(text: string): Float32Array {
  const digest = createHash('sha256').update(text).digest();
  return Float32Array.from({ length: DIMS }, (_unused, index) => (digest[index]! / 127.5) - 1);
}

function createProvider(dims = DIMS) {
  return {
    kind: 'test-text-hash',
    dims,
    embed: vi.fn(async (text: string) => textEmbedding(text)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(textEmbedding)),
  };
}

function memory(id: string, text: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id, text, type: 'semantic', importance: 0.8, confidence: 0.9, emotionalValence: 0,
    tags: [], sensitivity: 'personal', consentFlags: {}, salience: 0.8,
    sourceRef: 'turn:invented', sourceType: 'turn', extractedAt: 1_000, lastAccessed: 1_000, accessCount: 0,
    ...overrides,
  };
}

const ACTIVE_MISSING = [
  memory('mem-010', 'Morgan keeps two beehives on the roof.', {
    contactId: DM_CONTACT_ID,
    provenance: { channelId: 'discord:dm-fixture', sourceContactId: DM_CONTACT_ID, subjectContactId: DM_CONTACT_ID },
  }),
  memory('mem-020', 'Robin mentioned the choir rehearses on Thursdays.', {
    contactId: ROOM_CONTACT_ID,
    provenance: {
      channelId: 'discord:guild-fixture:general', sourceContactId: ROOM_CONTACT_ID,
      subjectContactId: ROOM_CONTACT_ID, addressMode: 'room',
    },
  }),
  memory('mem-030', 'Morgan has a serious hazelnut allergy.', {
    contactId: DM_CONTACT_ID, sensitivity: 'sensitive',
    provenance: { channelId: 'discord:dm-fixture', sourceContactId: DM_CONTACT_ID, subjectContactId: DM_CONTACT_ID },
  }),
  memory('mem-040', 'The companion enjoys describing old tram maps.', { provenance: {} }),
];
const ALREADY_EMBEDDED = memory('mem-005', 'Morgan started learning the cello.', {
  contactId: DM_CONTACT_ID,
  provenance: { channelId: 'discord:dm-fixture', sourceContactId: DM_CONTACT_ID, subjectContactId: DM_CONTACT_ID },
});
const DELETED_MISSING = memory('mem-050', 'A memory the owner deleted.', { contactId: DM_CONTACT_ID });
const SUPERSEDED_MISSING = memory('mem-060', 'An outdated version of a fact.', {
  contactId: DM_CONTACT_ID, supersededBy: 'mem-010',
});
const EXPECTED_IDS = ACTIVE_MISSING.map(row => row.id);

let harness: PostgresTestHarness | undefined;
let databaseUrl = '';
const pools: Pool[] = [];
let tenantPool: Pool;
let otherPool: Pool;
let store: MemoryStorePort;

interface PrivacySnapshot {
  id: string;
  row: Record<string, unknown>;
  classification: Record<string, unknown> | undefined;
}

async function privacySnapshot(ids: readonly string[]): Promise<PrivacySnapshot[]> {
  const rows = await tenantPool.query(`
    SELECT id, contact_id, sensitivity, scope_ref_kind, scope_ref_id, scope_tags, consent_flags,
      retention_class, provenance_json, deleted_at, superseded_by
    FROM l2_memories WHERE id = ANY($1::text[]) ORDER BY id
  `, [ids]);
  return await Promise.all(rows.rows.map(async (row: Record<string, unknown>) => {
    const classification = await store.getMemorySubjectClassification(String(row.id));
    return {
      id: String(row.id),
      row,
      classification: classification && {
        subjectClass: classification.subjectClass,
        status: classification.status,
        subjectContactIds: classification.subjectContactIds,
        roomId: classification.roomId,
        reasonClass: classification.reasonClass,
        evidence: classification.evidence,
      },
    };
  }));
}

async function embeddingState(pool: Pool, ids: readonly string[]) {
  return (await pool.query<{ id: string; embedding: string | null; authorization_revision: string }>(`
    SELECT id, embedding::text AS embedding, authorization_revision::text AS authorization_revision
    FROM l2_memories WHERE id = ANY($1::text[]) ORDER BY id
  `, [ids])).rows;
}

beforeAll(async () => {
  harness = await startPostgresTestHarness();
  databaseUrl = (await harness.createDatabase()).databaseUrl;
  const adminPool = createPostgresPool(databaseUrl, { applicationName: 'missing-embedding-test', allowExitOnIdle: true });
  await ensurePostgresSchemaExists(adminPool, SCHEMA);
  await ensurePostgresSchemaExists(adminPool, OTHER_SCHEMA);
  await adminPool.end();
  otherPool = createPostgresPool(databaseUrl, {
    applicationName: 'missing-embedding-test', allowExitOnIdle: true, schema: OTHER_SCHEMA,
  });
  tenantPool = createPostgresPool(databaseUrl, {
    applicationName: 'missing-embedding-test', allowExitOnIdle: true, schema: SCHEMA,
  });
  pools.push(otherPool, tenantPool);
  store = await createPostgresMemoryStoreFromPool(tenantPool, DIMS);
  for (const row of [...ACTIVE_MISSING, ALREADY_EMBEDDED, DELETED_MISSING, SUPERSEDED_MISSING]) {
    await store.insertMemory(row, textEmbedding(`stale:${row.text}`));
  }
  await store.softDeleteMemory(DELETED_MISSING.id);
  // Reproduce the defect: rows that lost their embedding. The classifier then
  // re-runs as at startup, so each row is gated exactly as production serves it.
  await tenantPool.query(`UPDATE l2_memories SET embedding = NULL WHERE id = ANY($1::text[])`, [
    [...EXPECTED_IDS, DELETED_MISSING.id, SUPERSEDED_MISSING.id],
  ]);
  await store.backfillMemorySubjectClassifications({ resetCheckpoint: true });

  // A different companion's schema in the same database, with its own gap.
  const decoyStore = await createPostgresMemoryStoreFromPool(otherPool, DIMS);
  await decoyStore.insertMemory(memory('mem-001', 'A different companion memory.'), textEmbedding('decoy'));
  await decoyStore.insertMemory(memory('mem-002', 'Another embedded memory.'), textEmbedding('decoy-2'));
  await otherPool.query(`UPDATE l2_memories SET embedding = NULL WHERE id = 'mem-001'`);
});

afterAll(async () => {
  for (const pool of pools.splice(0)) await pool.end();
  await harness?.stop();
});

describe('missing-embedding backfill (psfn-framework-d5e0p.23)', () => {
  it('plans, applies in bounds, resumes, stays idempotent, and keeps every row as private as it was', async () => {
    const privacyBefore = await privacySnapshot([...EXPECTED_IDS, ALREADY_EMBEDDED.id]);
    expect(privacyBefore.every(entry => entry.classification?.status === 'current')).toBe(true);
    const untouchedBefore = await embeddingState(tenantPool, [ALREADY_EMBEDDED.id, DELETED_MISSING.id, SUPERSEDED_MISSING.id]);

    // Dry run: exactly the active NULL rows of this schema, nothing written.
    const provider = createProvider();
    const dryRun = await migratePostgresMemoryEmbeddings(databaseUrl, provider, {
      schema: SCHEMA, missingOnly: true, dryRun: true,
    });
    expect(dryRun).toMatchObject({
      dryRun: true, total: 4, updated: 0, failed: 0, selectedMemoryIds: EXPECTED_IDS,
      coverageBefore: { activeMemoryCount: 5, activeMissingEmbeddingCount: 4 },
    });
    expect(dryRun.nextAfterId).toBeUndefined();
    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect((await embeddingState(tenantPool, EXPECTED_IDS)).every(row => row.embedding === null)).toBe(true);

    // Bounded apply, then resume from the cursor.
    const first = await migratePostgresMemoryEmbeddings(databaseUrl, provider, {
      schema: SCHEMA, missingOnly: true, limit: 2, batchSize: 1,
    });
    expect(first).toMatchObject({
      dryRun: false, total: 2, updated: 2, failed: 0, selectedMemoryIds: EXPECTED_IDS.slice(0, 2),
      nextAfterId: EXPECTED_IDS[1], coverageAfter: { activeMissingEmbeddingCount: 2 },
    });
    const second = await migratePostgresMemoryEmbeddings(databaseUrl, provider, {
      schema: SCHEMA, missingOnly: true, limit: 2, afterId: first.nextAfterId!,
    });
    expect(second).toMatchObject({
      total: 2, updated: 2, failed: 0, selectedMemoryIds: EXPECTED_IDS.slice(2),
      coverageAfter: { activeMemoryCount: 5, activeMissingEmbeddingCount: 0 },
    });
    expect(second.nextAfterId).toBeUndefined();
    expect(provider.embedBatch.mock.calls.flatMap(([texts]) => texts))
      .toEqual(ACTIVE_MISSING.map(row => row.text));

    const repaired = await embeddingState(tenantPool, EXPECTED_IDS);
    expect(repaired.map(row => decodeEmbedding(row.embedding))).toEqual(
      ACTIVE_MISSING.map(row => textEmbedding(row.text)),
    );

    // Idempotent: nothing left to select, nothing re-embedded or re-revised.
    const rerun = await migratePostgresMemoryEmbeddings(databaseUrl, provider, { schema: SCHEMA, missingOnly: true });
    expect(rerun).toMatchObject({ total: 0, updated: 0, selectedMemoryIds: [] });
    expect(provider.embedBatch).toHaveBeenCalledTimes(3);
    expect(await embeddingState(tenantPool, EXPECTED_IDS)).toEqual(repaired);

    // Untouched: the embedded row, the deleted row, the superseded row, and
    // the other schema's row.
    expect(await embeddingState(tenantPool, [ALREADY_EMBEDDED.id, DELETED_MISSING.id, SUPERSEDED_MISSING.id]))
      .toEqual(untouchedBefore);
    expect((await embeddingState(otherPool, ['mem-001']))[0]!.embedding).toBeNull();

    // Privacy and visibility unchanged; every classification current again.
    expect(await privacySnapshot([...EXPECTED_IDS, ALREADY_EMBEDDED.id])).toEqual(privacyBefore);
    expect(await inspectMemorySubjectClassificationCoverage(tenantPool))
      .toMatchObject({ missingCurrentClassificationCount: 0 });
  });

  it('keeps rows classified when the full re-embed rewrites every vector', async () => {
    const ids = [...EXPECTED_IDS, ALREADY_EMBEDDED.id, SUPERSEDED_MISSING.id];
    const privacyBefore = await privacySnapshot(ids);
    const revisionsBefore = await embeddingState(tenantPool, ids);
    const provider = createProvider();
    provider.embedBatch.mockImplementation(async (texts: string[]) => texts.map(text => textEmbedding(`v2:${text}`)));

    const report = await migratePostgresMemoryEmbeddings(databaseUrl, provider, { schema: SCHEMA });
    expect(report).toMatchObject({ missingOnly: false, total: 6, updated: 6, failed: 0 });
    const after = await embeddingState(tenantPool, ids);
    expect(after.map(row => Number(row.authorization_revision)))
      .toEqual(revisionsBefore.map(row => Number(row.authorization_revision) + 1));
    expect(await privacySnapshot(ids)).toEqual(privacyBefore);
    expect(await inspectMemorySubjectClassificationCoverage(tenantPool))
      .toMatchObject({ missingCurrentClassificationCount: 0 });
  });

  it('refuses a schema without a memory corpus instead of reporting it clean', async () => {
    const memorySchemas = async () => (await tenantPool.query<{ table_schema: string }>(`
      SELECT DISTINCT table_schema FROM information_schema.tables
      WHERE table_name = 'l2_memories' ORDER BY table_schema
    `)).rows.map(row => row.table_schema);
    const before = await memorySchemas();
    await expect(migratePostgresMemoryEmbeddings(databaseUrl, createProvider(), {
      schema: 'companion_mistyped', missingOnly: true, dryRun: true,
    })).rejects.toThrow(/no l2_memories table in schema/);
    expect(await memorySchemas()).toEqual(before);
  });

  it('never overwrites a row another writer embedded first', async () => {
    const before = await embeddingState(tenantPool, [ALREADY_EMBEDDED.id]);
    const outcome = await withPostgresClient(tenantPool, async client => (
      await persistMemoryEmbedding(client, ALREADY_EMBEDDED.id, textEmbedding('other'), { onlyIfMissing: true })
    ));
    expect(outcome).toBe('already_embedded');
    expect(await embeddingState(tenantPool, [ALREADY_EMBEDDED.id])).toEqual(before);
  });

  it('refuses to apply with a provider in a different vector space, but still reports', async () => {
    const provider = createProvider(DIMS * 2);
    const report = await migratePostgresMemoryEmbeddings(databaseUrl, provider, { schema: OTHER_SCHEMA, missingOnly: true, dryRun: true });
    expect(report).toMatchObject({ total: 1, selectedMemoryIds: ['mem-001'] });
    await expect(migratePostgresMemoryEmbeddings(databaseUrl, provider, { schema: OTHER_SCHEMA, missingOnly: true }))
      .rejects.toThrow(/stored embeddings have dimension 16 but the embedding provider produces 32/);
    expect(provider.embedBatch).not.toHaveBeenCalled();
  });

  it('counts a row it cannot re-classify as failed and leaves it unchanged', async () => {
    await otherPool.query(`UPDATE l2_memories SET type = 'unsupported_fixture_type' WHERE id = 'mem-001'`);
    const before = await embeddingState(otherPool, ['mem-001']);
    const report = await migratePostgresMemoryEmbeddings(databaseUrl, createProvider(), { schema: OTHER_SCHEMA, missingOnly: true });
    expect(report).toMatchObject({
      total: 1, updated: 0, failed: 1,
      failures: [{ memoryId: 'mem-001', error: expect.stringContaining('cannot be decoded') }],
      coverageAfter: { activeMissingEmbeddingCount: 1 },
    });
    expect(await embeddingState(otherPool, ['mem-001'])).toEqual(before);
  });
});
