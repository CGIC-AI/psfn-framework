import type { Pool } from 'pg';
import {
  parseMemorySubjectClassification,
  type MemorySubjectClassification,
} from '../../../shared/contracts/memory-subject.js';
import type {
  MemorySubjectAuthorizedQuery,
  MemorySubjectAuthorizedQueryResult,
} from '../memory-store-port.js';
import {
  decodeStringArray,
  encodeEmbeddingLiteral,
  tryFromMemoryRow,
  parsePgNumber,
  validateEmbeddingDimensions,
} from './rows.js';
import type { MemoryEmbeddingSearchRow } from './rows.js';
import { clampLimit } from './utils.js';
import { buildMemorySubjectAuthorizationPredicate } from './subject-policy.js';
import { normalizeMemoryScopeQuery } from '../types.js';
import {
  annCandidatePool,
  annEfSearch,
  embeddingAnnOrderExpression,
  runAnnTunedQuery,
} from './embedding-index.js';

export interface AuthorizedMemorySubjectQueryOptions {
  /** Whether the connected pgvector supports iterative scans (>= 0.8). */
  iterativeScanAvailable: boolean;
}

/**
 * Hard upper bound on ids resolved in a single `details_batch` authorization
 * query. Callers that resolve larger id sets must chunk into bounded batches so
 * the authorization predicate work and parameter size stay bounded. Enforced
 * fail-closed: an oversized batch throws rather than silently truncating.
 */
export const MEMORY_SUBJECT_DETAILS_BATCH_MAX = 256;

export const MEMORY_SUBJECT_SELECT_COLUMNS = `
  memory.id, memory.text, memory.type, memory.importance, memory.confidence,
  memory.emotional_valence, memory.formation_vad, memory.emotional_texture, memory.salience,
  memory.salience_decay_anchor_at, memory.source_ref, memory.source_type,
  memory.provenance_json, memory.extracted_at, memory.last_accessed,
  memory.access_count, memory.superseded_by, memory.tags,
  memory.scope_ref_kind, memory.scope_ref_id, memory.scope_ref_label,
  memory.scope_tags, memory.provenance_refs, memory.retention_class,
  memory.sensitivity, memory.consent_flags, memory.contact_id,
  memory.deleted_at, memory.deleted_by, memory.delete_reason,
  memory.embedding::text AS embedding
`;

interface ClassificationRow {
  memory_id: string;
  subject_class: string;
  status: string;
  classifier_version: number;
  memory_revision: string;
  evidence_digest: string;
  evidence_json: unknown;
  room_id: string | null;
  unbound_person_label_hash: string | null;
  reason_class: string;
  classified_at: string;
  updated_at: string;
  subject_contact_ids: unknown;
}

type EmptyAuthorizedPageRow = {
  [Key in keyof MemoryEmbeddingSearchRow]: null;
} & { authorized_total: string };
type AuthorizedPageRow =
  | (MemoryEmbeddingSearchRow & { authorized_total: string })
  | EmptyAuthorizedPageRow;

function hasAuthorizedPage(row: AuthorizedPageRow): row is MemoryEmbeddingSearchRow & {
  authorized_total: string;
} {
  return row.id !== null;
}

function assertActionMatchesSelector(input: MemorySubjectAuthorizedQuery): void {
  const allowedActions = (() => {
    switch (input.selector.kind) {
      case 'list':
        return ['list', 'snippet', 'export', 'prompt_preview'] as const;
      case 'detail':
      case 'details_batch':
        return ['detail', 'snippet', 'export', 'prompt_preview'] as const;
      case 'text_search':
        return ['search', 'snippet', 'export', 'prompt_preview'] as const;
      case 'embedding_search':
        return ['embedding'] as const;
      case 'count':
        return ['count'] as const;
    }
  })();
  if (!(allowedActions as readonly string[]).includes(input.authorization.action)) {
    throw new Error(
      `Memory subject authorization action ${input.authorization.action} does not permit ${input.selector.kind}`,
    );
  }
}

