import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool, ensurePostgresSchema } from '../../persistence/postgres.js';
import { POSTGRES_WIKI_PROJECTION_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import { WikiPgvectorProjectionStore } from './pgvector-projection.js';
import type { WikiDocument } from './types.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const EMBEDDING_DIMS = 16;

// Deterministic bag-of-chars embedding: identical text yields an identical
// vector, so a query embedded from a document's body scores highest against
// that document's chunk. Sufficient to exercise the pgvector round trip.
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

function makeDocument(id: string, body: string, overrides: Partial<WikiDocument> = {}): WikiDocument {
  return {
    schemaVersion: 1,
    id,
    title: overrides.title ?? `Title ${id}`,
    bodyPath: overrides.bodyPath ?? `documents/${id}.md`,
    bodyFormat: 'markdown',
    tags: overrides.tags ?? [],
    sourceClass: overrides.sourceClass ?? 'companion_authored_note',
    provenanceRefs: overrides.provenanceRefs ?? [],
    sensitivity: overrides.sensitivity ?? 'personal',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    updatedBy: 'agent',
    version: overrides.version ?? 1,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    body,
    ...(overrides.scope !== undefined ? { scope: overrides.scope } : {}),
  };
}

let harness: PostgresTestHarness | null = null;
let pool: Pool;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
  const database = await harness.createDatabase();
  pool = createPostgresPool(database.databaseUrl, { applicationName: 'psfn-wiki-projection-test', allowExitOnIdle: true });
  await ensurePostgresSchema(pool, POSTGRES_WIKI_PROJECTION_MIGRATIONS);
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  try {
    await pool.end();
  } catch {
    // pool may be unset if harness setup failed; teardown is best-effort.
  }
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

describe('WikiPgvectorProjectionStore (integration)', () => {
  it('projects a document and finds it by semantic similarity', async () => {
    const store = new WikiPgvectorProjectionStore(pool, deterministicEmbedding);
    const doc = makeDocument('gateways', 'Gateways and Garden are separate runtime surfaces.\n\nThe agent is isolated.');
    const outcome = await store.syncDocument(doc);
    expect(outcome.status).toBe('ran');
    expect(outcome.chunkCount).toBeGreaterThan(0);

    const results = await store.search(embed('Gateways and Garden are separate runtime surfaces.'), 0.1, 5);
    expect(results.some(match => match.documentId === 'gateways')).toBe(true);
    const top = results.find(match => match.documentId === 'gateways');
    expect(top?.title).toBe('Title gateways');
    expect(top?.path).toBe('documents/gateways.md');
    expect(top?.score).toBeGreaterThan(0.5);
  }, INTEGRATION_TIMEOUT_MS);

  it('rebuilds from canonical files: re-embeds on checksum drift and deletes orphans', async () => {
    const store = new WikiPgvectorProjectionStore(pool, deterministicEmbedding);
    // Reset table for a clean rebuild scenario.
    await pool.query('DELETE FROM wiki_document_chunks');

    const original = makeDocument('drifter', 'Original body about memory.');
    await store.syncDocument(original);
    const orphan = makeDocument('orphan', 'Soon to be deleted.');
    await store.syncDocument(orphan);

    const projectedBefore = await store.listProjectedShas();
    expect(projectedBefore.find(row => row.documentId === 'drifter')?.bodySha256).toBe(original.bodySha256);

    // The canonical workspace changed 'drifter' (new checksum) and removed 'orphan'.
    const drifted = makeDocument('drifter', 'Rewritten body about memory and gateways.', { version: 2 });
    expect(drifted.bodySha256).not.toBe(original.bodySha256);

    const result = await store.rebuild([drifted]);
    expect(result.reembedded).toContain('drifter');
    expect(result.deleted).toContain('orphan');
    expect(result.failed).toEqual([]);

    const projectedAfter = await store.listProjectedShas();
    expect(projectedAfter.find(row => row.documentId === 'drifter')?.bodySha256).toBe(drifted.bodySha256);
    expect(projectedAfter.some(row => row.documentId === 'orphan')).toBe(false);
  }, INTEGRATION_TIMEOUT_MS);

  it('W5b: scope filter includes shared_world only for the matching site; personal always', async () => {
    const store = new WikiPgvectorProjectionStore(pool, deterministicEmbedding);
    await pool.query('DELETE FROM wiki_document_chunks');

    // A shared body distinct enough that the same query embeds close to all three.
    const body = 'The kitchen has a new toaster next to the satellite. Toaster kitchen satellite.';
    const personal = makeDocument('p-note', body);
    const studio = makeDocument('studio-note', body, { scope: 'shared_world:studio' } as Partial<WikiDocument>);
    const cabin = makeDocument('cabin-note', body, { scope: 'shared_world:cabin' } as Partial<WikiDocument>);
    await store.syncDocument(personal);
    await store.syncDocument(studio);
    await store.syncDocument(cabin);

    const query = embed(body);

    // Unfiltered (flag-off path): all three participate.
    const all = await store.search(query, 0.1, 10);
    expect(new Set(all.map(m => m.documentId))).toEqual(new Set(['p-note', 'studio-note', 'cabin-note']));

    // At studio: personal + studio shared, never cabin.
    const atStudio = await store.search(query, 0.1, 10, ['personal', 'shared_world:studio']);
    const studioIds = new Set(atStudio.map(m => m.documentId));
    expect(studioIds.has('p-note')).toBe(true);
    expect(studioIds.has('studio-note')).toBe(true);
    expect(studioIds.has('cabin-note')).toBe(false);
    expect(atStudio.find(m => m.documentId === 'studio-note')?.scope).toBe('shared_world:studio');

    // Scope swap: moving to cabin swaps the shared scope, personal untouched.
    const atCabin = await store.search(query, 0.1, 10, ['personal', 'shared_world:cabin']);
    const cabinIds = new Set(atCabin.map(m => m.documentId));
    expect(cabinIds.has('p-note')).toBe(true);
    expect(cabinIds.has('cabin-note')).toBe(true);
    expect(cabinIds.has('studio-note')).toBe(false);

    // Unsited: personal-only, no shared world leaks in.
    const personalOnly = await store.search(query, 0.1, 10, ['personal']);
    expect(new Set(personalOnly.map(m => m.documentId))).toEqual(new Set(['p-note']));
  }, INTEGRATION_TIMEOUT_MS);

  it('fails closed for search when embedding throws, without corrupting existing rows', async () => {
    const failingEmbedding: EmbeddingProviderPort = {
      dims: EMBEDDING_DIMS,
      embed: async () => { throw new Error('embed unavailable'); },
      embedBatch: async () => { throw new Error('embed unavailable'); },
    };
    const store = new WikiPgvectorProjectionStore(pool, failingEmbedding);
    const outcome = await store.syncDocument(makeDocument('fails', 'Body that cannot be embedded.'));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('embed unavailable');
  }, INTEGRATION_TIMEOUT_MS);
});
