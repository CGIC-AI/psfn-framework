import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EpisodicStore, type EpisodeCreateInput } from './store.js';
import { EpisodeArcWeaver, parseProposedArcs } from './arc-formation.js';

const NOW = new Date('2026-06-10T08:00:00.000Z');

function arcResponse(arcs: unknown[]): { content: string } {
  return { content: JSON.stringify({ arcs }) } as { content: string };
}

describe('EpisodeArcWeaver', () => {
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
      title: `Episode ${id}`,
      landmark: `Things happened during ${id}.`,
      startedAt,
      endedAt,
      threadId: 'discord:main',
      channelId: 'discord:main',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.6 },
      affect: { labels: ['neutral'] },
      themes: ['postgres', 'memory'],
      spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'session', refId: 'discord:main' }],
      ...overrides,
    };
  }

  async function seedWeekOfEpisodes(store: EpisodicStore): Promise<void> {
    await store.createEpisode(episodeInput('day1', '2026-06-04T20:00:00.000Z', '2026-06-04T21:00:00.000Z'));
    await store.createEpisode(episodeInput('day2', '2026-06-06T20:00:00.000Z', '2026-06-06T21:00:00.000Z'));
    await store.createEpisode(episodeInput('day3', '2026-06-08T20:00:00.000Z', '2026-06-08T21:00:00.000Z'));
    await store.createEpisode(episodeInput('other', '2026-06-07T10:00:00.000Z', '2026-06-07T10:30:00.000Z', {
      themes: ['cooking'],
    }));
  }

  it('writes chained arcs for an LLM-approved story across days', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);

    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['day1', 'day2', 'day3'],
      kind: 'continuation',
      label: 'postgres memory cutover',
      confidence: 0.85,
      reason: 'the same project continues across three evenings',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });

    expect(result.ran).toBe(true);
    expect(result.proposedArcs).toBe(1);
    expect(result.writtenArcs).toBe(2);

    const day1Arcs = await store.listEpisodeArcsForEpisode('day1', { direction: 'outgoing' });
    expect(day1Arcs).toHaveLength(1);
    expect(day1Arcs[0].targetEpisodeId).toBe('day2');
    expect(day1Arcs[0].arcKind).toBe('continuation');
    expect(day1Arcs[0].themes).toEqual(['postgres memory cutover']);
    expect(day1Arcs[0].confidence).toBe(0.85);

    const day2Arcs = await store.listEpisodeArcsForEpisode('day2', { direction: 'outgoing' });
    expect(day2Arcs.map(arc => arc.targetEpisodeId)).toEqual(['day3']);
  });

  it('respects the pass cadence via its watermark', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);

    const complete = vi.fn(async () => arcResponse([]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const first = await weaver.run({ sessionId: 'discord:main' });
    const second = await weaver.run({ sessionId: 'discord:main' });

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe('cadence');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('skips when there are not enough episodes to weave', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('only', '2026-06-08T20:00:00.000Z', '2026-06-08T21:00:00.000Z'));

    const complete = vi.fn(async () => arcResponse([]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });

    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe('not_enough_episodes');
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects low-confidence proposals and survives invalid LLM output', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);

    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['day1', 'day2'],
      kind: 'same_theme',
      label: 'maybe related',
      confidence: 0.3,
      reason: 'weak hunch',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });
    expect(result.proposedArcs).toBe(1);
    expect(result.writtenArcs).toBe(0);
    expect(result.rejectedArcs).toBe(1);

    const invalidWeaver = new EpisodeArcWeaver(
      store,
      { complete: vi.fn(async () => ({ content: 'garbage' }) as { content: string }) },
      { now: () => NOW, passIntervalMs: 0 },
    );
    const invalidResult = await invalidWeaver.run({ sessionId: 'discord:main' });
    expect(invalidResult.ran).toBe(true);
    expect(invalidResult.proposedArcs).toBe(0);
    expect(invalidResult.writtenArcs).toBe(0);
  });

  it('does not duplicate arcs that already exist between two episodes', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);
    await store.writeEpisodeArc({
      sourceEpisodeId: 'day1',
      targetEpisodeId: 'day2',
      arcKind: 'same_theme',
      salience: 0.6,
      confidence: 0.6,
      themes: ['postgres'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });

    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['day1', 'day2', 'day3'],
      kind: 'continuation',
      label: 'postgres memory cutover',
      confidence: 0.9,
      reason: 'continues',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });

    // day1->day2 already linked; only day2->day3 is new.
    expect(result.writtenArcs).toBe(1);
    const day2Outgoing = await store.listEpisodeArcsForEpisode('day2', { direction: 'outgoing' });
    expect(day2Outgoing.map(arc => arc.targetEpisodeId)).toEqual(['day3']);
  });
});

describe('parseProposedArcs', () => {
  const known = new Set(['a', 'b', 'c']);

  it('rejects unknown episode ids', () => {
    expect(() => parseProposedArcs(JSON.stringify({
      arcs: [{ episode_ids: ['a', 'zzz'], kind: 'continuation', label: 'x', confidence: 0.8 }],
    }), known)).toThrow(/unknown episode id/);
  });

  it('rejects operator_defined as a machine arc kind', () => {
    expect(() => parseProposedArcs(JSON.stringify({
      arcs: [{ episode_ids: ['a', 'b'], kind: 'operator_defined', label: 'x', confidence: 0.8 }],
    }), known)).toThrow(/not a valid machine arc kind/);
  });

  it('rejects single-episode arcs', () => {
    expect(() => parseProposedArcs(JSON.stringify({
      arcs: [{ episode_ids: ['a'], kind: 'continuation', label: 'x', confidence: 0.8 }],
    }), known)).toThrow(/at least two/);
  });
});
