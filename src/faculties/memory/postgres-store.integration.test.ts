import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool, ensurePostgresSchema } from '../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import { startPostgresTestHarness, type PostgresTestHarness } from '../../test-support/postgres-test-harness.js';
import { createPostgresMemoryStoreFromPool } from './postgres-store.js';
import type { PurrMemory } from './types.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const DEFAULT_EMBEDDING = new Float32Array([0.9, 0.1, 0.1, 0.1]);

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) {
    await harness.stop();
  }
}, INTEGRATION_TIMEOUT_MS);

function makeMemory(overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id: overrides.id ?? 'memory-test-id',
    text: overrides.text ?? 'Postgres integration memory',
    type: overrides.type ?? 'semantic',
    importance: overrides.importance ?? 0.6,
    confidence: overrides.confidence ?? 0.9,
    emotionalValence: overrides.emotionalValence ?? 0.1,
    salience: overrides.salience ?? 0.3,
    sourceRef: overrides.sourceRef ?? 'api:test:postgres',
    extractedAt: overrides.extractedAt ?? 1_700_000_000_000,
    lastAccessed: overrides.lastAccessed ?? 1_700_000_000_000,
    accessCount: overrides.accessCount ?? 0,
    tags: overrides.tags ?? ['postgres', 'integration'],
    sensitivity: overrides.sensitivity ?? 'low',
    consentFlags: overrides.consentFlags ?? {},
    ...(overrides.formationVAD ? { formationVAD: overrides.formationVAD } : {}),
    ...(overrides.scopeRef ? { scopeRef: overrides.scopeRef } : {}),
    ...(overrides.scopeTags ? { scopeTags: overrides.scopeTags } : {}),
    ...(overrides.provenanceRefs ? { provenanceRefs: overrides.provenanceRefs } : {}),
    ...(overrides.retentionClass ? { retentionClass: overrides.retentionClass } : {}),
    ...(overrides.supersededBy ? { supersededBy: overrides.supersededBy } : {}),
    ...(overrides.contactId ? { contactId: overrides.contactId } : {}),
    ...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
    ...(overrides.deletedBy ? { deletedBy: overrides.deletedBy } : {}),
    ...(overrides.deleteReason ? { deleteReason: overrides.deleteReason } : {}),
  };
}

function encodeJsonValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

async function withMemoryDatabase<T>(handler: (pool: Pool) => Promise<T>): Promise<T> {
  if (!harness) {
    throw new Error('Postgres integration harness is not available');
  }
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-memory-integration',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    return await handler(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function seedMemoryRow(pool: Pool, memory: PurrMemory, embedding: readonly number[]): Promise<void> {
  await pool.query(`
    INSERT INTO l2_memories (
      id, text, type, importance, confidence, emotional_valence, formation_vad, salience,
      source_ref, extracted_at, last_accessed, access_count, superseded_by, tags,
      scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
      retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
      delete_reason, embedding
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
    )
  `, [
    memory.id,
    memory.text,
    memory.type,
    memory.importance,
    memory.confidence,
    memory.emotionalValence,
    encodeJsonValue(memory.formationVAD),
    memory.salience,
    memory.sourceRef,
    memory.extractedAt,
    memory.lastAccessed,
    memory.accessCount,
    memory.supersededBy ?? null,
    encodeJsonValue(memory.tags),
    memory.scopeRef?.kind ?? null,
    memory.scopeRef?.id ?? null,
    memory.scopeRef?.label ?? null,
    encodeJsonValue(memory.scopeTags ?? []),
    encodeJsonValue(memory.provenanceRefs ?? []),
    memory.retentionClass ?? null,
    memory.sensitivity,
    encodeJsonValue(memory.consentFlags ?? {}),
    memory.contactId ?? null,
    memory.deletedAt ?? null,
    memory.deletedBy ?? null,
    memory.deleteReason ?? null,
    embedding,
  ]);
}

