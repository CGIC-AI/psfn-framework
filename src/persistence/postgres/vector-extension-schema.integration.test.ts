import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import {
  createPostgresPool,
  runPostgresMigrations,
} from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresMemoryStoreFromPool } from '../../faculties/memory/postgres-store.js';
import { POSTGRES_MEMORY_MIGRATIONS } from './migrations.js';

const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | undefined;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

async function readVectorExtensionSchema(pool: Pool): Promise<string | undefined> {
  const result = await pool.query<{ schema_name: string }>(`
    SELECT namespace.nspname AS schema_name
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
    WHERE extension.extname = 'vector'
  `);
  return result.rows[0]?.schema_name;
}

const LEGACY_SUBJECT_EVIDENCE_TRIGGER_FUNCTION = `
  CREATE OR REPLACE FUNCTION psfn_prepare_memory_subject_evidence_change()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'UPDATE' AND (
      NEW.text IS DISTINCT FROM OLD.text
      OR NEW.type IS DISTINCT FROM OLD.type
      OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
      OR NEW.source_type IS DISTINCT FROM OLD.source_type
      OR NEW.provenance_json IS DISTINCT FROM OLD.provenance_json
      OR NEW.provenance_refs IS DISTINCT FROM OLD.provenance_refs
      OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
      OR NEW.scope_ref_kind IS DISTINCT FROM OLD.scope_ref_kind
      OR NEW.scope_ref_id IS DISTINCT FROM OLD.scope_ref_id
      OR NEW.scope_ref_label IS DISTINCT FROM OLD.scope_ref_label
      OR NEW.scope_tags IS DISTINCT FROM OLD.scope_tags
      OR NEW.tags IS DISTINCT FROM OLD.tags
      OR NEW.embedding IS DISTINCT FROM OLD.embedding
      OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
      OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
    ) THEN
      NEW.authorization_revision := OLD.authorization_revision + 1;
      NEW.subject_evidence_digest := NULL;
    END IF;
    RETURN NEW;
  END
  $$;
`;

interface TriggerTransitionCase {
  expectedChange?: boolean;
  id: string;
  initialEmbedding: string | null;
  initialSupersededBy: string | null;
  nextEmbedding?: string | null;
  nextSupersededBy?: string | null;
}

const SUBJECT_EVIDENCE_TRANSITIONS: readonly TriggerTransitionCase[] = [
  {
    id: 'superseded-null-to-value',
    initialEmbedding: '[0.9,0.1,0.1,0.1]',
    initialSupersededBy: null,
    nextSupersededBy: 'replacement-a',
  },
  {
    id: 'superseded-value-to-value',
    initialEmbedding: '[0.9,0.1,0.1,0.1]',
    initialSupersededBy: 'replacement-a',
    nextSupersededBy: 'replacement-b',
  },
  {
    id: 'superseded-value-to-null',
    initialEmbedding: '[0.9,0.1,0.1,0.1]',
    initialSupersededBy: 'replacement-a',
    nextSupersededBy: null,
  },
  {
    id: 'embedding-null-to-value',
    initialEmbedding: null,
    initialSupersededBy: null,
    nextEmbedding: '[0.1,0.2,0.3,0.4]',
  },
  {
    id: 'embedding-value-to-value',
    initialEmbedding: '[0.1,0.2,0.3,0.4]',
    initialSupersededBy: null,
    nextEmbedding: '[0.4,0.3,0.2,0.1]',
  },
  {
    id: 'embedding-value-to-null',
    initialEmbedding: '[0.1,0.2,0.3,0.4]',
    initialSupersededBy: null,
    nextEmbedding: null,
  },
  {
    expectedChange: false,
    id: 'embedding-equivalent-value-is-unchanged',
    // pgvector equality treats signed zeroes as equal. A text comparison does
    // not, so this protects the trigger's original vector equality semantics.
    initialEmbedding: '[0,1,0,0]',
    initialSupersededBy: null,
    nextEmbedding: '[-0,1,0,0]',
  },
];

