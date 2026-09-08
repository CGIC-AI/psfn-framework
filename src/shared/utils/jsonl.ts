import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

const NEWLINE_BYTE = 0x0a;

// Code fallbacks for the settings.json ledgerRead* keys. config/settings.seed.json
// carries the canonical owner-file values and backfills settings.json, so these
// only apply to direct programmatic construction (tests, tools).
const DEFAULT_JSONL_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_JSONL_READ_MAX_ROW_BYTES = 4 * 1024 * 1024;
const DEFAULT_JSONL_READ_YIELD_ROWS = 512;

const ensuredAppendDirectories = new Set<string>();

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function ensureAppendDirectory(directory: string): void {
  if (ensuredAppendDirectories.has(directory)) return;
  mkdirSync(directory, { recursive: true });
  ensuredAppendDirectories.add(directory);
}

/**
 * Append a single JSON object as one line to a JSONL file, creating the parent
 * directory if necessary. This lives in shared/utils so the telemetry ledgers
 * in shared/ can persist without importing upward into persistence/.
 */
export function appendJsonLine(path: string, entry: unknown): void {
  const directory = dirname(path);
  ensureAppendDirectory(directory);
  const serialized = `${JSON.stringify(entry)}\n`;
  try {
    appendFileSync(path, serialized, 'utf-8');
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    ensuredAppendDirectories.delete(directory);
    ensureAppendDirectory(directory);
    appendFileSync(path, serialized, 'utf-8');
  }
}

export interface ReadJsonLineContext {
  path: string;
  line: number;
  rawLine: string;
}

export interface ReadJsonLineErrorContext extends ReadJsonLineContext {
  error: unknown;
}

/**
 * Bounded append-only JSONL hydration (psfn-framework-z3e2x).
 *
 * `readJsonLines` above materializes the whole file as one string and then as
 * one array of physical rows before any caller limit applies, so a multi-
 * megabyte ledger both blocks the primary event loop and retains O(file)
 * bytes. The streaming readers below never retain more than one chunk plus one
 * physical row, fail closed on an oversized row instead of truncating it, and
 * (in the asynchronous form) yield cooperatively so timers and admin work keep
 * advancing. Callers decide what to retain, so retained bytes are bounded by
 * the caller's own window/top-K policy rather than by file growth.
 */
export interface JsonLinesReadLimits {
  /** Bytes read per `read(2)`; also the transient buffer bound. */
  chunkBytes: number;
  /** Fail closed rather than retain or truncate a physical row above this. */
  maxRowBytes: number;
  /** Cooperative yield cadence, in physical rows, for the async reader. */
  yieldRows: number;
}

export interface JsonLinesReadStats {
  bytesRead: number;
  rowsScanned: number;
  /** Largest physical row retained by the reader during this scan. */
  peakRowBytes: number;
  eventLoopYields: number;
}

export interface JsonLinesScanResult {
  /** True when the visitor asked to stop before the snapshot end. */
  stopped: boolean;
  /** Byte offset immediately after the last consumed row: an explicit continuation cursor. */
  nextOffsetBytes: number;
  /** True when the scan consumed the whole snapshot. */
  endOfSnapshot: boolean;
  stats: JsonLinesReadStats;
}

export interface JsonLinesScanOptions {
  /** Resume from a cursor returned by a previous bounded scan. */
  startOffsetBytes?: number;
  /**
   * Called for a row that is not valid JSON. Absent means fail closed: the
   * parse error propagates instead of being counted and skipped.
   */
  onParseError?: (context: ReadJsonLineErrorContext) => void;
  stats?: JsonLinesReadStats;
}

/** Return `true` from a row visitor to stop the scan at that row. */
export type JsonLinesRowVisitor = (
  parsed: unknown,
  context: ReadJsonLineContext,
) => boolean | void;

/**
 * Code fallback for the `ledgerRead*` settings keys. `config/settings.seed.json`
 * carries the canonical owner-file defaults and backfills settings.json, so
 * these values only apply to direct programmatic construction.
 */
const DEFAULT_JSONL_READ_LIMITS: JsonLinesReadLimits = Object.freeze({
  chunkBytes: DEFAULT_JSONL_READ_CHUNK_BYTES,
  maxRowBytes: DEFAULT_JSONL_READ_MAX_ROW_BYTES,
  yieldRows: DEFAULT_JSONL_READ_YIELD_ROWS,
});

export interface JsonLinesReadLimitSettings {
  ledgerReadChunkBytes?: number;
  ledgerReadMaxRowBytes?: number;
  ledgerReadYieldRows?: number;
}

/** Resolve owner-file bounded-read limits, falling back to the seeded defaults. */
export function resolveJsonLinesReadLimits(
  settings: JsonLinesReadLimitSettings | null | undefined,
): JsonLinesReadLimits {
  const limits: JsonLinesReadLimits = {
    chunkBytes: settings?.ledgerReadChunkBytes ?? DEFAULT_JSONL_READ_LIMITS.chunkBytes,
    maxRowBytes: settings?.ledgerReadMaxRowBytes ?? DEFAULT_JSONL_READ_LIMITS.maxRowBytes,
    yieldRows: settings?.ledgerReadYieldRows ?? DEFAULT_JSONL_READ_LIMITS.yieldRows,
  };
  assertReadLimits(limits);
  return limits;
}