describe('postgres memory store integration', () => {
  it('initializes the supported schema and hydrates seeded rows from postgres', async () => {
    await withMemoryDatabase(async (pool) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);

      const schemaTables = await pool.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('l2_memories', 'l2_memory_embeddings')
        ORDER BY table_name
      `);
      expect(schemaTables.rows.map(row => row.table_name)).toEqual(['l2_memories']);

      const embeddingColumn = await pool.query<{ column_name: string; data_type: string; udt_name: string }>(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'l2_memories'
          AND column_name = 'embedding'
      `);
      expect(embeddingColumn.rows).toHaveLength(1);
      expect(embeddingColumn.rows[0]).toMatchObject({
        column_name: 'embedding',
        data_type: 'ARRAY',
      });

      const seededMemory = makeMemory({
        id: 'seeded-memory',
        text: 'Seeded memory for postgres hydration',
        sourceRef: 'seed:postgres',
        extractedAt: 1_700_000_100_000,
        lastAccessed: 1_700_000_100_000,
        tags: ['hydration', 'postgres'],
      });
      await seedMemoryRow(pool, seededMemory, [0.9, 0.1, 0.1, 0.1]);

      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      expect(await store.getById(seededMemory.id)).toMatchObject({
        id: seededMemory.id,
        text: seededMemory.text,
        sourceRef: seededMemory.sourceRef,
      });

      const textSearch = await store.searchByText('hydration', 10);
      expect(textSearch).toHaveLength(1);
      expect(textSearch[0]).toMatchObject({
        id: seededMemory.id,
        text: seededMemory.text,
      });

      const embeddingSearch = await store.searchByEmbedding(DEFAULT_EMBEDDING, 0.99, 10);
      expect(embeddingSearch).toHaveLength(1);
      expect(embeddingSearch[0]).toMatchObject({
        id: seededMemory.id,
        text: seededMemory.text,
      });
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('persists insert, update, retrieval, and soft delete flows to postgres', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      const memory = makeMemory({
        id: 'write-memory',
        text: 'Write path memory for postgres persistence',
        sourceRef: 'api:test:write',
        extractedAt: 1_700_000_200_000,
        lastAccessed: 1_700_000_200_000,
        tags: ['write', 'postgres'],
      });

      await store.insertMemory(memory, DEFAULT_EMBEDDING);

      const inserted = await pool.query<{
        id: string;
        text: string;
        salience: number;
        deleted_at: number | null;
        embedding: number[] | null;
      }>('SELECT id, text, salience, deleted_at, embedding FROM l2_memories WHERE id = $1', [memory.id]);
      expect(inserted.rows).toHaveLength(1);
      expect(inserted.rows[0]).toMatchObject({
        id: memory.id,
        text: memory.text,
        deleted_at: null,
      });
      const expectedEmbedding = Array.from(DEFAULT_EMBEDDING);
      expect(inserted.rows[0]?.embedding).toHaveLength(4);
      inserted.rows[0]?.embedding?.forEach((value, index) => {
        expect(value).toBeCloseTo(expectedEmbedding[index]!, 5);
      });

      expect(await store.getById(memory.id)).toMatchObject({
        id: memory.id,
        text: memory.text,
      });
      const searchResults = await store.searchByEmbedding(DEFAULT_EMBEDDING, 0.99, 10);
      expect(searchResults).toHaveLength(1);
      expect(searchResults[0]).toMatchObject({
        id: memory.id,
        text: memory.text,
      });

      await store.updateMemory(memory.id, {
        salience: 0.95,
        contactId: 'contact-123',
      });

      const updated = await pool.query<{
        salience: number;
        contact_id: string | null;
      }>('SELECT salience, contact_id FROM l2_memories WHERE id = $1', [memory.id]);
      expect(updated.rows).toHaveLength(1);
      expect(updated.rows[0]).toMatchObject({
        salience: 0.95,
        contact_id: 'contact-123',
      });

      const deleteVersion = await store.softDeleteMemory(memory.id, {
        deleteId: 'delete-version-123',
        deletedBy: 'integration-test',
        reason: 'cleanup',
      });
      expect(deleteVersion).toMatchObject({
        deleteId: 'delete-version-123',
        memoryId: memory.id,
        deletedBy: 'integration-test',
        deleteReason: 'cleanup',
      });

      const deleted = await pool.query<{
        deleted_at: number | null;
        deleted_by: string | null;
        delete_reason: string | null;
      }>('SELECT deleted_at, deleted_by, delete_reason FROM l2_memories WHERE id = $1', [memory.id]);
      expect(deleted.rows).toHaveLength(1);
      expect(deleted.rows[0]?.deleted_at).not.toBeNull();
      expect(Number(deleted.rows[0]?.deleted_at)).toBeGreaterThan(0);
      expect(deleted.rows[0]).toMatchObject({
        deleted_by: 'integration-test',
        delete_reason: 'cleanup',
      });

      const deleteVersionRows = await pool.query<{
        delete_id: string;
        memory_id: string;
        deleted_by: string | null;
        delete_reason: string | null;
      }>('SELECT delete_id, memory_id, deleted_by, delete_reason FROM l2_memory_delete_versions WHERE delete_id = $1', ['delete-version-123']);
      expect(deleteVersionRows.rows).toHaveLength(1);
      expect(deleteVersionRows.rows[0]).toMatchObject({
        delete_id: 'delete-version-123',
        memory_id: memory.id,
        deleted_by: 'integration-test',
        delete_reason: 'cleanup',
      });

      expect(await store.countActiveMemories()).toBe(0);
      expect(await store.getById(memory.id)).toMatchObject({
        id: memory.id,
        deletedBy: 'integration-test',
      });
      expect(await store.searchByEmbedding(DEFAULT_EMBEDDING, 0.99, 10)).toHaveLength(0);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('rejects legacy embedding tables before startup', async () => {
    await withMemoryDatabase(async (pool) => {
      await pool.query(`
        CREATE TABLE l2_memory_embeddings (
          memory_id TEXT PRIMARY KEY,
          embedding DOUBLE PRECISION[] NOT NULL
        )
      `);

      await expect(createPostgresMemoryStoreFromPool(pool, 4)).rejects.toThrow(
        'Unsupported PostgreSQL memory schema detected: l2_memory_embeddings is no longer used',
      );
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('rejects schemas missing l2_memories.embedding before startup', async () => {
    await withMemoryDatabase(async (pool) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      await pool.query('ALTER TABLE l2_memories DROP COLUMN embedding');

      await expect(createPostgresMemoryStoreFromPool(pool, 4)).rejects.toThrow(
        'PostgreSQL memory schema is missing l2_memories.embedding',
      );
    });
  }, INTEGRATION_TIMEOUT_MS);
});