async function exerciseSubjectEvidenceTransitions(
  client: PoolClient,
  idPrefix: string,
): Promise<void> {
  for (const transition of SUBJECT_EVIDENCE_TRANSITIONS) {
    const id = `${idPrefix}-${transition.id}`;
    await client.query(`
      INSERT INTO l2_memories (
        id, text, type, importance, confidence, emotional_valence, salience,
        source_ref, extracted_at, last_accessed, access_count, superseded_by,
        subject_evidence_digest, embedding
      ) VALUES (
        $1, 'trigger transition', 'semantic', 0.5, 0.9, 0, 0.5,
        'integration:mk4h3', 1, 1, 0, $2, $3, $4
      )
    `, [id, transition.initialSupersededBy, 'a'.repeat(64), transition.initialEmbedding]);

    const assignments: string[] = [];
    const values: unknown[] = [id];
    if ('nextSupersededBy' in transition) {
      values.push(transition.nextSupersededBy);
      assignments.push(`superseded_by = $${values.length}`);
    }
    if ('nextEmbedding' in transition) {
      values.push(transition.nextEmbedding);
      assignments.push(`embedding = $${values.length}`);
    }
    const updated = await client.query<{
      authorization_revision: string;
      subject_evidence_digest: string | null;
    }>(`
      UPDATE l2_memories
      SET ${assignments.join(', ')}
      WHERE id = $1
      RETURNING authorization_revision, subject_evidence_digest
    `, values);

    expect(updated.rows[0], transition.id).toEqual(
      transition.expectedChange === false
        ? {
          authorization_revision: '1',
          subject_evidence_digest: 'a'.repeat(64),
        }
        : {
          authorization_revision: '2',
          subject_evidence_digest: null,
        },
    );
  }
}

