import { createHash } from 'node:crypto';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import type {
  EpisodeEmbeddingIndexStorePort,
  EpisodeEmbeddingIndexAttempt,
  EpisodeEmbeddingProfile,
} from './store-port.js';

export const EPISODE_SEARCH_DOCUMENT_SCHEMA = 'l01-episode-search/1';

/**
 * Canonical text projected into the semantic episode index. The projection is
 * deliberately limited to authored episode meaning and the existing retrieval
 * descriptors; transcript, participant, and provenance data are not embedded.
 */
export function buildEpisodeSearchDocument(episode: Episode): string {
  return [
    `Title: ${episode.title}`,
    `Landmark: ${episode.landmark}`,
    `Themes: ${episode.themes.join('; ')}`,
    `Affect: ${episode.affect.labels.join('; ')}`,
    ...(episode.meaning ? [`Meaning: ${episode.meaning.text}`] : []),
  ].join('\n');
}

export interface EpisodeSemanticIndexerOptions {
  provider: string;
  model: string;
  now?: () => Date;
}

export interface EpisodeBackfillResult {
  selected: number;
  indexed: number;
  failed: Array<{ episodeId: string; error: string }>;
  changedDuringIndex: string[];
}

export class EpisodeSemanticIndexer {
  readonly profile: EpisodeEmbeddingProfile;
  private readonly now: () => Date;

  constructor(
    private readonly store: EpisodeEmbeddingIndexStorePort,
    private readonly embedding: EmbeddingProviderPort,
    options: EpisodeSemanticIndexerOptions,
  ) {
    this.profile = {
      documentSchema: EPISODE_SEARCH_DOCUMENT_SCHEMA,
      provider: options.provider,
      model: options.model,
      dimensions: embedding.dims,
    };
    this.now = options.now ?? (() => new Date());
  }

  async runBackfill(input: { limit: number }): Promise<EpisodeBackfillResult> {
    const targets = await this.store.listEpisodeEmbeddingTargets({
      profile: this.profile,
      limit: input.limit,
    });
    const result: EpisodeBackfillResult = {
      selected: targets.length,
      indexed: 0,
      failed: [],
      changedDuringIndex: [],
    };
    for (const target of targets) {
      const attempt = await this.indexEpisode(target.episode);
      if (attempt.status === 'indexed') result.indexed += 1;
      else if (attempt.status === 'failed') {
        result.failed.push({ episodeId: attempt.episodeId, error: attempt.error });
      } else result.changedDuringIndex.push(attempt.episodeId);
    }
    return result;
  }

  async indexEpisode(episode: Episode): Promise<EpisodeEmbeddingIndexAttempt> {
    const document = buildEpisodeSearchDocument(episode);
    const attemptedAt = this.now().toISOString();
    try {
      const vector = await this.embedding.embed(document);
      this.assertEmbedding(vector);
      const written = await this.store.writeEpisodeEmbedding({
        episodeId: episode.id,
        sourceUpdatedAt: episode.updatedAt,
        profile: this.profile,
        documentHash: createHash('sha256').update(document).digest('hex'),
        embedding: vector,
        indexedAt: attemptedAt,
      });
      return written
        ? { episodeId: episode.id, status: 'indexed' }
        : { episodeId: episode.id, status: 'changed_during_index' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recorded = await this.store.recordEpisodeEmbeddingFailure({
        episodeId: episode.id,
        sourceUpdatedAt: episode.updatedAt,
        profile: this.profile,
        error: message,
        attemptedAt,
      });
      return recorded
        ? { episodeId: episode.id, status: 'failed', error: message }
        : { episodeId: episode.id, status: 'changed_during_index' };
    }
  }

  private assertEmbedding(vector: Float32Array): void {
    if (!(vector instanceof Float32Array)) {
      throw new Error('Episode embedding provider returned a non-Float32Array value');
    }
    if (vector.length !== this.profile.dimensions) {
      throw new Error(
        `Episode embedding dimension mismatch: expected ${this.profile.dimensions}, got ${vector.length}`,
      );
    }
    if (Array.from(vector).some(value => !Number.isFinite(value))) {
      throw new Error('Episode embedding provider returned non-finite values');
    }
  }
}
