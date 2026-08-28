import { createHash } from 'node:crypto';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import type {
  EpisodeEmbeddingIndexAttempt,
  EpisodeEmbeddingIndexStorePort,
  EpisodeEmbeddingProfile,
  EpisodeEmbeddingRuntimeStorePort,
} from './store-port.js';
import { createMaintenanceEmbeddingUsageProvenance } from '../../../core/agent/embedding-usage-provenance.js';

export const EPISODE_SEARCH_DOCUMENT_SCHEMA = 'l01-episode-search/1';
export const EPISODE_EMBEDDING_MAINTENANCE_OPERATION_ID = 'episode-semantic-index';

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
  written: number;
  concurrentlyChanged: string[];
  invalid: Array<{ episodeId: string; error: string }>;
  failed: Array<{ episodeId: string; error: string }>;
  noProgress: boolean;
}

class InvalidEpisodeEmbeddingError extends Error {}

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
      written: 0,
      concurrentlyChanged: [],
      invalid: [],
      failed: [],
      noProgress: false,
    };
    for (const target of targets) {
      const attempt = await this.indexEpisode(target.episode, target.sourceRevision);
      if (attempt.status === 'indexed') result.written += 1;
      else if (attempt.status === 'invalid') {
        result.invalid.push({ episodeId: attempt.episodeId, error: attempt.error });
      } else if (attempt.status === 'failed') {
        result.failed.push({ episodeId: attempt.episodeId, error: attempt.error });
      } else result.concurrentlyChanged.push(attempt.episodeId);
    }
    result.noProgress = result.selected > 0 && result.written === 0;
    return result;
  }

  async indexEpisode(
    episode: Episode,
    sourceRevision: string = episode.updatedAt,
  ): Promise<EpisodeEmbeddingIndexAttempt> {
    const document = buildEpisodeSearchDocument(episode);
    const attemptedAt = this.now().toISOString();
    try {
      const vector = await this.embedding.embed(document, {
        usageProvenance: createMaintenanceEmbeddingUsageProvenance({
          purpose: 'memory.episode_index',
          service: 'memory',
          process: 'episode-semantic-index',
          workloadType: 'episode_indexing',
          workloadId: episode.id,
        }),
      });
      this.assertEmbedding(vector);
      const written = await this.store.writeEpisodeEmbedding({
        episodeId: episode.id,
        sourceRevision,
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
        sourceRevision,
        profile: this.profile,
        error: message,
        attemptedAt,
      });
      const invalid = error instanceof InvalidEpisodeEmbeddingError;
      return recorded
        ? { episodeId: episode.id, status: invalid ? 'invalid' : 'failed', error: message }
        : { episodeId: episode.id, status: 'changed_during_index' };
    }
  }

  private assertEmbedding(vector: Float32Array): void {
    if (!(vector instanceof Float32Array)) {
      throw new InvalidEpisodeEmbeddingError(
        'Episode embedding provider returned a non-Float32Array value',
      );
    }
    if (vector.length !== this.profile.dimensions) {
      throw new InvalidEpisodeEmbeddingError(
        `Episode embedding dimension mismatch: expected ${this.profile.dimensions}, got ${vector.length}`,
      );
    }
    if (Array.from(vector).some(value => !Number.isFinite(value))) {
      throw new InvalidEpisodeEmbeddingError('Episode embedding provider returned non-finite values');
    }
  }
}

interface EpisodeEmbeddingMaintenanceRegistrar {
  registerOperation(operation: {
    id: string;
    name: string;
    description: string;
    eligibility?: { requiredTokens: readonly CapabilityToken[] };
    handler: () => void | Promise<void>;
  }): void;
}

export interface EpisodeSemanticIndexRuntimeOptions {
  store: EpisodeEmbeddingRuntimeStorePort;
  embedding: EmbeddingProviderPort;
  provider: string;
  model: string;
  backfillLimit: number;
  backgroundMaintenance: EpisodeEmbeddingMaintenanceRegistrar;
  onBatch?: (
    source: 'startup' | 'scheduled',
    result: EpisodeBackfillResult,
  ) => void | Promise<void>;
  onLiveResult?: (result: EpisodeEmbeddingIndexAttempt) => void;
  onLiveError?: (error: unknown, episode: Episode) => void;
}

export interface EpisodeSemanticIndexRuntime {
  indexer: EpisodeSemanticIndexer;
  startupBackfill: Promise<EpisodeBackfillResult>;
}

/** Attach write-through indexing and the bounded repair lane to one live store. */
export function wireEpisodeSemanticIndexRuntime(
  options: EpisodeSemanticIndexRuntimeOptions,
): EpisodeSemanticIndexRuntime {
  if (!Number.isInteger(options.backfillLimit) || options.backfillLimit < 1) {
    throw new Error('episode embedding backfillLimit must be a positive integer');
  }
  const indexer = new EpisodeSemanticIndexer(options.store, options.embedding, {
    provider: options.provider,
    model: options.model,
  });
  options.store.attachEpisodeEmbeddingIndexer(indexer, {
    ...(options.onLiveResult ? { onResult: options.onLiveResult } : {}),
    ...(options.onLiveError ? { onError: options.onLiveError } : {}),
  });

  const runBatch = async (source: 'startup' | 'scheduled'): Promise<EpisodeBackfillResult> => {
    const result = await indexer.runBackfill({ limit: options.backfillLimit });
    await options.onBatch?.(source, result);
    if (result.failed.length > 0 || result.invalid.length > 0) {
      throw new Error(
        `Episode semantic indexing failed for ${result.failed.length + result.invalid.length} of ${result.selected} episodes`,
      );
    }
    return result;
  };
  options.backgroundMaintenance.registerOperation({
    id: EPISODE_EMBEDDING_MAINTENANCE_OPERATION_ID,
    name: 'Episode Semantic Index',
    description: 'Indexes a bounded repair batch of active canonical episodes for semantic search.',
    eligibility: { requiredTokens: ['memory.write'] },
    handler: async () => {
      await runBatch('scheduled');
    },
  });
  return {
    indexer,
    startupBackfill: runBatch('startup'),
  };
}
