// ── Shared-world wiki pgvector projection (sprint 10, s10f9) ──
//
// Projects the shared-world wiki filesystem tree
// (<system-data>/shared-world/wiki/sites/<siteId>/) into the ONE
// `shared.shared_wiki_chunks` table so companion retrieval can serve
// `shared_world:<siteId>` scopes. The per-companion projection cannot host
// these documents: its boot-time rebuild-from-personal-store deletes every
// projected document that is missing from the companion's own workspace, so a
// shared document parked there would be reaped as an orphan on the next boot.
//
// Like the personal projection, this is never a source of truth (charter
// 6.23/7.5): the site's Markdown + metadata files are canonical, every row
// carries body_sha256, and a projection pass is an idempotent per-site rebuild
// (delete-and-replace per changed document, orphan rows pruned per site). The
// table lives in the `shared` schema, so per-companion projection rebuilds can
// never touch it.

import type { Pool } from 'pg';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  createPostgresPool,
  queryRows,
  withPostgresClient,
} from '../../persistence/postgres.js';
import { SHARED_SCHEMA_NAME } from '../../persistence/postgres/migrations.js';
import { ensureSharedWikiSchema } from '../../persistence/postgres/shared-schema.js';
import type { SensitivityLevel } from '../../system/trust/types.js';
import {
  chunkWikiBody,
  computeWikiProjectionDrift,
  encodeEmbeddingLiteral,
  parseWikiChunkScore,
  DEFAULT_WIKI_CHUNK_MAX_CHARS,
  type WikiProjectionRebuildResult,
  type WikiProjectionSyncOutcome,
  type WikiSemanticMatch,
} from './pgvector-projection.js';
import { isSharedWorldScope, resolveWikiScope, sharedWorldScope, type WikiScope } from './scope.js';
import type { SharedWorldWikiStore } from './store.js';
import type { WikiDocument, WikiSourceClass } from './types.js';

const log = createComponentLogger('SharedWikiPgvectorProjection');

interface SharedWikiChunkShaRow {
  document_id: string;
  body_sha256: string;
}

interface SharedWikiChunkSearchRow {
  site_id: string;
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

export interface SharedWikiProjectionStoreOptions {
  eventBus?: Pick<EventBus, 'emit'>;
  chunkMaxChars?: number;
}

/**
 * Search surface of the shared-world projection, consumed by the retrieval
 * union. Scopes are REQUIRED (there is no unfiltered shared read): every query
 * names the exact `shared_world:<siteId>` scopes it may see.
 */
export interface SharedWikiSearchPort {
  search(
    queryEmbedding: Float32Array,
    threshold: number,
    limit: number,
    scopes: readonly WikiScope[],
  ): Promise<WikiSemanticMatch[]>;
}

/**
 * PostgreSQL-backed pgvector projection of shared-world wiki sites, stored in
 * `shared.shared_wiki_chunks` (the pool is pinned to the shared schema). Every
 * write is keyed by (siteId, documentId): sync is delete-and-replace for one
 * document version, and rebuildSite reconciles exactly one site's rows against
 * that site's canonical filesystem documents — other sites' rows are never
 * touched, and per-companion `wiki_document_chunks` rows live in a different
 * schema entirely.
 */
export class SharedWikiPgvectorProjectionStore implements SharedWikiSearchPort {
  private readonly pool: Pool;
  private readonly embedding: EmbeddingProviderPort;
  private readonly embeddingDims: number;
  private readonly eventBus?: Pick<EventBus, 'emit'>;
  private readonly chunkMaxChars: number;

  constructor(
    pool: Pool,
    embedding: EmbeddingProviderPort,
    options: SharedWikiProjectionStoreOptions = {},
  ) {
    this.pool = pool;
    this.embedding = embedding;
    this.embeddingDims = embedding.dims;
    this.eventBus = options.eventBus;
    this.chunkMaxChars = options.chunkMaxChars ?? DEFAULT_WIKI_CHUNK_MAX_CHARS;
  }

  private emitSync(siteId: string, outcome: WikiProjectionSyncOutcome): void {
    void this.eventBus?.emit('wiki.projection.sync', {
      documentId: outcome.documentId,
      siteId,
      outcome: outcome.status === 'ran' ? 'ran' : 'failed',
      chunkCount: outcome.chunkCount,
      ...(outcome.error ? { error: outcome.error } : {}),
      timestamp: Date.now(),
    }).catch((emitError: unknown) => {
      log.debug('Failed to emit shared wiki projection sync event', { error: String(emitError) });
    });
  }

