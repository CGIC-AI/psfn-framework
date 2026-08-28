import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createPostgresPool, ensurePostgresSchema } from '../../../persistence/postgres.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import { EpisodeSemanticIndexer } from './episode-index.js';
import type { EpisodeCreateInput, EpisodeEmbeddingProfile } from './store-port.js';

const CREATED_AT = new Date('2026-07-28T11:00:00.000Z');
const REPOINTED_AT = new Date('2026-07-28T12:00:00.000Z');
const UPDATED_AT = new Date('2026-07-28T12:01:00.000Z');
const EMBEDDING_PROFILE: EpisodeEmbeddingProfile = {
  documentSchema: 'l01-episode-search/1',
  provider: 'transformers',
  model: 'integration-model',
  dimensions: 3,
};

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, 90_000);

afterAll(async () => {
  await harness?.stop();
});

async function withEpisodicDatabase<T>(
  operation: (
    pool: Pool,
    store: PostgresEpisodicStore,
    setNow: (value: Date) => void,
  ) => Promise<T>,
): Promise<T> {
  if (!harness) throw new Error('PostgreSQL integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-episodic-thread-repoint-integration',
    allowExitOnIdle: true,
    max: 2,
  });
  let now = CREATED_AT;
  try {
    await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
    const store = new PostgresEpisodicStore(pool, { now: () => now });
    await store.createEpisode(episodeInput('episode-anchor', 'thread-old'));
    await store.createEpisode(episodeInput('episode-sibling', 'thread-old'));
    now = REPOINTED_AT;
    return await operation(pool, store, value => {
      now = value;
    });
  } finally {
    await pool.end();
  }
}

function episodeInput(id: string, threadId: string): EpisodeCreateInput {
  return {
    id,
    threadId,
    channelId: 'api:episodic-repoint-integration',
    title: `Episode ${id}`,
    landmark: `Landmark ${id}`,
    startedAt: '2026-07-28T10:00:00.000Z',
    endedAt: '2026-07-28T10:10:00.000Z',
    participantContactIds: ['contact:integration'],
    salience: { score: 0.5 },
    affect: { labels: [] },
    themes: ['integration'],
    spanRefs: [{ spanId: `span-${id}`, sessionId: 'api:episodic-repoint-integration' }],
    artifactRefs: [],
    provenanceRefs: [],
  };
}

interface EpisodeRepointRow {
  id: string;
  thread_id: string;
  episode_json: { threadId?: unknown; updatedAt?: unknown };
  updated_at: Date | string;
}

async function readRows(pool: Pool): Promise<EpisodeRepointRow[]> {
  return (await pool.query<EpisodeRepointRow>(`
    SELECT id, thread_id, episode_json, updated_at
    FROM l01_episodes
    ORDER BY id ASC
  `)).rows;
}