function buildSelector(
  input: MemorySubjectAuthorizedQuery,
  embeddingDims: number,
): {
  where: string[];
  values: unknown[];
  orderBy: string;
  pageOrderBy: string;
  similaritySql: string;
  limit: number;
  offset: number;
  countOnly: boolean;
  annOrderExpr?: string;
} {
  const { selector } = input;
  const where = ['memory.superseded_by IS NULL', 'memory.deleted_at IS NULL'];
  const values: unknown[] = [];
  let orderBy = 'memory.extracted_at DESC, memory.id DESC';
  let pageOrderBy = 'extracted_at DESC, id DESC';
  let similaritySql = '1::double precision';
  let limit = 50;
  let offset = 0;
  let countOnly = false;
  let annOrderExpr: string | undefined;
  if ('scopeQuery' in selector) {
    const scopeQuery = normalizeMemoryScopeQuery(selector.scopeQuery);
    if (scopeQuery) {
      const refConditions = (scopeQuery.refs ?? []).map(ref => {
        values.push(ref.kind, ref.id);
        return `(memory.scope_ref_kind = $${values.length - 1} AND memory.scope_ref_id = $${values.length})`;
      });
      const tags = scopeQuery.tags ?? [];
      let tagCondition: string | undefined;
      if (tags.length > 0) {
        values.push(tags);
        tagCondition = `memory.scope_tags ?| $${values.length}::text[]`;
      }
      const refCondition = refConditions.length > 0 ? `(${refConditions.join(' OR ')})` : undefined;
      if (scopeQuery.mode === 'only') {
        if (refCondition) where.push(refCondition);
        if (tagCondition) where.push(tagCondition);
      } else if (refCondition && tagCondition) {
        where.push(`(${refCondition} OR ${tagCondition})`);
      } else if (refCondition || tagCondition) {
        where.push((refCondition ?? tagCondition)!);
      }
    }
  }
  switch (selector.kind) {
    case 'list':
      limit = clampLimit(selector.limit, 50, 1, 500);
      offset = clampLimit(selector.offset, 0, 0, 100_000);
      break;
    case 'detail': {
      const memoryId = selector.memoryId.trim();
      if (!memoryId) throw new Error('Authorized memory detail requires memoryId');
      values.push(memoryId);
      where.push(`memory.id = $${values.length}`);
      limit = 1;
      break;
    }
    case 'details_batch': {
      // Deduplicate and normalize before binding so the bounded batch matches
      // the union of the equivalent per-id `detail` queries exactly. The subject
      // authorization predicate is appended identically for every kind, so a
      // batch never widens access beyond what each id would resolve alone.
      const memoryIds = [...new Set(
        selector.memoryIds.map(id => id.trim()).filter(Boolean),
      )];
      if (memoryIds.length === 0) throw new Error('Authorized memory details batch requires at least one memoryId');
      if (memoryIds.length > MEMORY_SUBJECT_DETAILS_BATCH_MAX) {
        throw new Error(
          `Authorized memory details batch exceeds bound (${memoryIds.length} > ${MEMORY_SUBJECT_DETAILS_BATCH_MAX})`,
        );
      }
      values.push(memoryIds);
      where.push(`memory.id = ANY($${values.length}::text[])`);
      // The page LIMIT bounds materialized output to the authorized subset; the
      // deduped id count is the exact ceiling.
      limit = memoryIds.length;
      break;
    }
    case 'text_search': {
      const query = selector.query.trim();
      if (!query) throw new Error('Authorized memory text search requires a query');
      values.push(query);
      const textQuerySql = `plainto_tsquery('simple', $${values.length})`;
      where.push(`memory.search_vector @@ ${textQuerySql}`);
      similaritySql = `ts_rank_cd(memory.search_vector, ${textQuerySql})::double precision`;
      orderBy = `${similaritySql} DESC, memory.salience DESC, memory.extracted_at DESC`;
      pageOrderBy = 'similarity DESC, salience DESC, extracted_at DESC, id DESC';
      limit = clampLimit(selector.limit, 50, 1, 500);
      offset = clampLimit(selector.offset, 0, 0, 100_000);
      break;
    }
    case 'embedding_search': {
      validateEmbeddingDimensions(selector.embedding, embeddingDims, 'authorized search');
      if (!Number.isFinite(selector.threshold) || selector.threshold < -1 || selector.threshold > 1) {
        throw new Error('Authorized memory embedding threshold must be between -1 and 1');
      }
      values.push(encodeEmbeddingLiteral(selector.embedding));
      const embeddingParameter = `$${values.length}`;
      values.push(selector.threshold);
      where.push('memory.embedding IS NOT NULL');
      where.push(`vector_dims(memory.embedding) = ${embeddingDims}`);
      where.push(
        `CASE WHEN vector_dims(memory.embedding) = ${embeddingDims} `
        + `THEN 1 - (memory.embedding <=> ${embeddingParameter}::vector) END >= $${values.length}`,
      );
      similaritySql = `1 - (memory.embedding <=> ${embeddingParameter}::vector)`;
      orderBy = `memory.embedding <=> ${embeddingParameter}::vector ASC, memory.salience DESC, memory.extracted_at DESC`;
      // The bounded ANN path orders by the fixed-dimension cast distance so the
      // HNSW index is used; all filters (threshold, scope, and the subject
      // authorization predicate) sit at the same query level so an iterative scan
      // keeps the filtered top-k exact and never returns unauthorized rows.
      annOrderExpr = embeddingAnnOrderExpression('memory.embedding', embeddingParameter, embeddingDims);
      pageOrderBy = 'similarity DESC, salience DESC, extracted_at DESC, id DESC';
      limit = clampLimit(selector.limit, 50, 1, 500);
      offset = clampLimit(selector.offset, 0, 0, 100_000);
      break;
    }
    case 'count':
      countOnly = true;
      limit = 0;
      break;
  }
  return { where, values, orderBy, pageOrderBy, similaritySql, limit, offset, countOnly, annOrderExpr };
}

