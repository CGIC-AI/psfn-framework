import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  resolveWikiRetrievalSettings,
  type WikiRetrievalConfigLike,
} from '../../shared/context-budget.js';
import { createWikiTool } from './tools.js';
import { WikiStore } from './store.js';
import {
  createWikiPgvectorProjectionStore,
  type WikiPgvectorProjectionStore,
} from './pgvector-projection.js';
import { WikiRetrievalService } from './retrieval.js';
import type {
  WikiDocument,
  WikiSemanticSearchFn,
  WikiSemanticSearchResult,
} from './types.js';

const log = createComponentLogger('WikiRuntime');

const SEMANTIC_SEARCH_PREVIEW_CHARS = 240;

function previewText(value: string, maxChars = SEMANTIC_SEARCH_PREVIEW_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}

export interface WikiRuntimeTarget {
  registerTool: ToolRegistrar;
}

export interface WikiRuntimeDeps {
  /** Postgres connection string; when absent the projection is not built. */
  databaseUrl?: string;
  /** Embedding provider (the gateway) used for chunk + query embeddings. */
  embedding?: EmbeddingProviderPort;
  eventBus?: Pick<EventBus, 'emit'>;
  /** Live config accessor for wiki retrieval settings (caps, thresholds, enable). */
  getConfig?: () => WikiRetrievalConfigLike;
  /**
   * W5b: live accessor for the multi-companion topology flag. Default off, so
   * absence keeps retrieval scope unrestricted (byte-identical single-companion).
   */
  getMultiCompanion?: () => boolean;
}

export interface WikiRuntimeWiring {
  store: WikiStore;
  projection: WikiPgvectorProjectionStore | null;
  retrievalService: WikiRetrievalService | null;
}

/**
 * Wire the wiki subsystem: the canonical workspace store, its optional pgvector
 * projection (rebuildable mirror), the wiki tool (with semantic search when the
 * projection is available), and the supplemental chat RAG retrieval service.
 *
 * The projection is best-effort: if it cannot be created the wiki tool still
 * offers plain text search and writes still succeed — semantic search simply
 * fails closed. The store's write-hook mirrors every committed document into
 * the projection out of band, so it tolerates concurrent writers.
 */
export async function wireWikiRuntime(
  target: WikiRuntimeTarget,
  workspacePath: string,
  deps: WikiRuntimeDeps = {},
): Promise<WikiRuntimeWiring> {
  let projection: WikiPgvectorProjectionStore | null = null;
  if (deps.databaseUrl && deps.embedding) {
    try {
      projection = await createWikiPgvectorProjectionStore(deps.databaseUrl, deps.embedding, {
        ...(deps.eventBus ? { eventBus: deps.eventBus } : {}),
      });
    } catch (error) {
      log.warn('Wiki pgvector projection unavailable; semantic search disabled, text search still works', {
        error: String(error),
      });
      projection = null;
    }
  }

  const store = new WikiStore(workspacePath, projection
    ? {
      onUpsert: (document: WikiDocument) => {
        void projection!.syncDocument(document).catch((error: unknown) => {
          log.debug('Wiki projection sync hook failed', { documentId: document.id, error: String(error) });
        });
      },
    }
    : {});

  let retrievalService: WikiRetrievalService | null = null;
  let semanticSearch: WikiSemanticSearchFn | undefined;
  if (projection && deps.embedding) {
    const embedding = deps.embedding;
    const activeProjection = projection;
    semanticSearch = async (query: string, limit: number): Promise<WikiSemanticSearchResult> => {
      try {
        const vector = await embedding.embed(query);
        // Manual search surface uses a permissive threshold (>= 0 similarity) so
        // the operator/agent can browse the whole projection; the gated chat RAG
        // path applies its own stricter, config-owned thresholds separately.
        const matches = await activeProjection.search(vector, 0, limit);
        return {
          query,
          count: matches.length,
          degraded: false,
          matches: matches.map(match => ({
            id: match.documentId,
            title: match.title,
            sourceClass: match.sourceClass,
            sensitivity: match.sensitivity,
            path: match.path,
            score: match.score,
            preview: previewText(match.chunkText),
          })),
        };
      } catch (error) {
        log.warn('Wiki semantic search failed closed', { error: String(error) });
        return { query, count: 0, degraded: true, matches: [] };
      }
    };

    if (deps.getConfig) {
      const getConfig = deps.getConfig;
      retrievalService = new WikiRetrievalService({
        projection: activeProjection,
        embedding,
        ...(deps.eventBus ? { eventBus: deps.eventBus } : {}),
        getSettings: () => resolveWikiRetrievalSettings(getConfig()),
        ...(deps.getMultiCompanion ? { getMultiCompanion: deps.getMultiCompanion } : {}),
      });
    }
  }

  target.registerTool(createWikiTool(store, semanticSearch ? { semanticSearch } : {}), 'core');

  if (projection) {
    // Startup repair pass: rebuild the projection from the canonical workspace
    // files. computeWikiProjectionDrift only re-embeds documents whose checksum
    // drifted (or that are missing) and deletes orphaned projected documents,
    // so a lost/stale projection self-heals from the source of truth on boot.
    const activeProjection = projection;
    void (async () => {
      try {
        const documents = store
          .list()
          .map(entry => store.get(entry.id))
          .filter((document): document is WikiDocument => document !== null);
        const result = await activeProjection.rebuild(documents);
        if (result.reembedded.length > 0 || result.deleted.length > 0 || result.failed.length > 0) {
          log.info('Wiki projection startup repair completed', {
            reembedded: result.reembedded.length,
            deleted: result.deleted.length,
            failed: result.failed.length,
          });
        }
      } catch (error) {
        log.warn('Wiki projection startup repair failed; semantic search may be stale until next write', {
          error: String(error),
        });
      }
    })();
  }

  return { store, projection, retrievalService };
}
