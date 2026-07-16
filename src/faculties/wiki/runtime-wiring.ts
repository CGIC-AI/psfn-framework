import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  resolveWikiRetrievalSettings,
  type WikiRetrievalConfigLike,
} from '../../shared/context-budget.js';
import { createWikiTool } from './tools.js';
import type { IntakeSinkGate } from '../../core/cogsec/intake/sink-gates.js';
import { SharedWorldWikiStore, WikiStore } from './store.js';
import {
  createWikiPgvectorProjectionStore,
  type WikiPgvectorProjectionStore,
} from './pgvector-projection.js';
import {
  createSharedWikiPgvectorProjectionStore,
  type SharedWikiPgvectorProjectionStore,
} from './shared-pgvector-projection.js';
import { WikiRetrievalService } from './retrieval.js';
import type {
  WikiDocument,
  WikiSemanticSearchFn,
  WikiSemanticSearchResult,
} from './types.js';
import type { RetrievalQueryEmbeddingProvenance } from '../../shared/retrieval-query-embedding.js';
import { loadPlacesRegistryConfig } from '../../channels/backplane/places-registry.js';
import { SharedWorldWikiProposalStore } from './shared-world-caretaker-store.js';
import {
  SharedWorldWikiCaretakerService,
  SharedWorldWikiProposalService,
} from './shared-world-caretaker.js';
import { PersonalProjectLibrary } from './personal-projects.js';
import { PersonalWishlist } from './personal-wishlist.js';
import { derivePostgresTenantRole } from '../../persistence/postgres/tenancy.js';

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
  embeddingProvenance?: RetrievalQueryEmbeddingProvenance;
  eventBus?: Pick<EventBus, 'emit'>;
  /** Live config accessor for wiki retrieval settings (caps, thresholds, enable). */
  getConfig?: () => WikiRetrievalConfigLike;
  /**
   * W5b: live accessor for the multi-companion topology flag. Default off, so
   * absence keeps retrieval scope unrestricted (byte-identical single-companion).
   */
  getMultiCompanion?: () => boolean;
  /**
   * Per-companion schema (multi-companion, sprint 10). Pins the personal
   * projection pool's search_path so companion-private `wiki_document_chunks`
   * rows never land in `public` and collide across companions. Absent =>
   * byte-identical single-companion (default `public`). The shared-world
   * projection ignores this: it always pins its own `shared` schema.
   */
  postgresSchema?: string;
  /**
   * Intake sink gate provider (htm9.3), threaded to the wiki tool's
   * wiki_write gate. Absent/null = firewall off.
   */
  getIntakeSinkGate?: () => IntakeSinkGate | null;
  /** Runtime identity stamped on companion-authored shared-world proposals. */
  companionId?: string;
  /** System owner root containing places.json; used only to validate proposal site ids. */
  systemDataDir?: string;
}

export interface WikiRuntimeWiring {
  store: WikiStore;
  personalProjects: PersonalProjectLibrary;
  personalWishlist: PersonalWishlist;
  projection: WikiPgvectorProjectionStore | null;
  /**
   * s10f9: read-side handle on `shared.shared_wiki_chunks` for the retrieval
   * union. Built ONLY under multi-companion (flag-off never touches the shared
   * schema, matching the runtime-factory presence invariant).
   */
  sharedProjection: SharedWikiPgvectorProjectionStore | null;
  retrievalService: WikiRetrievalService | null;
  proposalStore: SharedWorldWikiProposalStore | null;
  sharedWorldCaretaker: SharedWorldWikiCaretakerService | null;
  close(): Promise<void>;
}

interface WikiRuntimeClosable {
  close(): Promise<void>;
}

export async function closeWikiRuntimeResources(
  resources: readonly WikiRuntimeClosable[],
): Promise<void> {
  const results = await Promise.allSettled(resources.map(resource => resource.close()));
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to close wiki runtime resources');
  }
}

async function closeWikiRuntimeAfterFailure(
  error: unknown,
  resources: readonly WikiRuntimeClosable[],
): Promise<never> {
  try {
    await closeWikiRuntimeResources(resources);
  } catch (closeError) {
    throw new AggregateError(
      [error, closeError],
      'Wiki runtime initialization failed and its resources did not close cleanly',
    );
  }
  throw error;
}

/**
 * Wire the wiki subsystem: the canonical workspace store, its optional pgvector
 * projection (rebuildable mirror), the wiki tool (with semantic search when the
 * projection is available), and the supplemental chat RAG retrieval service.
 *
 * In single-companion mode the projection is best-effort: if it cannot be
 * created the wiki tool still offers plain text search. Multi-companion mode
 * requires the shared projection and caretaker dependencies because silently
 * disabling approved shared-world maintenance would strand canonical changes.
 * The store's write-hook mirrors every committed document into the projection
 * out of band, so it tolerates concurrent writers.
 */