describe('Postgres pgvector extension schema targeting', () => {
  it('quarantines legacy contact profile prose until a live Recent Contact Shape rebuild', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase();
    const pool = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-recent-contact-shape-cutover',
      max: 1,
    });
    try {
      await pool.query(`
        CREATE TABLE contact_profiles (
          contact_id TEXT PRIMARY KEY,
          summary_text TEXT NOT NULL,
          source_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
          confidence_score DOUBLE PRECISION NOT NULL,
          novelty_score DOUBLE PRECISION NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);
      await pool.query(`
        INSERT INTO contact_profiles (
          contact_id, summary_text, source_memory_ids,
          confidence_score, novelty_score, updated_at
        ) VALUES (
          'contact-legacy', 'Unverified legacy prose', '["memory-legacy"]'::jsonb,
          0.9, 0.8, 1000
        )
      `);

      await runPostgresMigrations(pool, POSTGRES_MEMORY_MIGRATIONS);

      await expect(pool.query(`
        SELECT
          to_regclass('contact_profiles')::text AS legacy_table,
          to_regclass('recent_contact_shapes')::text AS current_table,
          schema_version,
          updated_at,
          fresh_until
        FROM recent_contact_shapes
        WHERE contact_id = 'contact-legacy'
      `)).resolves.toMatchObject({
        rows: [{
          legacy_table: null,
          current_table: 'recent_contact_shapes',
          schema_version: 0,
          updated_at: '1000',
          fresh_until: '1000',
        }],
      });

      const store = await createPostgresMemoryStoreFromPool(pool, 4, {
        awaitAnnIndexBuild: true,
        subjectBackfill: false,
      });
      await expect(store.getRecentContactShape('contact-legacy')).resolves.toBeUndefined();

      const rebuilt = {
        schemaVersion: 1 as const,
        contactId: 'contact-legacy',
        summary: 'Current source-grounded interaction shape',
        sourceMemoryIds: ['memory-current'],
        confidenceScore: 0.9,
        noveltyScore: 0.8,
        updatedAt: 2000,
        freshUntil: 3000,
      };
      await store.upsertRecentContactShape(rebuilt);
      await expect(store.getRecentContactShape('contact-legacy')).resolves.toEqual(rebuilt);
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('migrates an unprovisioned legacy database with pgvector in public', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase({ provisionExtensionSchema: false });
    const pool = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-schema-legacy',
      max: 1,
    });
    try {
      await pool.query('CREATE EXTENSION vector WITH SCHEMA public');

      await runPostgresMigrations(pool, POSTGRES_MEMORY_MIGRATIONS);

      await expect(pool.query(`
        SELECT
          to_regnamespace('extensions')::text AS extension_namespace,
          to_regclass('public.l2_memories')::text AS memory_table
      `)).resolves.toMatchObject({
        rows: [{
          extension_namespace: null,
          memory_table: 'l2_memories',
        }],
      });
      await expect(readVectorExtensionSchema(pool)).resolves.toBe('public');
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('migrates public and named tenants with pgvector in extensions', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase();
    const admin = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-schema-admin',
      max: 1,
    });
    const publicTenant = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-schema-public-tenant',
      schema: 'public',
      max: 1,
    });
    const namedTenant = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-schema-named-tenant',
      schema: 'companion_vector',
      max: 1,
    });
    try {
      await admin.query('CREATE EXTENSION vector WITH SCHEMA extensions');

      await runPostgresMigrations(publicTenant, POSTGRES_MEMORY_MIGRATIONS, {
        schema: 'public',
      });
      await runPostgresMigrations(namedTenant, POSTGRES_MEMORY_MIGRATIONS, {
        schema: 'companion_vector',
      });

      await expect(readVectorExtensionSchema(admin)).resolves.toBe('extensions');
      await expect(admin.query(`
        SELECT to_regclass('public.l2_memories')::text AS public_table,
               to_regclass('companion_vector.l2_memories')::text AS named_table
      `)).resolves.toMatchObject({
        rows: [{
          public_table: 'l2_memories',
          named_table: 'companion_vector.l2_memories',
        }],
      });
    } finally {
      await publicTenant.end();
      await namedTenant.end();
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('repairs the legacy memory evidence trigger for canonical and tenant-only callers', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase();
    const admin = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-trigger-admin',
      max: 1,
    });
    const canonicalTenant = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-trigger-canonical',
      schema: 'companion_vector_trigger',
      max: 1,
    });
    const tenantOnly = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-trigger-tenant-only',
      max: 1,
    });
    try {
      await admin.query('CREATE EXTENSION vector WITH SCHEMA extensions');
      await runPostgresMigrations(canonicalTenant, POSTGRES_MEMORY_MIGRATIONS, {
        schema: 'companion_vector_trigger',
      });

      const canonicalClient = await canonicalTenant.connect();
      try {
        await exerciseSubjectEvidenceTransitions(canonicalClient, 'canonical');
        await canonicalClient.query(LEGACY_SUBJECT_EVIDENCE_TRIGGER_FUNCTION);
      } finally {
        canonicalClient.release();
      }

      // The normal idempotent memory migration chain is the upgrade path for
      // already-created companion schemas. It must replace the legacy function
      // without requiring a trigger drop, privilege expansion, or search_path change.
      await runPostgresMigrations(canonicalTenant, POSTGRES_MEMORY_MIGRATIONS, {
        schema: 'companion_vector_trigger',
      });

      const tenantOnlyClient = await tenantOnly.connect();
      try {
        await tenantOnlyClient.query('SET search_path = companion_vector_trigger');
        await exerciseSubjectEvidenceTransitions(tenantOnlyClient, 'tenant-only');
      } finally {
        tenantOnlyClient.release();
      }
    } finally {
      await tenantOnly.end();
      await canonicalTenant.end();
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('installs available pgvector in extensions for an explicit public tenant', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase();
    const publicTenant = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-schema-public-tenant-install',
      schema: 'public',
      max: 1,
    });
    try {
      await runPostgresMigrations(publicTenant, POSTGRES_MEMORY_MIGRATIONS, {
        schema: 'public',
      });

      await expect(readVectorExtensionSchema(publicTenant)).resolves.toBe('extensions');
    } finally {
      await publicTenant.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('fails closed with both accepted schemas named when pgvector is unavailable', async () => {
    const plainHarness = await startPostgresTestHarness({
      image: DEFAULT_POSTGRES_TEST_IMAGE,
    });
    try {
      const database = await plainHarness.createDatabase({ provisionExtensionSchema: false });
      const pool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-vector-schema-missing',
        max: 1,
      });
      try {
        await expect(
          runPostgresMigrations(pool, POSTGRES_MEMORY_MIGRATIONS),
        ).rejects.toThrow(
          'pgvector is not installed in either acceptable schema: public or extensions',
        );
      } finally {
        await pool.end();
      }
    } finally {
      await plainHarness.stop();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
