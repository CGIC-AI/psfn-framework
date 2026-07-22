import { describe, expect, it, vi } from 'vitest';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import type { EpisodeListOptions, EpisodeUpdateInput } from './store-port.js';
import {
  applyThreadUnionForArc,
  chooseThreadRepresentative,
  computeThreadComponents,
  type ThreadAssignmentEvent,
} from './thread-assignment.js';

function episode(id: string, threadId: string = id): Episode {
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
  } as unknown as Episode;
}

/** In-memory store surface exercising thread grouping and updates. */
function makeStore(episodes: readonly Episode[]) {
  const byId = new Map(episodes.map(entry => [entry.id, entry]));
  return {
    async searchByThread(threadId: string, options?: EpisodeListOptions): Promise<Episode[]> {
      const matches = [...byId.values()]
        .filter(entry => entry.threadId === threadId)
        .sort((left, right) => left.id.localeCompare(right.id));
      return options?.limit ? matches.slice(0, options.limit) : matches;
    },
    async updateEpisode(input: EpisodeUpdateInput): Promise<Episode> {
      const current = byId.get(input.id);
      if (!current) throw new Error(`episode "${input.id}" does not exist`);
      const updated = { ...current, ...input } as Episode;
      byId.set(input.id, updated);
      return updated;
    },
    threadOf(id: string): string | undefined {
      return byId.get(id)?.threadId;
    },
  };
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
    const source = episode('e9');
    const target = episode('e5');
    const store = makeStore([source, target]);
    const events: ThreadAssignmentEvent[] = [];

    const result = await applyThreadUnionForArc(store, source, target, {
      maxThreadEpisodes: 100,
      now: () => new Date('2026-06-01T12:00:00.000Z'),
      onEvent: event => events.push(event),
    });

    expect(result.threadId).toBe('e5');
    expect(result.updatedEpisodeIds).toEqual(['e9']);
    expect(store.threadOf('e9')).toBe('e5');
    expect(store.threadOf('e5')).toBe('e5');
    expect(source.threadId).toBe('e5');
    expect(target.threadId).toBe('e5');
    expect(events).toEqual([{
      outcome: 'merged',
      winningThreadId: 'e5',
      losingThreadId: 'e9',
      updatedEpisodeCount: 1,
      timestamp: Date.parse('2026-06-01T12:00:00.000Z'),
    }]);
  });

  it('re-points every live member of the losing thread, not just the endpoint', async () => {
    const anchor = episode('e5');
    const sibling = episode('e8', 'e5'); // already in e5 thread
    const newcomer = episode('e2'); // its own thread, lower id
    const store = makeStore([anchor, sibling, newcomer]);

    await applyThreadUnionForArc(store, anchor, newcomer, { maxThreadEpisodes: 100 });

    // e2 is the new representative; the whole e5 thread (anchor + sibling) moves.
    expect(store.threadOf('e5')).toBe('e2');
    expect(store.threadOf('e8')).toBe('e2');
    expect(store.threadOf('e2')).toBe('e2');
  });

  it('is a no-op when both endpoints already share a thread', async () => {
    const source = episode('e9', 'e5');
    const target = episode('e5');
    const store = makeStore([source, target]);
    const update = vi.spyOn(store, 'updateEpisode');
    const events: ThreadAssignmentEvent[] = [];

    const result = await applyThreadUnionForArc(store, source, target, {
      maxThreadEpisodes: 100,
      onEvent: event => events.push(event),
    });

    expect(result.updatedEpisodeIds).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(events[0]?.outcome).toBe('noop');
  });

  it('fails safe on an oversize losing thread: no rewrite, distinct threads, oversize event', async () => {
    const source = episode('e9');
    const target = episode('e5');
    const extra = [episode('e6', 'e9'), episode('e7', 'e9')];
    const store = makeStore([source, target, ...extra]);
    const update = vi.spyOn(store, 'updateEpisode');
    const events: ThreadAssignmentEvent[] = [];

    // Losing thread 'e9' has 3 members (e9, e6, e7) which exceeds the cap of 2.
    const result = await applyThreadUnionForArc(store, source, target, {
      maxThreadEpisodes: 2,
      onEvent: event => events.push(event),
    });

    expect(result.skippedOversize).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(store.threadOf('e9')).toBe('e9');
    expect(store.threadOf('e5')).toBe('e5');
    expect(events[0]?.outcome).toBe('merge_skipped_oversize');
  });

  it('rejects a non-positive cap', async () => {
    const source = episode('a');
    const target = episode('b');
    const store = makeStore([source, target]);
    await expect(applyThreadUnionForArc(store, source, target, { maxThreadEpisodes: 0 }))
      .rejects.toThrow(/positive integer maxThreadEpisodes/);
  });
});
