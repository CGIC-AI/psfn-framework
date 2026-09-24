import { queryRows } from '../../../persistence/postgres.js';
import type {
  ActiveMemoryWindowOptions,
  ActiveMemoryWindowResult,
  EmbeddingSearchAuthorization,
  MemoryEmbeddingSample,
} from '../memory-store-port.js';
import {
  normalizeMemoryScopeQuery,
  type MemoryScopeQuery,
  type PurrMemory,
} from '../types.js';
import type { MemoryEmbeddingSearchRow, MemoryRow } from './rows.js';
import {
  decodeEmbedding,
  encodeEmbeddingLiteral,
  parsePgNumber,
  tryFromMemoryRow,
  validateEmbeddingDimensions,
} from './rows.js';
import { clampLimit } from './utils.js';
import {
  ANN_MAX_CANDIDATES,
  annCandidatePool,
  annEfSearch,
  embeddingAnnOrderExpression,
  runAnnTunedQuery,
} from './embedding-index.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';

function appendMemoryScopeSqlPredicate(
  scopeQuery: MemoryScopeQuery | undefined,
  values: unknown[],
): string | undefined {
  if (!scopeQuery) return undefined;
  const refConditions = (scopeQuery.refs ?? []).map((ref) => {
    values.push(ref.kind, ref.id);
    return `(scope_ref_kind = $${values.length - 1} AND scope_ref_id = $${values.length})`;
  });
  const tags = scopeQuery.tags ?? [];
  let tagCondition: string | undefined;
  if (tags.length > 0) {
    values.push(tags);
    tagCondition = `scope_tags ?| $${values.length}::text[]`;
  }
  const refCondition = refConditions.length > 0 ? `(${refConditions.join(' OR ')})` : undefined;
  if (scopeQuery.mode === 'only') {
    const conditions = [refCondition, tagCondition]
      .filter((condition): condition is string => condition !== undefined);
    return conditions.length > 0 ? conditions.join(' AND ') : undefined;
  }
  if (refCondition && tagCondition) return `(${refCondition} OR ${tagCondition})`;
  return refCondition ?? tagCondition;
}

/**
 * Bounded, pool-direct SQL reads of `l2_memories` for PostgresMemoryStore:
 * raw (system-internal) ANN embedding search, the active embedding evidence
 * window, and the scoped active-memory time window. None of these reads the
 * resident metadata mirror; each bounds its transfer with a LIMIT.
 */
export class PostgresL2BoundedReads {
  constructor(
    private readonly ctx: Pick<
      PostgresMemoryStoreCollaboratorContext,
      'pool' | 'embeddingDims' | 'settle' | 'hasActiveTransaction'
    >,
    private readonly annIterativeScanAvailable: boolean,
  ) {}

