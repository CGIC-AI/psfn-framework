import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';

const NEWLINE_BYTE = 0x0a;

export interface JsonlReadStats {
  bytesRead: number;
  readCalls?: number;
  filesRead?: number;
}

export interface JsonlScanOptions {
  chunkBytes: number;
  stats?: JsonlReadStats;
  scannedFileIdentities?: Set<string>;
}

export interface JsonlLineAtOffset {
  line: string;
  startOffset: number;
  endOffset: number;
}

function recordFileRead(stats: JsonlReadStats | undefined): void {
  if (stats?.filesRead !== undefined) stats.filesRead += 1;
}

function recordChunkRead(stats: JsonlReadStats | undefined, bytesRead: number): void {
  if (!stats) return;
  stats.bytesRead += bytesRead;
  if (stats.readCalls !== undefined) stats.readCalls += 1;
}

function claimFile(
  fd: number,
  stats: JsonlReadStats | undefined,
  scannedFileIdentities: Set<string> | undefined,
): { claimed: boolean; size: number } {
  const fileStat = fstatSync(fd);
  const identity = `${fileStat.dev}:${fileStat.ino}`;
  if (scannedFileIdentities?.has(identity)) {
    return { claimed: false, size: fileStat.size };
  }
  scannedFileIdentities?.add(identity);
  recordFileRead(stats);
  return { claimed: true, size: fileStat.size };
}

/** Scan newline-delimited bytes from newest to oldest. */
export function scanJsonlFileBackward(
  path: string,
  options: JsonlScanOptions & { endOffset?: number },
  onLine: (line: string) => boolean | void,
): boolean {
  const fd = openSync(path, 'r');
  try {
    const claimed = claimFile(fd, options.stats, options.scannedFileIdentities);
    if (!claimed.claimed || claimed.size <= 0) return false;

    const buffer = Buffer.allocUnsafe(options.chunkBytes);
    let position = Math.min(claimed.size, Math.max(0, options.endOffset ?? claimed.size));
    let remainder = Buffer.alloc(0);

    while (position > 0) {
      const bytesToRead = Math.min(options.chunkBytes, position);
      position -= bytesToRead;
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      recordChunkRead(options.stats, bytesRead);

      const combined = Buffer.concat([buffer.subarray(0, bytesRead), remainder]);
      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== NEWLINE_BYTE) continue;
        if (onLine(combined.subarray(index + 1, lineEnd).toString('utf8'))) return true;
        lineEnd = index;
      }
      remainder = combined.subarray(0, lineEnd);
    }

    return remainder.length > 0 ? Boolean(onLine(remainder.toString('utf8'))) : false;
  } finally {
    closeSync(fd);
  }
}

/** Read the complete JSONL row starting at or after a byte offset. */
export function readJsonlLineAtOrAfter(
  path: string,
  offset: number,
  options: JsonlScanOptions,
): JsonlLineAtOffset | null {
  const fd = openSync(path, 'r');
  try {
    const claimed = claimFile(fd, options.stats, options.scannedFileIdentities);
    if (claimed.size <= 0) return null;

    const buffer = Buffer.allocUnsafe(options.chunkBytes);
    let startOffset = Math.min(claimed.size, Math.max(0, Math.floor(offset)));
    if (startOffset > 0 && startOffset < claimed.size) {
      const prior = Buffer.allocUnsafe(1);
      const priorBytes = readSync(fd, prior, 0, 1, startOffset - 1);
      recordChunkRead(options.stats, priorBytes);
      if (priorBytes > 0 && prior[0] !== NEWLINE_BYTE) {
        let foundBoundary = false;
        while (startOffset < claimed.size && !foundBoundary) {
          const bytesToRead = Math.min(options.chunkBytes, claimed.size - startOffset);
          const bytesRead = readSync(fd, buffer, 0, bytesToRead, startOffset);
          if (bytesRead <= 0) break;
          recordChunkRead(options.stats, bytesRead);
          for (let index = 0; index < bytesRead; index += 1) {
            if (buffer[index] !== NEWLINE_BYTE) continue;
            startOffset += index + 1;
            foundBoundary = true;
            break;
          }
          if (!foundBoundary) startOffset += bytesRead;
        }
      }
    }
    if (startOffset >= claimed.size) return null;

    const chunks: Buffer[] = [];
    let position = startOffset;
    while (position < claimed.size) {
      const bytesToRead = Math.min(options.chunkBytes, claimed.size - position);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      recordChunkRead(options.stats, bytesRead);
      const newline = buffer.subarray(0, bytesRead).indexOf(NEWLINE_BYTE);
      if (newline >= 0) {
        chunks.push(Buffer.from(buffer.subarray(0, newline)));
        return {
          line: Buffer.concat(chunks).toString('utf8'),
          startOffset,
          endOffset: position + newline + 1,
        };
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      position += bytesRead;
    }
    return chunks.length > 0
      ? { line: Buffer.concat(chunks).toString('utf8'), startOffset, endOffset: claimed.size }
      : null;
  } finally {
    closeSync(fd);
  }
}

/** Read the complete JSONL row immediately preceding an exclusive byte offset. */
export function readJsonlLineBefore(
  path: string,
  exclusiveOffset: number,
  options: JsonlScanOptions,
): JsonlLineAtOffset | null {
  const fd = openSync(path, 'r');
  try {
    const claimed = claimFile(fd, options.stats, options.scannedFileIdentities);
    let position = Math.min(claimed.size, Math.max(0, Math.floor(exclusiveOffset)));
    if (position <= 0) return null;

    const buffer = Buffer.allocUnsafe(options.chunkBytes);
    const chunks: Buffer[] = [];
    let rowEnd = position;
    let ignoredTrailingNewline = false;
    while (position > 0) {
      const bytesToRead = Math.min(options.chunkBytes, position);
      position -= bytesToRead;
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      recordChunkRead(options.stats, bytesRead);
      let sliceEnd = bytesRead;
      if (!ignoredTrailingNewline && position + bytesRead === rowEnd && buffer[bytesRead - 1] === NEWLINE_BYTE) {
        sliceEnd -= 1;
        rowEnd -= 1;
        ignoredTrailingNewline = true;
      }
      for (let index = sliceEnd - 1; index >= 0; index -= 1) {
        if (buffer[index] !== NEWLINE_BYTE) continue;
        chunks.unshift(Buffer.from(buffer.subarray(index + 1, sliceEnd)));
        return {
          line: Buffer.concat(chunks).toString('utf8'),
          startOffset: position + index + 1,
          endOffset: rowEnd + (ignoredTrailingNewline ? 1 : 0),
        };
      }
      chunks.unshift(Buffer.from(buffer.subarray(0, sliceEnd)));
      ignoredTrailingNewline = true;
    }

    return chunks.length > 0
      ? {
        line: Buffer.concat(chunks).toString('utf8'),
        startOffset: 0,
        endOffset: rowEnd + (rowEnd < exclusiveOffset ? 1 : 0),
      }
      : null;
  } finally {
    closeSync(fd);
  }
}
