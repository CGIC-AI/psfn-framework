export const FILESYSTEM_READ_PAGE_CONTRACT = Object.freeze({
  minBytes: 1,
  defaultMaxBytes: 100_000,
  maxBytes: 200_000,
  maxOffsetBytes: Number.MAX_SAFE_INTEGER,
});

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
