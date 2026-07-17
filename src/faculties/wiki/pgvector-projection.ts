import type { Pool } from 'pg';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryRows,
  withPostgresClient,
} from '../../persistence/postgres.js';
import { POSTGRES_WIKI_PROJECTION_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import type { SensitivityLevel } from '../../system/trust/types.js';
import { resolveWikiScope, type WikiScope } from './scope.js';
import type { WikiDocument, WikiSourceClass } from './types.js';

const log = createComponentLogger('WikiPgvectorProjection');

/**
 * Chunk size cap for wiki body projection. Wiki documents are reference notes,
 * not transcripts, so a paragraph-granular chunker keeps each embedded unit
 * semantically coherent while bounding the vector count per document.
 */
export const DEFAULT_WIKI_CHUNK_MAX_CHARS = 1200;
const MAX_CHUNKS_PER_DOCUMENT = 64;

/**
 * Split a canonical wiki Markdown body into embedding chunks. Pure and
 * deterministic: paragraph boundaries first, then a hard character cap so a
 * single giant paragraph never produces an unbounded chunk. The concatenation
 * of chunks preserves the source content order.
 */
export function chunkWikiBody(body: string, maxChars = DEFAULT_WIKI_CHUNK_MAX_CHARS): string[] {
  const cap = Math.max(200, Math.floor(maxChars));
  const paragraphs = body
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(part => part.length > 0);
  const chunks: string[] = [];
  let current = '';
  const pushCurrent = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) chunks.push(trimmed);
    current = '';
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > cap) {
      pushCurrent();
      for (let start = 0; start < paragraph.length; start += cap) {
        chunks.push(paragraph.slice(start, start + cap).trim());
      }
      continue;
    }
    if (current.length > 0 && current.length + paragraph.length + 2 > cap) {
      pushCurrent();
    }
    current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
  }
  pushCurrent();
  const nonEmpty = chunks.filter(chunk => chunk.length > 0);
  if (nonEmpty.length === 0) {
    const fallback = body.trim();
    return fallback.length > 0 ? [fallback.slice(0, cap)] : [];
  }
  return nonEmpty.slice(0, MAX_CHUNKS_PER_DOCUMENT);
}

export interface WikiProjectionDriftInput {
  canonical: ReadonlyArray<{ id: string; bodySha256: string }>;
  projected: ReadonlyArray<{ documentId: string; bodySha256: string }>;
}

export interface WikiProjectionDrift {
  /** Canonical doc ids whose projection is missing or stale (checksum drift). */
  toReembed: string[];
  /** Projected doc ids that no longer exist in the canonical workspace. */
  toDelete: string[];
}

/**
 * Pure repair decision for the wiki projection. Compares the canonical
 * workspace checksums against the projected checksums and reports which
 * documents must be re-embedded (missing or drifted) and which projected
 * documents are orphaned (no canonical source). This is the heart of the
 * rebuild/repair path and is intentionally DB-free so it is unit-testable.
 */
export function computeWikiProjectionDrift(input: WikiProjectionDriftInput): WikiProjectionDrift {
  const projectedByDoc = new Map<string, string>();
  for (const row of input.projected) {
    // A document is only "clean" if every chunk shares the canonical sha; the
    // caller collapses chunks to distinct (documentId, sha) pairs, so a doc
    // with mixed shas surfaces here as multiple entries and is treated stale.
    const existing = projectedByDoc.get(row.documentId);
    if (existing === undefined) {
      projectedByDoc.set(row.documentId, row.bodySha256);
    } else if (existing !== row.bodySha256) {
      projectedByDoc.set(row.documentId, '\u0000mixed');
    }
  }
  const canonicalIds = new Set<string>();
  const toReembed: string[] = [];
  for (const doc of input.canonical) {
    canonicalIds.add(doc.id);
    const projectedSha = projectedByDoc.get(doc.id);
    if (projectedSha === undefined || projectedSha !== doc.bodySha256) {
      toReembed.push(doc.id);
    }
  }
  const toDelete: string[] = [];
  for (const documentId of projectedByDoc.keys()) {
    if (!canonicalIds.has(documentId)) toDelete.push(documentId);
  }
  toReembed.sort();
  toDelete.sort();
  return { toReembed, toDelete };
}

