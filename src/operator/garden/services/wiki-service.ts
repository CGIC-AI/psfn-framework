import { existsSync, readdirSync } from 'node:fs';
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
import {
  publishSiteWiki,
  type PlacesWikiPublicationReport,
} from '../../../faculties/wiki/places-wiki-publication.js';
import {
  importMarkdownDirectory,
  type WikiImportReport,
} from '../../../faculties/wiki/bulk-import.js';
import {
  loadPlacesRegistryConfig,
  resolveSiteById,
} from '../../../channels/backplane/places-registry.js';
import {
  resolveSharedWorldWikiDir,
  resolveSharedWorldWikiSiteDir,
} from '../../../persistence/layout.js';
import type {
  AdminSharedWorldWikiListData,
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
}

/** Resolve every scope tag explicitly so the admin surface can show/filter it. */
function withResolvedScope(entries: WikiDocumentListEntry[]): WikiDocumentListEntry[] {
  return entries.map(entry => ({ ...entry, scope: resolveWikiScope(entry.scope) }));
}

export class AdminWikiDataService implements AdminWikiService {
  private readonly personalStore: WikiStore;
  private readonly systemDataDir: string;

  constructor(options: AdminWikiDataServiceOptions) {
    this.personalStore = new WikiStore(options.workspacePath);
    this.systemDataDir = options.systemDataDir;
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
    // Union of registry sites and any site subtree already on disk, so an
    // imported/published site surfaces even if its registry entry was removed.
    const siteIds = new Set<string>(registry.sites.map(site => site.siteId));
    const sitesRoot = join(resolveSharedWorldWikiDir(this.systemDataDir), 'sites');
    if (existsSync(sitesRoot)) {
      for (const name of readdirSync(sitesRoot)) siteIds.add(name);
    }
    for (const siteId of [...siteIds].sort((a, b) => a.localeCompare(b))) {
      const site = resolveSiteById(registry, siteId);
      let documentCount = 0;
      try {
        documentCount = new SharedWorldWikiStore(this.systemDataDir, siteId).list().length;
      } catch {
        continue; // Invalid siteId token on disk — skip rather than fail the surface.
      }
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

  async publishSharedWorldSite(siteId: string): Promise<PlacesWikiPublicationReport> {
    const registry = loadPlacesRegistryConfig(this.systemDataDir);
    if (!resolveSiteById(registry, siteId)) {
      throw new Error(`unknown siteId "${siteId}" — not present in places.json sites (fail closed)`);
    }
    const store = new SharedWorldWikiStore(this.systemDataDir, siteId);
    return publishSiteWiki(store, registry, siteId, { updatedBy: 'garden-operator' });
  }

  async importSharedWorldDirectory(
    siteId: string,
    request: AdminWikiImportRequest,
  ): Promise<WikiImportReport> {
    const directory = request.directory.trim();
    if (!directory) throw new Error('directory is required for shared-world import');
    const registry = loadPlacesRegistryConfig(this.systemDataDir);
    if (!resolveSiteById(registry, siteId)) {
      throw new Error(`unknown siteId "${siteId}" — not present in places.json sites (fail closed)`);
    }
    // Touch the resolver so a malformed siteId fails closed before any FS read.
    resolveSharedWorldWikiSiteDir(this.systemDataDir, siteId);
    const store = new SharedWorldWikiStore(this.systemDataDir, siteId);
    return importMarkdownDirectory({
      directory,
      store,
      scope: store.scope,
      personalFactGuard: true,
      updatedBy: 'garden-operator',
      dryRun: request.dryRun === true,
    });
  }
}
