export const FILESYSTEM_READ_PAGE_CONTRACT = Object.freeze({
  minBytes: 1,
  defaultMaxBytes: 100_000,
  maxBytes: 200_000,
  maxOffsetBytes: Number.MAX_SAFE_INTEGER,
});

/** Fixed safety bounds on raw queries, checked before trimming or compilation. */
export const FILESYSTEM_SEARCH_QUERY_CONTRACT = Object.freeze({
  maxChars: 8_192,
  maxUtf8Bytes: 8_192,
});

export function isFilesystemSearchQueryWithinLimit(query: string): boolean {
  // Length is O(1). Only inspect UTF-8 bytes after bounding the work and avoid
  // constructing an encoded Buffer or a trimmed/escaped copy of the query.
  return query.length <= FILESYSTEM_SEARCH_QUERY_CONTRACT.maxChars
    && Buffer.byteLength(query, 'utf8') <= FILESYSTEM_SEARCH_QUERY_CONTRACT.maxUtf8Bytes;
}

export function assertFilesystemSearchQuerySize(query: string): void {
  if (!isFilesystemSearchQueryWithinLimit(query)) {
    throw new Error('fs search query exceeds the supported size limit');
  }
}

export function validateFilesystemReadMaxBytes(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < FILESYSTEM_READ_PAGE_CONTRACT.minBytes
    || value > FILESYSTEM_READ_PAGE_CONTRACT.maxBytes
  ) {
    throw new Error(
      `fsReadMaxBytes must be a safe integer between `
      + `${String(FILESYSTEM_READ_PAGE_CONTRACT.minBytes)} and `
      + `${String(FILESYSTEM_READ_PAGE_CONTRACT.maxBytes)}`,
    );
  }
  return value;
}
