import { describe, expect, it, vi } from 'vitest';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  parseEpisodeArc,
  type Episode,
  type EpisodeArc,
} from '../../../shared/contracts/episodic-memory.js';
import { AdminEpisodicMemoryDataService, type AdminEpisodicStore } from './episodic-memory-service.js';

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  const id = overrides.id ?? 'episode-alpha-1';
  const threadId = overrides.threadId ?? 'thread-alpha';
  return parseEpisode({
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id,
    title: `Episode ${id}`,
    landmark: `A bounded episodic landmark for ${id}.`,
    startedAt: '2026-04-01T10:00:00.000Z',
    endedAt: '2026-04-01T10:10:00.000Z',
    threadId,
    channelId: 'api:test',
    participantContactIds: ['contact:operator'],
    salience: { score: 0.7, novelty: 0.4, emotionalIntensity: 0.3 },
    affect: { valence: 0.2, arousal: 0.3, dominance: 0.5, labels: ['focused'] },
    themes: ['garden', threadId],
    spanRefs: [{ spanId: `span-${id}`, threadId, channelId: 'api:test' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: `span-${id}` }],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  });
}

function makeArc(overrides: Partial<EpisodeArc> = {}): EpisodeArc {
  const id = overrides.id ?? 'arc-alpha';
  return parseEpisodeArc({
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id,
    sourceEpisodeId: 'episode-alpha-1',
    targetEpisodeId: 'episode-alpha-2',
    arcKind: 'continuation',
    salience: 0.8,
    confidence: 0.75,
    themes: ['garden'],
    spanRefs: [{ spanId: `span-${id}` }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: `span-${id}` }],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  });
}

function compareArcRecency(left: EpisodeArc, right: EpisodeArc): number {
  if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
  return left.id.localeCompare(right.id);
}

function makeStore(episodes: readonly Episode[], arcs: readonly Episode[]) {
  const byEpisodeId = new Map(episodes.map(episode => [episode.id, episode]));
  const filterForEpisode = (
    episodeId: string,
    options: { direction?: 'incoming' | 'outgoing' | 'both'; arcKind?: string; limit?: number } = {},
  ): EpisodeArc[] => {
    const direction = options.direction ?? 'both';
    return arcs
      .filter((arc) => {
        if (direction === 'incoming') return arc.targetEpisodeId === episodeId;
        if (direction === 'outgoing') return arc.sourceEpisodeId === episodeId;
        return arc.sourceEpisodeId === episodeId || arc.targetEpisodeId === episodeId;
      })
      .filter(arc => options.arcKind === undefined || arc.arcKind === options.arcKind)
      .sort(compareArcRecency)
      .slice(0, options.limit ?? arcs.length);
  };
  const store = {
    getEpisode: vi.fn((id: string) => byEpisodeId.get(id)),
    getEpisodesByIds: vi.fn((ids: readonly string[]) => ids.flatMap((id) => {
      const episode = byEpisodeId.get(id);
      return episode ? [episode] : [];
    })),
    listEpisodeArcsForEpisode: vi.fn(filterForEpisode),
    listEpisodeArcsForEpisodes: vi.fn((
      ids: readonly string[],
      options: { direction?: 'incoming' | 'outgoing' | 'both'; arcKind?: string; limit?: number } = {},
    ) => {
      const byArcId = new Map<string, EpisodeArc>();
      for (const id of new Set(ids)) {
        for (const arc of filterForEpisode(id, options)) {
          byArcId.set(arc.id, arc);
        }
      }
      return [...byArcId.values()].sort(compareArcRecency);
    }),
    listEpisodes: vi.fn(() => [...episodes].sort((left, right) => (
      left.startedAt.localeCompare(right.startedAt)
      || left.id.localeCompare(right.id)
    ))),
    searchByThread: vi.fn((threadId: string) => episodes
      .filter(episode => episode.threadId === threadId)
      .sort((left, right) => (
        left.startedAt.localeCompare(right.startedAt)
        || left.id.localeCompare(right.id)
      ))),
    searchByTime: vi.fn(() => [...episodes]),
  } satisfies AdminEpisodicStore;
  return store;
}

