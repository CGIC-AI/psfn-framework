import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  resolveWikiRetrievalSettings,
  type WikiRetrievalConfigLike,
} from '../../shared/context-budget.js';
import { createWikiTool } from './tools.js';
import type { SelfAuthoredMutationIntakeRuntime } from '../../core/session/intake-sink-gating.js';
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
import { createWikiAdmissionGate, type WikiAdmissionGate } from './admission.js';
import type { CogSecArtifactAdmissionPort } from '../../core/cogsec/intake/durable-admission.js';
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
import type { GatewaySystemDataWriterPort } from '../../boundary/gateway/system-data-writer.js';
import { createGatewaySharedWorldWikiDocumentWriter } from './gateway-shared-world-writer.js';
import { awaitPostgresStoreReadiness } from '../../persistence/postgres/runtime-readiness.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import {
  createMaintenanceEmbeddingUsageProvenance,
  embeddingUsageProvenanceFromRequestContext,
} from '../../core/agent/embedding-usage-provenance.js';

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
  /** Topology-owned role paired with postgresSchema for tenant pool pinning. */
  postgresRole?: string;
  /** Screen-then-gate runtime threaded to companion-authored wiki writes. */
  intake: SelfAuthoredMutationIntakeRuntime;
  /**
   * Content-addressed CogSec admission for prompt-bearing wiki documents
   * (psfn-framework-1fjvm.2). Wired, a document is served into a prompt — the
   * retrieval context block, the wiki tool, the semantic projection — only
   * after its exact canonical bytes hold an admitted receipt or are admitted by
   * a fresh screen. Absent, wiki reads behave exactly as before.
   */
  admission?: CogSecArtifactAdmissionPort;
  /** Runtime identity stamped on companion-authored shared-world proposals. */
  companionId?: string;
  /** System owner root containing places.json; used only to validate proposal site ids. */
  systemDataDir?: string;
  /** Gateway-owned single writer for shared-world wiki canonical mutations. */
  systemDataWriter?: GatewaySystemDataWriterPort;
}