  async searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery: MemoryScopeQuery | undefined,
    authorization: EmbeddingSearchAuthorization,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    // Fail closed: the raw store cannot apply subject authorization. A caller
    // that declares it MUST be subject-enforced (product recall) but reaches
    // this raw path is misconfigured — throw rather than silently return
    // unscoped rows. Only an explicit `bypass-system-internal` opt-out (memory
    // formation dedup, operator admin surfaces) is permitted here, and every
    // such site is greppable by that literal.
    if (authorization.authorization !== 'bypass-system-internal') {
      throw new Error(
        'PostgresMemoryStore.searchByEmbedding cannot enforce subject authorization; '
        + 'wrap the store with createSubjectAuthorizedMemoryStore for product recall, '
        + "or pass { authorization: 'bypass-system-internal' } for system-internal access",
      );
    }
    validateEmbeddingDimensions(embedding, this.ctx.embeddingDims, 'search');
    // Bound the requested result count: reject a non-finite/non-positive limit
    // (no silent fallback) and clamp the effective return to the ANN candidate
    // ceiling so a caller can never ask the raw path for an unbounded result set
    // to transfer, decode, and allocate.
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`searchByEmbedding requires a positive finite limit, got ${String(limit)}`);
    }
    const boundedLimit = clampLimit(limit, ANN_MAX_CANDIDATES, 1, ANN_MAX_CANDIDATES);
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    // Bounded ANN retrieval: order by the fixed-dimension cast distance with a
    // candidate-pool LIMIT so the HNSW index serves a top-N scan instead of a
    // sequential scan over the whole corpus. Scope predicates are part of the
    // indexed query, before LIMIT, so other scopes cannot crowd matching rows out
    // of the candidate horizon. ef_search and iterative scans make that filtered
    // top-k exact when pgvector supports them.
    // The similarity column and threshold keep the unbounded `<=>` form (the same
    // distance) so scoring is unchanged from the pre-ANN query.
    const candidatePool = annCandidatePool(boundedLimit);
    const orderExpression = embeddingAnnOrderExpression('embedding', '$1', this.ctx.embeddingDims);
    const values: unknown[] = [encodeEmbeddingLiteral(embedding), threshold];
    const scopePredicate = appendMemoryScopeSqlPredicate(normalizedScopeQuery, values);
    values.push(candidatePool);
    const candidateLimitParameter = `$${values.length}`;
    const rows = await runAnnTunedQuery<MemoryEmbeddingSearchRow>(
      this.ctx.pool,
      { efSearch: annEfSearch(candidatePool), iterativeScan: this.annIterativeScanAvailable },
      `
      SELECT
        id, text, type, importance, confidence, emotional_valence, formation_vad, emotional_texture,
        salience, salience_decay_anchor_at, source_ref, source_type, provenance_json, extracted_at, last_accessed,
        access_count, superseded_by,
        tags, scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
        retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
        delete_reason, NULL::text AS embedding,
        1 - (embedding <=> $1::vector) AS similarity
      FROM l2_memories
      WHERE embedding IS NOT NULL
        AND vector_dims(embedding) = ${this.ctx.embeddingDims}
        AND superseded_by IS NULL
        AND deleted_at IS NULL
        AND CASE WHEN vector_dims(embedding) = ${this.ctx.embeddingDims}
          THEN 1 - (embedding <=> $1::vector) END >= $2
        ${scopePredicate ? `AND ${scopePredicate}` : ''}
      ORDER BY ${orderExpression} ASC
      LIMIT ${candidateLimitParameter}
    `,
      values,
    );

    return rows
      .flatMap((row) => {
        const memory = tryFromMemoryRow(row);
        if (!memory) return [];
        return [{ ...memory, similarity: parsePgNumber(row.similarity, 'similarity') }];
      })
      .filter((memory) => {
        if (!normalizedScopeQuery) return true;
        const refs = normalizedScopeQuery.refs ?? [];
        const tags = normalizedScopeQuery.tags ?? [];
        if (refs.length === 0 && tags.length === 0) return true;
        const scopeMatch = refs.length === 0 || refs.some(ref => {
          const scope = memory.scopeRef;
          return scope?.kind === ref.kind && scope.id === ref.id;
        });
        const tagMatch = tags.length === 0 || tags.some(tag => memory.scopeTags?.includes(tag));
        return normalizedScopeQuery.mode === 'only' ? scopeMatch && tagMatch : scopeMatch || tagMatch;
      })
      .sort((left, right) => right.similarity - left.similarity || right.salience - left.salience || right.extractedAt - left.extractedAt)
      .slice(0, boundedLimit);
  }

  /**
   * Active memories written at/after `sinceMs`, paired with their stored
   * embeddings (htm9.15 second-arrow evidence read). a27w.1: queried from
   * Postgres on demand rather than scanning a hydrated embedding map, so the
   * read cost is bounded by the `limit` window (default 4096) and the active
   * corpus since `sinceMs`, not by lifetime corpus size. The WHERE/ORDER/LIMIT
   * reproduce the former in-memory semantics exactly: active rows only, rows
   * lacking a persisted embedding excluded (never re-embedded), ordered by
   * extractedAt ASC then id ASC. A present-but-undecodable vector fails closed.
   */
  async listActiveMemoryEmbeddingsSince(
    sinceMs: number,
    limit: number = 4096,
  ): Promise<MemoryEmbeddingSample[]> {
    if (this.ctx.hasActiveTransaction()) {
      throw new Error('Active memory embedding reads are unavailable inside a memory-store transaction');
    }
    // Settle any in-flight write/rollback so the pool read observes committed
    // state, matching queryAuthorizedMemorySubjects / getRetrievalCorpusVersion.
    await this.ctx.settle();
    const rows = await queryRows<MemoryRow>(this.ctx.pool, `
      SELECT
        id, text, type, importance, confidence, emotional_valence, formation_vad, emotional_texture,
        salience, salience_decay_anchor_at, source_ref, source_type, provenance_json, extracted_at, last_accessed,
        access_count, superseded_by,
        tags, scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
        retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
        delete_reason, embedding::text AS embedding
      FROM l2_memories
      WHERE superseded_by IS NULL
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND extracted_at >= $1
      ORDER BY extracted_at ASC, id ASC
      LIMIT $2
    `, [sinceMs, limit]);
    const samples: MemoryEmbeddingSample[] = [];
    for (const row of rows) {
      const embedding = decodeEmbedding(row.embedding);
      if (!embedding) {
        throw new Error(`PostgreSQL memory schema returned an unreadable pgvector embedding for memory ${row.id}`);
      }
      validateEmbeddingDimensions(embedding, this.ctx.embeddingDims, 'evidence');
      const memory = tryFromMemoryRow(row);
      if (!memory) continue;
      samples.push({
        id: memory.id,
        text: memory.text,
        type: memory.type,
        extractedAt: memory.extractedAt,
        ...(memory.contactId !== undefined ? { contactId: memory.contactId } : {}),
        ...(memory.sourceType !== undefined ? { sourceType: memory.sourceType } : {}),
        salience: memory.salience,
        embedding,
      });
    }
    return samples;
  }

  async listActiveMemoriesInWindow(
    options: ActiveMemoryWindowOptions,
  ): Promise<ActiveMemoryWindowResult> {
    if (!Number.isFinite(options.fromMs) || !Number.isFinite(options.toMs) || options.fromMs > options.toMs) {
      throw new Error('Active memory window requires finite ordered bounds');
    }
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error('Active memory window limit must be a positive safe integer');
    }
    if (this.ctx.hasActiveTransaction()) {
      throw new Error('Active memory window reads are unavailable inside a memory-store transaction');
    }
    await this.ctx.settle();

    const limit = clampLimit(options.limit, 50, 1, 500);
    const values: unknown[] = [options.fromMs, options.toMs];
    const scopeConditions: string[] = [];
    if (options.scope.kind !== 'companion') {
      values.push(options.scope.conversationId);
      const conversationParameter = `$${values.length}`;
      scopeConditions.push(
        `provenance_json ->> 'channelId' = ${conversationParameter}`,
        `(scope_ref_kind = 'conversation' AND scope_ref_id = ${conversationParameter})`,
      );
      if (options.scope.kind === 'contact') {
        values.push(options.scope.contactId);
        scopeConditions.push(`contact_id = $${values.length}`);
      }
    }
    values.push(limit + 1);
    const rows = await queryRows<MemoryRow>(this.ctx.pool, `
      SELECT
        id, text, type, importance, confidence, emotional_valence, formation_vad, emotional_texture,
        salience, salience_decay_anchor_at, source_ref, source_type, provenance_json, extracted_at, last_accessed,
        access_count, superseded_by,
        tags, scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
        retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
        delete_reason, NULL::text AS embedding
      FROM l2_memories
      WHERE superseded_by IS NULL
        AND deleted_at IS NULL
        AND extracted_at >= $1
        AND extracted_at <= $2
        ${scopeConditions.length > 0 ? `AND (${scopeConditions.join(' OR ')})` : ''}
      ORDER BY extracted_at DESC, id DESC
      LIMIT $${values.length}
    `, values);
    return {
      memories: rows.slice(0, limit).flatMap((row) => {
        const memory = tryFromMemoryRow(row);
        return memory ? [memory] : [];
      }),
      saturated: rows.length > limit,
    };
  }
}
