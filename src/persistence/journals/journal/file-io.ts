import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { JournalEntry } from '../../../core/session/types.js';
import { appendJsonLine } from '../../jsonl.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { backfillLegacyTurnId, parseTurnId } from '../../../core/turns/id.js';
import type {
  JournalBoundedReadStats,
  JournalFileMetadata,
  QuarantinedJournalEntry,
  ReadJournalBeforeOptions,
  ReadJournalBeforeResult,
  ReadJournalFileOptions,
  ReadJournalResult,
  ReadJournalTailOptions,
  ReadJournalTailResult,
  ScanJournalMetadataOptions,
} from './types.js';
import {
  listNumberedJsonlSegments,
  readJsonlLineAtOrAfter,
  readJsonlLineBefore,
  scanJsonlFileBackward,
} from '../../jsonl-segments.js';
import { readJournalEntriesBeforeAsyncOnce } from './bounded-seek.js';

const DEFAULT_JOURNAL_SCAN_CHUNK_BYTES = 64 * 1024;
const JOURNAL_SEGMENT_READ_RETRIES = 3;
const JOURNAL_SEEK_ROW_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
});
const log = createComponentLogger('Journal');

function resolveJournalMessageTurnId(entry: JournalEntry): string {
  if (entry.type !== 'message') {
    throw new Error('resolveJournalMessageTurnId expects message entries only');
  }

  const fallbackRole = entry.role === 'assistant' || entry.role === 'system' || entry.role === 'tool'
    ? entry.role
    : 'user';
  const fallbackSeed = `legacy-turn:${entry.channelId}:${entry.id}:${entry.timestamp}:${fallbackRole}`;

  if (typeof entry.metadata !== 'string' || entry.metadata.trim().length === 0) {
    return backfillLegacyTurnId(fallbackSeed);
  }

  try {
    const parsed = JSON.parse(entry.metadata) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = (parsed as Record<string, unknown>).turn;
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const turnId = parseTurnId((candidate as Record<string, unknown>).turnId, 'metadata.turn.turnId');
        if (turnId) return turnId;
      }
    }
  } catch {
    // Fall through to deterministic backfill below.
  }

  return backfillLegacyTurnId(fallbackSeed);
}

export function parseJournalLine(line: string): JournalEntry {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('entry is not an object');
  }

  const entry = parsed as Partial<JournalEntry>;
  if (
    entry.type !== 'message'
    && entry.type !== 'compaction'
    && entry.type !== 'marker'
    && entry.type !== 'tombstone'
  ) {
    throw new Error('entry type must be "message", "compaction", "marker", or "tombstone"');
  }
  if (typeof entry.id !== 'number' || !Number.isFinite(entry.id)) {
    throw new Error('entry id must be a finite number');
  }
  if (typeof entry.channelId !== 'string' || entry.channelId.length === 0) {
    throw new Error('entry channelId must be a non-empty string');
  }
  if (typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp)) {
    throw new Error('entry timestamp must be a finite number');
  }
  if (entry.type === 'marker') {
    if (entry.marker !== 'extraction' && entry.marker !== 'graceful_shutdown') {
      throw new Error('marker entry marker must be "extraction" or "graceful_shutdown"');
    }
    if (entry.marker === 'extraction') {
      if (typeof entry.coveredUpTo !== 'number' || !Number.isFinite(entry.coveredUpTo)) {
        throw new Error('extraction marker entry coveredUpTo must be a finite number');
      }
    }
  }

  if (entry.type === 'message') {
    if (entry.role !== 'user' && entry.role !== 'assistant' && entry.role !== 'system' && entry.role !== 'tool') {
      throw new Error('message entry role must be "user", "assistant", "system", or "tool"');
    }
    if (typeof entry.content !== 'string') {
      throw new Error('message entry content must be a string');
    }
  }

  if (entry.type === 'tombstone') {
    if (entry.tombstoneTargetType !== 'turn') {
      throw new Error('tombstone entry target type must be "turn"');
    }
    const turnId = parseTurnId(entry.tombstoneTargetId, 'tombstoneTargetId');
    if (!turnId) {
      throw new Error('tombstone entry target id must be a valid TurnID');
    }
    if (entry.tombstoneAction !== 'redact' && entry.tombstoneAction !== 'restore') {
      throw new Error('tombstone entry action must be "redact" or "restore"');
    }
    if (entry.tombstoneActor !== undefined && typeof entry.tombstoneActor !== 'string') {
      throw new Error('tombstone entry actor must be a string when present');
    }
    if (entry.tombstoneReason !== undefined && typeof entry.tombstoneReason !== 'string') {
      throw new Error('tombstone entry reason must be a string when present');
    }
  }

  return entry as JournalEntry;
}