export interface WikiSemanticMatch {
  documentId: string;
  title: string;
  path: string;
  sourceClass: WikiSourceClass;
  sensitivity: SensitivityLevel;
  /** W5b scope of the source document (`personal` or `shared_world:<siteId>`). */
  scope: WikiScope;
  chunkIndex: number;
  chunkText: string;
  score: number;
}

export interface WikiProjectionSyncOutcome {
  status: 'ran' | 'failed';
  documentId: string;
  chunkCount: number;
  error?: string;
}

export interface WikiProjectionRebuildResult {
  reembedded: string[];
  deleted: string[];
  failed: Array<{ documentId: string; error: string }>;
}

export interface WikiProjectionPort {
  syncDocument(document: WikiDocument): Promise<WikiProjectionSyncOutcome>;
  removeDocument(documentId: string): Promise<void>;
  rebuild(documents: ReadonlyArray<WikiDocument>): Promise<WikiProjectionRebuildResult>;
  search(
    queryEmbedding: Float32Array,
    threshold: number,
    limit: number,
    scopes?: WikiScopeFilter,
  ): Promise<WikiSemanticMatch[]>;
  listProjectedShas(): Promise<Array<{ documentId: string; bodySha256: string }>>;
}

interface WikiChunkShaRow {
  document_id: string;
  body_sha256: string;
}

interface WikiChunkSearchRow {
  document_id: string;
  chunk_index: number;
  title: string;
  body_path: string;
  source_class: string;
  sensitivity: string;
  scope: string;
  chunk_text: string;
  score: number | string;
}

export interface WikiProjectionStoreOptions {
  eventBus?: Pick<EventBus, 'emit'>;
  chunkMaxChars?: number;
  /**
   * Per-companion schema (multi-companion, sprint 10). The personal projection's
   * `wiki_document_chunks` table is companion-private, so under multi-companion
   * the pool MUST pin its search_path to the companion schema — otherwise every
   * companion's chunks land in `public` and collide (the enrollment-store bug
   * class, s10f9 reconciliation). When absent no search_path is set and behavior
   * is byte-identical to single-companion (the default `public` schema).
   */
  schema?: string;
  role?: string;
}

/**
 * Optional W5b scope restriction for a semantic search. When `undefined` the
 * query is UNFILTERED — byte-identical to the pre-W5b / single-companion path.
 * When provided, only chunks whose document scope is in the set are considered.
 */
export type WikiScopeFilter = readonly WikiScope[] | undefined;

/** Encode an embedding as a pgvector literal. Shared with the shared-world projection. */
export function encodeEmbeddingLiteral(embedding: Float32Array): string {
  return `[${Array.from(embedding, value => Number(value)).join(',')}]`;
}

