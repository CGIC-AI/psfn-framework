import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { FakeEpisodicPool } from '../../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import type { EpisodeCreateInput } from './store-port.js';
import {
  applyThreadUnionForArc,
  chooseThreadRepresentative,
  computeThreadComponents,
  hasLegacySessionThreadId,
  type ThreadAssignmentEvent,
} from './thread-assignment.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

/**
 * Thread-union tests run against the REAL PostgresEpisodicStore backed by the
 * in-process FakeEpisodicPool, so they exercise the actual atomic
 * `repointThreadMembers` SQL path (single UPDATE ... WHERE id = ANY) — not a
 * hand-rolled loop that could hide a partial-split regression.
 */
function makeHarness(): { pool: FakeEpisodicPool; store: PostgresEpisodicStore } {
  const pool = new FakeEpisodicPool();
  const store = new PostgresEpisodicStore(pool as unknown as Pool, { now: () => NOW });
  return { pool, store };
}

function episodeInput(id: string, threadId: string = id): EpisodeCreateInput {
  return {
    id,
    threadId,
    channelId: 'discord:main',
    title: `Episode ${id}`,
    landmark: `Landmark ${id}`,
    startedAt: '2026-06-01T10:00:00.000Z',
    endedAt: '2026-06-01T10:30:00.000Z',
    participantContactIds: ['contact:vega'],
    salience: { score: 0.5 },
    affect: { valence: 0, arousal: 0, dominance: 0.5, labels: ['neutral'] },
    themes: ['memory'],
    spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
    artifactRefs: [],
    provenanceRefs: [],
  };
}

async function threadOf(store: PostgresEpisodicStore, id: string): Promise<string | undefined> {
  return (await store.getEpisode(id))?.threadId;
}

function threadRepointUpdateCount(pool: FakeEpisodicPool): number {
  return pool.queries.filter(query => (
    query.text.replace(/\s+/g, ' ').trim().toLowerCase().startsWith('update l01_episodes set thread_id =')
  )).length;
}

describe('chooseThreadRepresentative', () => {
  it('returns the lexicographically-smaller id and is symmetric', () => {
    expect(chooseThreadRepresentative('b', 'a')).toBe('a');
    expect(chooseThreadRepresentative('a', 'b')).toBe('a');
    expect(chooseThreadRepresentative('a', 'a')).toBe('a');
  });
});

describe('computeThreadComponents', () => {
  it('maps every episode to its component minimum id', () => {
    const assignments = computeThreadComponents(
      ['e5', 'e9', 'e3', 'e7', 'lonely'],
      [['e9', 'e5'], ['e7', 'e3']],
    );
    expect(assignments.get('e5')).toBe('e5');
    expect(assignments.get('e9')).toBe('e5');
    expect(assignments.get('e3')).toBe('e3');
    expect(assignments.get('e7')).toBe('e3');
    expect(assignments.get('lonely')).toBe('lonely');
  });

  it('is order-independent: any edge permutation converges on the global minimum', () => {
    const ids = ['d', 'a', 'c', 'b'];
    const permutations: Array<Array<readonly [string, string]>> = [
      [['d', 'c'], ['c', 'b'], ['b', 'a']],
      [['b', 'a'], ['d', 'c'], ['c', 'b']],
      [['c', 'b'], ['b', 'a'], ['d', 'c']],
    ];
    for (const edges of permutations) {
      const assignments = computeThreadComponents(ids, edges);
      expect([...assignments.values()]).toEqual(['a', 'a', 'a', 'a']);
    }
  });

  it('unions two established components onto the overall minimum', () => {
    const assignments = computeThreadComponents(
      ['e5', 'e9', 'e3', 'e7'],
      [['e5', 'e9'], ['e3', 'e7'], ['e9', 'e7']],
    );
    expect([...assignments.values()].every(rep => rep === 'e3')).toBe(true);
  });
});

