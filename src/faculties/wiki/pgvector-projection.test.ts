import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import {
  chunkWikiBody,
  computeWikiProjectionDrift,
  createWikiPgvectorProjectionStore,
  DEFAULT_WIKI_CHUNK_MAX_CHARS,
  WikiPgvectorProjectionStore,
} from './pgvector-projection.js';
import type { WikiDocument } from './types.js';

// Schema-threading test seam: stub the Postgres port so the create function can
// be exercised without a live database. Only the pool-construction call is under
// test here; the pure chunk/drift tests below never touch these.
const postgresMocks = vi.hoisted(() => ({
  createPostgresPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [] })) })),
  ensurePostgresSchema: vi.fn(async () => undefined),
}));

vi.mock('../../persistence/postgres.js', () => ({
  createPostgresPool: postgresMocks.createPostgresPool,
  ensurePostgresSchema: postgresMocks.ensurePostgresSchema,
  queryRows: vi.fn(async () => []),
  withPostgresClient: vi.fn(),
}));

function fakeEmbedding(): EmbeddingProviderPort {
  return { dims: 8, embed: vi.fn(), embedBatch: vi.fn() } as unknown as EmbeddingProviderPort;
}

describe('createWikiPgvectorProjectionStore (per-companion schema pinning, s10f9 reconciliation)', () => {
  beforeEach(() => {
    postgresMocks.createPostgresPool.mockClear();
    postgresMocks.ensurePostgresSchema.mockClear();
  });

  it('pins the projection pool to the configured companion schema', async () => {
    await createWikiPgvectorProjectionStore('postgres://db', fakeEmbedding(), { schema: 'companion_x' });
    expect(postgresMocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://db',
      expect.objectContaining({ applicationName: 'psfn-wiki-projection', schema: 'companion_x' }),
    );
  });

  it('omits the schema property entirely when none is configured (byte-identical single-companion)', async () => {
    await createWikiPgvectorProjectionStore('postgres://db', fakeEmbedding(), {});
    expect(postgresMocks.createPostgresPool).toHaveBeenCalledTimes(1);
    const options = postgresMocks.createPostgresPool.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty('schema');
  });
});

describe('WikiPgvectorProjectionStore usage attribution', () => {
  it('classifies a personal wiki projection by its canonical document id', async () => {
    const embedBatch = vi.fn(async () => [new Float32Array(8)]);
    const embedding = {
      dims: 8,
      embed: vi.fn(),
      embedBatch,
    } as unknown as EmbeddingProviderPort;
    const store = new WikiPgvectorProjectionStore({} as never, embedding);
    const document: WikiDocument = {
      schemaVersion: 1,
      id: 'journal-index',
      title: 'Journal index',
      bodyPath: 'documents/journal-index.md',
      bodyFormat: 'markdown',
      tags: [],
      sourceClass: 'companion_authored_note',
      provenanceRefs: [],
      sensitivity: 'personal',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
      updatedBy: 'agent',
      version: 1,
      bodySha256: 'sha',
      body: 'A durable note.',
    };

    await expect(store.syncDocument(document)).resolves.toMatchObject({ status: 'ran' });
    expect(embedBatch).toHaveBeenCalledWith(['A durable note.'], {
      usageProvenance: {
        callType: 'scheduled',
        purpose: 'wiki.projection',
        originType: 'scheduled',
        originStage: 'wiki.projection',
        service: 'wiki',
        process: 'personal-projection',
        runtimeLaneClass: 'maintenance_reflection',
        workloadType: 'wiki_projection',
        workloadId: expect.stringMatching(/^wiki-projection:[a-f0-9]{64}$/),
      },
    });
    const options = embedBatch.mock.calls[0]?.[1];
    expect(options?.usageProvenance?.workloadId).not.toContain(document.id);
  });
});

describe('chunkWikiBody', () => {
  it('splits on paragraph boundaries and preserves content order', () => {
    const body = 'First paragraph about gateways.\n\nSecond paragraph about the garden.\n\nThird one.';
    const chunks = chunkWikiBody(body);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.join(' ')).toContain('First paragraph');
    expect(chunks.join(' ')).toContain('Third one');
  });

  it('hard-splits an oversized single paragraph so no chunk exceeds the cap', () => {
    const giant = 'x'.repeat(DEFAULT_WIKI_CHUNK_MAX_CHARS * 3 + 17);
    const chunks = chunkWikiBody(giant, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it('returns an empty chunk list for a blank body', () => {
    expect(chunkWikiBody('   \n\n  ')).toEqual([]);
  });
});

describe('computeWikiProjectionDrift (repair decision)', () => {
  it('flags missing documents for re-embedding', () => {
    const drift = computeWikiProjectionDrift({
      canonical: [
        { id: 'a', bodySha256: 'sha-a' },
        { id: 'b', bodySha256: 'sha-b' },
      ],
      projected: [{ documentId: 'a', bodySha256: 'sha-a' }],
    });
    expect(drift.toReembed).toEqual(['b']);
    expect(drift.toDelete).toEqual([]);
  });

  it('detects checksum drift and schedules a re-embed of the changed document', () => {
    const drift = computeWikiProjectionDrift({
      canonical: [{ id: 'a', bodySha256: 'sha-a-v2' }],
      // projection still holds the old checksum for the same document id
      projected: [{ documentId: 'a', bodySha256: 'sha-a-v1' }],
    });
    expect(drift.toReembed).toEqual(['a']);
    expect(drift.toDelete).toEqual([]);
  });

  it('treats a document with mixed projected checksums as stale', () => {
    const drift = computeWikiProjectionDrift({
      canonical: [{ id: 'a', bodySha256: 'sha-a' }],
      projected: [
        { documentId: 'a', bodySha256: 'sha-a' },
        { documentId: 'a', bodySha256: 'sha-a-old' },
      ],
    });
    expect(drift.toReembed).toEqual(['a']);
  });

  it('marks orphaned projected documents for deletion', () => {
    const drift = computeWikiProjectionDrift({
      canonical: [{ id: 'a', bodySha256: 'sha-a' }],
      projected: [
        { documentId: 'a', bodySha256: 'sha-a' },
        { documentId: 'gone', bodySha256: 'sha-gone' },
      ],
    });
    expect(drift.toReembed).toEqual([]);
    expect(drift.toDelete).toEqual(['gone']);
  });

  it('reports a clean projection as no-op', () => {
    const drift = computeWikiProjectionDrift({
      canonical: [
        { id: 'a', bodySha256: 'sha-a' },
        { id: 'b', bodySha256: 'sha-b' },
      ],
      projected: [
        { documentId: 'a', bodySha256: 'sha-a' },
        { documentId: 'b', bodySha256: 'sha-b' },
      ],
    });
    expect(drift.toReembed).toEqual([]);
    expect(drift.toDelete).toEqual([]);
  });
});
