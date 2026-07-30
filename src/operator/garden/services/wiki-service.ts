import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SharedWorldWikiStore,
  WikiStore,
} from '../../../faculties/wiki/store.js';
import {
  resolveWikiScope,
  sharedWorldScope,
} from '../../../faculties/wiki/scope.js';
import type { WikiDocumentListEntry } from '../../../faculties/wiki/types.js';
import type { PlacesWikiPublicationReport } from '../../../faculties/wiki/places-wiki-publication.js';
import {
  importMarkdownFiles,
  readMarkdownDirectory,
  type WikiImportReport,
} from '../../../faculties/wiki/bulk-import.js';
import type { GatewaySystemDataWriterPort } from '../../../boundary/gateway/system-data-writer.js';
import {
  createSharedWikiPgvectorProjectionStore,
  runSharedWorldWikiWrite,
  type SharedWikiProjectionContext,
  type SharedWikiProjectionOutcome,
} from '../../../faculties/wiki/shared-pgvector-projection.js';
import { SharedWorldWikiProposalStore } from '../../../faculties/wiki/shared-world-caretaker-store.js';
import { SharedWorldWikiCaretakerService } from '../../../faculties/wiki/shared-world-caretaker.js';
import { createGatewaySharedWorldWikiDocumentWriter } from '../../../faculties/wiki/gateway-shared-world-writer.js';
import type {
  SharedWorldWikiProposalApplyResult,
  SharedWorldWikiProposalListQuery,
  SharedWorldWikiCleanupResult,
} from '../../../faculties/wiki/shared-world-caretaker-types.js';
import {
  loadPlacesRegistryConfig,
  resolveSiteById,
} from '../../../channels/backplane/places-registry.js';
import {
  resolveSharedWorldWikiDir,
  resolveSharedWorldWikiSiteDir,
} from '../../../persistence/layout.js';
import type {
  AdminSharedWorldWikiImportData,
  AdminSharedWorldWikiListData,
  AdminSharedWorldWikiPublishData,
  AdminWikiImportRequest,
  AdminWikiListData,
  AdminWikiScopeSummary,
  AdminWikiScopesData,
  AdminWikiService,
} from './types.js';

const WIKI_BOUNDARY =
  'Wiki/reference knowledge is workspace-backed durable reference material, separate from L0/L0.1/L2 memory.';

export interface AdminWikiDataServiceOptions {
  workspacePath: string;
  /** System-data dir owning shared-world wiki subtrees and places.json. */
  systemDataDir: string;
  /** Gateway-owned single writer for system-data mutations. */
  systemDataWriter?: GatewaySystemDataWriterPort;
  /**
   * s10f9: dependencies for the shared-schema pgvector projection that follows
   * every shared-world write (publish/import). When absent the service still
   * works flag-off (writes report `projection: skipped` honestly); under
   * multi-companion the projection runner fails the write closed instead.
   */
  sharedProjection?: SharedWikiProjectionContext;
}

interface SharedWikiScopeCount {
  siteId: string;
  documentCount: number;
}

interface SharedWikiScopeMemo {
  registrySiteIds: string[];
  sitesRootModifiedMs: number | null;
  counts: SharedWikiScopeCount[];
}

