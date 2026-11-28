import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionEntry } from '../../../core/session/types.js';
import { createPostgresPool, ensurePostgresSchema } from '../../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import { recomputePostgresEpisodeThreads } from '../../../persistence/repair/episode-thread-recompute.js';
import type { Episode, EpisodeArcKind } from '../../../shared/contracts/episodic-memory.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { retrieveEpisodeDrilldown } from '../retrieval/episode-drilldown.js';
import { EpisodeArcWeaver } from './arc-formation.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import type { EpisodeCreateInput } from './store-port.js';
import { EpisodicSynthesizer } from './synthesis.js';
import type { EpisodicThemeDecisionPort } from './theme-classification.js';
import { applyThreadUnionForArc, type ThreadAssignmentEvent } from './thread-assignment.js';

// psfn-framework-d5e0p.1: topic threads are connected components of the arc
// graph. They must stay bounded topics: low-evidence arcs (a subject that
// merely recurs) do not merge threads, the cap holds on the WINNING side of a
// union, and existing mega-threads can be recomputed into bounded threads.

const INTEGRATION_TIMEOUT_MS = 120_000;
const NOW = new Date('2026-06-30T08:00:00.000Z');
const CHANNEL_ID = 'discord:dm-long-history';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

async function withEpisodicDatabase<T>(
  operation: (pool: Pool, store: PostgresEpisodicStore) => Promise<T>,
): Promise<T> {
  if (!harness) throw new Error('PostgreSQL integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-topic-thread-bounds-integration',
    allowExitOnIdle: true,
    max: 3,
  });
  try {
    await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
    return await operation(pool, new PostgresEpisodicStore(pool, { now: () => NOW }));
  } finally {
    await pool.end();
  }
}

function episodeInput(id: string, day: number, overrides: Partial<EpisodeCreateInput> = {}): EpisodeCreateInput {
  const date = `2026-06-${String(day).padStart(2, '0')}`;
  return {
    id,
    threadId: id,
    channelId: CHANNEL_ID,
    title: `Episode ${id}`,
    landmark: `Landmark ${id}`,
    startedAt: `${date}T10:00:00.000Z`,
    endedAt: `${date}T10:20:00.000Z`,
    participantContactIds: ['contact:morgan'],
    salience: { score: 0.6 },
    affect: { labels: [] },
    themes: ['wellbeing_and_daily_life'],
    spanRefs: [{ spanId: `span-${id}`, sessionId: CHANNEL_ID }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'session', refId: CHANNEL_ID }],
    ...overrides,
  };
}

async function writeArc(
  store: PostgresEpisodicStore,
  sourceEpisodeId: string,
  targetEpisodeId: string,
  arcKind: EpisodeArcKind,
  createdAt: string,
): Promise<void> {
  await store.writeEpisodeArc({
    sourceEpisodeId,
    targetEpisodeId,
    arcKind,
    salience: 0.6,
    confidence: 0.8,
    themes: ['fixture'],
    spanRefs: [],
    artifactRefs: [],
    provenanceRefs: [],
    createdAt,
  });
}

async function threadOf(store: PostgresEpisodicStore, episodeId: string): Promise<string> {
  const episode = await store.getEpisode(episodeId);
  if (!episode) throw new Error(`missing episode ${episodeId}`);
  return episode.threadId ?? episode.id;
}

async function liveThreadSizes(pool: Pool): Promise<Map<string, number>> {
  const rows = (await pool.query<{ thread_id: string; size: number }>(`
    SELECT COALESCE(thread_id, id) AS thread_id, count(*)::int AS size
    FROM l01_episodes
    WHERE (status IS NULL OR status IN ('canonical', 'candidate'))
      AND merged_into_episode_id IS NULL
      AND superseded_by_episode_id IS NULL
    GROUP BY 1
  `)).rows;
  return new Map(rows.map(row => [row.thread_id, row.size]));
}

