import { describe, expect, it, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { parseEpisode, serializeEpisode } from '../../../shared/contracts/episodic-memory.js';
import { FakeEpisodicPool } from '../../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import type { EpisodeEmbeddingProfile } from './store-port.js';

const PROFILE: EpisodeEmbeddingProfile = {
  documentSchema: 'l01-episode-search/1',
  provider: 'transformers',
  model: 'test-model',
  dimensions: 3,
};

const EPISODE = parseEpisode({
  schemaVersion: 2,
  id: 'episode-1',
  title: 'Backfill target',
  landmark: 'The indexer found this episode.',
  startedAt: '2026-08-09T09:00:00.000Z',
  endedAt: '2026-08-09T09:30:00.000Z',
  participantContactIds: [],
  salience: { score: 0.7 },
  affect: { labels: [] },
  themes: ['memory'],
  spanRefs: [{ spanId: 'span-1' }],
  artifactRefs: [],
  provenanceRefs: [{ kind: 'l0_span', refId: 'span-1' }],
  createdAt: '2026-08-09T09:30:00.000Z',
  updatedAt: '2026-08-09T10:00:00.000Z',
});

function queryResult(rows: unknown[], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
}

describe('PostgresEpisodicStore episode embedding index', () => {
  it('attempts live indexing after episode creates and material updates commit', async () => {
    const pool = new FakeEpisodicPool();
    const store = new PostgresEpisodicStore(pool as unknown as Pool);
    const indexEpisode = vi.fn(async () => ({
      episodeId: EPISODE.id,
      status: 'indexed' as const,
    }));
    store.attachEpisodeEmbeddingIndexer({ indexEpisode });
    const {
      schemaVersion: _schemaVersion,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...input
    } = EPISODE;

    const created = await store.createEpisode(input);
    const {
      schemaVersion: _createdSchemaVersion,
      createdAt: _createdCreatedAt,
      updatedAt: _createdUpdatedAt,
      ...update
    } = created;
    const updated = await store.updateEpisode({ ...update, title: 'Updated episode' });

    expect(indexEpisode).toHaveBeenNthCalledWith(1, created);
    expect(indexEpisode).toHaveBeenNthCalledWith(2, updated);
    expect(pool.episodes.get(EPISODE.id)?.episode_json).toBe(serializeEpisode(updated));
  });

  it('keeps a current embedding current when confirming a candidate', async () => {
    const query = vi.fn(async () => queryResult([], 1));
    const confirmedAt = new Date('2026-08-10T12:00:00.000Z');
    const store = new PostgresEpisodicStore(
      { query } as unknown as Pool,
      { now: () => confirmedAt },
    );

    await store.confirmEpisodeCanonical(EPISODE.id);

    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("SET status = 'canonical'");
    expect(String(sql)).toContain("jsonb_set(\n            episode_json,\n            '{updatedAt}'");
    expect(String(sql)).toContain('WHEN embedding_source_updated_at = updated_at THEN $2::timestamptz');
    expect(String(sql)).toContain('updated_at = $2::timestamptz');
    expect(values).toEqual([EPISODE.id, confirmedAt.toISOString()]);
  });

  it('selects a bounded deterministic batch of missing, stale, or failed live episodes', async () => {
    const query = vi.fn(async () => queryResult([{
      id: EPISODE.id,
      episode_json: serializeEpisode(EPISODE),
      index_state: 'stale',
      embedding_last_error: null,
    }]));
    const store = new PostgresEpisodicStore({ query } as unknown as Pool);

    await expect(store.listEpisodeEmbeddingTargets({
      profile: PROFILE,
      limit: 5,
    })).resolves.toEqual([{ episode: EPISODE, reason: 'stale' }]);

    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("status IN ('canonical', 'candidate')");
    expect(String(sql)).toContain('embedding_document_schema IS DISTINCT FROM $1');
    expect(String(sql)).toContain('embedding_source_updated_at IS DISTINCT FROM updated_at');
    expect(String(sql)).toContain('ORDER BY embedding_attempted_at ASC NULLS FIRST, updated_at ASC, id ASC');
    expect(values).toEqual([
      PROFILE.documentSchema,
      PROFILE.provider,
      PROFILE.model,
      PROFILE.dimensions,
      5,
    ]);
  });

  it('writes derived vector state only when the live episode revision still matches', async () => {
    const query = vi.fn(async () => queryResult([{}], 1));
    const store = new PostgresEpisodicStore({ query } as unknown as Pool);

    await expect(store.writeEpisodeEmbedding({
      episodeId: EPISODE.id,
      sourceUpdatedAt: EPISODE.updatedAt,
      profile: PROFILE,
      documentHash: 'a'.repeat(64),
      embedding: new Float32Array([0.1, 0.2, 0.3]),
      indexedAt: '2026-08-10T12:00:00.000Z',
    })).resolves.toBe(true);

    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('embedding = $3::vector');
    expect(String(sql)).toContain('embedding_source_updated_at = $8');
    expect(String(sql)).toContain('embedding_last_error = NULL');
    expect(String(sql)).toContain('updated_at = $8');
    expect(String(sql)).toContain("status IN ('canonical', 'candidate')");
    expect(values).toEqual([
      EPISODE.id,
      EPISODE.updatedAt,
      '[0.10000000149011612,0.20000000298023224,0.30000001192092896]',
      PROFILE.documentSchema,
      PROFILE.provider,
      PROFILE.model,
      PROFILE.dimensions,
      EPISODE.updatedAt,
      'a'.repeat(64),
      '2026-08-10T12:00:00.000Z',
    ]);
  });

  it('persists a retryable indexing error without changing the episode or its prior vector', async () => {
    const query = vi.fn(async () => queryResult([{}], 1));
    const store = new PostgresEpisodicStore({ query } as unknown as Pool);

    await expect(store.recordEpisodeEmbeddingFailure({
      episodeId: EPISODE.id,
      sourceUpdatedAt: EPISODE.updatedAt,
      profile: PROFILE,
      error: 'provider unavailable',
      attemptedAt: '2026-08-10T12:00:00.000Z',
    })).resolves.toBe(true);

    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('embedding_attempted_at = $7');
    expect(String(sql)).toContain('embedding_last_error = $8');
    expect(String(sql)).not.toContain('SET embedding =');
    expect(String(sql)).not.toContain('episode_json =');
    expect(String(sql)).toContain('updated_at = $2');
    expect(values).toEqual([
      EPISODE.id,
      EPISODE.updatedAt,
      PROFILE.documentSchema,
      PROFILE.provider,
      PROFILE.model,
      PROFILE.dimensions,
      '2026-08-10T12:00:00.000Z',
      'provider unavailable',
    ]);
  });

  it('returns bounded semantic candidates only from the exact current index profile', async () => {
    const query = vi.fn(async () => queryResult([{
      id: EPISODE.id,
      episode_json: serializeEpisode(EPISODE),
      similarity: '0.875',
    }]));
    const store = new PostgresEpisodicStore({ query } as unknown as Pool);

    await expect(store.searchEpisodesByEmbedding({
      profile: PROFILE,
      queryEmbedding: new Float32Array([0.2, 0.3, 0.4]),
      limit: 6,
    })).resolves.toEqual([{ episode: EPISODE, similarity: 0.875 }]);

    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('embedding_document_schema = $2');
    expect(String(sql)).toContain('embedding_last_error IS NULL');
    expect(String(sql)).toContain('embedding_source_updated_at = updated_at');
    expect(String(sql)).toContain('vector_dims(embedding) = $5');
    expect(String(sql)).toContain('ORDER BY embedding <=> $1::vector ASC, id ASC');
    expect(values).toEqual([
      '[0.20000000298023224,0.30000001192092896,0.4000000059604645]',
      PROFILE.documentSchema,
      PROFILE.provider,
      PROFILE.model,
      PROFILE.dimensions,
      6,
    ]);

    await expect(store.searchEpisodesByEmbedding({
      profile: PROFILE,
      queryEmbedding: new Float32Array([0.2, 0.3]),
      limit: 6,
    })).rejects.toThrow(/dimension mismatch/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports missing, stale, and failed live index state without reading episode bodies', async () => {
    const query = vi.fn(async () => queryResult([{
      total_count: '9',
      current_count: '4',
      missing_count: '2',
      stale_count: '1',
      failed_count: '2',
    }]));
    const store = new PostgresEpisodicStore({ query } as unknown as Pool);

    await expect(store.getEpisodeEmbeddingIndexHealth(PROFILE)).resolves.toEqual({
      total: 9,
      current: 4,
      missing: 2,
      stale: 1,
      failed: 2,
    });
    const [sql] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("status IN ('canonical', 'candidate')");
    expect(String(sql)).toContain('embedding_document_schema IS DISTINCT FROM $1');
    expect(String(sql)).toContain('embedding_source_updated_at IS DISTINCT FROM updated_at');
    expect(String(sql)).not.toContain('episode_json');
  });
});