/** Coerce a pgvector similarity score row value to a finite number. */
export function parseWikiChunkScore(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * PostgreSQL-backed pgvector projection of the canonical workspace wiki. Never
 * a source of truth: every write mirrors whatever the {@link WikiStore} already
 * committed to the workspace. Embedding failures fail closed for semantic
 * search (they emit a typed `wiki.projection.sync` event and leave the row set
 * unchanged) but never block wiki writes, because the store hook invokes this
 * out of band.
 */
export class WikiPgvectorProjectionStore implements WikiProjectionPort {
  private readonly pool: Pool;
  private readonly embedding: EmbeddingProviderPort;
  private readonly embeddingDims: number;
  private readonly eventBus?: Pick<EventBus, 'emit'>;
  private readonly chunkMaxChars: number;

  constructor(
    pool: Pool,
    embedding: EmbeddingProviderPort,
    options: WikiProjectionStoreOptions = {},
  ) {
    this.pool = pool;
    this.embedding = embedding;
    this.embeddingDims = embedding.dims;
    this.eventBus = options.eventBus;
    this.chunkMaxChars = options.chunkMaxChars ?? DEFAULT_WIKI_CHUNK_MAX_CHARS;
  }

  private emitSync(outcome: WikiProjectionSyncOutcome): void {
    void this.eventBus?.emit('wiki.projection.sync', {
      documentId: outcome.documentId,
      outcome: outcome.status === 'ran' ? 'ran' : 'failed',
      chunkCount: outcome.chunkCount,
      ...(outcome.error ? { error: outcome.error } : {}),
      timestamp: Date.now(),
    }).catch((emitError: unknown) => {
      log.debug('Failed to emit wiki projection sync event', { error: String(emitError) });
    });
  }

  async syncDocument(document: WikiDocument): Promise<WikiProjectionSyncOutcome> {
    const chunks = chunkWikiBody(document.body, this.chunkMaxChars);
    if (chunks.length === 0) {
      await this.removeDocument(document.id);
      const outcome: WikiProjectionSyncOutcome = { status: 'ran', documentId: document.id, chunkCount: 0 };
      this.emitSync(outcome);
      return outcome;
    }
    let embeddings: Float32Array[];
    try {
      embeddings = await this.embedding.embedBatch(chunks);
      if (embeddings.length !== chunks.length) {
        throw new Error(`expected ${chunks.length} embeddings, received ${embeddings.length}`);
      }
      for (const embedding of embeddings) {
        if (embedding.length !== this.embeddingDims) {
          throw new Error(`embedding dimension mismatch: expected ${this.embeddingDims}, got ${embedding.length}`);
        }
      }
    } catch (error) {
      // Fail closed for search; the canonical workspace document is untouched.
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Wiki projection embedding failed closed; semantic index left stale for document', {
        documentId: document.id,
        error: message,
      });
      const outcome: WikiProjectionSyncOutcome = {
        status: 'failed',
        documentId: document.id,
        chunkCount: 0,
        error: message,
      };
      this.emitSync(outcome);
      return outcome;
    }
    try {
      const updatedAt = Date.now();
      await withPostgresClient(this.pool, async (client) => {
        await client.query('DELETE FROM wiki_document_chunks WHERE document_id = $1', [document.id]);
        for (let index = 0; index < chunks.length; index += 1) {
          const chunkText = chunks[index] ?? '';
          await client.query(
            `INSERT INTO wiki_document_chunks (
              document_id, chunk_index, body_sha256, title, body_path, source_class,
              sensitivity, scope, chunk_text, chunk_char_count, embedding, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12)`,
            [
              document.id,
              index,
              document.bodySha256,
              document.title,
              document.bodyPath,
              document.sourceClass,
              document.sensitivity,
              resolveWikiScope(document.scope),
              chunkText,
              chunkText.length,
              encodeEmbeddingLiteral(embeddings[index] as Float32Array),
              updatedAt,
            ],
          );
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Wiki projection write failed closed for document', { documentId: document.id, error: message });
      const outcome: WikiProjectionSyncOutcome = {
        status: 'failed',
        documentId: document.id,
        chunkCount: 0,
        error: message,
      };
      this.emitSync(outcome);
      return outcome;
    }
    const outcome: WikiProjectionSyncOutcome = { status: 'ran', documentId: document.id, chunkCount: chunks.length };
    this.emitSync(outcome);
    return outcome;
  }

  async removeDocument(documentId: string): Promise<void> {
    await this.pool.query('DELETE FROM wiki_document_chunks WHERE document_id = $1', [documentId]);
  }

  async listProjectedShas(): Promise<Array<{ documentId: string; bodySha256: string }>> {
    const rows = await queryRows<WikiChunkShaRow>(this.pool, `
      SELECT DISTINCT document_id, body_sha256 FROM wiki_document_chunks
    `);
    return rows.map(row => ({ documentId: row.document_id, bodySha256: row.body_sha256 }));
  }

  async rebuild(documents: ReadonlyArray<WikiDocument>): Promise<WikiProjectionRebuildResult> {
    const projected = await this.listProjectedShas();
    const drift = computeWikiProjectionDrift({
      canonical: documents.map(doc => ({ id: doc.id, bodySha256: doc.bodySha256 })),
      projected,
    });
    const byId = new Map(documents.map(doc => [doc.id, doc] as const));
    const reembedded: string[] = [];
    const failed: Array<{ documentId: string; error: string }> = [];
    for (const documentId of drift.toReembed) {
      const document = byId.get(documentId);
      if (!document) continue;
      const outcome = await this.syncDocument(document);
      if (outcome.status === 'ran') {
        reembedded.push(documentId);
      } else {
        failed.push({ documentId, error: outcome.error ?? 'unknown' });
      }
    }
    for (const documentId of drift.toDelete) {
      await this.removeDocument(documentId);
    }
    return { reembedded, deleted: drift.toDelete, failed };
  }

  async search(
    queryEmbedding: Float32Array,
    threshold: number,
    limit: number,
    scopes?: WikiScopeFilter,
  ): Promise<WikiSemanticMatch[]> {
    if (queryEmbedding.length !== this.embeddingDims) {
      throw new Error(`wiki projection search embedding dimension mismatch: expected ${this.embeddingDims}, got ${queryEmbedding.length}`);
    }
    const docLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    // Over-fetch chunk-level rows so per-document dedup still yields docLimit docs.
    const chunkFetch = Math.min(500, docLimit * 8);
    // W5b scope filter is opt-in: when `scopes` is undefined the query is
    // byte-identical to the pre-W5b path (no scope predicate, no extra param).
    const params: Array<string | number | string[]> = [encodeEmbeddingLiteral(queryEmbedding), threshold];
    let scopeClause = '';
    if (scopes !== undefined) {
      params.push([...scopes]);
      scopeClause = `AND scope = ANY($${String(params.length)}::text[])\n      `;
    }
    params.push(chunkFetch);
    const rows = await queryRows<WikiChunkSearchRow>(this.pool, `
      SELECT
        document_id, chunk_index, title, body_path, source_class, sensitivity, scope, chunk_text,
        1 - (embedding <=> $1::vector) AS score
      FROM wiki_document_chunks
      WHERE 1 - (embedding <=> $1::vector) >= $2
      ${scopeClause}ORDER BY embedding <=> $1::vector ASC
      LIMIT $${String(params.length)}
    `, params);
    const bestByDoc = new Map<string, WikiSemanticMatch>();
    for (const row of rows) {
      const score = parseWikiChunkScore(row.score);
      const existing = bestByDoc.get(row.document_id);
      if (existing && existing.score >= score) continue;
      bestByDoc.set(row.document_id, {
        documentId: row.document_id,
        title: row.title,
        path: row.body_path,
        sourceClass: row.source_class as WikiSourceClass,
        sensitivity: row.sensitivity as SensitivityLevel,
        scope: resolveWikiScope(row.scope),
        chunkIndex: row.chunk_index,
        chunkText: row.chunk_text,
        score,
      });
    }
    return Array.from(bestByDoc.values())
      .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId))
      .slice(0, docLimit);
  }
}

export async function createWikiPgvectorProjectionStore(
  databaseUrl: string,
  embedding: EmbeddingProviderPort,
  options: WikiProjectionStoreOptions = {},
): Promise<WikiPgvectorProjectionStore> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-wiki-projection',
    allowExitOnIdle: true,
    ...(options.schema ? { schema: options.schema } : {}),
    ...(options.role ? { role: options.role } : {}),
  });
  await ensurePostgresSchema(pool, POSTGRES_WIKI_PROJECTION_MIGRATIONS);
  return new WikiPgvectorProjectionStore(pool, embedding, options);
}
