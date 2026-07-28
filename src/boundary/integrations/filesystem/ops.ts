export type FilesystemSearchMode = 'literal' | 'regex';

export interface FilesystemReadOptions {
  maxBytes?: number;
  offsetBytes?: number;
}

export const FILESYSTEM_DIRECT_READ_CONTRACT = Object.freeze({
  defaultMaxBytes: 20_000,
  maxBytes: 20_000,
  maxOffsetBytes: Number.MAX_SAFE_INTEGER,
});

export function normalizeFilesystemReadOptions(
  options: FilesystemReadOptions = {},
): Required<FilesystemReadOptions> {
  const maxBytes = options.maxBytes ?? FILESYSTEM_DIRECT_READ_CONTRACT.defaultMaxBytes;
  const offsetBytes = options.offsetBytes ?? 0;
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < 1
    || maxBytes > FILESYSTEM_DIRECT_READ_CONTRACT.maxBytes
  ) {
    throw new Error(
      `max_bytes must be a safe integer between 1 and ${String(FILESYSTEM_DIRECT_READ_CONTRACT.maxBytes)}`,
    );
  }
  if (
    !Number.isSafeInteger(offsetBytes)
    || offsetBytes < 0
    || offsetBytes > FILESYSTEM_DIRECT_READ_CONTRACT.maxOffsetBytes
  ) {
    throw new Error(
      `offset_bytes must be a safe integer between 0 and ${String(FILESYSTEM_DIRECT_READ_CONTRACT.maxOffsetBytes)}`,
    );
  }
  return { maxBytes, offsetBytes };
}

export interface FilesystemReadResult {
  content: string;
  offsetBytes: number;
  nextOffsetBytes: number | null;
  eof: boolean;
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
  /** Clock override for the cooperative search time budget (tests only). */
  now?: () => number;
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