  /**
   * Project one shared-world document (delete-and-replace for its version).
   * Fails closed for search on embedding/write errors — the canonical
   * filesystem document is untouched and the outcome reports the failure.
   * The document's scope MUST be `shared_world:<siteId>` for this site; a
   * mis-scoped document is rejected outright (never written), because a
   * personal-scoped row in the shared table is the W5b leak surface.
   */
  async syncDocument(siteId: string, document: WikiDocument): Promise<WikiProjectionSyncOutcome> {
    const expectedScope = sharedWorldScope(siteId);
    const documentScope = resolveWikiScope(document.scope);
    if (documentScope !== expectedScope) {
      throw new Error(
        `shared wiki projection for site "${siteId}" refuses document "${document.id}" `
        + `with scope "${documentScope}"; only "${expectedScope}" may be projected here.`,
      );
    }
    const chunks = chunkWikiBody(document.body, this.chunkMaxChars);
    if (chunks.length === 0) {
      await this.removeDocument(siteId, document.id);
      const outcome: WikiProjectionSyncOutcome = { status: 'ran', documentId: document.id, chunkCount: 0 };
      this.emitSync(siteId, outcome);
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
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Shared wiki projection embedding failed closed; shared index left stale for document', {
        siteId,
        documentId: document.id,
        error: message,
      });
      const outcome: WikiProjectionSyncOutcome = {
        status: 'failed',
        documentId: document.id,
        chunkCount: 0,
        error: message,
      };
      this.emitSync(siteId, outcome);
      return outcome;
    }
    try {
      const updatedAt = Date.now();
      await withPostgresClient(this.pool, async (client) => {
        await client.query(
          'DELETE FROM shared_wiki_chunks WHERE site_id = $1 AND document_id = $2',
          [siteId, document.id],
        );
        for (let index = 0; index < chunks.length; index += 1) {
          const chunkText = chunks[index] ?? '';
          await client.query(
            `INSERT INTO shared_wiki_chunks (
              site_id, document_id, chunk_index, body_sha256, title, body_path, source_class,
              sensitivity, scope, chunk_text, chunk_char_count, embedding, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector,$13)`,
            [
              siteId,
              document.id,
              index,
              document.bodySha256,
              document.title,
              document.bodyPath,
              document.sourceClass,
              document.sensitivity,
              expectedScope,
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
      log.warn('Shared wiki projection write failed closed for document', {
        siteId,
        documentId: document.id,
        error: message,
      });
      const outcome: WikiProjectionSyncOutcome = {
        status: 'failed',
        documentId: document.id,
        chunkCount: 0,
        error: message,
      };
      this.emitSync(siteId, outcome);
      return outcome;
    }
    const outcome: WikiProjectionSyncOutcome = { status: 'ran', documentId: document.id, chunkCount: chunks.length };
    this.emitSync(siteId, outcome);
    return outcome;
  }

  async removeDocument(siteId: string, documentId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM shared_wiki_chunks WHERE site_id = $1 AND document_id = $2',
      [siteId, documentId],
    );
  }

  async listProjectedShas(siteId: string): Promise<Array<{ documentId: string; bodySha256: string }>> {
    const rows = await queryRows<SharedWikiChunkShaRow>(this.pool, `
      SELECT DISTINCT document_id, body_sha256 FROM shared_wiki_chunks WHERE site_id = $1
    `, [siteId]);
    return rows.map(row => ({ documentId: row.document_id, bodySha256: row.body_sha256 }));
  }

  /**
   * Reconcile ONE site's projected rows against that site's canonical
   * filesystem documents: re-embed missing/drifted documents, delete orphans.
   * Scoped strictly to `site_id = siteId`, so re-publishing one site can never
   * disturb another site's projection.
   */
  async rebuildSite(
    siteId: string,
    documents: ReadonlyArray<WikiDocument>,
  ): Promise<WikiProjectionRebuildResult> {
    const projected = await this.listProjectedShas(siteId);
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
      const outcome = await this.syncDocument(siteId, document);
      if (outcome.status === 'ran') {
        reembedded.push(documentId);
      } else {
        failed.push({ documentId, error: outcome.error ?? 'unknown' });
      }
    }
    for (const documentId of drift.toDelete) {
      await this.removeDocument(siteId, documentId);
    }
    return { reembedded, deleted: drift.toDelete, failed };
  }

  async search(
    queryEmbedding: Float32Array,
    threshold: number,
    limit: number,
    scopes: readonly WikiScope[],
  ): Promise<WikiSemanticMatch[]> {
    if (queryEmbedding.length !== this.embeddingDims) {
      throw new Error(
        `shared wiki projection search embedding dimension mismatch: `
        + `expected ${this.embeddingDims}, got ${queryEmbedding.length}`,
      );
    }
    const sharedScopes = scopes.filter(isSharedWorldScope);
    // No shared scope granted → nothing to search. There is deliberately no
    // unfiltered shared read: an empty grant returns empty, never everything.
    if (sharedScopes.length === 0) return [];
    const docLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const chunkFetch = Math.min(500, docLimit * 8);
    const rows = await queryRows<SharedWikiChunkSearchRow>(this.pool, `
      SELECT
        site_id, document_id, chunk_index, title, body_path, source_class, sensitivity, scope, chunk_text,
        1 - (embedding <=> $1::vector) AS score
      FROM shared_wiki_chunks
      WHERE 1 - (embedding <=> $1::vector) >= $2
        AND scope = ANY($3::text[])
      ORDER BY embedding <=> $1::vector ASC
      LIMIT $4
    `, [encodeEmbeddingLiteral(queryEmbedding), threshold, [...sharedScopes], chunkFetch]);
    const bestByDoc = new Map<string, WikiSemanticMatch>();
    for (const row of rows) {
      const score = parseWikiChunkScore(row.score);
      // Document ids repeat across sites (every site has `site-overview`), so
      // per-document dedup keys on scope + id, never id alone.
      const key = `${row.scope} ${row.document_id}`;
      const existing = bestByDoc.get(key);
      if (existing && existing.score >= score) continue;
      bestByDoc.set(key, {
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Open a shared-schema-pinned pool, provision the shared schema INCLUDING the
 * wiki chunk table (advisory-lock serialized), and return the projection
 * store. Fails closed (throws) when Postgres or pgvector is unavailable.
 */
export async function createSharedWikiPgvectorProjectionStore(
  databaseUrl: string,
  embedding: EmbeddingProviderPort,
  options: SharedWikiProjectionStoreOptions = {},
): Promise<SharedWikiPgvectorProjectionStore> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-shared-wiki-projection',
    allowExitOnIdle: true,
    schema: SHARED_SCHEMA_NAME,
  });
  try {
    await ensureSharedWikiSchema(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return new SharedWikiPgvectorProjectionStore(pool, embedding, options);
}

// ── Write-surface projection runner (vinz.4 publish / vinz.27 import) ──

/** How a shared-world write surface resolves its projection dependencies. */
export interface SharedWikiProjectionContext {
  /** Postgres URL when configured; absent → projection cannot run. */
  databaseUrl?: string | undefined;
  /**
   * Embedding port. In the agent runtime this is the gateway-backed provider;
   * host-side maintenance CLIs construct the configured provider directly.
   * Absent (construction failed / unconfigured) → projection cannot run.
   */
  embedding?: EmbeddingProviderPort | undefined;
  /** Multi-companion topology flag. On → projection unavailability fails closed. */
  multiCompanion: boolean;
  eventBus?: Pick<EventBus, 'emit'>;
}

export interface SharedWikiProjectionOutcome {
  siteId: string;
  status: 'projected' | 'skipped' | 'failed';
  /** Present for `skipped` (honest no-Postgres/no-embedder report). */
  reason?: string;
  /** Present for `failed` (connection/schema/rebuild error, flag-off only). */
  error?: string;
  /** Document ids re-embedded by this pass (empty when already in sync). */
  projected: string[];
  /** Orphaned projected document ids deleted by this pass. */
  deleted: string[];
  /** Per-document embedding/write failures (reported, never silent). */
  failedDocuments: Array<{ documentId: string; error: string }>;
}

/**
 * Pure decision for whether a shared-world write surface can project. Fails
 * closed (throws) under multi-companion when the projection dependencies are
 * missing — a shared write surface must never mutate the filesystem while the
 * fleet-visible projection is known-unreachable. Flag-off it degrades to an
 * honest `skip` reason so the single-companion surface keeps working locally.
 */
export function resolveSharedWikiProjectionDecision(context: {
  databaseUrl?: string | undefined;
  embeddingAvailable: boolean;
  multiCompanion: boolean;
}): { action: 'project' } | { action: 'skip'; reason: string } {
  if (!context.databaseUrl?.trim()) {
    if (context.multiCompanion) {
      throw new Error(
        'shared-world wiki write requires config.postgresDatabaseUrl under multi-companion: '
        + 'the shared projection is how other companions see this write (fail closed).',
      );
    }
    return { action: 'skip', reason: 'postgres_not_configured' };
  }
  if (!context.embeddingAvailable) {
    if (context.multiCompanion) {
      throw new Error(
        'shared-world wiki write requires an embedding provider under multi-companion: '
        + 'shared documents cannot be projected without embeddings (fail closed).',
      );
    }
    return { action: 'skip', reason: 'embedding_unavailable' };
  }
  return { action: 'project' };
}

/**
 * Run one shared-world wiki write (vinz.4 publish or vinz.27 import) together
 * with its projection pass so the filesystem and `shared.shared_wiki_chunks`
 * cannot drift silently:
 *
 * 1. Resolve the projection decision FIRST. Under multi-companion, missing
 *    Postgres/embedding throws before any filesystem mutation.
 * 2. When projecting, connect + provision the shared wiki schema BEFORE the
 *    filesystem write — an unreachable schema under multi-companion aborts
 *    with the filesystem untouched.
 * 3. Perform the filesystem write (the caller's publish/import), then rebuild
 *    the site's projection from the store's now-canonical contents. The
 *    rebuild is a full per-site reconcile, so any later successful pass also
 *    heals drift left by an earlier failure.
 *
 * Flag-off, projection problems never block the local write: the outcome
 * reports `skipped`/`failed` honestly instead (no silent success).
 */
export async function runSharedWorldWikiWrite<TReport>(options: {
  context: SharedWikiProjectionContext;
  store: SharedWorldWikiStore;
  write: () => TReport;
}): Promise<{ report: TReport; projection: SharedWikiProjectionOutcome }> {
  const { context, store } = options;
  const siteId = store.siteId;
  const emptyOutcome: Pick<SharedWikiProjectionOutcome, 'projected' | 'deleted' | 'failedDocuments'> = {
    projected: [],
    deleted: [],
    failedDocuments: [],
  };

  const decision = resolveSharedWikiProjectionDecision({
    databaseUrl: context.databaseUrl,
    embeddingAvailable: context.embedding !== undefined,
    multiCompanion: context.multiCompanion,
  });
  if (decision.action === 'skip') {
    const report = options.write();
    log.warn('Shared-world wiki write completed WITHOUT projection (flag-off, honest skip)', {
      siteId,
      reason: decision.reason,
    });
    return {
      report,
      projection: { siteId, status: 'skipped', reason: decision.reason, ...emptyOutcome },
    };
  }

  // Connect before the filesystem write so an unreachable shared schema under
  // multi-companion aborts with nothing mutated.
  let projectionStore: SharedWikiPgvectorProjectionStore;
  try {
    projectionStore = await createSharedWikiPgvectorProjectionStore(
      context.databaseUrl as string,
      context.embedding as EmbeddingProviderPort,
      context.eventBus ? { eventBus: context.eventBus } : {},
    );
  } catch (error) {
    if (context.multiCompanion) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const report = options.write();
    log.warn('Shared-world wiki projection unavailable; write completed, projection reported failed', {
      siteId,
      error: message,
    });
    return {
      report,
      projection: { siteId, status: 'failed', error: message, ...emptyOutcome },
    };
  }

  try {
    const report = options.write();
    let rebuild: WikiProjectionRebuildResult;
    try {
      const documents = store
        .list()
        .map(entry => store.get(entry.id))
        .filter((document): document is WikiDocument => document !== null);
      rebuild = await projectionStore.rebuildSite(siteId, documents);
    } catch (error) {
      if (context.multiCompanion) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Shared-world wiki projection pass failed; filesystem write already committed', {
        siteId,
        error: message,
      });
      return {
        report,
        projection: { siteId, status: 'failed', error: message, ...emptyOutcome },
      };
    }
    if (context.multiCompanion && rebuild.failed.length > 0) {
      // Per-document failures under multi-companion are still loud: the write
      // surface reports an error so the operator sees the drift immediately.
      throw new Error(
        `shared-world wiki projection for site "${siteId}" failed for `
        + `${rebuild.failed.length} document(s): `
        + rebuild.failed.map(entry => `${entry.documentId} (${entry.error})`).join(', '),
      );
    }
    return {
      report,
      projection: {
        siteId,
        status: 'projected',
        projected: rebuild.reembedded,
        deleted: rebuild.deleted,
        failedDocuments: rebuild.failed,
      },
    };
  } finally {
    await projectionStore.close().catch(() => undefined);
  }
}
