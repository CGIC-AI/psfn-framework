import type { Pool } from 'pg';
import {
  executeQuery,
  queryOne,
  queryRows,
} from '../../../../persistence/postgres.js';
import {
  encodeEmbeddingLiteral,
  validateEmbeddingDimensions,
} from '../../postgres-store/rows.js';
import type {
  EpisodeEmbeddingFailureInput,
  EpisodeEmbeddingIndexHealth,
  EpisodeEmbeddingProfile,
  EpisodeEmbeddingStorePort,
  EpisodeEmbeddingTarget,
  EpisodeEmbeddingTargetListInput,
  EpisodeEmbeddingWriteInput,
  EpisodeSemanticCandidate,
  EpisodeSemanticSearchInput,
} from '../store-port.js';
import {
  ACTIVE_CANONICAL_EPISODE_FILTER,
  mapEpisodeRow,
  normalizeInstant,
  normalizeLimit,
  parseRequiredText,
  type PostgresEpisodeRow,
} from './rows.js';

function normalizeEmbeddingProfile(profile: EpisodeEmbeddingProfile): EpisodeEmbeddingProfile {
  if (!Number.isInteger(profile.dimensions) || profile.dimensions < 1) {
    throw new Error('episode embedding profile dimensions must be a positive integer');
  }
  return {
    documentSchema: parseRequiredText(profile.documentSchema, 'episode embedding document schema'),
    provider: parseRequiredText(profile.provider, 'episode embedding provider'),
    model: parseRequiredText(profile.model, 'episode embedding model'),
    dimensions: profile.dimensions,
  };
}