describe('applyThreadUnionForArc', () => {
  it('re-points the higher-id thread onto the lower-id representative and mutates the endpoints', async () => {
    const { store } = makeHarness();
    const source = await store.createEpisode(episodeInput('e9'));
    const target = await store.createEpisode(episodeInput('e5'));
    const events: ThreadAssignmentEvent[] = [];

    const result = await applyThreadUnionForArc(store, source, target, {
      maxThreadEpisodes: 100,
      now: () => NOW,
      onEvent: event => events.push(event),
    });

    expect(result.threadId).toBe('e5');
    expect(result.updatedEpisodeIds).toEqual(['e9']);
    expect(await threadOf(store, 'e9')).toBe('e5');
    expect(await threadOf(store, 'e5')).toBe('e5');
    expect(source.threadId).toBe('e5');
    expect(target.threadId).toBe('e5');
    expect(events).toEqual([{
      outcome: 'merged',
      winningThreadId: 'e5',
      losingThreadId: 'e9',
      updatedEpisodeCount: 1,
      timestamp: NOW.getTime(),
    }]);
  });

  it('re-points every live member of the losing thread, not just the endpoint', async () => {
    const { store } = makeHarness();
    const anchor = await store.createEpisode(episodeInput('e5'));
    await store.createEpisode(episodeInput('e8', 'e5')); // already in e5 thread
    const newcomer = await store.createEpisode(episodeInput('e2')); // its own thread, lower id

    await applyThreadUnionForArc(store, anchor, newcomer, { maxThreadEpisodes: 100 });

    // e2 is the new representative; the whole e5 thread (anchor + sibling) moves.
    expect(await threadOf(store, 'e5')).toBe('e2');
    expect(await threadOf(store, 'e8')).toBe('e2');
    expect(await threadOf(store, 'e2')).toBe('e2');
  });

  it('re-points the whole losing thread in exactly one atomic UPDATE (no partial split)', async () => {
    const { pool, store } = makeHarness();
    const anchor = await store.createEpisode(episodeInput('e5'));
    await store.createEpisode(episodeInput('e8', 'e5'));
    await store.createEpisode(episodeInput('e4', 'e5'));
    const newcomer = await store.createEpisode(episodeInput('e2'));

    const result = await applyThreadUnionForArc(store, anchor, newcomer, { maxThreadEpisodes: 100 });

    // Three live members re-pointed, but only ONE re-point statement was
    // issued: there is no per-member loop, so a mid-union crash cannot leave
    // the thread half-split.
    expect(result.updatedEpisodeIds.sort()).toEqual(['e4', 'e5', 'e8']);
    expect(threadRepointUpdateCount(pool)).toBe(1);
    for (const id of ['e5', 'e8', 'e4']) {
      expect(await threadOf(store, id)).toBe('e2');
    }
  });

  it('is a no-op when both endpoints already share a thread', async () => {
    const { pool, store } = makeHarness();
    const source = await store.createEpisode(episodeInput('e9', 'e5'));
    const target = await store.createEpisode(episodeInput('e5'));
    const events: ThreadAssignmentEvent[] = [];

    const result = await applyThreadUnionForArc(store, source, target, {
      maxThreadEpisodes: 100,
      onEvent: event => events.push(event),
    });

    expect(result.updatedEpisodeIds).toEqual([]);
    expect(threadRepointUpdateCount(pool)).toBe(0);
    expect(events[0]?.outcome).toBe('noop');
  });

  it('fails safe on an oversize losing thread: no rewrite, distinct threads, oversize event', async () => {
    const { pool, store } = makeHarness();
    const source = await store.createEpisode(episodeInput('e9'));
    const target = await store.createEpisode(episodeInput('e5'));
    await store.createEpisode(episodeInput('e6', 'e9'));
    await store.createEpisode(episodeInput('e7', 'e9'));
    const events: ThreadAssignmentEvent[] = [];

    // Losing thread 'e9' has 3 members (e9, e6, e7) which exceeds the cap of 2.
    const result = await applyThreadUnionForArc(store, source, target, {
      maxThreadEpisodes: 2,
      onEvent: event => events.push(event),
    });

    expect(result.skippedOversize).toBe(true);
    expect(threadRepointUpdateCount(pool)).toBe(0);
    expect(await threadOf(store, 'e9')).toBe('e9');
    expect(await threadOf(store, 'e5')).toBe('e5');
    expect(events[0]?.outcome).toBe('merge_skipped_oversize');
  });

  it('rejects a non-positive cap', async () => {
    const { store } = makeHarness();
    const source = await store.createEpisode(episodeInput('a'));
    const target = await store.createEpisode(episodeInput('b'));
    await expect(applyThreadUnionForArc(store, source, target, { maxThreadEpisodes: 0 }))
      .rejects.toThrow(/positive integer maxThreadEpisodes/);
  });
});

