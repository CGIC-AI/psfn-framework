import type {
  WikiDocument,
  WikiDocumentListEntry,
  WikiScope,
  WikiSearchResult,
} from '../../../../faculties/wiki/types.js';
import type { PlacesWikiPublicationReport } from '../../../../faculties/wiki/places-wiki-publication.js';
import type { WikiImportReport } from '../../../../faculties/wiki/bulk-import.js';

export interface AdminWikiListData {
  roots: {
    workspaceRoot: string;
    wikiRoot: string;
    documentsDir: string;
    metadataDir: string;
  };
  documents: WikiDocumentListEntry[];
  boundary: string;
}

/** Summary of one wiki scope available in the admin surface (vinz.28). */
export interface AdminWikiScopeSummary {
  scope: WikiScope;
  /** Present for shared-world scopes; absent for personal. */
  siteId?: string;
  displayName: string;
  documentCount: number;
}

export interface AdminWikiScopesData {
  boundary: string;
  scopes: AdminWikiScopeSummary[];
}

/** Listing for one shared-world site scope (system-data backed, not companion-data). */
export interface AdminSharedWorldWikiListData {
  scope: WikiScope;
  siteId: string;
  roots: {
    wikiRoot: string;
    documentsDir: string;
    metadataDir: string;
  };
  documents: WikiDocumentListEntry[];
  boundary: string;
}

export interface AdminWikiImportRequest {
  directory: string;
  dryRun?: boolean;
}

export interface AdminWikiService {
  listWikiDocuments(): Promise<AdminWikiListData>;
  getWikiDocument(id: string): Promise<WikiDocument | null>;
  searchWikiDocuments(query: { query: string; limit?: number }): Promise<WikiSearchResult>;
  // ── vinz.28: scope delineation (personal vs shared_world:<siteId>) ──
  /** Enumerate every scope the admin surface can filter by (personal + shared-world sites). */
  listWikiScopes(): Promise<AdminWikiScopesData>;
  /** List documents for one shared-world site scope. */
  listSharedWorldWikiDocuments(siteId: string): Promise<AdminSharedWorldWikiListData>;
  /** Read one shared-world document by id. */
  getSharedWorldWikiDocument(siteId: string, id: string): Promise<WikiDocument | null>;
  /** Run the deterministic places→wiki publication for one site (operator surface). */
  publishSharedWorldSite(siteId: string): Promise<PlacesWikiPublicationReport>;
  /** Bulk-import a server-side markdown directory into a site's shared-world scope. */
  importSharedWorldDirectory(siteId: string, request: AdminWikiImportRequest): Promise<WikiImportReport>;
}
