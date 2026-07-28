import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createPostgresPool, ensurePostgresSchema } from '../../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import type { EpisodeCreateInput } from './store-port.js';

const CREATED_AT = new Date('2026-07-28T11:00:00.000Z');
const REPOINTED_AT = new Date('2026-07-28T12:00:00.000Z');

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
});

afterAll(async () => {
  await harness?.stop();
});

async function withEpisodicDatabase<T>(
  operation: (pool: Pool, store: PostgresEpisodicStore) => Promise<T>,
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
    return await operation(pool, store);
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
    affect: { valence: 0, arousal: 0, dominance: 0.5, labels: ['neutral'] },
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