function parseHealthCount(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Episode embedding index ${field} must be a non-negative integer`);
  }
  return parsed;
}

/** PostgreSQL projection adapter for rebuildable L0.1 semantic vectors. */
export class PostgresEpisodeEmbeddingIndex implements EpisodeEmbeddingStorePort {
  constructor(private readonly pool: Pool) {}

  async listEpisodeEmbeddingTargets(
    input: EpisodeEmbeddingTargetListInput,
  ): Promise<EpisodeEmbeddingTarget[]> {
    const profile = normalizeEmbeddingProfile(input.profile);
    const limit = normalizeLimit(input.limit);
    const rows = await queryRows<PostgresEpisodeRow & {
      index_state: string;
      embedding_last_error: string | null;
    }>(this.pool, `
      SELECT id, episode_json, embedding_last_error,
        CASE
          WHEN embedding_last_error IS NOT NULL THEN 'failed'
          WHEN embedding IS NULL THEN 'missing'
          ELSE 'stale'
        END AS index_state
      FROM l01_episodes
      WHERE ${ACTIVE_CANONICAL_EPISODE_FILTER}
        AND (
          embedding IS NULL
          OR embedding_last_error IS NOT NULL
          OR embedding_document_schema IS DISTINCT FROM $1
          OR embedding_provider IS DISTINCT FROM $2
          OR embedding_model IS DISTINCT FROM $3
          OR embedding_dimensions IS DISTINCT FROM $4
          OR embedding_source_updated_at IS DISTINCT FROM updated_at
        )
      ORDER BY embedding_attempted_at ASC NULLS FIRST, updated_at ASC, id ASC
      LIMIT $5
    `, [
      profile.documentSchema,
      profile.provider,
      profile.model,
      profile.dimensions,
      limit,
    ]);
    return rows.map((row) => ({
      episode: mapEpisodeRow(row),
      reason: row.index_state === 'missing' || row.index_state === 'failed'
        ? row.index_state
        : 'stale',
      ...(row.embedding_last_error === null ? {} : { lastError: row.embedding_last_error }),
    }));
  }

  async writeEpisodeEmbedding(input: EpisodeEmbeddingWriteInput): Promise<boolean> {
    const episodeId = parseRequiredText(input.episodeId, 'episode embedding episode id');
    const sourceUpdatedAt = normalizeInstant(
      input.sourceUpdatedAt,
      'episode embedding source updatedAt',
    );
    const indexedAt = normalizeInstant(input.indexedAt, 'episode embedding indexedAt');
    if (sourceUpdatedAt === undefined || indexedAt === undefined) {
      throw new Error('episode embedding timestamps are required');
    }
    const profile = normalizeEmbeddingProfile(input.profile);
    validateEmbeddingDimensions(input.embedding, profile.dimensions, 'write');
    if (Array.from(input.embedding).some(value => !Number.isFinite(value))) {
      throw new Error('PostgreSQL episode embedding write contains non-finite values');
    }
    if (!/^[a-f0-9]{64}$/.test(input.documentHash)) {
      throw new Error('episode embedding document hash must be a lowercase SHA-256 digest');
    }
    const result = await executeQuery(this.pool, `
      UPDATE l01_episodes
      SET embedding = $3::vector,
          embedding_document_schema = $4,
          embedding_provider = $5,
          embedding_model = $6,
          embedding_dimensions = $7,
          embedding_source_updated_at = $8,
          embedding_document_hash = $9,
          embedding_indexed_at = $10,
          embedding_attempted_at = $10,
          embedding_last_error = NULL
      WHERE id = $1
        AND updated_at = $2
        AND ${ACTIVE_CANONICAL_EPISODE_FILTER}
    `, [
      episodeId,
      sourceUpdatedAt,
      encodeEmbeddingLiteral(input.embedding),
      profile.documentSchema,
      profile.provider,
      profile.model,
      profile.dimensions,
      sourceUpdatedAt,
      input.documentHash,
      indexedAt,
    ]);
    return result.rowCount === 1;
  }

  async recordEpisodeEmbeddingFailure(input: EpisodeEmbeddingFailureInput): Promise<boolean> {
    const episodeId = parseRequiredText(input.episodeId, 'episode embedding episode id');
    const sourceUpdatedAt = normalizeInstant(
      input.sourceUpdatedAt,
      'episode embedding source updatedAt',
    );
    const attemptedAt = normalizeInstant(input.attemptedAt, 'episode embedding attemptedAt');
    if (sourceUpdatedAt === undefined || attemptedAt === undefined) {
      throw new Error('episode embedding timestamps are required');
    }
    const profile = normalizeEmbeddingProfile(input.profile);
    const error = parseRequiredText(input.error, 'episode embedding error');
    const result = await executeQuery(this.pool, `
      UPDATE l01_episodes
      SET embedding_document_schema = $3,
          embedding_provider = $4,
          embedding_model = $5,
          embedding_dimensions = $6,
          embedding_attempted_at = $7,
          embedding_last_error = $8
      WHERE id = $1
        AND updated_at = $2
        AND ${ACTIVE_CANONICAL_EPISODE_FILTER}
    `, [
      episodeId,
      sourceUpdatedAt,
      profile.documentSchema,
      profile.provider,
      profile.model,
      profile.dimensions,
      attemptedAt,
      error,
    ]);
    return result.rowCount === 1;
  }

  async searchEpisodesByEmbedding(
    input: EpisodeSemanticSearchInput,
  ): Promise<EpisodeSemanticCandidate[]> {
    const profile = normalizeEmbeddingProfile(input.profile);
    validateEmbeddingDimensions(input.queryEmbedding, profile.dimensions, 'search');
    if (Array.from(input.queryEmbedding).some(value => !Number.isFinite(value))) {
      throw new Error('PostgreSQL episode embedding search contains non-finite values');
    }
    const limit = normalizeLimit(input.limit);
    const rows = await queryRows<PostgresEpisodeRow & { similarity: number | string }>(this.pool, `
      SELECT id, episode_json,
             1 - (embedding <=> $1::vector) AS similarity
      FROM l01_episodes
      WHERE ${ACTIVE_CANONICAL_EPISODE_FILTER}
        AND embedding IS NOT NULL
        AND embedding_document_schema = $2
        AND embedding_provider = $3
        AND embedding_model = $4
        AND embedding_dimensions = $5
        AND vector_dims(embedding) = $5
        AND embedding_document_hash IS NOT NULL
        AND embedding_last_error IS NULL
        AND embedding_source_updated_at = updated_at
        AND (embedding <=> $1::vector) IS NOT NULL
      ORDER BY embedding <=> $1::vector ASC, id ASC
      LIMIT $6
    `, [
      encodeEmbeddingLiteral(input.queryEmbedding),
      profile.documentSchema,
      profile.provider,
      profile.model,
      profile.dimensions,
      limit,
    ]);
    return rows.map((row) => {
      const similarity = typeof row.similarity === 'number'
        ? row.similarity
        : Number(row.similarity);
      if (!Number.isFinite(similarity)) {
        throw new Error(`malformed semantic score for episode "${row.id}"`);
      }
      return { episode: mapEpisodeRow(row), similarity };
    });
  }

  async getEpisodeEmbeddingIndexHealth(
    inputProfile: EpisodeEmbeddingProfile,
  ): Promise<EpisodeEmbeddingIndexHealth> {
    const profile = normalizeEmbeddingProfile(inputProfile);
    const row = await queryOne<{
      total_count: number | string;
      current_count: number | string;
      missing_count: number | string;
      stale_count: number | string;
      failed_count: number | string;
    }>(this.pool, `
      SELECT
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE
          embedding IS NOT NULL
          AND embedding_document_schema = $1
          AND embedding_provider = $2
          AND embedding_model = $3
          AND embedding_dimensions = $4
          AND vector_dims(embedding) = $4
          AND embedding_document_hash IS NOT NULL
          AND embedding_last_error IS NULL
          AND embedding_source_updated_at = updated_at
        ) AS current_count,
        COUNT(*) FILTER (WHERE
          embedding IS NULL AND embedding_last_error IS NULL
        ) AS missing_count,
        COUNT(*) FILTER (WHERE
          embedding IS NOT NULL
          AND embedding_last_error IS NULL
          AND (
            embedding_document_schema IS DISTINCT FROM $1
            OR embedding_provider IS DISTINCT FROM $2
            OR embedding_model IS DISTINCT FROM $3
            OR embedding_dimensions IS DISTINCT FROM $4
            OR vector_dims(embedding) IS DISTINCT FROM $4
            OR embedding_document_hash IS NULL
            OR embedding_source_updated_at IS DISTINCT FROM updated_at
          )
        ) AS stale_count,
        COUNT(*) FILTER (WHERE embedding_last_error IS NOT NULL) AS failed_count
      FROM l01_episodes
      WHERE ${ACTIVE_CANONICAL_EPISODE_FILTER}
    `, [
      profile.documentSchema,
      profile.provider,
      profile.model,
      profile.dimensions,
    ]);
    if (!row) throw new Error('Episode embedding index health query returned no row');
    return {
      total: parseHealthCount(row.total_count, 'total'),
      current: parseHealthCount(row.current_count, 'current'),
      missing: parseHealthCount(row.missing_count, 'missing'),
      stale: parseHealthCount(row.stale_count, 'stale'),
      failed: parseHealthCount(row.failed_count, 'failed'),
    };
  }
}