export function createJsonLinesReadStats(): JsonLinesReadStats {
  return { bytesRead: 0, rowsScanned: 0, peakRowBytes: 0, eventLoopYields: 0 };
}

function assertReadLimits(limits: JsonLinesReadLimits): void {
  for (const [label, value] of [
    ['chunkBytes', limits.chunkBytes],
    ['maxRowBytes', limits.maxRowBytes],
    ['yieldRows', limits.yieldRows],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`JSONL bounded read ${label} must be a positive safe integer`);
    }
  }
  if (limits.maxRowBytes < limits.chunkBytes) {
    throw new Error('JSONL bounded read maxRowBytes must be at least chunkBytes');
  }
}

function oversizedRowError(path: string, maxRowBytes: number, observedBytes: number): Error {
  const error = new Error(
    `Append-only JSONL row in ${path} exceeds the ${String(maxRowBytes)}-byte hydration limit `
    + `(observed at least ${String(observedBytes)} bytes); refusing to retain or truncate it`,
  ) as NodeJS.ErrnoException;
  error.code = 'EOVERFLOW';
  return error;
}

function staleSnapshotError(path: string, detail: string): Error {
  const error = new Error(
    `Append-only JSONL snapshot for ${path} changed during hydration: ${detail}`,
  ) as NodeJS.ErrnoException;
  error.code = 'ESTALE';
  return error;
}

/**
 * An append-only snapshot may grow under the reader, but replacement or
 * truncation invalidates every offset already consumed and fails closed.
 */
function assertSnapshotUnchanged(
  path: string,
  identity: string,
  snapshotSize: number,
  closing: { dev: bigint; ino: bigint; size: bigint },
): void {
  if (`${String(closing.dev)}:${String(closing.ino)}` !== identity) {
    throw staleSnapshotError(path, 'the file was replaced');
  }
  if (Number(closing.size) < snapshotSize) {
    throw staleSnapshotError(path, 'the append-only file shrank');
  }
}

interface ScanCursor {
  lineNumber: number;
  offset: number;
  remainder: Buffer;
  rowsSinceYield: number;
  stopped: boolean;
}

/**
 * Feed one decoded physical row to the visitor. Returns true when the visitor
 * asked to stop. Parse failures fail closed unless the caller supplied an
 * explicit `onParseError` sink.
 */
function consumeRow(
  path: string,
  rawLine: string,
  cursor: ScanCursor,
  onRow: JsonLinesRowVisitor,
  options: JsonLinesScanOptions,
  stats: JsonLinesReadStats,
): boolean {
  cursor.lineNumber += 1;
  stats.rowsScanned += 1;
  stats.peakRowBytes = Math.max(stats.peakRowBytes, Buffer.byteLength(rawLine, 'utf8'));
  const line = rawLine.trim();
  if (line.length === 0) return false;
  const context: ReadJsonLineContext = { path, line: cursor.lineNumber, rawLine };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    if (!options.onParseError) throw error;
    options.onParseError({ ...context, error });
    return false;
  }
  return onRow(parsed, context) === true;
}

/**
 * Stream an append-only JSONL file forward without materializing it.
 *
 * The snapshot is pinned by size and inode identity at open time: growth by
 * concurrent appends is expected and ignored, while truncation or replacement
 * fails closed with `ESTALE`.
 */