export interface WikiRuntimeWiring {
  store: WikiStore;
  /** Present only when a CogSec admission port was wired (1fjvm.2). */
  admissionGate: WikiAdmissionGate | null;
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
  deps: WikiRuntimeDeps,
): Promise<WikiRuntimeWiring> {
  const multiCompanion = deps.getMultiCompanion?.() === true;
  const systemDataWriter = deps.systemDataWriter;
  const postgresRole = multiCompanion && deps.postgresSchema?.trim()
    ? deps.postgresRole?.trim() || (() => {
        throw new Error('Multi-companion wiki runtime requires a topology-owned PostgreSQL role');
      })()
    : undefined;
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
    if (!systemDataWriter) {
      throw new Error(
        'Multi-companion shared-world wiki caretaker requires the gateway system-data writer',
      );
    }
  }

  let projection: WikiPgvectorProjectionStore | null = null;
  if (deps.databaseUrl && deps.embedding) {
    const databaseUrl = deps.databaseUrl;
    const embedding = deps.embedding;
    try {
      projection = await awaitPostgresStoreReadiness(
        'wiki_projection',
        () => createWikiPgvectorProjectionStore(databaseUrl, embedding, {
          ...(deps.eventBus ? { eventBus: deps.eventBus } : {}),
          ...(deps.postgresSchema ? { schema: deps.postgresSchema } : {}),
          ...(postgresRole ? { role: postgresRole } : {}),
        }),
      );
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
    const databaseUrl = deps.databaseUrl;
    const embedding = deps.embedding;
    try {
      sharedProjection = await awaitPostgresStoreReadiness(
        'shared_wiki',
        () => createSharedWikiPgvectorProjectionStore(databaseUrl, embedding, {
          ...(deps.eventBus ? { eventBus: deps.eventBus } : {}),
        }),
      );
    } catch (error) {
      await closeWikiRuntimeAfterFailure(error, projection ? [projection] : []);
    }
  }

  // psfn-framework-1fjvm.2: the admission gate is the single place a wiki
  // document earns the right to be served. It sits ON the upsert hook rather
  // than inside WikiStore because the store is synchronous and admission is
  // not — and because the hook is the one seam every canonical write already
  // passes through.
  const admissionGate = deps.admission ? createWikiAdmissionGate(deps.admission) : null;
  const activeProjectionForUpsert = projection;
  const onUpsert = admissionGate || activeProjectionForUpsert
    ? async (document: WikiDocument): Promise<void> => {
      if (admissionGate) {
        const outcome = await admissionGate.admit(document);
        if (outcome.state !== 'admitted') {
          // A held document must not remain retrievable through chunks
          // projected from an earlier, admitted version of itself.
          await activeProjectionForUpsert?.removeDocument(document.id);
          log.warn('Wiki document held by CogSec admission; withheld from retrieval', {
            documentId: document.id,
            sourceClass: document.sourceClass,
            state: outcome.state,
          });
          return;
        }
      }
      await activeProjectionForUpsert?.syncDocument(document);
    }
    : undefined;
  const store = new WikiStore(workspacePath, onUpsert
    ? {
      // Return the promise so WikiStore's canonical hook boundary reports any
      // unexpected rejection through the Garden-visible diagnostic log ring.
      // Expected projection failures still emit wiki.projection.sync outcomes.
      onUpsert,
    }
    : {});

  /**
   * Whether the document behind a projected chunk is admitted RIGHT NOW
   * (psfn-framework-1fjvm.2). Reads the canonical file, so a document that was
   * restored or rewritten since it was admitted reads back as unadmitted. A
   * missing document, an unreadable one, and a checksum mismatch are all
   * withheld: the read paths fail closed, never open.
   */
  const isPersonalDocumentAdmitted = admissionGate
    ? (documentId: string): boolean => {
      try {
        const document = store.get(documentId);
        return document !== null && admissionGate.status(document).state === 'admitted';
      } catch (error) {
        log.warn('Wiki admission check could not read the canonical document; withholding it', {
          documentId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }
    : undefined;

  let retrievalService: WikiRetrievalService | null = null;
  let semanticSearch: WikiSemanticSearchFn | undefined;
  if (projection && deps.embedding) {
    const embedding = deps.embedding;
    const activeProjection = projection;
    semanticSearch = async (query: string, limit: number): Promise<WikiSemanticSearchResult> => {
      try {
        const vector = await embedding.embed(query, {
          usageProvenance: embeddingUsageProvenanceFromRequestContext(getRequestContext())
            ?? createMaintenanceEmbeddingUsageProvenance({
            purpose: 'wiki.semantic_search',
            service: 'wiki',
            process: 'semantic-search',
            workloadType: 'wiki_semantic_search',
            workloadId: 'manual-search',
            }),
        });
        // Manual search surface uses a permissive threshold (>= 0 similarity) so
        // the operator/agent can browse the whole projection; the gated chat RAG
        // path applies its own stricter, config-owned thresholds separately.
        const found = await activeProjection.search(vector, 0, limit);
        // psfn-framework-1fjvm.2: chunk text is document body text, so an
        // unadmitted document is withheld from this surface too.
        const matches = isPersonalDocumentAdmitted
          ? found.filter(match => isPersonalDocumentAdmitted(match.documentId))
          : found;
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
        ...(isPersonalDocumentAdmitted ? { isPersonalDocumentAdmitted } : {}),
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
      || !deps.embedding || !sharedProjection || !knownSiteIds || !systemDataWriter) {
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
    const writeSharedDocument = createGatewaySharedWorldWikiDocumentWriter({
      systemDataDir,
      systemDataWriter,
    });
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
      writeSharedDocument,
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
      ...(admissionGate ? { admissionGate } : {}),
      intake: deps.intake,
      ...(sharedWorldProposal ? { sharedWorldProposal } : {}),
      personalProjects,
      personalWishlist,
    }), 'core');
  } catch (error) {
    await closeWikiRuntimeAfterFailure(error, resources);
  }

  // Startup admission + projection repair pass.
  //
  // This is the seam a RESTORE lands on. A fleet restore copies documents and
  // metadata straight onto disk with their original `bodySha256`, never
  // touching `upsert`, so nothing else in the runtime would ever look at those
  // bytes again. Here every canonical document is re-admitted from disk before
  // it can be projected, and only admitted documents are handed to `rebuild` —
  // whose drift computation then deletes the projected chunks of everything
  // else, including chunks left behind by an earlier admitted version.
  //
  // With receipts wired this costs one content-addressed lookup per unchanged
  // document and no screening at all.
  const startupAdmissionGate = admissionGate;
  const startupProjection = projection;
  if (startupAdmissionGate || startupProjection) {
    void (async () => {
      try {
        const documents = store
          .list()
          .map(entry => store.get(entry.id))
          .filter((document): document is WikiDocument => document !== null);
        let admitted = documents;
        if (startupAdmissionGate) {
          const gate = startupAdmissionGate;
          const outcomes = await Promise.all(documents.map(async (document) => ({
            document,
            state: (await gate.admit(document)).state,
          })));
          admitted = outcomes
            .filter((entry) => entry.state === 'admitted')
            .map((entry) => entry.document);
          const held = outcomes.length - admitted.length;
          if (held > 0) {
            log.warn('Wiki documents held by CogSec admission at startup', {
              held,
              scanned: outcomes.length,
            });
          }
        }
        if (!startupProjection) return;
        const result = await startupProjection.rebuild(admitted);
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
    admissionGate,
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