function scanJournalLinesForward(
  filePath: string,
  onLine: (line: string, lineNumber: number) => boolean | void,
): boolean {
  const fd = openSync(filePath, 'r');
  let stoppedEarly = false;
  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize <= 0) return false;

    const buffer = Buffer.allocUnsafe(DEFAULT_JOURNAL_SCAN_CHUNK_BYTES);
    let offset = 0;
    let remainder = '';
    let lineNumber = 0;

    while (offset < fileSize) {
      const bytesToRead = Math.min(DEFAULT_JOURNAL_SCAN_CHUNK_BYTES, fileSize - offset);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;

      const chunk = buffer.toString('utf8', 0, bytesRead);
      const parts = (remainder + chunk).split('\n');
      remainder = parts.pop() ?? '';

      for (const line of parts) {
        lineNumber += 1;
        if (onLine(line, lineNumber)) {
          stoppedEarly = true;
          return stoppedEarly;
        }
      }
    }

    if (remainder.length > 0) {
      lineNumber += 1;
      if (onLine(remainder, lineNumber)) {
        stoppedEarly = true;
      }
    }
  } finally {
    closeSync(fd);
  }
  return stoppedEarly;
}

export function scanJournalLinesBackward(
  filePath: string,
  onLine: (line: string) => boolean | void,
): boolean {
  const fd = openSync(filePath, 'r');
  let stoppedEarly = false;
  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize <= 0) return false;

    const buffer = Buffer.allocUnsafe(DEFAULT_JOURNAL_SCAN_CHUNK_BYTES);
    let position = fileSize;
    // Keep the incomplete leading line as bytes. Decoding each chunk on its
    // own corrupts a UTF-8 code point split across the 64 KiB boundary.
    let remainder = Buffer.alloc(0);

    while (position > 0) {
      const bytesToRead = Math.min(DEFAULT_JOURNAL_SCAN_CHUNK_BYTES, position);
      position -= bytesToRead;

      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;

      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const combined = remainder.length > 0
        ? Buffer.concat([chunk, remainder])
        : chunk;
      let lineEnd = combined.length;
      let leadingBytes = combined.length;
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== 0x0a) continue;
        const line = combined.subarray(index + 1, lineEnd).toString('utf8');
        if (onLine(line)) {
          stoppedEarly = true;
          return stoppedEarly;
        }
        lineEnd = index;
        leadingBytes = index;
      }
      remainder = Buffer.from(combined.subarray(0, leadingBytes));
    }

    if (remainder.length > 0) {
      if (onLine(remainder.toString('utf8'))) {
        stoppedEarly = true;
      }
    }
  } finally {
    closeSync(fd);
  }
  return stoppedEarly;
}

export function parseJournalText(raw: string): ReadJournalResult {
  const entries: JournalEntry[] = [];
  const quarantined: QuarantinedJournalEntry[] = [];
  let maxId = 0;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;

    try {
      const entry = parseJournalLine(line);
      entries.push(entry);
      if (entry.id > maxId) {
        maxId = entry.id;
      }
    } catch (error) {
      quarantined.push({
        lineNumber: i + 1,
        error: toErrorMessage(error),
        raw: line,
      });
    }
  }

  return { entries, maxId, quarantined };
}

export function quarantineSidecarPath(filePath: string): string {
  return `${filePath}.quarantine`;
}

export function listJournalArchivePaths(filePath: string): string[] {
  const paths = listNumberedJsonlSegments(filePath)
    .sort((left, right) => left.segmentNumber - right.segmentNumber)
    .map(segment => segment.path);
  if (existsSync(filePath)) paths.push(filePath);
  return paths;
}