describe('PostgresEpisodicStore thread repoint integration', () => {
  it('repairs timestamp drift with the relational CAS token and resumes cleanly', async () => {
    await withEpisodicDatabase(async (pool, store) => {
      await store.markEpisodeMerged('episode-sibling', 'episode-anchor');
      await pool.query(`
        UPDATE l01_episodes
        SET updated_at = updated_at + INTERVAL '1 microsecond'
        WHERE id = 'episode-anchor'
      `);
      const [target] = await store.listEpisodeEmbeddingTargets({
        profile: EMBEDDING_PROFILE,
        limit: 1,
      });
      if (!target) throw new Error('expected drifted episode embedding target');
      expect(target.episode.updatedAt).toBe(CREATED_AT.toISOString());
      const drift = await pool.query<{
        token_matches: boolean;
        json_matches: boolean;
      }>(`
        SELECT
          updated_at = $2::timestamptz AS token_matches,
          updated_at = (episode_json->>'updatedAt')::timestamptz AS json_matches
        FROM l01_episodes
        WHERE id = $1
      `, ['episode-anchor', target.sourceRevision]);
      expect(drift.rows[0]).toEqual({ token_matches: true, json_matches: false });

      const embedding: EmbeddingProviderPort = {
        dims: 3,
        embed: async () => new Float32Array([1, 0, 0]),
        embedBatch: async () => [],
      };
      const firstProcess = new EpisodeSemanticIndexer(store, embedding, {
        provider: EMBEDDING_PROFILE.provider,
        model: EMBEDDING_PROFILE.model,
        now: () => REPOINTED_AT,
      });
      await expect(firstProcess.runBackfill({ limit: 1 })).resolves.toMatchObject({
        selected: 1,
        written: 1,
        concurrentlyChanged: [],
        noProgress: false,
      });

      const restartedProcess = new EpisodeSemanticIndexer(store, embedding, {
        provider: EMBEDDING_PROFILE.provider,
        model: EMBEDDING_PROFILE.model,
        now: () => UPDATED_AT,
      });
      await expect(restartedProcess.runBackfill({ limit: 1 })).resolves.toMatchObject({
        selected: 0,
        written: 0,
        noProgress: false,
      });
    });
  });

  it('rejects a stale vector after a concurrent source revision and retries fresh content', async () => {
    await withEpisodicDatabase(async (pool, store) => {
      await store.markEpisodeMerged('episode-sibling', 'episode-anchor');
      const [target] = await store.listEpisodeEmbeddingTargets({
        profile: EMBEDDING_PROFILE,
        limit: 1,
      });
      if (!target) throw new Error('expected episode embedding target');

      const embeddedDocuments: string[] = [];
      const embedding: EmbeddingProviderPort = {
        dims: 3,
        embed: async (document) => {
          embeddedDocuments.push(document);
          return embeddedDocuments.length === 1
            ? new Float32Array([1, 0, 0])
            : new Float32Array([0, 1, 0]);
        },
        embedBatch: async () => [],
      };
      const indexer = new EpisodeSemanticIndexer(store, embedding, {
        provider: EMBEDDING_PROFILE.provider,
        model: EMBEDDING_PROFILE.model,
        now: () => REPOINTED_AT,
      });

      await pool.query(`
        UPDATE l01_episodes
        SET episode_json = jsonb_set(
              jsonb_set(episode_json, '{title}', to_jsonb('Concurrent title'::text), true),
              '{updatedAt}',
              to_jsonb($2::text),
              true
            ),
            updated_at = $2::timestamptz
        WHERE id = $1
      `, ['episode-anchor', UPDATED_AT.toISOString()]);

      await expect(indexer.indexEpisode(
        target.episode,
        target.sourceRevision,
      )).resolves.toEqual({
        episodeId: 'episode-anchor',
        status: 'changed_during_index',
      });
      await expect(indexer.runBackfill({ limit: 1 })).resolves.toMatchObject({
        selected: 1,
        written: 1,
        concurrentlyChanged: [],
      });
      expect(embeddedDocuments[0]).toContain('Title: Episode episode-anchor');
      expect(embeddedDocuments[1]).toContain('Title: Concurrent title');
      await expect(store.searchEpisodesByEmbedding({
        profile: EMBEDDING_PROFILE,
        queryEmbedding: new Float32Array([0, 1, 0]),
        limit: 1,
      })).resolves.toMatchObject([{
        episode: { id: 'episode-anchor', title: 'Concurrent title' },
        similarity: 1,
      }]);
    });
  });

  it('searches only live vectors from the exact current episode revision', async () => {
    await withEpisodicDatabase(async (_pool, store, setNow) => {
      const anchor = await store.getEpisode('episode-anchor');
      const sibling = await store.getEpisode('episode-sibling');
      if (!anchor || !sibling) throw new Error('expected seeded episodes');

      await expect(store.writeEpisodeEmbedding({
        episodeId: anchor.id,
        sourceRevision: anchor.updatedAt,
        profile: EMBEDDING_PROFILE,
        documentHash: 'a'.repeat(64),
        embedding: new Float32Array([1, 0, 0]),
        indexedAt: CREATED_AT.toISOString(),
      })).resolves.toBe(true);
      await expect(store.writeEpisodeEmbedding({
        episodeId: sibling.id,
        sourceRevision: sibling.updatedAt,
        profile: EMBEDDING_PROFILE,
        documentHash: 'b'.repeat(64),
        embedding: new Float32Array([0, 1, 0]),
        indexedAt: CREATED_AT.toISOString(),
      })).resolves.toBe(true);

      await store.confirmEpisodeCanonical(anchor.id);
      await expect(store.getEpisode(anchor.id)).resolves.toMatchObject({
        updatedAt: REPOINTED_AT.toISOString(),
      });

      await expect(store.searchEpisodesByEmbedding({
        profile: EMBEDDING_PROFILE,
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 2,
      })).resolves.toMatchObject([
        { episode: { id: 'episode-anchor' }, similarity: 1 },
        { episode: { id: 'episode-sibling' }, similarity: 0 },
      ]);

      await store.markEpisodeMerged(sibling.id, anchor.id);
      setNow(UPDATED_AT);
      const {
        schemaVersion: _schemaVersion,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...anchorUpdate
      } = anchor;
      await store.updateEpisode({ ...anchorUpdate, title: 'Updated anchor' });

      await expect(store.searchEpisodesByEmbedding({
        profile: EMBEDDING_PROFILE,
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 2,
      })).resolves.toEqual([]);
      await expect(store.getEpisodeEmbeddingIndexHealth(EMBEDDING_PROFILE)).resolves.toEqual({
        total: 1,
        current: 0,
        missing: 0,
        stale: 1,
        failed: 0,
      });
      await expect(store.listEpisodeEmbeddingTargets({
        profile: EMBEDDING_PROFILE,
        limit: 2,
      })).resolves.toMatchObject([{ episode: { id: 'episode-anchor' }, reason: 'stale' }]);
    });
  });

  it('round-trips first-person authorship columns and exposes legacy NULL as unknown', async () => {
    await withEpisodicDatabase(async (pool, store) => {
      await expect(store.getEpisodeFirstPersonAuthorship('episode-anchor')).resolves.toEqual({
        episodeId: 'episode-anchor',
        affect: 'none',
        meaning: 'none',
      });

      await store.createCompanionAuthoredEpisode({
        ...episodeInput('companion-authored', 'thread-authored'),
        affect: { valence: 0.4, labels: ['hopeful'] },
        meaning: {
          text: 'I chose these words for what the moment meant to me.',
          recordedAt: CREATED_AT.toISOString(),
          source: 'companion_direct',
        },
      });
      await expect(store.getEpisodeFirstPersonAuthorship('companion-authored')).resolves.toEqual({
        episodeId: 'companion-authored',
        affect: 'companion',
        meaning: 'companion',
      });
      await store.updateCompanionAuthoredEpisode({
        id: 'companion-authored',
        affect: { valence: 0.6, labels: ['hopeful', 'grounded'] },
      });
      await expect(store.getEpisode('companion-authored')).resolves.toMatchObject({
        affect: { valence: 0.6, labels: ['hopeful', 'grounded'] },
      });

      await pool.query(`
        UPDATE l01_episodes
        SET affect_authorship = NULL, meaning_authorship = NULL
        WHERE id = 'companion-authored'
      `);
      await expect(store.getEpisodeFirstPersonAuthorship('companion-authored')).resolves.toEqual({
        episodeId: 'companion-authored',
        affect: 'legacy_unknown',
        meaning: 'legacy_unknown',
      });
    });
  });

  it('keeps a failed multi-member repoint atomic, then writes one typed timestamp everywhere', async () => {
    await withEpisodicDatabase(async (pool, store) => {
      await pool.query(`
        CREATE FUNCTION reject_sibling_repoint() RETURNS trigger AS $$
        BEGIN
          IF NEW.id = 'episode-sibling' AND NEW.thread_id = 'thread-new' THEN
            RAISE EXCEPTION 'injected sibling repoint failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await pool.query(`
        CREATE TRIGGER reject_sibling_repoint
        BEFORE UPDATE ON l01_episodes
        FOR EACH ROW EXECUTE FUNCTION reject_sibling_repoint()
      `);

      await expect(store.repointThreadMembers({
        fromThreadId: 'thread-old',
        toThreadId: 'thread-new',
        maxEpisodes: 10,
      })).rejects.toThrow(/injected sibling repoint failure/);

      const unchanged = await readRows(pool);
      expect(unchanged).toHaveLength(2);
      for (const row of unchanged) {
        expect(row.thread_id).toBe('thread-old');
        expect(row.episode_json.threadId).toBe('thread-old');
        expect(new Date(row.updated_at).toISOString()).toBe(CREATED_AT.toISOString());
      }

      await pool.query('DROP TRIGGER reject_sibling_repoint ON l01_episodes');
      await pool.query('DROP FUNCTION reject_sibling_repoint()');

      await expect(store.repointThreadMembers({
        fromThreadId: 'thread-old',
        toThreadId: 'thread-new',
        maxEpisodes: 10,
      })).resolves.toMatchObject({
        skippedOversize: false,
        updatedEpisodeIds: ['episode-anchor', 'episode-sibling'],
      });

      const updated = await readRows(pool);
      for (const row of updated) {
        expect(row.thread_id).toBe('thread-new');
        expect(row.episode_json.threadId).toBe('thread-new');
        expect(row.episode_json.updatedAt).toBe(REPOINTED_AT.toISOString());
        expect(new Date(row.updated_at).toISOString()).toBe(REPOINTED_AT.toISOString());
      }
    });
  });
});