describe('legacy session-keyed threads (pre-apq0 threadId = sessionId)', () => {
  it('detects a legacy session-keyed threadId via the episode span refs', () => {
    expect(hasLegacySessionThreadId({
      id: 'e1',
      threadId: 'discord:main',
      spanRefs: [{ spanId: 'span-e1', sessionId: 'discord:main' }],
    })).toBe(true);
    // Own singleton thread — not legacy.
    expect(hasLegacySessionThreadId({
      id: 'e1',
      threadId: 'e1',
      spanRefs: [{ spanId: 'span-e1', sessionId: 'discord:main' }],
    })).toBe(false);
    // Topic thread named by another episode's id — not legacy.
    expect(hasLegacySessionThreadId({
      id: 'e1',
      threadId: 'e0',
      spanRefs: [{ spanId: 'span-e1', sessionId: 'discord:main' }],
    })).toBe(false);
  });

  it('extracts only the arc endpoint from a legacy session bucket instead of absorbing or renaming the bucket', async () => {
    const { store } = makeHarness();
    // A pre-apq0 per-channel mega-thread: three episodes keyed to the session.
    const bucketMember = await store.createEpisode(episodeInput('b2', 'discord:main'));
    await store.createEpisode(episodeInput('b1', 'discord:main'));
    await store.createEpisode(episodeInput('b3', 'discord:main'));
    const fresh = await store.createEpisode(episodeInput('e1'));
    const events: ThreadAssignmentEvent[] = [];

    const result = await applyThreadUnionForArc(store, bucketMember, fresh, {
      maxThreadEpisodes: 100,
      now: () => NOW,
      onEvent: event => events.push(event),
    });

    // The arc-linked legacy endpoint joined a TOPIC thread with the fresh
    // episode ('b2' is the min id), and the rest of the mega-thread stayed
    // exactly where it was: neither absorbed into the topic thread nor
    // mass-relabeled.
    expect(result.threadId).toBe('b2');
    expect(await threadOf(store, 'b2')).toBe('b2');
    expect(await threadOf(store, 'e1')).toBe('b2');
    expect(await threadOf(store, 'b1')).toBe('discord:main');
    expect(await threadOf(store, 'b3')).toBe('discord:main');
    expect(events.map(event => event.outcome)).toEqual([
      'legacy_session_thread_extracted',
      'merged',
    ]);
    expect(events[0]).toMatchObject({
      winningThreadId: 'b2',
      losingThreadId: 'discord:main',
      updatedEpisodeCount: 1,
    });
  });

  it('unions two legacy bucket members into a real topic thread instead of no-oping inside the mega-thread', async () => {
    const { store } = makeHarness();
    const left = await store.createEpisode(episodeInput('b1', 'discord:main'));
    const right = await store.createEpisode(episodeInput('b2', 'discord:main'));
    await store.createEpisode(episodeInput('b3', 'discord:main'));
    const events: ThreadAssignmentEvent[] = [];

    const result = await applyThreadUnionForArc(store, left, right, {
      maxThreadEpisodes: 100,
      onEvent: event => events.push(event),
    });

    // Pre-fix this was a silent noop (both endpoints "shared" the session
    // thread) and the mega-thread kept accreting. Now both endpoints peel off
    // into one topic thread while the uninvolved member stays behind.
    expect(result.threadId).toBe('b1');
    expect(await threadOf(store, 'b1')).toBe('b1');
    expect(await threadOf(store, 'b2')).toBe('b1');
    expect(await threadOf(store, 'b3')).toBe('discord:main');
    expect(events.map(event => event.outcome)).toEqual([
      'legacy_session_thread_extracted',
      'legacy_session_thread_extracted',
      'merged',
    ]);
  });
});

