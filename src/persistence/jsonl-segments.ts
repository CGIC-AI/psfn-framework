import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

const NEWLINE_BYTE = 0x0a;

export interface NumberedJsonlSegment {
  segmentNumber: number;
  path: string;
}
export interface JsonlReadStats {
  bytesRead: number;
  readCalls?: number;
  filesRead?: number;
  /** Maximum physical-row bytes retained by one incremental read. */
  maxRetainedLineBytes?: number;
  /** Explicit cooperative yields completed during asynchronous reads. */
  eventLoopYields?: number;
}

export interface JsonlScanOptions {
  chunkBytes: number;
  stats?: JsonlReadStats;
  scannedFileIdentities?: Set<string>;
  /** Fail closed if the opened path no longer names the expected snapshot inode. */
  expectedFileIdentity?: string;
}

export interface AsyncJsonlLineScanOptions extends JsonlScanOptions {
  /** Fail closed before retaining a physical row larger than this limit. */
  maxLineBytes: number;
}

export interface JsonlLineAtOffset {
  line: string;
  startOffset: number;
  endOffset: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function fileIdentityKey(stat: { dev: number | bigint; ino: number | bigint }): string {
  return `${stat.dev}:${stat.ino}`;
}

/**
 * Discover sealed siblings for an active JSONL file using the hgw3 contract:
 * `<stem>.00001.jsonl`, `<stem>.00002.jsonl`, ... Higher numbers are newer.
 * The directory listing is authoritative; there is deliberately no manifest.
 */
export function listNumberedJsonlSegments(activePath: string): NumberedJsonlSegment[] {
  const directory = dirname(activePath);
  if (!existsSync(directory)) return [];
  const activeName = basename(activePath);
  const extension = extname(activeName);
  const stem = activeName.slice(0, -extension.length);
  const pattern = new RegExp(`^${escapeRegExp(stem)}\\.(\\d{5,})${escapeRegExp(extension)}$`);
  const segments: NumberedJsonlSegment[] = [];
  for (const name of readdirSync(directory)) {
    const match = pattern.exec(name);
    if (!match) continue;
    segments.push({
      segmentNumber: Number(match[1]),
      path: join(directory, name),
    });
  }
  return segments;
}
function recordFileRead(stats: JsonlReadStats | undefined): void {
  if (stats?.filesRead !== undefined) stats.filesRead += 1;
}

function recordChunkRead(stats: JsonlReadStats | undefined, bytesRead: number): void {
  if (!stats) return;
  stats.bytesRead += bytesRead;
  if (stats.readCalls !== undefined) stats.readCalls += 1;
}

function recordRetainedLineBytes(stats: JsonlReadStats | undefined, bytes: number): void {
  if (stats?.maxRetainedLineBytes === undefined) return;
  stats.maxRetainedLineBytes = Math.max(stats.maxRetainedLineBytes, bytes);
}

async function recordEventLoopYield(stats: JsonlReadStats | undefined): Promise<void> {
  await yieldToEventLoop();
  if (stats?.eventLoopYields !== undefined) stats.eventLoopYields += 1;
}

function assertPositiveByteLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function oversizedJsonlLineError(
  path: string,
  maxLineBytes: number,
  observedBytes: number,
): NodeJS.ErrnoException {
  const error = new Error(
    `JSONL row in ${path} exceeds the ${maxLineBytes}-byte cursor safety limit `
    + `(observed at least ${observedBytes} bytes); refusing to truncate or retain it`,
  ) as NodeJS.ErrnoException;
  error.code = 'EOVERFLOW';
  return error;
}

function claimFileIdentity(
  fd: number,
  stats: JsonlReadStats | undefined,
  scannedFileIdentities: Set<string> | undefined,
  expectedFileIdentity: string | undefined,
): { claimed: boolean; size: number } {
  const fileStat = fstatSync(fd);
  const identity = fileIdentityKey(fileStat);
  if (
    expectedFileIdentity !== undefined
    && identity !== expectedFileIdentity
  ) {
    const error = new Error(
      `JSONL snapshot identity changed: expected ${expectedFileIdentity}, found ${identity}`,
    ) as NodeJS.ErrnoException;
    error.code = 'ESTALE';
    throw error;
  }
  if (scannedFileIdentities?.has(identity)) {
    return { claimed: false, size: fileStat.size };
  }
  scannedFileIdentities?.add(identity);
  recordFileRead(stats);
  return { claimed: true, size: fileStat.size };
}

/**
 * Scan newline-delimited bytes from newest to oldest. Lines larger than the
 * chunk size and multi-byte UTF-8 text are reassembled before decoding.
 */
export function scanJsonlFileBackward(
  path: string,
  options: JsonlScanOptions & { endOffset?: number },
  onLine: (line: string) => boolean | void,
): boolean {
  const fd = openSync(path, 'r');
  try {
    const claimed = claimFileIdentity(
      fd,
      options.stats,
      options.scannedFileIdentities,
      options.expectedFileIdentity,
    );
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

/**
 * Read the complete JSONL row starting at or after a byte offset. When the
 * offset lands inside a row, that partial row is skipped. The returned end
 * offset is immediately after the row's newline (or EOF).
 */
export function readJsonlLineAtOrAfter(
  path: string,
  offset: number,
  options: JsonlScanOptions,
): JsonlLineAtOffset | null {
  const fd = openSync(path, 'r');
  try {
    const claimed = claimFileIdentity(
      fd,
      options.stats,
      options.scannedFileIdentities,
      options.expectedFileIdentity,
    );
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
          const bytesToRead = Math.min(buffer.length, claimed.size - startOffset);
          const bytesRead = readSync(fd, buffer, 0, bytesToRead, startOffset);
          if (bytesRead <= 0) break;
          recordChunkRead(options.stats, bytesRead);
          for (let index = 0; index < bytesRead; index += 1) {
            if (buffer[index] !== NEWLINE_BYTE) continue;
            startOffset += index + 1;
            foundBoundary = true;
            break;
          }
          if (!foundBoundary) {
            startOffset += bytesRead;
          }
        }
      }
    }
    if (startOffset >= claimed.size) return null;

    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let position = startOffset;
    while (position < claimed.size) {
      const bytesToRead = Math.min(buffer.length, claimed.size - position);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      recordChunkRead(options.stats, bytesRead);
      const newline = buffer.subarray(0, bytesRead).indexOf(NEWLINE_BYTE);
      if (newline >= 0) {
        chunks.push(Buffer.from(buffer.subarray(0, newline)));
        retainedBytes += newline;
        recordRetainedLineBytes(options.stats, retainedBytes);
        return {
          line: Buffer.concat(chunks, retainedBytes).toString('utf8'),
          startOffset,
          endOffset: position + newline + 1,
        };
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      retainedBytes += bytesRead;
      recordRetainedLineBytes(options.stats, retainedBytes);
      position += bytesRead;
    }
    return chunks.length > 0
      ? {
        line: Buffer.concat(chunks, retainedBytes).toString('utf8'),
        startOffset,
        endOffset: claimed.size,
      }
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
    const claimed = claimFileIdentity(
      fd,
      options.stats,
      options.scannedFileIdentities,
      options.expectedFileIdentity,
    );
    let position = Math.min(claimed.size, Math.max(0, Math.floor(exclusiveOffset)));
    if (position <= 0) return null;

    const buffer = Buffer.allocUnsafe(options.chunkBytes);
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let rowEnd = position;
    let ignoredTrailingNewline = false;
    while (position > 0) {
      const bytesToRead = Math.min(buffer.length, position);
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
        const retainedSliceBytes = sliceEnd - index - 1;
        chunks.unshift(Buffer.from(buffer.subarray(index + 1, sliceEnd)));
        retainedBytes += retainedSliceBytes;
        recordRetainedLineBytes(options.stats, retainedBytes);
        return {
          line: Buffer.concat(chunks, retainedBytes).toString('utf8'),
          startOffset: position + index + 1,
          endOffset: rowEnd + (ignoredTrailingNewline ? 1 : 0),
        };
      }
      chunks.unshift(Buffer.from(buffer.subarray(0, sliceEnd)));
      retainedBytes += sliceEnd;
      recordRetainedLineBytes(options.stats, retainedBytes);
      ignoredTrailingNewline = true;
    }

    return chunks.length > 0
      ? {
        line: Buffer.concat(chunks, retainedBytes).toString('utf8'),
        startOffset: 0,
        endOffset: rowEnd + (rowEnd < exclusiveOffset ? 1 : 0),
      }
      : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Asynchronously read the complete row before an exclusive offset.
 *
 * Unlike the legacy synchronous primitive, this path yields between fixed-size
 * reads and fails before retaining more than `maxLineBytes`. It is intended for
 * request-time cursor work where an old-fat physical row must never monopolize
 * the primary event loop or grow the primary heap without bound.
 */
export async function readJsonlLineBeforeAsync(
  path: string,
  exclusiveOffset: number,
  options: AsyncJsonlLineScanOptions,
): Promise<JsonlLineAtOffset | null> {
  assertPositiveByteLimit(options.chunkBytes, 'JSONL scan chunkBytes');
  assertPositiveByteLimit(options.maxLineBytes, 'JSONL scan maxLineBytes');
  const handle = await openFile(path, 'r');
  try {
    const fileStat = await handle.stat();
    const identity = fileIdentityKey(fileStat);
    if (
      options.expectedFileIdentity !== undefined
      && identity !== options.expectedFileIdentity
    ) {
      const error = new Error(
        `JSONL snapshot identity changed: expected ${options.expectedFileIdentity}, found ${identity}`,
      ) as NodeJS.ErrnoException;
      error.code = 'ESTALE';
      throw error;
    }
    if (!options.scannedFileIdentities?.has(identity)) {
      options.scannedFileIdentities?.add(identity);
      recordFileRead(options.stats);
    }
    let position = Math.min(fileStat.size, Math.max(0, Math.floor(exclusiveOffset)));
    if (position <= 0) return null;

    const boundedChunkBytes = Math.min(options.chunkBytes, options.maxLineBytes);
    const buffer = Buffer.allocUnsafe(boundedChunkBytes);
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let rowEnd = position;
    let ignoredTrailingNewline = false;
    while (position > 0) {
      const bytesToRead = Math.min(boundedChunkBytes, position);
      position -= bytesToRead;
      let bytesRead = 0;
      while (bytesRead < bytesToRead) {
        const result = await handle.read(
          buffer,
          bytesRead,
          bytesToRead - bytesRead,
          position + bytesRead,
        );
        if (result.bytesRead <= 0) {
          const error = new Error(
            `JSONL snapshot row became unavailable during a bounded read of ${path}`,
          ) as NodeJS.ErrnoException;
          error.code = 'ESTALE';
          throw error;
        }
        recordChunkRead(options.stats, result.bytesRead);
        bytesRead += result.bytesRead;
      }
      let sliceEnd = bytesRead;
      if (
        !ignoredTrailingNewline
        && position + bytesRead === rowEnd
        && buffer[bytesRead - 1] === NEWLINE_BYTE
      ) {
        sliceEnd -= 1;
        rowEnd -= 1;
        ignoredTrailingNewline = true;
      }
      let sliceStart = 0;
      for (let index = sliceEnd - 1; index >= 0; index -= 1) {
        if (buffer[index] !== NEWLINE_BYTE) continue;
        sliceStart = index + 1;
        break;
      }
      const retainedSliceBytes = sliceEnd - sliceStart;
      if (retainedBytes + retainedSliceBytes > options.maxLineBytes) {
        throw oversizedJsonlLineError(
          path,
          options.maxLineBytes,
          retainedBytes + retainedSliceBytes,
        );
      }
      chunks.unshift(Buffer.from(buffer.subarray(sliceStart, sliceEnd)));
      retainedBytes += retainedSliceBytes;
      recordRetainedLineBytes(options.stats, retainedBytes);
      if (sliceStart > 0) {
        return {
          line: Buffer.concat(chunks, retainedBytes).toString('utf8'),
          startOffset: position + sliceStart,
          endOffset: rowEnd + (ignoredTrailingNewline ? 1 : 0),
        };
      }
      ignoredTrailingNewline = true;
      await recordEventLoopYield(options.stats);
    }

    return chunks.length > 0
      ? {
        line: Buffer.concat(chunks, retainedBytes).toString('utf8'),
        startOffset: 0,
        endOffset: rowEnd + (rowEnd < exclusiveOffset ? 1 : 0),
      }
      : null;
  } finally {
    await handle.close();
  }
}

/**
 * Asynchronously read the complete row starting at or after a byte offset.
 *
 * A partial row at the requested offset is skipped cooperatively, matching
 * `readJsonlLineAtOrAfter`. The returned row is retained only up to
 * `maxLineBytes`; larger rows fail closed before decoding or truncation.
 */
export async function readJsonlLineAtOrAfterAsync(
  path: string,
  offset: number,
  options: AsyncJsonlLineScanOptions,
): Promise<JsonlLineAtOffset | null> {
  assertPositiveByteLimit(options.chunkBytes, 'JSONL scan chunkBytes');
  assertPositiveByteLimit(options.maxLineBytes, 'JSONL scan maxLineBytes');
  const handle = await openFile(path, 'r');
  try {
    const fileStat = await handle.stat();
    const identity = fileIdentityKey(fileStat);
    if (
      options.expectedFileIdentity !== undefined
      && identity !== options.expectedFileIdentity
    ) {
      const error = new Error(
        `JSONL snapshot identity changed: expected ${options.expectedFileIdentity}, found ${identity}`,
      ) as NodeJS.ErrnoException;
      error.code = 'ESTALE';
      throw error;
    }
    if (!options.scannedFileIdentities?.has(identity)) {
      options.scannedFileIdentities?.add(identity);
      recordFileRead(options.stats);
    }
    if (fileStat.size <= 0) return null;

    const boundedChunkBytes = Math.min(options.chunkBytes, options.maxLineBytes);
    const buffer = Buffer.allocUnsafe(boundedChunkBytes);
    let startOffset = Math.min(fileStat.size, Math.max(0, Math.floor(offset)));
    if (startOffset > 0 && startOffset < fileStat.size) {
      const prior = Buffer.allocUnsafe(1);
      const priorRead = await handle.read(prior, 0, 1, startOffset - 1);
      if (priorRead.bytesRead !== 1) {
        const error = new Error(
          `JSONL snapshot row became unavailable during a bounded read of ${path}`,
        ) as NodeJS.ErrnoException;
        error.code = 'ESTALE';
        throw error;
      }
      recordChunkRead(options.stats, priorRead.bytesRead);
      if (prior[0] !== NEWLINE_BYTE) {
        let foundBoundary = false;
        let skippedPartialRowBytes = 0;
        while (startOffset < fileStat.size && !foundBoundary) {
          const bytesToRead = Math.min(boundedChunkBytes, fileStat.size - startOffset);
          const result = await handle.read(buffer, 0, bytesToRead, startOffset);
          if (result.bytesRead !== bytesToRead) {
            const error = new Error(
              `JSONL snapshot row became unavailable during a bounded read of ${path}`,
            ) as NodeJS.ErrnoException;
            error.code = 'ESTALE';
            throw error;
          }
          recordChunkRead(options.stats, result.bytesRead);
          const newline = buffer.subarray(0, result.bytesRead).indexOf(NEWLINE_BYTE);
          if (newline >= 0) {
            if (skippedPartialRowBytes + newline > options.maxLineBytes) {
              throw oversizedJsonlLineError(
                path,
                options.maxLineBytes,
                skippedPartialRowBytes + newline,
              );
            }
            startOffset += newline + 1;
            foundBoundary = true;
          } else {
            skippedPartialRowBytes += result.bytesRead;
            if (skippedPartialRowBytes > options.maxLineBytes) {
              throw oversizedJsonlLineError(
                path,
                options.maxLineBytes,
                skippedPartialRowBytes,
              );
            }
            startOffset += result.bytesRead;
          }
          await recordEventLoopYield(options.stats);
        }
      }
    }
    if (startOffset >= fileStat.size) return null;

    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let position = startOffset;
    while (position < fileStat.size) {
      const bytesToRead = Math.min(boundedChunkBytes, fileStat.size - position);
      const result = await handle.read(buffer, 0, bytesToRead, position);
      if (result.bytesRead !== bytesToRead) {
        const error = new Error(
          `JSONL snapshot row became unavailable during a bounded read of ${path}`,
        ) as NodeJS.ErrnoException;
        error.code = 'ESTALE';
        throw error;
      }
      recordChunkRead(options.stats, result.bytesRead);
      const newline = buffer.subarray(0, result.bytesRead).indexOf(NEWLINE_BYTE);
      const retainedSliceBytes = newline >= 0 ? newline : result.bytesRead;
      if (retainedBytes + retainedSliceBytes > options.maxLineBytes) {
        throw oversizedJsonlLineError(
          path,
          options.maxLineBytes,
          retainedBytes + retainedSliceBytes,
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, retainedSliceBytes)));
      retainedBytes += retainedSliceBytes;
      recordRetainedLineBytes(options.stats, retainedBytes);
      if (newline >= 0) {
        return {
          line: Buffer.concat(chunks, retainedBytes).toString('utf8'),
          startOffset,
          endOffset: position + newline + 1,
        };
      }
      position += result.bytesRead;
      await recordEventLoopYield(options.stats);
    }
    return chunks.length > 0
      ? {
        line: Buffer.concat(chunks, retainedBytes).toString('utf8'),
        startOffset,
        endOffset: fileStat.size,
      }
      : null;
  } finally {
    await handle.close();
  }
}
