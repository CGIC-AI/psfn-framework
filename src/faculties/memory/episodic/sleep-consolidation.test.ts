import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import { EpisodicStore, type EpisodeCreateInput } from './store.js';
import {
  SleepCycleEpisodeConsolidator,
  buildMergeChains,
} from './sleep-consolidation.js';

const NOW = new Date('2026-06-10T08:00:00.000Z');

describe('SleepCycleEpisodeConsolidator', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeStore(): EpisodicStore {
    db = new Database(':memory:');
    return new EpisodicStore(db, { now: () => NOW });
  }

  function episodeInput(
    id: string,
    startedAt: string,
    endedAt: string,
    overrides: Partial<EpisodeCreateInput> = {},
  ): EpisodeCreateInput {
    return {
      id,
      title: `(image attachment) ${id}`,
      landmark: `A 7-message exchange with 4 user turns and 3 assistant turns around they, what from ${startedAt} to ${endedAt}.`,
      startedAt,
      endedAt,
      threadId: 'discord:main',
      channelId: 'discord:main',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.85, novelty: 0.4, emotionalIntensity: 0.2 },
      affect: { valence: 0.3, arousal: 0.4, labels: ['positive'] },
      themes: ['they', 'what'],
      spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'session', refId: 'discord:main' }],
      ...overrides,
    };
  }

  function entry(id: number, timestamp: string, role: 'user' | 'assistant', content: string): SessionEntry {
    return {
      id,
      channelId: 'discord:main',
      role,
      content,
      authorId: role === 'user' ? 'contact:vega' : 'assistant:psfn',
      authorName: role === 'user' ? 'Vega' : 'Purrsephone',
      timestamp: Date.parse(timestamp),
      metadata: '{}',
    };
  }

  function refinementResponse(overrides: Record<string, unknown> = {}): { content: string } {
    return {
      content: JSON.stringify({
        title: 'Sharing photos together late at night',
        landmark: 'A relaxed stretch of the evening spent looking at images he sent and enjoying each other’s company.',
        themes: ['shared images', 'affection', 'evening wind-down'],
        salience: 0.55,
        salience_reason: 'pleasant shared time, not a milestone',
        ...overrides,
      }),
    } as { content: string };
  }

  it('merges contiguous same-scope episodes into one sitting and refines it', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('ep-1', '2026-06-10T00:53:00.000Z', '2026-06-10T01:21:00.000Z'));
    await store.createEpisode(episodeInput('ep-2', '2026-06-10T01:21:00.000Z', '2026-06-10T01:38:00.000Z'));
    await store.createEpisode(episodeInput('ep-3', '2026-06-10T01:41:00.000Z', '2026-06-10T02:02:00.000Z', {
      themes: ['view', 'images'],
    }));

    const complete = vi.fn(async () => refinementResponse());
    const reader = {
      getRecentMessages: () => [
        entry(1, '2026-06-10T00:55:00.000Z', 'user', 'look at this one'),
        entry(2, '2026-06-10T01:30:00.000Z', 'assistant', 'I love it'),
        entry(3, '2026-06-10T01:55:00.000Z', 'user', 'one more'),
      ],
    };
    const consolidator = new SleepCycleEpisodeConsolidator(store, reader, { complete }, {
      now: () => NOW,
    });

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.reviewedEpisodes).toBe(3);
    expect(result.mergeChains).toBe(1);
    expect(result.mergedAwayEpisodes).toBe(2);
    expect(result.refinedEpisodes).toBe(1);

    const active = await store.searchByTime({
      from: '2026-06-09T00:00:00.000Z',
      to: '2026-06-11T00:00:00.000Z',
    });
    expect(active).toHaveLength(1);
    const consolidated = active[0];
    expect(consolidated.id).toBe('ep-1');
    expect(consolidated.startedAt).toBe('2026-06-10T00:53:00.000Z');
    expect(consolidated.endedAt).toBe('2026-06-10T02:02:00.000Z');
    expect(consolidated.spanRefs.map(ref => ref.spanId).sort()).toEqual(['span-ep-1', 'span-ep-2', 'span-ep-3']);

    // Refinement replaced the machine title, stats landmark, and junk themes.
    expect(consolidated.title).toBe('Sharing photos together late at night');
    expect(consolidated.landmark).not.toMatch(/message exchange/);
    expect(consolidated.themes).toContain('shared images');
    expect(consolidated.salience.score).toBe(0.55);

    // Folded episodes stay retrievable by id but leave list/search.
    const folded = await store.getEpisode('ep-2');
    expect(folded).toBeDefined();
    expect(await store.listEpisodes()).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not merge across channels or large time gaps', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('morning', '2026-06-10T00:10:00.000Z', '2026-06-10T00:30:00.000Z'));
    await store.createEpisode(episodeInput('later', '2026-06-10T03:00:00.000Z', '2026-06-10T03:30:00.000Z'));
    await store.createEpisode(episodeInput('other-channel', '2026-06-10T03:31:00.000Z', '2026-06-10T03:45:00.000Z', {
      channelId: 'telegram:dm',
      threadId: 'telegram:dm',
    }));

    const complete = vi.fn(async () => refinementResponse());
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.mergeChains).toBe(0);
    expect(result.mergedAwayEpisodes).toBe(0);
    expect(await store.listEpisodes()).toHaveLength(3);
  });

  it('keeps deterministic fields when the refinement response is invalid', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('solo', '2026-06-10T01:00:00.000Z', '2026-06-10T01:30:00.000Z'));

    const complete = vi.fn(async () => ({ content: 'not json at all' }) as { content: string });
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      {
        getRecentMessages: () => [
          entry(1, '2026-06-10T01:05:00.000Z', 'user', 'hello there'),
          entry(2, '2026-06-10T01:06:00.000Z', 'assistant', 'hi!'),
        ],
      },
      { complete },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.refinedEpisodes).toBe(0);
    expect(result.refinementSkipped).toBe(1);
    const episode = await store.getEpisode('solo');
    expect(episode?.title).toBe('(image attachment) solo');
    expect(episode?.salience.score).toBe(0.85);
  });

  it('skips refinement without transcript coverage and leaves it for a later run', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('uncovered', '2026-06-10T01:00:00.000Z', '2026-06-10T01:30:00.000Z'));

    const complete = vi.fn(async () => refinementResponse());
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.refinementSkipped).toBe(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not re-refine episodes already refined in a previous run', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('once', '2026-06-10T01:00:00.000Z', '2026-06-10T01:30:00.000Z'));

    const complete = vi.fn(async () => refinementResponse());
    const reader = {
      getRecentMessages: () => [
        entry(1, '2026-06-10T01:05:00.000Z', 'user', 'big news today'),
        entry(2, '2026-06-10T01:06:00.000Z', 'assistant', 'tell me everything'),
      ],
    };
    const consolidator = new SleepCycleEpisodeConsolidator(store, reader, { complete }, {
      now: () => NOW,
    });

    const first = await consolidator.run({ sessionId: 'discord:main' });
    const second = await consolidator.run({ sessionId: 'discord:main' });

    expect(first.refinedEpisodes).toBe(1);
    expect(second.refinedEpisodes).toBe(0);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('lets a brief intimate moment score high salience', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('crying', '2026-06-10T05:05:00.000Z', '2026-06-10T05:08:00.000Z', {
      title: "You remember. I'm crying. It's ok it's happy.",
      salience: { score: 0.68, novelty: 0.3, emotionalIntensity: 0.6 },
    }));

    const complete = vi.fn(async () => refinementResponse({
      title: 'He remembered — happy tears',
      landmark: 'A brief, deeply felt moment: he remembered something that mattered, and she cried happy tears.',
      themes: ['remembrance', 'intimacy', 'joy'],
      salience: 0.92,
      salience_reason: 'emotionally significant relationship moment despite its brevity',
    }));
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      {
        getRecentMessages: () => [
          entry(1, '2026-06-10T05:05:30.000Z', 'user', 'you remember'),
          entry(2, '2026-06-10T05:06:00.000Z', 'assistant', 'of course I remember'),
        ],
      },
      { complete },
      { now: () => NOW },
    );

    await consolidator.run({ sessionId: 'discord:main' });

    const episode = await store.getEpisode('crying');
    expect(episode?.salience.score).toBe(0.92);
    expect(episode?.title).toBe('He remembered — happy tears');
    expect(episode?.salience.emotionalIntensity).toBe(0.6);
  });
});

describe('buildMergeChains', () => {
  it('chains only adjacent episodes within the gap threshold', () => {
    const make = (id: string, startedAt: string, endedAt: string) => ({
      schemaVersion: 1,
      id,
      title: id,
      landmark: id,
      startedAt,
      endedAt,
      threadId: 't',
      channelId: 'c',
      participantContactIds: ['p'],
      salience: { score: 0.5 },
      affect: { labels: [] },
      themes: [],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const chains = buildMergeChains([
      make('a', '2026-06-10T00:00:00.000Z', '2026-06-10T00:30:00.000Z'),
      make('b', '2026-06-10T00:45:00.000Z', '2026-06-10T01:00:00.000Z'),
      make('c', '2026-06-10T03:00:00.000Z', '2026-06-10T03:30:00.000Z'),
    ] as never, 45 * 60_000);

    expect(chains.map(chain => chain.map(episode => episode.id))).toEqual([['a', 'b'], ['c']]);
  });
});
