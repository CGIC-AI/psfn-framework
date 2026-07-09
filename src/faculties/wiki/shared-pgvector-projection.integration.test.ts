// ── Live-database integration tests for the shared-world wiki projection (s10f9) ──
// Follows the companion-presence harness pattern: a throwaway dockerized
// postgres (pgvector image — this chain NEEDS the extension), a fresh database
// per test. Covers what the unit tests cannot: real DDL for shared migration
// v3 (table, site-qualified PK, scope CHECK, ledger), delete-and-replace sync
// semantics, per-site rebuild isolation, and the rebuild-safety invariant that
// the per-companion projection can never touch shared chunks.

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool, ensurePostgresSchema } from '../../persistence/postgres.js';
import {
  POSTGRES_WIKI_PROJECTION_MIGRATIONS,
  SHARED_SCHEMA_NAME,
} from '../../persistence/postgres/migrations.js';
import { ensureSharedWikiSchema } from '../../persistence/postgres/shared-schema.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import { WikiPgvectorProjectionStore } from './pgvector-projection.js';
import {
  createSharedWikiPgvectorProjectionStore,
  type SharedWikiPgvectorProjectionStore,
} from './shared-pgvector-projection.js';
import type { WikiDocument } from './types.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const EMBEDDING_DIMS = 16;

// Deterministic bag-of-chars embedding (same as the personal projection's
// integration test): identical text yields an identical vector.
const deterministicEmbedding: EmbeddingProviderPort = {
  dims: EMBEDDING_DIMS,
  embed: async (text: string) => embed(text),
  embedBatch: async (texts: string[]) => texts.map(embed),
};

function embed(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMS);
  for (const char of text) {
    vector[char.charCodeAt(0) % EMBEDDING_DIMS] += 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] as number) / norm;
  }
  return vector;
}

function makeSharedDocument(
  siteId: string,
  id: string,
  body: string,
  overrides: Partial<WikiDocument> = {},
): WikiDocument {
  return {
    schemaVersion: 1,
    id,
    title: overrides.title ?? `Title ${id}`,
    bodyPath: overrides.bodyPath ?? `documents/${id}.md`,
    bodyFormat: 'markdown',
    tags: overrides.tags ?? [],
    sourceClass: overrides.sourceClass ?? 'system_seed',
    provenanceRefs: overrides.provenanceRefs ?? [],
    sensitivity: overrides.sensitivity ?? 'personal',
    scope: overrides.scope ?? (`shared_world:${siteId}` as WikiDocument['scope']),
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    updatedBy: 'places-wiki-publisher',
    version: overrides.version ?? 1,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    body,
  };
}

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) {
    await harness.stop();
  }
}, INTEGRATION_TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) {
    throw new Error('Postgres integration harness is not available');
  }
  const database = await harness.createDatabase();
  return database.databaseUrl;
}

async function connectStore(databaseUrl: string): Promise<SharedWikiPgvectorProjectionStore> {
  return createSharedWikiPgvectorProjectionStore(databaseUrl, deterministicEmbedding);
}

