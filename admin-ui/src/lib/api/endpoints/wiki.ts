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

export function listWikiDocuments(): Promise<WikiListResponse> {
  return apiGet<WikiListResponse>('/api/admin/wiki');
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