export function listContiguousJournalArchivePaths(filePath: string): string[] {
  const segments = listNumberedJsonlSegments(filePath)
    .sort((left, right) => left.segmentNumber - right.segmentNumber);
  for (let index = 0; index < segments.length; index += 1) {
    const expected = index + 1;
    if (segments[index]!.segmentNumber !== expected) {
      throw new Error(
        `Journal archive generation for ${filePath} is not contiguous: `
        + `expected segment ${expected}, found ${segments[index]!.segmentNumber}`,
      );
    }
  }
  const paths = segments.map(segment => segment.path);
  if (existsSync(filePath)) paths.push(filePath);
  return paths;
}

export function fingerprintJournalArchive(filePath: string): string | null {
  const paths = listJournalArchivePaths(filePath);
  if (paths.length === 0) return null;
  return paths.map((path) => {
    const stats = statSync(path);
    return [path, stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(':');
  }).join('|');
}

export function persistQuarantinedEntries(
  filePath: string,
  quarantined: QuarantinedJournalEntry[],
): void {
  const quarantinePath = quarantineSidecarPath(filePath);
  if (quarantined.length === 0) {
    if (existsSync(quarantinePath)) {
      unlinkSync(quarantinePath);
    }
    return;
  }

  const body = quarantined.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  writeFileSync(quarantinePath, body, 'utf-8');
}

export function readJournalFile(
  filePath: string,
  options: ReadJournalFileOptions = {},
): ReadJournalResult {
  const archivePaths = listJournalArchivePaths(filePath);
  if (archivePaths.length === 0) {
    return { entries: [], maxId: 0, quarantined: [] };
  }

  const result: ReadJournalResult = { entries: [], maxId: 0, quarantined: [] };
  for (const path of archivePaths) {
    const parsed = parseJournalText(readFileSync(path, 'utf-8'));
    result.entries.push(...parsed.entries);
    result.maxId = Math.max(result.maxId, parsed.maxId);
    result.quarantined.push(...parsed.quarantined);
    if (options.persistQuarantine !== false) {
      try {
        persistQuarantinedEntries(path, parsed.quarantined);
      } catch (err) {
        // Quarantine sidecar write failure should never block journal loading.
        log.warn('Quarantine sidecar write failed', {
          path: quarantineSidecarPath(path),
          error: toErrorMessage(err),
        });
      }
    }
  }
  return result;
}

export function readJournalFirstEntry(
  filePath: string,
  options: { malformedRow?: 'return-null' | 'throw' } = {},
): JournalEntry | null {
  for (const path of listJournalArchivePaths(filePath)) {
    let first: JournalEntry | null = null;
    const foundEntry = scanJournalLinesForward(path, (line) => {
      if (line.trim().length === 0) return false;
      try {
        first = parseJournalLine(line);
      } catch (error) {
        if (options.malformedRow === 'throw') {
          throw error;
        }
        first = null;
      }
      // The first nonblank physical row is boundary authority. A malformed
      // row cannot authorize skipping forward to a later parseable id.
      return true;
    });
    if (foundEntry) return first;
  }
  return null;
}

export function scanJournalFileMetadata(
  filePath: string,
  options: ScanJournalMetadataOptions = {},
): JournalFileMetadata {
  const parsed = readJournalFile(filePath, { persistQuarantine: options.persistQuarantine });
  if (parsed.entries.length === 0 && parsed.quarantined.length === 0) {
    return {
      entryCount: 0,
      minId: 0,
      maxId: 0,
      messageCount: 0,
      compactionCount: 0,
      turnTombstoneCount: 0,
      activeTurnTombstoneCount: 0,
      activeTurnTombstoneIds: [],
      lastTimestamp: 0,
      lastHmac: null,
      lastEntry: null,
      lastExtractionCoveredUpTo: 0,
      quarantined: [],
    };
  }

  let entryCount = 0;
  let minId = Number.POSITIVE_INFINITY;
  let maxId = 0;
  let compactionCount = 0;
  let turnTombstoneCount = 0;
  const messageCountsByTurn = new Map<string, number>();
  const activeTurnTombstones = new Set<string>();
  let lastTimestamp = 0;
  let lastHmac: string | null = null;
  let lastEntry: JournalEntry | null = null;
  let lastExtractionCoveredUpTo = 0;
  const quarantined = parsed.quarantined;

  for (const entry of parsed.entries) {
    entryCount += 1;
    minId = Math.min(minId, entry.id);
    maxId = Math.max(maxId, entry.id);
    if (entry.type === 'message') {
      const turnId = resolveJournalMessageTurnId(entry);
      messageCountsByTurn.set(turnId, (messageCountsByTurn.get(turnId) ?? 0) + 1);
    } else if (entry.type === 'compaction') {
      compactionCount += 1;
    } else if (entry.type === 'tombstone' && entry.tombstoneTargetType === 'turn') {
      turnTombstoneCount += 1;
      const turnId = parseTurnId(entry.tombstoneTargetId, 'tombstoneTargetId');
      if (turnId) {
        if (entry.tombstoneAction === 'redact') {
          activeTurnTombstones.add(turnId);
        } else if (entry.tombstoneAction === 'restore') {
          activeTurnTombstones.delete(turnId);
        }
      }
    }
    lastTimestamp = entry.timestamp;
    lastEntry = entry;
    if (typeof entry._hmac === 'string') lastHmac = entry._hmac;
    if (entry.type === 'marker' && entry.marker === 'extraction' && typeof entry.coveredUpTo === 'number') {
      lastExtractionCoveredUpTo = Math.max(lastExtractionCoveredUpTo, entry.coveredUpTo);
    }
  }

  let messageCount = 0;
  for (const [turnId, count] of messageCountsByTurn.entries()) {
    if (activeTurnTombstones.has(turnId)) continue;
    messageCount += count;
  }

  return {
    entryCount,
    minId: Number.isFinite(minId) ? minId : 0,
    maxId,
    messageCount,
    compactionCount,
    turnTombstoneCount,
    activeTurnTombstoneCount: activeTurnTombstones.size,
    activeTurnTombstoneIds: [...activeTurnTombstones].sort(),
    lastTimestamp,
    lastHmac,
    lastEntry,
    lastExtractionCoveredUpTo,
    quarantined,
  };
}

export function readJournalTailEntries(
  filePath: string,
  options: ReadJournalTailOptions,
): ReadJournalTailResult {
  const messageLimit = Math.max(0, Math.floor(options.messageLimit));
  const archivePaths = listJournalArchivePaths(filePath);
  if (archivePaths.length === 0 || messageLimit <= 0) {
    return {
      entries: [],
      quarantined: [],
      truncated: false,
    };
  }

  const includeBoundaryEntry = options.includeBoundaryEntry !== false;
  const parsedDescending: JournalEntry[] = [];
  const quarantined: QuarantinedJournalEntry[] = [];
  let messageCount = 0;
  let needBoundaryEntry = false;

  let truncated = false;
  for (let index = archivePaths.length - 1; index >= 0 && !truncated; index -= 1) {
    truncated = scanJournalLinesBackward(archivePaths[index]!, (line) => {
      if (line.trim().length === 0) return false;

      try {
        const entry = parseJournalLine(line);
        parsedDescending.push(entry);

        if (needBoundaryEntry) return true;
        if (entry.type === 'message') {
          messageCount += 1;
          if (messageCount >= messageLimit) {
            if (!includeBoundaryEntry) return true;
            needBoundaryEntry = true;
          }
        }
        return false;
      } catch (error) {
        quarantined.push({ lineNumber: -1, error: toErrorMessage(error), raw: line });
        return false;
      }
    });
  }

  return {
    entries: parsedDescending.reverse(),
    quarantined,
    truncated,
  };
}

export function readJournalMatchingEntriesBackward(
  filePath: string,
  options: import('./types.js').ReadJournalMatchingOptions,
): import('./types.js').ReadJournalMatchingResult {
  const limit = Math.max(0, Math.floor(options.limit));
  const archivePaths = listJournalArchivePaths(filePath);
  if (archivePaths.length === 0 || limit <= 0) return { matches: [], quarantined: [] };

  const matches: import('./types.js').JournalBackwardMatch[] = [];
  const quarantined: QuarantinedJournalEntry[] = [];
  const state: { awaitingBoundary: JournalEntry | null } = { awaitingBoundary: null };

  let stopped = false;
  for (let index = archivePaths.length - 1; index >= 0 && !stopped; index -= 1) {
    stopped = scanJournalLinesBackward(archivePaths[index]!, (line) => {
      if (line.trim().length === 0) return false;
      let entry: JournalEntry;
      try {
        entry = parseJournalLine(line);
      } catch (error) {
        quarantined.push({ lineNumber: -1, error: toErrorMessage(error), raw: line });
        if (state.awaitingBoundary) {
          matches.push({ entry: state.awaitingBoundary, previousHmac: null });
          state.awaitingBoundary = null;
        }
        return matches.length >= limit;
      }

      if (state.awaitingBoundary) {
        matches.push({
          entry: state.awaitingBoundary,
          previousHmac: typeof entry._hmac === 'string' ? entry._hmac : null,
        });
        state.awaitingBoundary = null;
        if (matches.length >= limit) return true;
      }
      if (options.stopAfter?.(entry)) return true;
      if (options.matches(entry)) state.awaitingBoundary = entry;
      return false;
    });
  }

  if (state.awaitingBoundary && matches.length < limit) {
    matches.push({ entry: state.awaitingBoundary, previousHmac: null });
  }
  return { matches, quarantined };
}
function appendQuarantinedLine(
  target: QuarantinedJournalEntry[],
  line: string,
  error: unknown,
): void {
  const quarantined = {
    lineNumber: -1,
    error: toErrorMessage(error),
    raw: line,
  } satisfies QuarantinedJournalEntry;
  if (target.some(existing => existing.raw === quarantined.raw && existing.error === quarantined.error)) {
    return;
  }
  target.push(quarantined);
}

function readJournalEntriesBeforeOnce(
  filePath: string,
  beforeId: number,
  messageLimit: number,
  includeBoundaryEntry: boolean,
  chunkBytes: number,
  stats: JournalBoundedReadStats | undefined,
  trustSeekEntry: ReadJournalBeforeOptions['trustSeekEntry'],
  previousFileHmac: string | null,
): ReadJournalBeforeResult {
  const parsedDescending: JournalEntry[] = [];
  const quarantined: QuarantinedJournalEntry[] = [];
  const seekFileIdentities = new Set<string>();
  const scannedFileIdentities = new Set<string>();
  const seekChunkBytes = Math.max(chunkBytes, 1024);
  let messageCount = 0;
  let needBoundaryEntry = false;
  let truncated = false;

  const readSeekEntry = (
    path: string,
    offset: number,
    previousPath: string | undefined,
  ): { entry: JournalEntry; startOffset: number; endOffset: number } | null => {
    const row = readJsonlLineAtOrAfter(path, offset, {
      chunkBytes: seekChunkBytes,
      stats,
      scannedFileIdentities: seekFileIdentities,
    });
    if (!row || row.line.trim().length === 0) return null;

    let entry: JournalEntry;
    try {
      entry = parseJournalLine(row.line);
    } catch (error) {
      appendQuarantinedLine(quarantined, row.line, error);
      return null;
    }
    if (!trustSeekEntry) {
      return { entry, startOffset: row.startOffset, endOffset: row.endOffset };
    }

    const previousRow = row.startOffset > 0
      ? readJsonlLineBefore(path, row.startOffset, {
        chunkBytes: seekChunkBytes,
        stats,
        scannedFileIdentities: seekFileIdentities,
      })
      : previousPath
        ? readJsonlLineBefore(previousPath, statSync(previousPath).size, {
          chunkBytes: seekChunkBytes,
          stats,
          scannedFileIdentities: seekFileIdentities,
        })
        : null;
    let previousHmac = previousFileHmac;
    if (previousRow?.line.trim()) {
      try {
        const previousEntry = parseJournalLine(previousRow.line);
        previousHmac = typeof previousEntry._hmac === 'string' ? previousEntry._hmac : null;
      } catch (error) {
        appendQuarantinedLine(quarantined, previousRow.line, error);
        return null;
      }
    }
    try {
      return trustSeekEntry(entry, previousHmac)
        ? { entry, startOffset: row.startOffset, endOffset: row.endOffset }
        : null;
    } catch {
      return null;
    }
  };

  const findCursorOffset = (path: string, previousPath: string | undefined): number | null => {
    const fileSize = statSync(path).size;
    let low = 0;
    let high = fileSize;
    while (high - low > seekChunkBytes) {
      const midpoint = low + Math.floor((high - low) / 2);
      const sampled = readSeekEntry(path, midpoint, previousPath);
      if (!sampled) {
        high = midpoint;
        continue;
      }
      if (sampled.entry.id < beforeId) {
        low = Math.max(low + 1, sampled.endOffset);
      } else {
        high = midpoint;
      }
    }

    let offset = low;
    while (offset < fileSize) {
      const candidate = readSeekEntry(path, offset, previousPath);
      if (!candidate) return null;
      if (candidate.entry.id >= beforeId) return candidate.startOffset;
      if (candidate.endOffset <= offset) return null;
      offset = candidate.endOffset;
    }
    return fileSize;
  };

  const scanCandidate = (path: string, endOffset?: number): boolean => {
    const stopped = scanJsonlFileBackward(path, {
      chunkBytes,
      stats,
      scannedFileIdentities,
      ...(endOffset === undefined ? {} : { endOffset }),
    }, (line) => {
      if (line.trim().length === 0) return false;
      let entry: JournalEntry;
      try {
        entry = parseJournalLine(line);
      } catch (error) {
        appendQuarantinedLine(quarantined, line, error);
        return false;
      }
      if (entry.id >= beforeId) return false;

      parsedDescending.push(entry);
      if (needBoundaryEntry) return true;
      if (entry.type !== 'message') return false;

      messageCount += 1;
      if (messageCount < messageLimit) return false;
      if (!includeBoundaryEntry) return true;
      needBoundaryEntry = true;
      return false;
    });
    return stopped;
  };

  const archivePaths = listNumberedJsonlSegments(filePath)
    .sort((left, right) => left.segmentNumber - right.segmentNumber)
    .map(segment => segment.path);
  if (existsSync(filePath)) archivePaths.push(filePath);
  const nonEmptyPaths = archivePaths.filter(path => statSync(path).size > 0);

  let candidateIndex = -1;
  let low = 0;
  let high = nonEmptyPaths.length - 1;
  let segmentSeekTrusted = true;
  while (low <= high) {
    const midpoint = low + Math.floor((high - low) / 2);
    const sampled = readSeekEntry(
      nonEmptyPaths[midpoint]!,
      0,
      midpoint > 0 ? nonEmptyPaths[midpoint - 1]! : undefined,
    );
    if (!sampled) {
      segmentSeekTrusted = false;
      break;
    }
    if (sampled.entry.id < beforeId) {
      candidateIndex = midpoint;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  if (segmentSeekTrusted && candidateIndex >= 0) {
    for (let index = candidateIndex; index >= 0 && !truncated; index -= 1) {
      const candidateSize = statSync(nonEmptyPaths[index]!).size;
      const cursorOffset = index === candidateIndex && candidateSize > 256 * 1024
        ? findCursorOffset(nonEmptyPaths[index]!, index > 0 ? nonEmptyPaths[index - 1]! : undefined)
        : candidateSize;
      truncated = scanCandidate(
        nonEmptyPaths[index]!,
        cursorOffset ?? candidateSize,
      );
    }
  } else if (!segmentSeekTrusted) {
    // An unauthenticated or malformed boundary is never skip authority.
    for (let index = nonEmptyPaths.length - 1; index >= 0 && !truncated; index -= 1) {
      truncated = scanCandidate(nonEmptyPaths[index]!);
    }
  }

  return {
    entries: parsedDescending.reverse(),
    quarantined,
    truncated,
  };
}

/**
 * Read the message window immediately before an entry id without loading the
 * complete archive. The active file and hgw3-style numbered sealed siblings
 * are walked newest-first. Newer segments cost only their first valid entry;
 * the containing/older segments are scanned backward until the requested
 * messages plus one HMAC boundary entry are found.
 */
export function readJournalEntriesBefore(
  filePath: string,
  options: ReadJournalBeforeOptions,
): ReadJournalBeforeResult {
  const beforeId = Number.isFinite(options.beforeId)
    ? Math.max(0, Math.floor(options.beforeId))
    : 0;
  const messageLimit = Number.isFinite(options.messageLimit)
    ? Math.max(0, Math.floor(options.messageLimit))
    : 0;
  if (beforeId <= 0 || messageLimit <= 0) {
    return { entries: [], quarantined: [], truncated: false };
  }
  const requestedChunkBytes = options.scanChunkBytes ?? DEFAULT_JOURNAL_SCAN_CHUNK_BYTES;
  const chunkBytes = Number.isFinite(requestedChunkBytes)
    ? Math.max(1, Math.floor(requestedChunkBytes))
    : DEFAULT_JOURNAL_SCAN_CHUNK_BYTES;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return readJournalEntriesBeforeOnce(
        filePath,
        beforeId,
        messageLimit,
        options.includeBoundaryEntry !== false,
        chunkBytes,
        options.stats,
        options.trustSeekEntry,
        options.previousFileHmac ?? null,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        (code !== 'ENOENT' && code !== 'ESTALE')
        || attempt >= JOURNAL_SEGMENT_READ_RETRIES
      ) {
        throw error;
      }
    }
  }
}

/**
 * Cooperative request-time variant of `readJournalEntriesBefore`.
 *
 * Sampled current/predecessor rows are read in fixed chunks with an explicit
 * retained-byte ceiling. Oversized seek authority fails closed instead of
 * monopolizing the primary event loop or being parsed as truncated JSON.
 */
export async function readJournalEntriesBeforeAsync(
  filePath: string,
  options: ReadJournalBeforeOptions,
): Promise<ReadJournalBeforeResult> {
  const beforeId = Number.isFinite(options.beforeId)
    ? Math.max(0, Math.floor(options.beforeId))
    : 0;
  const messageLimit = Number.isFinite(options.messageLimit)
    ? Math.max(0, Math.floor(options.messageLimit))
    : 0;
  if (beforeId <= 0 || messageLimit <= 0) {
    return { entries: [], quarantined: [], truncated: false };
  }
  const requestedChunkBytes = options.scanChunkBytes ?? DEFAULT_JOURNAL_SCAN_CHUNK_BYTES;
  const chunkBytes = Number.isFinite(requestedChunkBytes)
    ? Math.max(1, Math.floor(requestedChunkBytes))
    : DEFAULT_JOURNAL_SCAN_CHUNK_BYTES;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readJournalEntriesBeforeAsyncOnce({
        filePath,
        beforeId,
        messageLimit,
        includeBoundaryEntry: options.includeBoundaryEntry !== false,
        chunkBytes,
        maxSeekLineBytes: JOURNAL_SEEK_ROW_LIMITS.maxBytes,
        stats: options.stats,
        trustSeekEntry: options.trustSeekEntry,
        previousFileHmac: options.previousFileHmac ?? null,
        parseJournalLine,
        appendQuarantinedLine,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        (code !== 'ENOENT' && code !== 'ESTALE')
        || attempt >= JOURNAL_SEGMENT_READ_RETRIES
      ) {
        throw error;
      }
    }
  }
}

export function appendJournalEntry(filePath: string, entry: JournalEntry): void {
  appendJsonLine(filePath, entry);
}

export function writeJournalFileAtomic(filePath: string, entries: readonly JournalEntry[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const body = entries.map(entry => JSON.stringify(entry)).join('\n');
  const payload = body.length > 0 ? `${body}\n` : '';

  try {
    writeFileSync(tmpPath, payload, 'utf-8');
    renameSync(tmpPath, filePath);
    // Rewrites operate on the complete logical archive. Once the replacement
    // active file is durable, retired sealed siblings must not remain visible
    // or canonical replay would duplicate pre-rewrite content.
    for (const segment of listNumberedJsonlSegments(filePath)) {
      unlinkSync(segment.path);
    }
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}
