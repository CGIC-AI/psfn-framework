import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import { parseEpisode, type Episode } from '../../../shared/contracts/episodic-memory.js';
import type {
  EpisodeEmbeddingProfile,
  EpisodeEmbeddingStorePort,
  EpisodeSemanticCandidate,
} from '../episodic/store-port.js';
import {
  createHybridEpisodeSearch,
  type HybridEpisodeSearchStore,
} from './episode-search.js';

const PROFILE: EpisodeEmbeddingProfile = {
  documentSchema: 'l01-episode-search/1',
  provider: 'test',
  model: 'test-embedding',
  dimensions: 2,
};

function episode(id: string, title: string, overrides: Partial<Episode> = {}): Episode {
  return parseEpisode({
    schemaVersion: 2,
    id,
    title,
    landmark: `${title} became a landmark.`,
    startedAt: '2026-08-09T09:00:00.000Z',
    endedAt: '2026-08-09T09:30:00.000Z',
    channelId: 'discord:primary',
    participantContactIds: ['contact:primary'],
    salience: { score: 0.8 },
    affect: { labels: ['curious'] },
    themes: ['continuity'],
    spanRefs: [{ spanId: `${id}-span`, sessionId: 'discord:primary' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'session', refId: 'discord:primary' }],
    createdAt: '2026-08-09T09:30:00.000Z',
    updatedAt: '2026-08-09T09:30:00.000Z',
    ...overrides,
  });
}

function store(
  episodes: Episode[],
  semantic: EpisodeSemanticCandidate[],
  embeddingTargets: Awaited<ReturnType<EpisodeEmbeddingStorePort['listEpisodeEmbeddingTargets']>> = [],
): HybridEpisodeSearchStore {
  const byId = new Map(episodes.map(value => [value.id, value]));
  return {
    listEpisodes: vi.fn(async ({ limit } = {}) => episodes.slice(0, limit)),
    searchByTime: vi.fn(async () => episodes),
    getEpisode: vi.fn(async id => byId.get(id)),
    listEpisodeArcsForEpisode: vi.fn(async () => []),
    listEpisodeEmbeddingTargets: vi.fn(async () => embeddingTargets),
    writeEpisodeEmbedding: vi.fn(async () => true),
    recordEpisodeEmbeddingFailure: vi.fn(async () => true),
    searchEpisodesByEmbedding: vi.fn(async () => semantic),
  };
}

function embedding(
  embed: EmbeddingProviderPort['embed'] = vi.fn(async () => new Float32Array([0.2, 0.8])),
): EmbeddingProviderPort {
  return { dims: 2, embed, embedBatch: vi.fn() };
}

const foregroundInput = {
  query: 'Apollo repair',
  channelId: 'discord:primary',
  trustLevel: 'trusted' as const,
  channelDisclosure: { channelPrivacy: 'private' as const, broadcast: false },
  canonicalContactId: 'contact:primary',
  limit: 10,
};

describe('createHybridEpisodeSearch', () => {
  it('fuses lexical and semantic-only roots with deterministic mode provenance', async () => {
    const lexical = episode('episode-lexical', 'Apollo repair');
    const semanticOnly = episode('episode-semantic', 'A quiet garden', {
      themes: ['rest'],
      landmark: 'We finally let the pressure go.',
    });
    const search = createHybridEpisodeSearch({
      store: store([lexical, semanticOnly], [
        { episode: semanticOnly, similarity: 0.94 },
        { episode: lexical, similarity: 0.72 },
      ]),
      embeddingService: embedding(),
      profile: PROFILE,
    });

    const result = await search.search(foregroundInput);

    expect(result.modes).toEqual({
      lexical: { status: 'completed', candidateCount: 1 },
      semantic: { status: 'completed', candidateCount: 2 },
    });
    expect(result.degraded).toBe(false);
    expect(result.results.map(item => item.episode.id)).toEqual([
      'episode-lexical',
      'episode-semantic',
    ]);
    expect(result.results[0]).toMatchObject({
      retrievalModes: ['lexical', 'semantic'],
      lexicalScore: expect.any(Number),
      semanticSimilarity: 0.72,
    });
    expect(result.results[1]).toMatchObject({
      retrievalModes: ['semantic'],
      semanticSimilarity: 0.94,
    });
  });

  it('labels embedding failure while returning lexical evidence', async () => {
    const lexical = episode('episode-lexical', 'Apollo repair');
    const search = createHybridEpisodeSearch({
      store: store([lexical], []),
      embeddingService: embedding(vi.fn(async () => {
        throw new Error('embedding offline');
      })),
      profile: PROFILE,
    });

    const result = await search.search(foregroundInput);

    expect(result.results.map(item => item.episode.id)).toEqual(['episode-lexical']);
    expect(result.degraded).toBe(true);
    expect(result.modes.semantic).toEqual({
      status: 'failed',
      candidateCount: 0,
      error: 'embedding offline',
    });
  });

  it('reports stale semantic state instead of claiming an empty healthy index', async () => {
    const lexical = episode('episode-lexical', 'Apollo repair');
    const search = createHybridEpisodeSearch({
      store: store(
        [lexical],
        [{ episode: lexical, similarity: 0.82 }],
        [{ episode: lexical, reason: 'stale' }],
      ),
      embeddingService: embedding(),
      profile: PROFILE,
    });

    const result = await search.search(foregroundInput);

    expect(result.degraded).toBe(true);
    expect(result.modes.semantic).toEqual({
      status: 'stale',
      candidateCount: 1,
      pendingIndexCount: 1,
    });
  });

  it('applies visibility and quarantine before semantic candidates enter results', async () => {
    const visible = episode('episode-visible', 'Apollo repair');
    const foreign = episode('episode-foreign', 'Foreign account', {
      channelId: 'discord:foreign',
      participantContactIds: ['contact:foreign'],
    });
    const quarantined = episode('episode-quarantined', 'Quarantined account', {
      spanRefs: [{ spanId: 'q-span', sessionId: 'discord:quarantined' }],
      provenanceRefs: [{ kind: 'session', refId: 'discord:quarantined' }],
    });
    const search = createHybridEpisodeSearch({
      store: store([visible, foreign, quarantined], [
        { episode: foreign, similarity: 0.99 },
        { episode: quarantined, similarity: 0.98 },
        { episode: visible, similarity: 0.8 },
      ]),
      embeddingService: embedding(),
      profile: PROFILE,
    });

    const result = await search.search({
      ...foregroundInput,
      sessionQuarantineFilter: {
        isSessionRetiredOrQuarantined: id => id === 'discord:quarantined',
      },
    });

    expect(result.results.map(item => item.episode.id)).toEqual(['episode-visible']);
    expect(result.modes.semantic).toEqual({ status: 'completed', candidateCount: 1 });
  });
});