describe('shared_wiki_chunks shared-schema integration (s10f9)', () => {
  it(
    'provisions the chunk table, indexes, and ledger version 3 in the shared schema only',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await connectStore(databaseUrl);
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-shared-wiki-verify',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        const tables = await pool.query<{ table_schema: string }>(
          `SELECT table_schema FROM information_schema.tables
           WHERE table_name = 'shared_wiki_chunks' ORDER BY table_schema`,
        );
        expect(tables.rows.map(r => r.table_schema)).toEqual([SHARED_SCHEMA_NAME]);

        const indexes = await pool.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname = 'shared' AND tablename = 'shared_wiki_chunks'
           ORDER BY indexname`,
        );
        expect(indexes.rows.map(r => r.indexname)).toEqual(
          expect.arrayContaining(['idx_shared_wiki_chunks_site', 'idx_shared_wiki_chunks_scope']),
        );

        const ledger = await pool.query<{ version: number; name: string }>(
          `SELECT version, name FROM shared.shared_schema_migrations ORDER BY version`,
        );
        expect(ledger.rows).toEqual([
          { version: 1, name: 'shared-schema-baseline' },
          { version: 2, name: 'companion-presence' },
          { version: 3, name: 'shared-wiki-chunks' },
        ]);

        // Idempotent re-provisioning (advisory-lock serialized).
        await ensureSharedWikiSchema(pool);
        const ledgerAgain = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM shared.shared_schema_migrations`,
        );
        expect(ledgerAgain.rows[0]?.count).toBe('3');
      } finally {
        await pool.end();
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'projects per site: same document id coexists across sites and scope filtering is exact',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await connectStore(databaseUrl);
      try {
        const body = 'The kitchen has a new toaster next to the satellite.';
        await store.syncDocument('studio', makeSharedDocument('studio', 'site-overview', body));
        await store.syncDocument('cabin', makeSharedDocument('cabin', 'site-overview', body));

        const query = embed(body);
        const atStudio = await store.search(query, 0.1, 10, ['shared_world:studio']);
        expect(atStudio).toHaveLength(1);
        expect(atStudio[0]?.scope).toBe('shared_world:studio');

        const atCabin = await store.search(query, 0.1, 10, ['shared_world:cabin']);
        expect(atCabin).toHaveLength(1);
        expect(atCabin[0]?.scope).toBe('shared_world:cabin');

        // Both sites at once dedups per (scope, document): two entries survive
        // even though the document id is identical.
        const both = await store.search(query, 0.1, 10, ['shared_world:studio', 'shared_world:cabin']);
        expect(both).toHaveLength(2);

        // A personal scope in the filter matches nothing here — there is no
        // personal data in the shared table, by CHECK constraint.
        const personalOnly = await store.search(query, 0.1, 10, ['personal']);
        expect(personalOnly).toEqual([]);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'sync is idempotent delete-and-replace per document version',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await connectStore(databaseUrl);
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-shared-wiki-rows',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        const original = makeSharedDocument('studio', 'kitchen', 'Original kitchen note.\n\nSecond paragraph.');
        const first = await store.syncDocument('studio', original);
        expect(first.status).toBe('ran');
        const again = await store.syncDocument('studio', original);
        expect(again.chunkCount).toBe(first.chunkCount);
        const countAfterRepeat = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM shared.shared_wiki_chunks
           WHERE site_id = 'studio' AND document_id = 'kitchen'`,
        );
        expect(Number(countAfterRepeat.rows[0]?.count)).toBe(first.chunkCount);

        // New version replaces the old rows outright (no stale sha left).
        const rewritten = makeSharedDocument('studio', 'kitchen', 'Rewritten kitchen note.', { version: 2 });
        await store.syncDocument('studio', rewritten);
        const shas = await pool.query<{ body_sha256: string }>(
          `SELECT DISTINCT body_sha256 FROM shared.shared_wiki_chunks
           WHERE site_id = 'studio' AND document_id = 'kitchen'`,
        );
        expect(shas.rows.map(r => r.body_sha256)).toEqual([rewritten.bodySha256]);
      } finally {
        await pool.end();
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'rebuildSite reconciles one site only: drift re-embedded, orphans pruned, other sites untouched',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await connectStore(databaseUrl);
      try {
        await store.syncDocument('studio', makeSharedDocument('studio', 'drifter', 'Original body.'));
        await store.syncDocument('studio', makeSharedDocument('studio', 'orphan', 'Soon deleted.'));
        await store.syncDocument('cabin', makeSharedDocument('cabin', 'cabin-note', 'Cabin body.'));

        const drifted = makeSharedDocument('studio', 'drifter', 'Rewritten body.', { version: 2 });
        const result = await store.rebuildSite('studio', [drifted]);
        expect(result.reembedded).toEqual(['drifter']);
        expect(result.deleted).toEqual(['orphan']);
        expect(result.failed).toEqual([]);

        // Cabin's projection is untouched by the studio rebuild.
        const cabinShas = await store.listProjectedShas('cabin');
        expect(cabinShas.map(row => row.documentId)).toEqual(['cabin-note']);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'REBUILD SAFETY: a per-companion projection rebuild never touches shared chunks',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const sharedStore = await connectStore(databaseUrl);
      // Personal projection in its default (public-schema) home, exactly as the
      // agent runtime wires it.
      const personalPool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-wiki-personal',
        allowExitOnIdle: true,
      });
      try {
        await ensurePostgresSchema(personalPool, POSTGRES_WIKI_PROJECTION_MIGRATIONS);
        const personalStore = new WikiPgvectorProjectionStore(personalPool, deterministicEmbedding);

        await personalStore.syncDocument(
          { ...makeSharedDocument('studio', 'p-note', 'Personal note body.'), scope: undefined } as unknown as WikiDocument,
        );
        await sharedStore.syncDocument('studio', makeSharedDocument('studio', 'site-overview', 'Shared world body.'));

        // The boot-time repair path with an EMPTY canonical workspace — the
        // exact scenario that reaps every orphan the personal table holds.
        const result = await personalStore.rebuild([]);
        expect(result.deleted).toEqual(['p-note']);

        // Personal table drained; shared table byte-for-byte intact.
        expect(await personalStore.listProjectedShas()).toEqual([]);
        const sharedShas = await sharedStore.listProjectedShas('studio');
        expect(sharedShas.map(row => row.documentId)).toEqual(['site-overview']);
      } finally {
        await personalPool.end();
        await sharedStore.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'fails closed on leak surfaces: mis-scoped documents are rejected and the DB CHECK backstops raw rows',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await connectStore(databaseUrl);
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-shared-wiki-check',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        // A personal-scoped document can never be projected into the shared table.
        const personalDoc = {
          ...makeSharedDocument('studio', 'sneaky', 'Body.'),
          scope: undefined,
        } as unknown as WikiDocument;
        await expect(store.syncDocument('studio', personalDoc)).rejects.toThrow(/refuses document/i);

        // Neither can a document scoped to a DIFFERENT site.
        const crossSite = makeSharedDocument('cabin', 'cross', 'Body.');
        await expect(store.syncDocument('studio', crossSite)).rejects.toThrow(/refuses document/i);

        // And the schema itself refuses a raw mis-scoped row (belt-and-suspenders).
        await expect(pool.query(
          `INSERT INTO shared.shared_wiki_chunks (
             site_id, document_id, chunk_index, body_sha256, title, body_path, source_class,
             sensitivity, scope, chunk_text, chunk_char_count, embedding, updated_at
           ) VALUES ('studio', 'raw', 0, 'sha', 't', 'p', 'system_seed',
             'personal', 'personal', 'text', 4, $1::vector, 0)`,
          [`[${new Array(EMBEDDING_DIMS).fill(0).join(',')}]`],
        )).rejects.toThrow(/check constraint/i);
      } finally {
        await pool.end();
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