export async function streamJsonLines(
  path: string,
  limits: JsonLinesReadLimits,
  onRow: JsonLinesRowVisitor,
  options: JsonLinesScanOptions = {},
): Promise<JsonLinesScanResult> {
  assertReadLimits(limits);
  const stats = options.stats ?? createJsonLinesReadStats();
  if (!existsSync(path)) {
    return { stopped: false, nextOffsetBytes: 0, endOfSnapshot: true, stats };
  }
  const handle = await openFile(path, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    const identity = `${String(opened.dev)}:${String(opened.ino)}`;
    const snapshotSize = Number(opened.size);
    const cursor: ScanCursor = {
      lineNumber: 0,
      offset: Math.min(Math.max(options.startOffsetBytes ?? 0, 0), snapshotSize),
      remainder: Buffer.alloc(0),
      rowsSinceYield: 0,
      stopped: false,
    };
    let consumedOffset = cursor.offset;
    const buffer = Buffer.allocUnsafe(limits.chunkBytes);

    while (!cursor.stopped && cursor.offset < snapshotSize) {
      const bytesToRead = Math.min(limits.chunkBytes, snapshotSize - cursor.offset);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, cursor.offset);
      if (bytesRead <= 0) break;
      stats.bytesRead += bytesRead;
      cursor.offset += bytesRead;
      let scanFrom = 0;
      const combined = cursor.remainder.length > 0
        ? Buffer.concat([cursor.remainder, buffer.subarray(0, bytesRead)])
        : Buffer.from(buffer.subarray(0, bytesRead));
      const remainderBase = consumedOffset;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== NEWLINE_BYTE) continue;
        const rawLine = combined.subarray(scanFrom, index).toString('utf8');
        scanFrom = index + 1;
        consumedOffset = remainderBase + scanFrom;
        cursor.rowsSinceYield += 1;
        if (consumeRow(path, rawLine, cursor, onRow, options, stats)) {
          cursor.stopped = true;
          break;
        }
        if (cursor.rowsSinceYield >= limits.yieldRows) {
          cursor.rowsSinceYield = 0;
          await yieldToEventLoop();
          stats.eventLoopYields += 1;
        }
      }
      cursor.remainder = cursor.stopped
        ? Buffer.alloc(0)
        : Buffer.from(combined.subarray(scanFrom));
      if (cursor.remainder.length > limits.maxRowBytes) {
        throw oversizedRowError(path, limits.maxRowBytes, cursor.remainder.length);
      }
    }

    // Validate the pinned snapshot before decoding the trailing partial row:
    // a concurrent truncation must fail closed as ESTALE rather than surface as
    // a spurious parse error on a row the reader only half read.
    assertSnapshotUnchanged(path, identity, snapshotSize, await handle.stat({ bigint: true }));

    if (!cursor.stopped && cursor.remainder.length > 0) {
      const rawLine = cursor.remainder.toString('utf8');
      const stop = consumeRow(path, rawLine, cursor, onRow, options, stats);
      consumedOffset += cursor.remainder.length;
      cursor.stopped = stop;
      cursor.remainder = Buffer.alloc(0);
    }

    return {
      stopped: cursor.stopped,
      nextOffsetBytes: consumedOffset,
      endOfSnapshot: !cursor.stopped && consumedOffset >= snapshotSize,
      stats,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Synchronous form for the few call sites whose surrounding contract cannot
 * become asynchronous. It keeps the retained-byte bound and the fail-closed
 * oversized-row behaviour, but cannot yield: prefer `streamJsonLines`.
 */
export function streamJsonLinesSync(
  path: string,
  limits: JsonLinesReadLimits,
  onRow: JsonLinesRowVisitor,
  options: JsonLinesScanOptions = {},
): JsonLinesScanResult {
  assertReadLimits(limits);
  const stats = options.stats ?? createJsonLinesReadStats();
  if (!existsSync(path)) {
    return { stopped: false, nextOffsetBytes: 0, endOfSnapshot: true, stats };
  }
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    const identity = `${String(opened.dev)}:${String(opened.ino)}`;
    const snapshotSize = Number(opened.size);
    const cursor: ScanCursor = {
      lineNumber: 0,
      offset: Math.min(Math.max(options.startOffsetBytes ?? 0, 0), snapshotSize),
      remainder: Buffer.alloc(0),
      rowsSinceYield: 0,
      stopped: false,
    };
    let consumedOffset = cursor.offset;
    const buffer = Buffer.allocUnsafe(limits.chunkBytes);

    while (!cursor.stopped && cursor.offset < snapshotSize) {
      const bytesToRead = Math.min(limits.chunkBytes, snapshotSize - cursor.offset);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, cursor.offset);
      if (bytesRead <= 0) break;
      stats.bytesRead += bytesRead;
      cursor.offset += bytesRead;
      let scanFrom = 0;
      const combined = cursor.remainder.length > 0
        ? Buffer.concat([cursor.remainder, buffer.subarray(0, bytesRead)])
        : Buffer.from(buffer.subarray(0, bytesRead));
      const remainderBase = consumedOffset;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== NEWLINE_BYTE) continue;
        const rawLine = combined.subarray(scanFrom, index).toString('utf8');
        scanFrom = index + 1;
        consumedOffset = remainderBase + scanFrom;
        if (consumeRow(path, rawLine, cursor, onRow, options, stats)) {
          cursor.stopped = true;
          break;
        }
      }
      cursor.remainder = cursor.stopped
        ? Buffer.alloc(0)
        : Buffer.from(combined.subarray(scanFrom));
      if (cursor.remainder.length > limits.maxRowBytes) {
        throw oversizedRowError(path, limits.maxRowBytes, cursor.remainder.length);
      }
    }

    assertSnapshotUnchanged(path, identity, snapshotSize, fstatSync(fd, { bigint: true }));

    if (!cursor.stopped && cursor.remainder.length > 0) {
      const rawLine = cursor.remainder.toString('utf8');
      const stop = consumeRow(path, rawLine, cursor, onRow, options, stats);
      consumedOffset += cursor.remainder.length;
      cursor.stopped = stop;
      cursor.remainder = Buffer.alloc(0);
    }

    return {
      stopped: cursor.stopped,
      nextOffsetBytes: consumedOffset,
      endOfSnapshot: !cursor.stopped && consumedOffset >= snapshotSize,
      stats,
    };
  } finally {
    closeSync(fd);
  }
}

