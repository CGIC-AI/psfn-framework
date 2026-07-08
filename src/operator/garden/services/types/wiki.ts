import type {
  WikiDocument,
  WikiDocumentListEntry,
  WikiSearchResult,
} from '../../../../faculties/wiki/types.js';

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

export interface AdminWikiService {
  listWikiDocuments(): Promise<AdminWikiListData>;
  getWikiDocument(id: string): Promise<WikiDocument | null>;
  searchWikiDocuments(query: { query: string; limit?: number }): Promise<WikiSearchResult>;
}
