import { FILESYSTEM_READ_PAGE_CONTRACT } from '../../../shared/contracts/filesystem.js';

export type FilesystemSearchMode = 'literal' | 'regex';

export interface FilesystemReadOptions {
  maxBytes?: number;
  offsetBytes?: number;
}

export function normalizeFilesystemReadOptions(
  options: FilesystemReadOptions = {},
): Required<FilesystemReadOptions> {
  const maxBytes = options.maxBytes ?? FILESYSTEM_READ_PAGE_CONTRACT.defaultMaxBytes;
  const offsetBytes = options.offsetBytes ?? 0;
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < FILESYSTEM_READ_PAGE_CONTRACT.minBytes
    || maxBytes > FILESYSTEM_READ_PAGE_CONTRACT.maxBytes
  ) {
    throw new Error(
      `max_bytes must be a safe integer between `
      + `${String(FILESYSTEM_READ_PAGE_CONTRACT.minBytes)} and `
      + `${String(FILESYSTEM_READ_PAGE_CONTRACT.maxBytes)}`,
    );
  }
  if (
    !Number.isSafeInteger(offsetBytes)
    || offsetBytes < 0
    || offsetBytes > FILESYSTEM_READ_PAGE_CONTRACT.maxOffsetBytes
  ) {
    throw new Error(
      `offset_bytes must be a safe integer between 0 and `
      + `${String(FILESYSTEM_READ_PAGE_CONTRACT.maxOffsetBytes)}`,
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
  /**
   * Optional batched read-seam guard. Called once with every bounded candidate
   * before opening/reading; false omits the corresponding file without letting its
   * bytes or match count influence the result.
   */
  screenFileReads?: (candidates: readonly {
    absolutePath: string;
    relativePath: string;
    /** Device/inode identity captured before screening and verified on the opened handle. */
    physicalIdentity: string;
  }[]) => {
    readable: readonly boolean[];
    /** Cheap revision check against quarantine decisions made after screening. */
    revisionIsCurrent: () => boolean;
  };
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
