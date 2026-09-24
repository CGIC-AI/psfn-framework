import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { createPostgresPool, ensurePostgresSchema } from '../../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import type { EpisodeCreateInput } from './store-port.js';
import {
  createSubjectAuthorizedEpisodicStore,
  type EpisodicSubjectAccessContext,
} from './subject-authorized-store.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const VIEWER = 'contact-viewer';
const OTHER = 'contact-other';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

/** Records every row id the pool materializes from l01_episodes. */
function recordingPool(pool: Pool, materialized: string[]): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
      return async (...args: Parameters<Pool['query']>) => {
        const result = await (target.query as (...a: unknown[]) => Promise<QueryResult<QueryResultRow>>)(...args);
        const text = typeof args[0] === 'string' ? args[0] : '';
        if (/FROM l01_episodes\b/.test(text) && !/l01_episode_arcs/.test(text)) {
          for (const row of result.rows) {
            if (typeof row.id === 'string') materialized.push(row.id);
          }
        }
        return result;
      };
    },
  });
}

function episode(id: string, index: number, participantContactIds: string[]): EpisodeCreateInput {
  const minute = String(index).padStart(2, '0');
  return {
    id,
    threadId: 'thread-shared',
    channelId: 'api:subject-pagination',
    title: `Episode ${id}`,
    landmark: `Landmark ${id}`,
    startedAt: `2026-07-28T10:${minute}:00.000Z`,
    endedAt: `2026-07-28T10:${minute}:30.000Z`,
    participantContactIds,
    salience: { score: 0.5 },
    affect: { labels: [] },
    themes: ['pagination'],
    spanRefs: [{ spanId: `span-${id}`, sessionId: 'api:subject-pagination' }],
    artifactRefs: [],
    provenanceRefs: [],
  };
}

async function withSeededStore(
  operation: (raw: PostgresEpisodicStore, recording: PostgresEpisodicStore, materialized: string[]) => Promise<void>,
): Promise<void> {
  if (!harness) throw new Error('PostgreSQL integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-episodic-subject-pagination-integration',
    allowExitOnIdle: true,
    max: 2,
  });
  try {
    await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
    const raw = new PostgresEpisodicStore(pool, { now: () => new Date('2026-07-28T11:00:00.000Z') });
    // Interleave: other-only, viewer, unattributed, other-only, viewer, ...
    const layout: Array<[string, string[]]> = [
      ['e01-other', [OTHER]],
      ['e02-viewer', [VIEWER]],
      ['e03-unattributed', []],
      ['e04-other', [OTHER]],
      ['e05-both', [VIEWER, OTHER]],
      ['e06-other', [OTHER]],
      ['e07-viewer', [VIEWER]],
      ['e08-other', [OTHER]],
    ];
    for (const [index, [id, participants]] of layout.entries()) {
      await raw.createEpisode(episode(id, index, participants));
    }
    for (const [source, target] of [['e02-viewer', 'e05-both'], ['e02-viewer', 'e04-other'], ['e05-both', 'e07-viewer']]) {
      await raw.writeEpisodeArc({
        sourceEpisodeId: source!,
        targetEpisodeId: target!,
        arcKind: 'continuation',
        salience: 0.6,
        confidence: 0.8,
        themes: ['pagination'],
        spanRefs: [],
        artifactRefs: [],
        provenanceRefs: [],
      });
    }
    const materialized: string[] = [];
    const recording = new PostgresEpisodicStore(recordingPool(pool, materialized), {
      now: () => new Date('2026-07-28T11:00:00.000Z'),
    });
    await operation(raw, recording, materialized);
  } finally {
    await pool.end();
  }
}

const member: EpisodicSubjectAccessContext = { viewerContactId: VIEWER };

describe('subject-authorized episodic reads push authorization into SQL (klvoz)', () => {
  it('pages over authorized rows only and never materializes invisible episodes', async () => {
    await withSeededStore(async (_raw, recording, materialized) => {
      const scoped = createSubjectAuthorizedEpisodicStore(recording, member);
      const page1 = await scoped.listEpisodes({ limit: 2, offset: 0 });
      const page2 = await scoped.listEpisodes({ limit: 2, offset: 2 });
      expect(page1.map(e => e.id)).toEqual(['e02-viewer', 'e05-both']);
      expect(page2.map(e => e.id)).toEqual(['e07-viewer']);

      const byTime = await scoped.searchByTime({ limit: 10, order: 'desc' });
      expect(byTime.map(e => e.id)).toEqual(['e07-viewer', 'e05-both', 'e02-viewer']);
      const byThread = await scoped.searchByThread('thread-shared', { limit: 1, offset: 1 });
      expect(byThread.map(e => e.id)).toEqual(['e05-both']);

      await expect(scoped.getEpisode('e04-other')).resolves.toBeUndefined();
      expect((await scoped.getEpisodesByIds(['e01-other', 'e02-viewer'])).map(e => e.id)).toEqual(['e02-viewer']);

      expect(materialized.filter(id => id.includes('other') && id !== 'e05-both')).toEqual([]);
      expect(materialized).not.toContain('e03-unattributed');
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('keeps the both-endpoints arc rule and agrees with the direct in-process predicate', async () => {
    await withSeededStore(async (raw, recording) => {
      const scoped = createSubjectAuthorizedEpisodicStore(recording, member);
      const arcs = await scoped.listEpisodeArcsForEpisode('e02-viewer', { limit: 1 });
      // The newest arc overall touches e04-other; SQL filtering keeps the page full.
      expect(arcs.map(arc => [arc.sourceEpisodeId, arc.targetEpisodeId])).toHaveLength(1);
      const allArcs = await scoped.listEpisodeArcsForEpisodes(['e02-viewer', 'e05-both', 'e04-other']);
      expect(allArcs.map(arc => `${arc.sourceEpisodeId}->${arc.targetEpisodeId}`).sort())
        .toEqual(['e02-viewer->e05-both', 'e05-both->e07-viewer']);

      // Direct store filtered in-process by the same rule must agree with SQL.
      const direct = (await raw.listEpisodes({ limit: 100 }))
        .filter(e => e.participantContactIds.includes(VIEWER))
        .map(e => e.id);
      expect((await scoped.listEpisodes({ limit: 100 })).map(e => e.id)).toEqual(direct);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('admits unattributed episodes only for multi-admin and everything for sole admin', async () => {
    await withSeededStore(async (_raw, recording) => {
      const multi = createSubjectAuthorizedEpisodicStore(recording, {
        viewerContactId: VIEWER,
        adminAccessMode: 'multi_admin',
      });
      expect((await multi.listEpisodes({ limit: 100 })).map(e => e.id))
        .toEqual(['e02-viewer', 'e03-unattributed', 'e05-both', 'e07-viewer']);
      const sole = createSubjectAuthorizedEpisodicStore(recording, {
        viewerContactId: VIEWER,
        adminAccessMode: 'sole_admin',
      });
      expect(await sole.listEpisodes({ limit: 100 })).toHaveLength(8);
    });
  }, INTEGRATION_TIMEOUT_MS);
});