describe('PostgresEpisodicStore.repointThreadMembers', () => {
  it('atomically moves every live member and keeps episode_json.threadId consistent', async () => {
    const { pool, store } = makeHarness();
    await store.createEpisode(episodeInput('e5'));
    await store.createEpisode(episodeInput('e8', 'e5'));

    const outcome = await store.repointThreadMembers({
      fromThreadId: 'e5',
      toThreadId: 'e2',
      maxEpisodes: 100,
    });

    expect(outcome.skippedOversize).toBe(false);
    expect(outcome.updatedEpisodeIds.sort()).toEqual(['e5', 'e8']);
    expect(threadRepointUpdateCount(pool)).toBe(1);
    // Both the thread_id column and the materialized episode_json.threadId move
    // together (getEpisode reads threadId out of episode_json).
    const moved = await store.getEpisode('e8');
    expect(moved?.threadId).toBe('e2');
  });

  it('is idempotent: a re-run finds no members on the drained thread and moves nothing', async () => {
    const { pool, store } = makeHarness();
    await store.createEpisode(episodeInput('e5'));
    await store.createEpisode(episodeInput('e8', 'e5'));

    const first = await store.repointThreadMembers({ fromThreadId: 'e5', toThreadId: 'e2', maxEpisodes: 100 });
    expect(first.updatedEpisodeIds.sort()).toEqual(['e5', 'e8']);

    // Re-running the same union (as a crash-recovery retry would) is a clean
    // no-op — the losing thread is already drained, so there is nothing to
    // half-move and no duplicate re-point.
    const second = await store.repointThreadMembers({ fromThreadId: 'e5', toThreadId: 'e2', maxEpisodes: 100 });
    expect(second.updatedEpisodeIds).toEqual([]);
    expect(second.skippedOversize).toBe(false);
    expect(threadRepointUpdateCount(pool)).toBe(1); // only the first run wrote
    expect(await threadOf(store, 'e5')).toBe('e2');
    expect(await threadOf(store, 'e8')).toBe('e2');
  });

  it('refuses to re-point onto the same thread', async () => {
    const { store } = makeHarness();
    await expect(store.repointThreadMembers({ fromThreadId: 'e5', toThreadId: 'e5', maxEpisodes: 10 }))
      .rejects.toThrow(/same thread/);
  });

  it('restricts the re-point to memberEpisodeIds, leaving the rest of the thread untouched', async () => {
    const { pool, store } = makeHarness();
    await store.createEpisode(episodeInput('b1', 'discord:main'));
    await store.createEpisode(episodeInput('b2', 'discord:main'));
    await store.createEpisode(episodeInput('b3', 'discord:main'));

    const outcome = await store.repointThreadMembers({
      fromThreadId: 'discord:main',
      toThreadId: 'b2',
      maxEpisodes: 1,
      memberEpisodeIds: ['b2'],
    });

    expect(outcome.skippedOversize).toBe(false);
    expect(outcome.updatedEpisodeIds).toEqual(['b2']);
    expect(threadRepointUpdateCount(pool)).toBe(1);
    expect(await threadOf(store, 'b2')).toBe('b2');
    expect(await threadOf(store, 'b1')).toBe('discord:main');
    expect(await threadOf(store, 'b3')).toBe('discord:main');
  });

  it('rejects an empty memberEpisodeIds restriction', async () => {
    const { store } = makeHarness();
    await expect(store.repointThreadMembers({
      fromThreadId: 'discord:main',
      toThreadId: 'b2',
      maxEpisodes: 1,
      memberEpisodeIds: [],
    })).rejects.toThrow(/memberEpisodeIds must be non-empty/);
  });
});