export async function queryAuthorizedMemorySubjects(
  pool: Pool,
  embeddingDims: number,
  input: MemorySubjectAuthorizedQuery,
  options: AuthorizedMemorySubjectQueryOptions,
): Promise<MemorySubjectAuthorizedQueryResult> {
  assertActionMatchesSelector(input);
  const selector = buildSelector(input, embeddingDims);
  const predicate = buildMemorySubjectAuthorizationPredicate(input.authorization, {
    memoryAlias: 'memory',
    firstParameter: selector.values.length + 1,
  });
  const values = [...selector.values, ...predicate.values];
  const where = [...selector.where, predicate.sql].join('\n AND ');
  if (selector.countOnly) {
    const countRows = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count
      FROM l2_memories memory
      WHERE ${where}
    `, values);
    return { memories: [], total: Number(countRows.rows[0]?.count ?? 0) };
  }

  if (selector.annOrderExpr) {
    return await queryAuthorizedEmbeddingAnn(pool, options, {
      where,
      values,
      annOrderExpr: selector.annOrderExpr,
      pageOrderBy: selector.pageOrderBy,
      similaritySql: selector.similaritySql,
      limit: selector.limit,
      offset: selector.offset,
    });
  }

  const pageValues = [...values, selector.limit, selector.offset];
  const rows = await pool.query<AuthorizedPageRow>(`
    WITH authorized AS MATERIALIZED (
      SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS}, ${selector.similaritySql} AS similarity
      FROM l2_memories memory
      WHERE ${where}
      ORDER BY ${selector.orderBy}
    )
    SELECT page.*, totals.authorized_total
    FROM (SELECT COUNT(*) AS authorized_total FROM authorized) totals
    LEFT JOIN LATERAL (
      SELECT * FROM authorized
      ORDER BY ${selector.pageOrderBy}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    ) page ON TRUE
  `, pageValues);
  const total = Number(rows.rows.at(0)?.authorized_total ?? 0);
  return {
    memories: rows.rows.filter(hasAuthorizedPage).flatMap(row => {
      const memory = tryFromMemoryRow(row);
      return memory ? [{
      ...memory,
      similarity: parsePgNumber(row.similarity, 'similarity'),
    }] : [];
    }),
    total,
  };
}

/**
 * Subject-authorized semantic search on a bounded ANN plan. Every filter — the
 * similarity threshold, scope predicates, AND the subject authorization
 * predicate — sits at the same query level as the ANN `ORDER BY <distance>
 * LIMIT candidatePool`, so the HNSW index drives the scan and (on pgvector >=
 * 0.8) an iterative scan keeps the filtered top-k exact. Subject isolation is a
 * hard WHERE, so unauthorized rows are never returned regardless of recall; the
 * candidate pool oversamples the requested page so authorized rows are still
 * found when most nearest neighbours are unauthorized. `total` is the count of
 * authorized matches within the ANN candidate pool (the nearest-neighbour
 * horizon), not an exhaustive corpus-wide count — an exhaustive count would
 * defeat the bounded plan and is not meaningful for nearest-neighbour retrieval.
 */
async function queryAuthorizedEmbeddingAnn(
  pool: Pool,
  options: AuthorizedMemorySubjectQueryOptions,
  input: {
    where: string;
    values: unknown[];
    annOrderExpr: string;
    pageOrderBy: string;
    similaritySql: string;
    limit: number;
    offset: number;
  },
): Promise<MemorySubjectAuthorizedQueryResult> {
  const candidatePool = annCandidatePool(input.limit + input.offset);
  const pageValues = [...input.values, candidatePool, input.limit, input.offset];
  const rows = await runAnnTunedQuery<AuthorizedPageRow>(
    pool,
    { efSearch: annEfSearch(candidatePool), iterativeScan: options.iterativeScanAvailable },
    `
    WITH authorized AS MATERIALIZED (
      SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS}, ${input.similaritySql} AS similarity
      FROM l2_memories memory
      WHERE ${input.where}
      ORDER BY ${input.annOrderExpr} ASC
      LIMIT $${input.values.length + 1}
    )
    SELECT page.*, totals.authorized_total
    FROM (SELECT COUNT(*) AS authorized_total FROM authorized) totals
    LEFT JOIN LATERAL (
      SELECT * FROM authorized
      ORDER BY ${input.pageOrderBy}
      LIMIT $${input.values.length + 2}
      OFFSET $${input.values.length + 3}
    ) page ON TRUE
  `,
    pageValues,
  );
  const total = Number(rows.at(0)?.authorized_total ?? 0);
  return {
    memories: rows.filter(hasAuthorizedPage).flatMap(row => {
      const memory = tryFromMemoryRow(row);
      return memory ? [{
      ...memory,
      similarity: parsePgNumber(row.similarity, 'similarity'),
    }] : [];
    }),
    total,
  };
}

export async function getMemorySubjectClassification(
  pool: Pool,
  memoryId: string,
): Promise<MemorySubjectClassification | undefined> {
  const normalizedId = memoryId.trim();
  if (!normalizedId) return undefined;
  const rows = await pool.query<ClassificationRow>(`
    SELECT classification.memory_id, classification.subject_class, classification.status,
           classification.classifier_version, classification.memory_revision,
           classification.evidence_digest, classification.evidence_json,
           classification.room_id, classification.unbound_person_label_hash,
           classification.reason_class, classification.classified_at,
           classification.updated_at,
           COALESCE(jsonb_agg(subject_contact.contact_id ORDER BY subject_contact.contact_id)
             FILTER (WHERE subject_contact.contact_id IS NOT NULL), '[]'::jsonb) AS subject_contact_ids
    FROM l2_memory_subject_classifications classification
    LEFT JOIN l2_memory_subject_contacts subject_contact
      ON subject_contact.memory_id = classification.memory_id
    WHERE classification.memory_id = $1
    GROUP BY classification.memory_id
  `, [normalizedId]);
  const row = rows.rows.at(0);
  if (!row) return undefined;
  return parseMemorySubjectClassification({
    memoryId: row.memory_id,
    subjectClass: row.subject_class,
    status: row.status,
    classifierVersion: row.classifier_version,
    memoryRevision: Number(row.memory_revision),
    evidenceDigest: row.evidence_digest,
    evidence: decodeStringArray(row.evidence_json),
    subjectContactIds: decodeStringArray(row.subject_contact_ids),
    ...(row.room_id ? { roomId: row.room_id } : {}),
    ...(row.unbound_person_label_hash ? { unboundPersonLabelHash: row.unbound_person_label_hash } : {}),
    reasonClass: row.reason_class,
    classifiedAt: Number(row.classified_at),
    updatedAt: Number(row.updated_at),
  });
}
