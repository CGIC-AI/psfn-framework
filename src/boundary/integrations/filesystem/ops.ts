export type FilesystemSearchMode = 'literal' | 'regex';

export interface FilesystemReadOptions {
  maxBytes?: number;
}

export interface FilesystemReadResult {
  content: string;
  truncated: boolean;
}

export interface FilesystemListOptions {
  path?: string;
  maxScannedEntries?: number;
}

export interface FilesystemListResult {
  paths: string[];
  scannedEntries: number;
  maxEntries: number;
  maxScannedEntries: number;
  truncated: boolean;
  scanLimitReached: boolean;
  entryLimitReached: boolean;
}

export interface FilesystemSearchOptions {
  query: string;
  glob?: string;
  mode?: FilesystemSearchMode;
  maxMatches?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
  contextLines?: number;
}

export interface FilesystemSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface FilesystemSearchResult {
  query: string;
  glob: string;
  mode: FilesystemSearchMode;
  scannedFiles: number;
  hitLimit: boolean;
  truncatedFiles: string[];
  matches: FilesystemSearchMatch[];
}

export interface FilesystemWriteOptions {
  path: string;
  content: string;
  overwrite?: boolean;
}

export interface FilesystemWriteResult {
  path: string;
  status: 'created' | 'overwritten' | 'unchanged';
  bytesWritten: number;
}

export interface FilesystemEditOptions {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface FilesystemEditResult {
  path: string;
  replacements: number;
}

export interface FilesystemOperations {
  read(path: string, options?: FilesystemReadOptions): Promise<FilesystemReadResult>;
  list(glob?: string, maxEntries?: number, options?: FilesystemListOptions): Promise<FilesystemListResult>;
  search(options: FilesystemSearchOptions): Promise<FilesystemSearchResult>;
  write(options: FilesystemWriteOptions): Promise<FilesystemWriteResult>;
  edit(options: FilesystemEditOptions): Promise<FilesystemEditResult>;
}
