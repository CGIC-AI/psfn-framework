import { apiGet } from '$lib/api/client';
import type {
  WikiDocument,
  WikiDocumentListEntry,
  WikiSearchResult,
} from '../../../../../src/faculties/wiki/types.js';

export interface WikiListResponse {
  roots: {
    workspaceRoot: string;
    wikiRoot: string;
    documentsDir: string;
    metadataDir: string;
  };
  documents: WikiDocumentListEntry[];
  boundary: string;
}

export interface WikiScopeSummary {
  scope: string;
  siteId?: string;
  displayName: string;
  documentCount: number;
}

export interface WikiScopesResponse {
  boundary: string;
  scopes: WikiScopeSummary[];
}

export interface SharedWorldWikiListResponse {
  scope: string;
  siteId: string;
  roots: {
    wikiRoot: string;
    documentsDir: string;
    metadataDir: string;
  };
  documents: WikiDocumentListEntry[];
  boundary: string;
}

export function listWikiDocuments(): Promise<WikiListResponse> {
  return apiGet<WikiListResponse>('/api/admin/wiki');
}

export function listWikiScopes(): Promise<WikiScopesResponse> {
  return apiGet<WikiScopesResponse>('/api/admin/wiki/scopes');
}

export function listSharedWorldWikiDocuments(siteId: string): Promise<SharedWorldWikiListResponse> {
  return apiGet<SharedWorldWikiListResponse>(`/api/admin/wiki/shared-world/${encodeURIComponent(siteId)}`);
}

export function getSharedWorldWikiDocument(siteId: string, id: string): Promise<WikiDocument> {
  return apiGet<WikiDocument>(
    `/api/admin/wiki/shared-world/${encodeURIComponent(siteId)}?id=${encodeURIComponent(id)}`,
  );
}

export function getWikiDocument(id: string): Promise<WikiDocument> {
  return apiGet<WikiDocument>(`/api/admin/wiki/${encodeURIComponent(id)}`);
}

export function searchWikiDocuments(query: string, limit = 20): Promise<WikiSearchResult> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
  });
  return apiGet<WikiSearchResult>(`/api/admin/wiki/search?${params.toString()}`);
}
