import type { SensitivityLevel } from '../../system/trust/types.js';

export const WIKI_SOURCE_CLASSES = [
  'companion_authored_note',
  'operator_authored_note',
  'imported_partner_vault_note',
  'parsed_document',
  'generated_synthesis',
  'external_reference',
  'system_seed',
] as const;

export type WikiSourceClass = typeof WIKI_SOURCE_CLASSES[number];

export const WIKI_BODY_FORMATS = ['markdown'] as const;
export type WikiBodyFormat = typeof WIKI_BODY_FORMATS[number];

export interface WikiDocumentMetadata {
  schemaVersion: 1;
  id: string;
  title: string;
  bodyPath: string;
  bodyFormat: WikiBodyFormat;
  tags: string[];
  sourceClass: WikiSourceClass;
  provenanceRefs: string[];
  sensitivity: SensitivityLevel;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
  bodySha256: string;
}

export interface WikiDocument extends WikiDocumentMetadata {
  body: string;
}

export interface WikiDocumentListEntry extends WikiDocumentMetadata {
  preview: string;
  bodyCharCount: number;
}

export interface WikiDocumentUpsertInput {
  id?: string;
  title: string;
  body: string;
  tags?: readonly string[] | string;
  sourceClass?: WikiSourceClass;
  provenanceRefs?: readonly string[] | string;
  sensitivity?: SensitivityLevel;
  summary?: string;
  updatedBy?: string;
}

export interface WikiSearchInput {
  query: string;
  limit?: number;
}

export interface WikiSearchMatch {
  id: string;
  title: string;
  sourceClass: WikiSourceClass;
  sensitivity: SensitivityLevel;
  path: string;
  preview: string;
}

export interface WikiSearchResult {
  query: string;
  count: number;
  matches: WikiSearchMatch[];
}

export interface WikiStorePort {
  getRootInfo(): {
    workspaceRoot: string;
    wikiRoot: string;
    documentsDir: string;
    metadataDir: string;
  };
  list(): WikiDocumentListEntry[];
  get(id: string): WikiDocument | null;
  upsert(input: WikiDocumentUpsertInput): WikiDocument;
  search(input: WikiSearchInput): WikiSearchResult;
}
