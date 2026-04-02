export type ResearchLibraryEntryKind = 'note' | 'file';

export type ResearchLibrarySourceKind =
  | 'scratchpad'
  | 'workspace_file'
  | 'generated_media'
  | 'direct_text';

export interface ResearchLibraryEntryProvenance {
  sourceKind: ResearchLibrarySourceKind;
  scratchpadEntryId?: string;
  sourcePath?: string;
  sourceUrl?: string;
  note?: string;
  importedBy?: string;
}

export interface ResearchLibraryStoredAsset {
  relativePath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface ResearchLibraryEntryManifest {
  schemaVersion: 1;
  id: string;
  slug: string;
  title: string;
  kind: ResearchLibraryEntryKind;
  importedAt: string;
  asset: ResearchLibraryStoredAsset;
  provenance: ResearchLibraryEntryProvenance;
}

export interface ResearchLibraryEntrySummary {
  id: string;
  title: string;
  kind: ResearchLibraryEntryKind;
  importedAt: string;
  asset: ResearchLibraryStoredAsset;
  provenance: ResearchLibraryEntryProvenance;
}

export interface ResearchLibraryEntryDetail {
  manifest: ResearchLibraryEntryManifest;
  previewText?: string;
  absolutePath: string;
}

export interface ResearchLibraryTextImportInput {
  title: string;
  content: string;
  provenance: ResearchLibraryEntryProvenance;
}

export interface ResearchLibraryFileImportInput {
  path: string;
  title?: string;
  provenance: ResearchLibraryEntryProvenance;
}