describe('bounded topic threads (real Postgres)', () => {
  it('refuses a union whose merged thread would exceed the cap on the winning side', async () => {
    await withEpisodicDatabase(async (pool, store) => {
      // The winner (lexicographically smallest id) already holds three
      // episodes; the loser is a fresh singleton. Only the loser was bounded.
      await store.createEpisode(episodeInput('ep-a1', 1));
      await store.createEpisode(episodeInput('ep-a2', 2, { threadId: 'ep-a1' }));
      await store.createEpisode(episodeInput('ep-a3', 3, { threadId: 'ep-a1' }));
      await store.createEpisode(episodeInput('ep-z9', 4));
      const events: ThreadAssignmentEvent[] = [];
      const winner = await store.getEpisode('ep-a3');
      const loser = await store.getEpisode('ep-z9');
      if (!winner || !loser) throw new Error('fixture episodes missing');

      const refused = await applyThreadUnionForArc(store, winner, loser, {
        arcKind: 'continuation',
        maxThreadEpisodes: 3,
        onEvent: event => events.push(event),
      });

      expect(refused.skippedOversize).toBe(true);
      expect(events.map(event => event.outcome)).toEqual(['merge_skipped_oversize']);
      expect(await threadOf(store, 'ep-z9')).toBe('ep-z9');
      expect((await liveThreadSizes(pool)).get('ep-a1')).toBe(3);

      const merged = await applyThreadUnionForArc(store, winner, loser, {
        arcKind: 'continuation',
        maxThreadEpisodes: 4,
      });
      expect(merged.skippedOversize).toBe(false);
      expect(await threadOf(store, 'ep-z9')).toBe('ep-a1');
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('never merges threads for recurring-subject arcs, live or on replay', async () => {
    await withEpisodicDatabase(async (pool, store) => {
      for (const [index, id] of ['ep-1', 'ep-2', 'ep-3', 'ep-4'].entries()) {
        await store.createEpisode(episodeInput(id, index + 10));
      }
      const first = await store.getEpisode('ep-1');
      const second = await store.getEpisode('ep-2');
      if (!first || !second) throw new Error('fixture episodes missing');
      for (const arcKind of ['same_theme', 'recurrence'] as const) {
        await applyThreadUnionForArc(store, first, second, { arcKind, maxThreadEpisodes: 10 });
        expect(await threadOf(store, 'ep-2')).toBe('ep-2');
      }

      // A persisted recurring-subject arc is not replayed as a pending union;
      // a continuation arc is.
      await writeArc(store, 'ep-1', 'ep-2', 'same_theme', '2026-06-20T00:00:00.000Z');
      await writeArc(store, 'ep-3', 'ep-4', 'continuation', '2026-06-20T00:00:01.000Z');
      const pending = await store.listEpisodeArcsNeedingThreadAssignment({ limit: 10 });
      expect(pending.map(arc => [arc.sourceEpisodeId, arc.targetEpisodeId])).toEqual([['ep-3', 'ep-4']]);

      // The weaver's LLM pass proposes one recurring subject across every
      // episode and one effort progressing across two: only the latter is a
      // topic thread.
      const complete = vi.fn(async () => ({
        content: JSON.stringify({
          arcs: [
            {
              episode_ids: ['ep-1', 'ep-2', 'ep-3', 'ep-4'],
              kind: 'same_theme',
              label: 'daily check-ins',
              confidence: 0.9,
              reason: 'the same everyday subject keeps coming back',
            },
            {
              episode_ids: ['ep-1', 'ep-3'],
              kind: 'continuation',
              label: 'garden shed build',
              confidence: 0.85,
              reason: 'one build progressing',
            },
          ],
        }),
      }));
      const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW, maxThreadEpisodes: 10 });
      await expect(weaver.run({ sessionId: CHANNEL_ID })).resolves.toMatchObject({ ran: true });

      expect(await threadOf(store, 'ep-3')).toBe('ep-1');
      expect(await threadOf(store, 'ep-4')).toBe('ep-1');
      expect(await threadOf(store, 'ep-2')).toBe('ep-2');
      expect([...(await liveThreadSizes(pool)).values()].sort()).toEqual([1, 3]);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('keeps a long single-channel history with recurring generic themes in bounded, distinct topic threads', async () => {
    await withEpisodicDatabase(async (pool, store) => {
      // Twelve days of one DM. Every conversation reads as the same broad life
      // categories (as the decision model classifies them), and every one
      // repeats the progress words the deterministic arc classifier keys on.
      // Only two real topics recur; the segmenter labels them identically
      // each time ("... update", "... follow-up").
      const days: Array<{ day: number; topic: string; text: string }> = [
        { day: 1, topic: 'Garden shed build update', text: 'garden shed build: framing the walls' },
        { day: 2, topic: 'Spanish lessons follow-up', text: 'spanish lessons: past tense drills' },
        { day: 3, topic: 'Garden shed build update', text: 'garden shed build: roof trusses' },
        { day: 4, topic: 'Dentist appointment', text: 'dentist appointment for the cracked molar' },
        { day: 5, topic: 'Garden shed build update', text: 'garden shed build: shingles' },
        { day: 6, topic: 'Spanish lessons follow-up', text: 'spanish lessons: subjunctive mood' },
        { day: 7, topic: 'Garden shed build update', text: 'garden shed build: painting the door' },
        { day: 8, topic: 'Movie night pick', text: 'movie night pick for friday' },
        { day: 9, topic: 'Car tire replacement', text: 'car tire replacement after the flat' },
        { day: 10, topic: 'Spanish lessons follow-up', text: 'spanish lessons: conversation practice' },
        { day: 11, topic: 'Birthday gift ideas', text: 'birthday gift ideas for my sister' },
        { day: 12, topic: 'Tax paperwork', text: 'tax paperwork for the quarterly filing' },
      ];
      const entries: SessionEntry[] = days.flatMap(({ day, text }, dayIndex) => {
        const date = `2026-06-${String(day).padStart(2, '0')}`;
        const lines = [
          `Quick update again because things changed: ${text}.`,
          `Got it, here is where we are on ${text}.`,
          `Back to ${text} again, because that is the next step.`,
          `Done for now on ${text}; the update is saved.`,
        ];
        return lines.map((content, line) => {
          const id = dayIndex * 4 + line + 1;
          const role = line % 2 === 0 ? 'user' as const : 'assistant' as const;
          return {
            id,
            channelId: CHANNEL_ID,
            role,
            content,
            authorId: role === 'user' ? 'contact:morgan' : 'assistant:psfn',
            authorName: role === 'user' ? 'Morgan' : 'PSFN',
            timestamp: Date.parse(`${date}T19:0${line}:00.000Z`),
            metadata: JSON.stringify({
              turn: {
                schemaVersion: 1,
                turnId: `00000000-0000-7000-a000-${String(id).padStart(12, '0')}`,
                requestId: `request:${id}`,
                role,
              },
            }),
          };
        });
      });
      const topicFor = (prompt: string): string => {
        const match = days.find(({ text }) => prompt.includes(text));
        if (!match) throw new Error('segmentation prompt carried no known topic');
        return match.topic;
      };
      const segmentation = {
        complete: vi.fn(async (...args: unknown[]) => ({
          content: JSON.stringify({
            segments: [{ start_index: 0, end_index: 3, topic: topicFor(JSON.stringify(args)), status: 'closed' }],
          }),
        })),
      };
      const decisions: EpisodicThemeDecisionPort = {
        siteSettings: () => undefined,
        decide: vi.fn(async () => ({
          ok: true as const,
          backend: 'local' as const,
          probabilitySource: 'local' as const,
          latencyMs: 1,
          answers: {
            wellbeing_and_daily_life: { type: 'noul' as const, pYes: 0.92 },
            relationships_and_social: { type: 'noul' as const, pYes: 0.81 },
            planning_and_events: { type: 'noul' as const, pYes: 0.74 },
          },
        })),
      } as unknown as EpisodicThemeDecisionPort;
      const events: ThreadAssignmentEvent[] = [];
      const synthesizer = new EpisodicSynthesizer(store, { getRecentMessages: () => entries }, {
        gapSplitMinutes: 45,
        maxEntriesPerEpisode: 14,
        maxEpisodesPerRun: 20,
        transcriptMessageLimit: 64,
        maxThreadEpisodes: 3,
        decisions,
        topicSegmentation: { enabled: true, llmProvider: segmentation },
        onThreadAssignment: event => events.push(event),
      });

      const result = await synthesizer.run({ sessionId: CHANNEL_ID });
      expect(result.createdEpisodes).toHaveLength(12);

      const byTopic = new Map<string, Episode[]>();
      for (const episode of result.createdEpisodes) {
        const stored = await store.getEpisode(episode.id);
        if (!stored) throw new Error(`missing episode ${episode.id}`);
        byTopic.set(stored.title, [...(byTopic.get(stored.title) ?? []), stored]);
      }
      const threadsFor = (topic: string): Set<string> => new Set(
        (byTopic.get(topic) ?? []).map(episode => episode.threadId ?? episode.id),
      );

      // The cap holds everywhere.
      const sizes = await liveThreadSizes(pool);
      expect(Math.max(...sizes.values())).toBeLessThanOrEqual(3);
      // The recurring real topic threads together up to the cap; the fourth
      // garden episode is refused with a typed event rather than absorbed.
      expect(threadsFor('Spanish lessons follow-up').size).toBe(1);
      expect(threadsFor('Garden shed build update').size).toBe(2);
      expect(events.some(event => event.outcome === 'merge_skipped_oversize')).toBe(true);
      // Unrelated topics never share a thread with each other or with the
      // recurring ones, even though every episode shares the broad themes.
      const allThreads = [...byTopic.keys()].map(topic => [...threadsFor(topic)]);
      const flat = allThreads.flat();
      expect(new Set(flat).size).toBe(flat.length);

      // Drill-down siblings for the most recent Spanish episode come from its
      // own bounded topic, not the oldest episodes of the channel.
      const spanish = [...(byTopic.get('Spanish lessons follow-up') ?? [])]
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
      const latest = spanish.at(-1);
      if (!latest) throw new Error('missing latest spanish episode');
      const drilldown = await retrieveEpisodeDrilldown(store, { getRecent: () => [] }, {
        episodeId: latest.id,
        channelId: CHANNEL_ID,
        trustLevel: 'primary',
        channelDisclosure: { channelPrivacy: 'private', broadcast: false },
        siblingLimit: 10,
      });
      expect(drilldown?.threadSiblings.map(episode => episode.title)).toEqual([
        'Spanish lessons follow-up',
        'Spanish lessons follow-up',
      ]);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('recomputes an existing mega-thread into bounded topic threads, leaving legacy session threads alone', async () => {
    await withEpisodicDatabase(async (pool, store) => {
      // Live shape before the fix: every episode was unioned into the thread
      // of the oldest one, mostly through same_theme arcs.
      const ids = ['ep-00', 'ep-01', 'ep-02', 'ep-03', 'ep-04', 'ep-05', 'ep-06', 'ep-07'];
      for (const [index, id] of ids.entries()) {
        await store.createEpisode(episodeInput(id, index + 1, { threadId: 'ep-00' }));
      }
      // A pre-apq0 session-keyed episode belongs to h4fp.7, not this repair.
      await store.createEpisode(episodeInput('ep-legacy', 20, { threadId: CHANNEL_ID }));
      for (let index = 1; index < ids.length; index += 1) {
        await writeArc(store, ids[index - 1]!, ids[index]!, 'same_theme', `2026-06-21T00:00:0${index}.000Z`);
      }
      await writeArc(store, 'ep-01', 'ep-02', 'continuation', '2026-06-22T00:00:01.000Z');
      await writeArc(store, 'ep-02', 'ep-03', 'continuation', '2026-06-22T00:00:02.000Z');
      await writeArc(store, 'ep-03', 'ep-04', 'resolution', '2026-06-22T00:00:03.000Z');
      await writeArc(store, 'ep-05', 'ep-06', 'causal', '2026-06-22T00:00:04.000Z');
      await writeArc(store, 'ep-06', 'ep-legacy', 'continuation', '2026-06-22T00:00:05.000Z');

      const dryRun = await recomputePostgresEpisodeThreads(pool, { dryRun: true, maxThreadEpisodes: 3 });
      expect(dryRun).toMatchObject({
        dryRun: true,
        maxThreadEpisodes: 3,
        liveEpisodeCount: 9,
        legacySessionThreadEpisodeCount: 1,
        threadFormingArcCount: 4,
        refusedArcCount: 1,
        before: { threadCount: 1, largestThreadSize: 8 },
        after: { threadCount: 5, largestThreadSize: 3 },
        plannedEpisodeUpdates: 7,
        updatedEpisodes: 0,
      });
      expect(await threadOf(store, 'ep-07')).toBe('ep-00');

      const applied = await recomputePostgresEpisodeThreads(pool, { dryRun: false, maxThreadEpisodes: 3 });
      expect(applied).toMatchObject({ dryRun: false, plannedEpisodeUpdates: 7, updatedEpisodes: 7 });
      const assignment = Object.fromEntries(
        await Promise.all([...ids, 'ep-legacy'].map(async id => [id, await threadOf(store, id)] as const)),
      );
      expect(assignment).toEqual({
        'ep-00': 'ep-00',
        'ep-01': 'ep-01',
        'ep-02': 'ep-01',
        'ep-03': 'ep-01',
        'ep-04': 'ep-04',
        'ep-05': 'ep-05',
        'ep-06': 'ep-05',
        'ep-07': 'ep-07',
        'ep-legacy': CHANNEL_ID,
      });
      const stored = await pool.query<{ id: string; json_thread_id: string }>(`
        SELECT id, episode_json->>'threadId' AS json_thread_id FROM l01_episodes WHERE id = 'ep-06'
      `);
      expect(stored.rows[0]?.json_thread_id).toBe('ep-05');

      await expect(recomputePostgresEpisodeThreads(pool, { dryRun: false, maxThreadEpisodes: 3 }))
        .resolves.toMatchObject({ plannedEpisodeUpdates: 0, updatedEpisodes: 0 });

      const drilldown = await retrieveEpisodeDrilldown(store, { getRecent: () => [] }, {
        episodeId: 'ep-06',
        channelId: CHANNEL_ID,
        trustLevel: 'primary',
        channelDisclosure: { channelPrivacy: 'private', broadcast: false },
        siblingLimit: 10,
      });
      expect(drilldown?.threadSiblings.map(episode => episode.id)).toEqual(['ep-05']);
    });
  }, INTEGRATION_TIMEOUT_MS);
});