/** Resolve every scope tag explicitly so the admin surface can show/filter it. */
function withResolvedScope(entries: WikiDocumentListEntry[]): WikiDocumentListEntry[] {
  return entries.map(entry => ({ ...entry, scope: resolveWikiScope(entry.scope) }));
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertPublicationVisible(
  store: SharedWorldWikiStore,
  report: PlacesWikiPublicationReport,
): void {
  for (const documentId of [...report.created, ...report.updated, ...report.unchanged]) {
    if (!store.get(documentId)) {
      throw new Error(
        `Gateway published shared-world wiki document "${documentId}", but the agent cannot read it. `
        + 'Verify the gateway and agent share the same system-data volume.',
      );
    }
  }
  for (const documentId of report.deleted) {
    if (store.get(documentId)) {
      throw new Error(
        `Gateway deleted shared-world wiki document "${documentId}", but the agent still sees it. `
        + 'Verify the gateway and agent share the same system-data volume.',
      );
    }
  }
}

function assertImportVisible(store: SharedWorldWikiStore, report: WikiImportReport): void {
  for (const entry of report.imported) {
    if (!store.get(entry.id)) {
      throw new Error(
        `Gateway imported shared-world wiki document "${entry.id}", but the agent cannot read it. `
        + 'Verify the gateway and agent share the same system-data volume.',
      );
    }
  }
}

export class AdminWikiDataService implements AdminWikiService {
  private readonly personalStore: WikiStore;
  private readonly systemDataDir: string;
  private readonly systemDataWriter?: GatewaySystemDataWriterPort;
  private readonly sharedProjectionContext: SharedWikiProjectionContext;
  private readonly proposalStore: SharedWorldWikiProposalStore | null;
  private sharedWikiScopeMemo: SharedWikiScopeMemo | null = null;

  constructor(options: AdminWikiDataServiceOptions) {
    this.personalStore = new WikiStore(options.workspacePath);
    this.systemDataDir = options.systemDataDir;
    this.systemDataWriter = options.systemDataWriter;
    // Without injected deps the runner degrades honestly flag-off; note it can
    // never fail closed here because multiCompanion is only knowable from the
    // injected context — compositions running multi-companion MUST inject it.
    this.sharedProjectionContext = options.sharedProjection ?? { multiCompanion: false };
    const proposalDatabaseUrl = this.sharedProjectionContext.databaseUrl?.trim();
    this.proposalStore = this.sharedProjectionContext.multiCompanion && proposalDatabaseUrl
      ? new SharedWorldWikiProposalStore(proposalDatabaseUrl)
      : null;
  }

  private requireProposalStore(): SharedWorldWikiProposalStore {
    if (!this.proposalStore) {
      throw new Error('shared-world wiki caretaker is unavailable');
    }
    return this.proposalStore;
  }

  private requireSystemDataWriter(): GatewaySystemDataWriterPort {
    if (!this.systemDataWriter) {
      throw new Error(
        'Shared-world wiki writes require the gateway system-data writer. '
        + 'Verify the agent is connected to a gateway with system.data.write configured.',
      );
    }
    return this.systemDataWriter;
  }

  private isKnownSite(siteId: string): boolean {
    return loadPlacesRegistryConfig(this.systemDataDir).sites.some(site => site.siteId === siteId);
  }

  private invalidateSharedWikiScopeMemo(): void {
    this.sharedWikiScopeMemo = null;
  }

  private listSharedWikiScopeCounts(registrySiteIds: string[]): SharedWikiScopeCount[] {
    const sitesRoot = join(resolveSharedWorldWikiDir(this.systemDataDir), 'sites');
    const sitesRootStats = statSync(sitesRoot, { throwIfNoEntry: false });
    const sitesRootModifiedMs = sitesRootStats?.mtimeMs ?? null;
    if (
      this.sharedWikiScopeMemo
      && this.sharedWikiScopeMemo.sitesRootModifiedMs === sitesRootModifiedMs
      && stringArraysEqual(this.sharedWikiScopeMemo.registrySiteIds, registrySiteIds)
    ) {
      return this.sharedWikiScopeMemo.counts;
    }

    // Union of registry sites and any site subtree already on disk, so an
    // imported/published site surfaces even if its registry entry was removed.
    const siteIds = new Set<string>(registrySiteIds);
    if (existsSync(sitesRoot)) {
      for (const name of readdirSync(sitesRoot)) siteIds.add(name);
    }
    const counts: SharedWikiScopeCount[] = [];
    for (const siteId of [...siteIds].sort((a, b) => a.localeCompare(b))) {
      let documentCount = 0;
      try {
        documentCount = new SharedWorldWikiStore(this.systemDataDir, siteId).list().length;
      } catch {
        continue; // Invalid siteId token on disk — skip rather than fail the surface.
      }
      counts.push({ siteId, documentCount });
    }
    this.sharedWikiScopeMemo = {
      registrySiteIds: [...registrySiteIds],
      // Opening a registry-only site store can create its canonical directory.
      // Capture the post-scan mtime so that creation does not force a redundant
      // rescan on the very next unchanged request.
      sitesRootModifiedMs: statSync(sitesRoot, { throwIfNoEntry: false })?.mtimeMs ?? null,
      counts,
    };
    return counts;
  }

  async listWikiDocuments(): Promise<AdminWikiListData> {
    return {
      roots: this.personalStore.getRootInfo(),
      documents: withResolvedScope(this.personalStore.list()),
      boundary: WIKI_BOUNDARY,
    };
  }

  async getWikiDocument(id: string) {
    return this.personalStore.get(id);
  }

  async searchWikiDocuments(query: { query: string; limit?: number }) {
    return this.personalStore.search(query);
  }

  async listWikiScopes(): Promise<AdminWikiScopesData> {
    const scopes: AdminWikiScopeSummary[] = [{
      scope: 'personal',
      displayName: 'Personal (companion)',
      documentCount: this.personalStore.list().length,
    }];
    const registry = loadPlacesRegistryConfig(this.systemDataDir);
    const registrySiteIds = registry.sites
      .map(site => site.siteId)
      .sort((left, right) => left.localeCompare(right));
    for (const { siteId, documentCount } of this.listSharedWikiScopeCounts(registrySiteIds)) {
      const site = resolveSiteById(registry, siteId);
      scopes.push({
        scope: sharedWorldScope(siteId),
        siteId,
        displayName: site ? `${site.displayName} (shared world)` : `${siteId} (shared world)`,
        documentCount,
      });
    }
    return { boundary: WIKI_BOUNDARY, scopes };
  }

  async listSharedWorldWikiDocuments(siteId: string): Promise<AdminSharedWorldWikiListData> {
    const store = new SharedWorldWikiStore(this.systemDataDir, siteId);
    return {
      scope: store.scope,
      siteId,
      roots: store.getRootInfo(),
      documents: withResolvedScope(store.list()),
      boundary: WIKI_BOUNDARY,
    };
  }

  async getSharedWorldWikiDocument(siteId: string, id: string) {
    return new SharedWorldWikiStore(this.systemDataDir, siteId).get(id);
  }

  async publishSharedWorldSite(siteId: string): Promise<AdminSharedWorldWikiPublishData> {
    const registry = loadPlacesRegistryConfig(this.systemDataDir);
    if (!resolveSiteById(registry, siteId)) {
      throw new Error(`unknown siteId "${siteId}" — not present in places.json sites (fail closed)`);
    }
    const store = new SharedWorldWikiStore(this.systemDataDir, siteId);
    const systemDataWriter = this.requireSystemDataWriter();
    // s10f9: write + shared-schema projection run together so filesystem and
    // shared.shared_wiki_chunks cannot drift silently. Multi-companion fails
    // closed BEFORE the write when the projection is unavailable.
    try {
      const { report, projection } = await runSharedWorldWikiWrite({
        context: this.sharedProjectionContext,
        store,
        write: async (): Promise<PlacesWikiPublicationReport> => {
          const result = await systemDataWriter.writeSystemData({
            kind: 'shared_world_wiki',
            operation: 'publish_site',
            siteId,
            updatedBy: 'garden-operator',
          });
          if (!('kind' in result) || result.operation !== 'publish_site') {
            throw new Error('Gateway shared-world wiki writer returned an invalid publish response');
          }
          assertPublicationVisible(store, result.report);
          return result.report;
        },
      });
      return { ...report, projection };
    } finally {
      this.invalidateSharedWikiScopeMemo();
    }
  }

  async importSharedWorldDirectory(
    siteId: string,
    request: AdminWikiImportRequest,
  ): Promise<AdminSharedWorldWikiImportData> {
    const directory = request.directory.trim();
    if (!directory) throw new Error('directory is required for shared-world import');
    const registry = loadPlacesRegistryConfig(this.systemDataDir);
    if (!resolveSiteById(registry, siteId)) {
      throw new Error(`unknown siteId "${siteId}" — not present in places.json sites (fail closed)`);
    }
    // Touch the resolver so a malformed siteId fails closed before any FS read.
    resolveSharedWorldWikiSiteDir(this.systemDataDir, siteId);
    const store = new SharedWorldWikiStore(this.systemDataDir, siteId);
    const files = readMarkdownDirectory(directory);
    const plannedReport = importMarkdownFiles({
      directory,
      files,
      store,
      scope: store.scope,
      personalFactGuard: true,
      updatedBy: 'garden-operator',
      dryRun: true,
    });
    if (request.dryRun === true) {
      // Nothing written → nothing to project; the outcome says so explicitly.
      return {
        ...plannedReport,
        projection: {
          siteId,
          status: 'skipped',
          reason: 'dry_run',
          projected: [],
          deleted: [],
          failedDocuments: [],
        } satisfies SharedWikiProjectionOutcome,
      };
    }
    const systemDataWriter = this.requireSystemDataWriter();
    try {
      const { report, projection } = await runSharedWorldWikiWrite({
        context: this.sharedProjectionContext,
        store,
        write: async (): Promise<WikiImportReport> => {
          const result = await systemDataWriter.writeSystemData({
            kind: 'shared_world_wiki',
            operation: 'import_files',
            siteId,
            directory,
            files,
            updatedBy: 'garden-operator',
          });
          if (!('kind' in result) || result.operation !== 'import_files') {
            throw new Error('Gateway shared-world wiki writer returned an invalid import response');
          }
          assertImportVisible(store, result.report);
          return result.report;
        },
      });
      return { ...report, projection };
    } finally {
      this.invalidateSharedWikiScopeMemo();
    }
  }

  async listSharedWorldWikiProposals(query: SharedWorldWikiProposalListQuery = {}) {
    return this.requireProposalStore().list(query);
  }

  async getSharedWorldWikiProposal(proposalId: string) {
    return this.requireProposalStore().get(proposalId);
  }

  async approveSharedWorldWikiProposal(
    proposalId: string,
    operatorActorId: string,
  ): Promise<SharedWorldWikiProposalApplyResult> {
    const systemDataWriter = this.requireSystemDataWriter();
    const databaseUrl = this.sharedProjectionContext.databaseUrl?.trim();
    const embedding = this.sharedProjectionContext.embedding;
    if (!databaseUrl || !embedding) {
      throw new Error('shared-world wiki caretaker projection dependencies are unavailable');
    }
    const writeSharedDocument = createGatewaySharedWorldWikiDocumentWriter({
      systemDataDir: this.systemDataDir,
      systemDataWriter,
    });
    const projection = await createSharedWikiPgvectorProjectionStore(databaseUrl, embedding, {
      ...(this.sharedProjectionContext.eventBus
        ? { eventBus: this.sharedProjectionContext.eventBus }
        : {}),
    });
    try {
      const caretaker = new SharedWorldWikiCaretakerService({
        proposalStore: this.requireProposalStore(),
        isKnownSite: siteId => this.isKnownSite(siteId),
        openSharedStore: siteId => new SharedWorldWikiStore(this.systemDataDir, siteId),
        writeSharedDocument,
        projection,
      });
      return await caretaker.approve(proposalId, operatorActorId);
    } finally {
      this.invalidateSharedWikiScopeMemo();
      await projection.close();
    }
  }

  async rejectSharedWorldWikiProposal(proposalId: string, operatorActorId: string) {
    return this.requireProposalStore().review({
      proposalId,
      decision: 'reject',
      operatorActorId,
      rejectionCode: 'operator_rejected',
      nowMs: Date.now(),
    });
  }

  async cleanupSharedWorldWikiProposals(limit: number): Promise<SharedWorldWikiCleanupResult> {
    const systemDataWriter = this.requireSystemDataWriter();
    const databaseUrl = this.sharedProjectionContext.databaseUrl?.trim();
    const embedding = this.sharedProjectionContext.embedding;
    if (!databaseUrl || !embedding) {
      throw new Error('shared-world wiki caretaker projection dependencies are unavailable');
    }
    const writeSharedDocument = createGatewaySharedWorldWikiDocumentWriter({
      systemDataDir: this.systemDataDir,
      systemDataWriter,
    });
    const projection = await createSharedWikiPgvectorProjectionStore(databaseUrl, embedding, {
      ...(this.sharedProjectionContext.eventBus
        ? { eventBus: this.sharedProjectionContext.eventBus }
        : {}),
    });
    try {
      const caretaker = new SharedWorldWikiCaretakerService({
        proposalStore: this.requireProposalStore(),
        isKnownSite: siteId => this.isKnownSite(siteId),
        openSharedStore: siteId => new SharedWorldWikiStore(this.systemDataDir, siteId),
        writeSharedDocument,
        projection,
      });
      return await caretaker.cleanupChangedContent(limit);
    } finally {
      await projection.close();
    }
  }
}
