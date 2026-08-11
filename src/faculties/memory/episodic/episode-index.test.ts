import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import { parseEpisode, type Episode } from '../../../shared/contracts/episodic-memory.js';
import {
  buildEpisodeSearchDocument,
  EpisodeSemanticIndexer,
} from './episode-index.js';
import type { EpisodeEmbeddingIndexStorePort } from './store-port.js';

function episode(overrides: Partial<Episode> = {}): Episode {
  return parseEpisode({
    schemaVersion: 2,
    id: 'episode-1',
    title: 'The quiet repair',
    landmark: 'We restored the journal after the outage.',
    startedAt: '2026-08-09T09:00:00.000Z',
    endedAt: '2026-08-09T09:30:00.000Z',
    participantContactIds: [],
    salience: { score: 0.8 },
    affect: { labels: ['relieved', 'wary'] },
    themes: ['continuity', 'trust'],
    spanRefs: [{ spanId: 'span-1' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: 'span-1' }],
    meaning: {
      text: 'I learned that visible failure is kinder than silent failure.',
      recordedAt: '2026-08-09T10:00:00.000Z',
      source: 'companion_direct',
    },
    createdAt: '2026-08-09T09:30:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  });
}

describe('buildEpisodeSearchDocument', () => {
  it('deterministically indexes only the canonical searchable episode fields', () => {
    expect(buildEpisodeSearchDocument(episode())).toBe([
      'Title: The quiet repair',
      'Landmark: We restored the journal after the outage.',
      'Themes: continuity; trust',
      'Affect: relieved; wary',
      'Meaning: I learned that visible failure is kinder than silent failure.',
    ].join('\n'));

    expect(buildEpisodeSearchDocument(episode({
      channelId: 'discord:private',
      participantContactIds: ['contact:someone'],
      artifactRefs: [{ artifactId: 'private-artifact' }],
    }))).toBe(buildEpisodeSearchDocument(episode()));
  });
});

describe('EpisodeSemanticIndexer', () => {
  it('indexes a newly written episode without waiting for the backfill scan', async () => {
    const target = episode();
    const store: EpisodeEmbeddingIndexStorePort = {
      listEpisodeEmbeddingTargets: vi.fn(async () => []),
      writeEpisodeEmbedding: vi.fn(async () => true),
      recordEpisodeEmbeddingFailure: vi.fn(async () => true),
    };
    const embedding: EmbeddingProviderPort = {
      dims: 2,
      embed: vi.fn(async () => new Float32Array([0.25, 0.75])),
      embedBatch: vi.fn(),
    };
    const indexer = new EpisodeSemanticIndexer(store, embedding, {
      provider: 'api',
      model: 'embed-v2',
    });

    await expect(indexer.indexEpisode(target)).resolves.toEqual({
      episodeId: target.id,
      status: 'indexed',
    });
    expect(store.listEpisodeEmbeddingTargets).not.toHaveBeenCalled();
  });

  it('embeds a bounded backfill target and records its exact source revision', async () => {
    const target = episode();
    const writeEpisodeEmbedding = vi.fn(async () => true);
    const store: EpisodeEmbeddingIndexStorePort = {
      listEpisodeEmbeddingTargets: vi.fn(async () => [{
        episode: target,
        reason: 'missing',
      }]),
      writeEpisodeEmbedding,
      recordEpisodeEmbeddingFailure: vi.fn(async () => true),
    };
    const embedding: EmbeddingProviderPort = {
      dims: 3,
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(),
    };
    const indexer = new EpisodeSemanticIndexer(store, embedding, {
      provider: 'transformers',
      model: 'test-model',
      now: () => new Date('2026-08-10T12:00:00.000Z'),
    });

    await expect(indexer.runBackfill({ limit: 4 })).resolves.toEqual({
      selected: 1,
      indexed: 1,
      failed: [],
      changedDuringIndex: [],
    });
    expect(store.listEpisodeEmbeddingTargets).toHaveBeenCalledWith({
      profile: {
        documentSchema: 'l01-episode-search/1',
        provider: 'transformers',
        model: 'test-model',
        dimensions: 3,
      },
      limit: 4,
    });
    expect(embedding.embed).toHaveBeenCalledWith(buildEpisodeSearchDocument(target));
    expect(writeEpisodeEmbedding).toHaveBeenCalledWith(expect.objectContaining({
      episodeId: 'episode-1',
      sourceUpdatedAt: target.updatedAt,
      embedding: new Float32Array([0.1, 0.2, 0.3]),
      indexedAt: '2026-08-10T12:00:00.000Z',
      documentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('records a retryable failure and continues the bounded batch', async () => {
    const first = episode({ id: 'episode-failed' });
    const second = episode({ id: 'episode-indexed' });
    const recordEpisodeEmbeddingFailure = vi.fn(async () => true);
    const writeEpisodeEmbedding = vi.fn(async () => true);
    const store: EpisodeEmbeddingIndexStorePort = {
      listEpisodeEmbeddingTargets: vi.fn(async () => [
        { episode: first, reason: 'missing' },
        { episode: second, reason: 'missing' },
      ]),
      writeEpisodeEmbedding,
      recordEpisodeEmbeddingFailure,
    };
    const embedding: EmbeddingProviderPort = {
      dims: 2,
      embed: vi.fn()
        .mockRejectedValueOnce(new Error('provider unavailable'))
        .mockResolvedValueOnce(new Float32Array([0.4, 0.6])),
      embedBatch: vi.fn(),
    };
    const indexer = new EpisodeSemanticIndexer(store, embedding, {
      provider: 'api',
      model: 'embed-v2',
      now: () => new Date('2026-08-10T12:00:00.000Z'),
    });

    await expect(indexer.runBackfill({ limit: 2 })).resolves.toEqual({
      selected: 2,
      indexed: 1,
      failed: [{ episodeId: 'episode-failed', error: 'provider unavailable' }],
      changedDuringIndex: [],
    });
    expect(recordEpisodeEmbeddingFailure).toHaveBeenCalledWith({
      episodeId: 'episode-failed',
      sourceUpdatedAt: first.updatedAt,
      profile: indexer.profile,
      error: 'provider unavailable',
      attemptedAt: '2026-08-10T12:00:00.000Z',
    });
    expect(writeEpisodeEmbedding).toHaveBeenCalledTimes(1);
  });
});