export async function wireWikiRuntime(
  target: WikiRuntimeTarget,
  workspacePath: string,
  deps: WikiRuntimeDeps = {},
): Promise<WikiRuntimeWiring> {
  const multiCompanion = deps.getMultiCompanion?.() === true;
  let knownSiteIds: ReadonlySet<string> | null = null;
  if (multiCompanion) {
    if (!deps.databaseUrl?.trim()) {
      throw new Error('Multi-companion shared-world wiki caretaker requires PostgreSQL');
    }
    if (!deps.embedding) {
      throw new Error('Multi-companion shared-world wiki caretaker requires an embedding provider');
    }
    if (!deps.companionId?.trim()) {
      throw new Error('Multi-companion shared-world wiki caretaker requires a companion identity');
    }
    const systemDataDir = deps.systemDataDir?.trim();
    if (!systemDataDir) {
      throw new Error('Multi-companion shared-world wiki caretaker requires the system data root');
    }
    try {
      knownSiteIds = new Set(loadPlacesRegistryConfig(systemDataDir).sites.map(site => site.siteId));
      if (knownSiteIds.size === 0) {
        throw new Error('places registry contains no sites');
      }
    } catch (error) {
      throw new Error(
        'Multi-companion shared-world wiki caretaker requires a valid places registry',
        { cause: error },
      );
    }
  }

  let projection: WikiPgvectorProjectionStore | null = null;
  if (deps.databaseUrl && deps.embedding) {
    try {
      projection = await createWikiPgvectorProjectionStore(deps.databaseUrl, deps.embedding, {
        ...(deps.eventBus ? { eventBus: deps.eventBus } : {}),
        ...(deps.postgresSchema ? { schema: deps.postgresSchema } : {}),
        ...(deps.postgresSchema && deps.getMultiCompanion?.() === true
          ? { role: derivePostgresTenantRole(deps.postgresSchema) }
          : {}),
      });
    } catch (error) {
      log.warn('Wiki pgvector projection unavailable; semantic search disabled, text search still works', {
        error: String(error),
      });
      projection = null;
    }
  }

  // s10f9: shared-world chunk projection for the retrieval union. Multi-
  // companion only — flag-off the shared schema is never created or touched,
  // and retrieval never grants a shared scope anyway (resolveReadableWikiScopes
  // returns undefined), so the personal path stays byte-identical.
  // Multi-companion startup requires this projection because it is also the
  // approved shared-world caretaker's write-side projection target.
  let sharedProjection: SharedWikiPgvectorProjectionStore | null = null;
  if (deps.databaseUrl && deps.embedding && multiCompanion) {
    try {
      sharedProjection = await createSharedWikiPgvectorProjectionStore(deps.databaseUrl, deps.embedding, {
        ...(deps.eventBus ? { eventBus: deps.eventBus } : {}),
      });
    } catch (error) {
      await closeWikiRuntimeAfterFailure(error, projection ? [projection] : []);
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
        ...(sharedProjection ? { sharedProjection } : {}),
        embedding,
        ...(deps.embeddingProvenance ? { embeddingProvenance: deps.embeddingProvenance } : {}),
        ...(deps.eventBus ? { eventBus: deps.eventBus } : {}),
        getSettings: () => resolveWikiRetrievalSettings(getConfig()),
        ...(deps.getMultiCompanion ? { getMultiCompanion: deps.getMultiCompanion } : {}),
      });
    }
  }

  let proposalStore: SharedWorldWikiProposalStore | null = null;
  let sharedWorldCaretaker: SharedWorldWikiCaretakerService | null = null;
  let sharedWorldProposal: {
    actorId: string;
    submitter: SharedWorldWikiProposalService;
  } | undefined;
  if (multiCompanion) {
    if (!deps.databaseUrl || !deps.companionId || !deps.systemDataDir
      || !deps.embedding || !sharedProjection || !knownSiteIds) {
      throw new Error('Multi-companion shared-world wiki caretaker dependencies are incomplete');
    }
    proposalStore = new SharedWorldWikiProposalStore(deps.databaseUrl);
    try {
      await proposalStore.initialize();
    } catch (error) {
      await closeWikiRuntimeAfterFailure(
        error,
        [proposalStore, ...(projection ? [projection] : []), sharedProjection],
      );
    }
    const systemDataDir = deps.systemDataDir;
    const activeKnownSiteIds = knownSiteIds;
    sharedWorldProposal = {
      actorId: deps.companionId.trim(),
      submitter: new SharedWorldWikiProposalService({
        proposalStore,
        isKnownSite: siteId => activeKnownSiteIds.has(siteId),
      }),
    };
    sharedWorldCaretaker = new SharedWorldWikiCaretakerService({
      proposalStore,
      isKnownSite: siteId => activeKnownSiteIds.has(siteId),
      openSharedStore: siteId => new SharedWorldWikiStore(systemDataDir, siteId),
      projection: sharedProjection,
    });
  }

  const personalProjects = new PersonalProjectLibrary(store);
  const personalWishlist = new PersonalWishlist(store);
  const resources = [
    ...(projection ? [projection] : []),
    ...(sharedProjection ? [sharedProjection] : []),
    ...(proposalStore ? [proposalStore] : []),
  ];
  try {
    target.registerTool(createWikiTool(store, {
      ...(semanticSearch ? { semanticSearch } : {}),
      ...(deps.getIntakeSinkGate ? { getIntakeSinkGate: deps.getIntakeSinkGate } : {}),
      ...(sharedWorldProposal ? { sharedWorldProposal } : {}),
      personalProjects,
      personalWishlist,
    }), 'core');
  } catch (error) {
    await closeWikiRuntimeAfterFailure(error, resources);
  }

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

  return {
    store,
    personalProjects,
    personalWishlist,
    projection,
    sharedProjection,
    retrievalService,
    proposalStore,
    sharedWorldCaretaker,
    close: () => closeWikiRuntimeResources(resources),
  };
}