describe('AdminEpisodicMemoryDataService', () => {
  it('builds thread summaries with one batched arc lookup across listed episodes', async () => {
    const alphaOne = makeEpisode({ id: 'episode-alpha-1', threadId: 'thread-alpha' });
    const alphaTwo = makeEpisode({
      id: 'episode-alpha-2',
      threadId: 'thread-alpha',
      startedAt: '2026-04-01T11:00:00.000Z',
      endedAt: '2026-04-01T11:10:00.000Z',
      themes: ['garden', 'thread-alpha', 'follow-up'],
    });
    const betaOne = makeEpisode({
      id: 'episode-beta-1',
      threadId: 'thread-beta',
      startedAt: '2026-04-02T10:00:00.000Z',
      endedAt: '2026-04-02T10:10:00.000Z',
      themes: ['garden', 'thread-beta'],
    });
    const alphaArc = makeArc({
      id: 'arc-alpha-internal',
      sourceEpisodeId: alphaOne.id,
      targetEpisodeId: alphaTwo.id,
      updatedAt: '2026-04-03T00:00:00.000Z',
    });
    const crossThreadArc = makeArc({
      id: 'arc-beta-alpha',
      sourceEpisodeId: betaOne.id,
      targetEpisodeId: alphaOne.id,
      updatedAt: '2026-04-04T00:00:00.000Z',
    });
    const store = makeStore([alphaOne, alphaTwo, betaOne], [alphaArc, crossThreadArc]);
    const service = new AdminEpisodicMemoryDataService(store);

    const result = await service.listThreads();

    expect(result.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: 'thread-alpha', episodeCount: 2, arcCount: 2 }),
      expect.objectContaining({ threadId: 'thread-beta', episodeCount: 1, arcCount: 1 }),
    ]));
    expect(store.listEpisodeArcsForEpisodes).toHaveBeenCalledTimes(1);
    expect(store.listEpisodeArcsForEpisodes).toHaveBeenCalledWith(
      ['episode-alpha-1', 'episode-alpha-2', 'episode-beta-1'],
      { direction: 'both', limit: 1000 },
    );
    expect(store.listEpisodeArcsForEpisode).not.toHaveBeenCalled();
  });

  it('builds thread detail related arc views with batched arcs and related episodes', async () => {
    const alphaOne = makeEpisode({ id: 'episode-alpha-1', threadId: 'thread-alpha' });
    const alphaTwo = makeEpisode({
      id: 'episode-alpha-2',
      threadId: 'thread-alpha',
      startedAt: '2026-04-01T11:00:00.000Z',
      endedAt: '2026-04-01T11:10:00.000Z',
    });
    const betaOne = makeEpisode({ id: 'episode-beta-1', threadId: 'thread-beta' });
    const alphaArc = makeArc({
      id: 'arc-alpha-internal',
      sourceEpisodeId: alphaOne.id,
      targetEpisodeId: alphaTwo.id,
      updatedAt: '2026-04-03T00:00:00.000Z',
    });
    const incomingArc = makeArc({
      id: 'arc-beta-alpha',
      sourceEpisodeId: betaOne.id,
      targetEpisodeId: alphaOne.id,
      updatedAt: '2026-04-04T00:00:00.000Z',
    });
    const store = makeStore([alphaOne, alphaTwo, betaOne], [alphaArc, incomingArc]);
    const service = new AdminEpisodicMemoryDataService(store);

    const result = await service.getThreadDetail('thread-alpha');

    expect(result?.arcs.map(arc => arc.id)).toEqual(['arc-beta-alpha', 'arc-alpha-internal']);
    expect(result?.relatedArcs).toEqual([
      expect.objectContaining({
        arc: expect.objectContaining({ id: 'arc-beta-alpha' }),
        direction: 'incoming',
        relatedEpisode: expect.objectContaining({ id: 'episode-beta-1' }),
      }),
      expect.objectContaining({
        arc: expect.objectContaining({ id: 'arc-alpha-internal' }),
        direction: 'outgoing',
        relatedEpisode: expect.objectContaining({ id: 'episode-alpha-2' }),
      }),
    ]);
    expect(store.listEpisodeArcsForEpisodes).toHaveBeenCalledTimes(1);
    expect(store.getEpisodesByIds).toHaveBeenCalledTimes(1);
    expect(store.getEpisodesByIds).toHaveBeenCalledWith(['episode-beta-1', 'episode-alpha-2']);
    expect(store.listEpisodeArcsForEpisode).not.toHaveBeenCalled();
    expect(store.getEpisode).not.toHaveBeenCalled();
  });

  it('builds related arc endpoint views without per-arc episode lookups', async () => {
    const alphaOne = makeEpisode({ id: 'episode-alpha-1', threadId: 'thread-alpha' });
    const alphaTwo = makeEpisode({ id: 'episode-alpha-2', threadId: 'thread-alpha' });
    const betaOne = makeEpisode({ id: 'episode-beta-1', threadId: 'thread-beta' });
    const outgoingArc = makeArc({
      id: 'arc-alpha-outgoing',
      sourceEpisodeId: alphaOne.id,
      targetEpisodeId: alphaTwo.id,
      updatedAt: '2026-04-03T00:00:00.000Z',
    });
    const incomingArc = makeArc({
      id: 'arc-beta-alpha',
      sourceEpisodeId: betaOne.id,
      targetEpisodeId: alphaOne.id,
      updatedAt: '2026-04-04T00:00:00.000Z',
    });
    const store = makeStore([alphaOne, alphaTwo, betaOne], [outgoingArc, incomingArc]);
    const service = new AdminEpisodicMemoryDataService(store);

    const result = await service.listEpisodeArcs('episode-alpha-1');

    expect(result?.relatedArcs).toEqual([
      expect.objectContaining({
        arc: expect.objectContaining({ id: 'arc-beta-alpha' }),
        direction: 'incoming',
        relatedEpisode: expect.objectContaining({ id: 'episode-beta-1' }),
      }),
      expect.objectContaining({
        arc: expect.objectContaining({ id: 'arc-alpha-outgoing' }),
        direction: 'outgoing',
        relatedEpisode: expect.objectContaining({ id: 'episode-alpha-2' }),
      }),
    ]);
    expect(store.getEpisode).toHaveBeenCalledTimes(1);
    expect(store.getEpisode).toHaveBeenCalledWith('episode-alpha-1');
    expect(store.listEpisodeArcsForEpisode).toHaveBeenCalledTimes(1);
    expect(store.getEpisodesByIds).toHaveBeenCalledTimes(1);
    expect(store.getEpisodesByIds).toHaveBeenCalledWith(['episode-beta-1', 'episode-alpha-2']);
  });
});
