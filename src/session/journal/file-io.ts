import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { JournalEntry } from '../types.js';
import { appendJsonLine } from '../../persistence/jsonl.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { backfillLegacyTurnId, parseTurnId } from '../../turns/id.js';
import type {
  JournalFileMetadata,
  QuarantinedJournalEntry,
  ReadJournalFileOptions,
  ReadJournalResult,
  ReadJournalTailOptions,
  ReadJournalTailResult,
  ScanJournalMetadataOptions,
} from './types.js';

const DEFAULT_JOURNAL_SCAN_CHUNK_BYTES = 64 * 1024;

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

function parseJournalLine(line: string): JournalEntry {
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

function scanJournalLinesBackward(
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
    let remainder = '';

    while (position > 0) {
      const bytesToRead = Math.min(DEFAULT_JOURNAL_SCAN_CHUNK_BYTES, position);
      position -= bytesToRead;

      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;

      const chunk = buffer.toString('utf8', 0, bytesRead);
      const parts = (chunk + remainder).split('\n');
      remainder = parts.shift() ?? '';

      for (let index = parts.length - 1; index >= 0; index--) {
        if (onLine(parts[index])) {
          stoppedEarly = true;
          return stoppedEarly;
        }
      }
    }

    if (remainder.length > 0) {
      if (onLine(remainder)) {
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
    if (line.trim().length === 0) continue;

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
  if (!existsSync(filePath)) {
    return { entries: [], maxId: 0, quarantined: [] };
  }
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseJournalText(raw);
  if (options.persistQuarantine !== false) {
    try {
      persistQuarantinedEntries(filePath, parsed.quarantined);
    } catch (err) {
      // Quarantine sidecar write failure should never block journal loading.
      if (typeof process !== 'undefined' && process.env.LOG_LEVEL === 'debug') {
        console.debug('[Journal] Quarantine sidecar write failed', String(err));
      }
    }
  }
  return parsed;
}

export function readJournalFirstEntry(filePath: string): JournalEntry | null {
  if (!existsSync(filePath)) return null;

  let first: JournalEntry | null = null;
  scanJournalLinesForward(filePath, (line) => {
    if (line.trim().length === 0) return false;
    try {
      first = parseJournalLine(line);
      return true;
    } catch {
      return false;
    }
  });

  return first;
}

export function scanJournalFileMetadata(
  filePath: string,
  options: ScanJournalMetadataOptions = {},
): JournalFileMetadata {
  if (!existsSync(filePath)) {
    return {
      entryCount: 0,
      maxId: 0,
      messageCount: 0,
      activeTurnTombstoneCount: 0,
      lastTimestamp: 0,
      lastHmac: null,
      lastEntry: null,
      lastExtractionCoveredUpTo: 0,
      quarantined: [],
    };
  }

  let entryCount = 0;
  let maxId = 0;
  const messageCountsByTurn = new Map<string, number>();
  const activeTurnTombstones = new Set<string>();
  let lastTimestamp = 0;
  let lastHmac: string | null = null;
  let lastEntry: JournalEntry | null = null;
  let lastExtractionCoveredUpTo = 0;
  const quarantined: QuarantinedJournalEntry[] = [];

  scanJournalLinesForward(filePath, (line, lineNumber) => {
    if (line.trim().length === 0) return false;

    try {
      const entry = parseJournalLine(line);
      entryCount += 1;
      maxId = Math.max(maxId, entry.id);
      if (entry.type === 'message') {
        const turnId = resolveJournalMessageTurnId(entry);
        messageCountsByTurn.set(turnId, (messageCountsByTurn.get(turnId) ?? 0) + 1);
      } else if (entry.type === 'tombstone' && entry.tombstoneTargetType === 'turn') {
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
      if (typeof entry._hmac === 'string') {
        lastHmac = entry._hmac;
      }
      if (entry.type === 'marker' && entry.marker === 'extraction' && typeof entry.coveredUpTo === 'number') {
        lastExtractionCoveredUpTo = Math.max(lastExtractionCoveredUpTo, entry.coveredUpTo);
      }
      return false;
    } catch (error) {
      quarantined.push({
        lineNumber,
        error: toErrorMessage(error),
        raw: line,
      });
      return false;
    }
  });

  if (options.persistQuarantine !== false) {
    try {
      persistQuarantinedEntries(filePath, quarantined);
    } catch (err) {
      // Quarantine sidecar write failure should never block journal loading.
      if (typeof process !== 'undefined' && process.env.LOG_LEVEL === 'debug') {
        console.debug('[Journal] Quarantine sidecar write failed', String(err));
      }
    }
  }

  let messageCount = 0;
  for (const [turnId, count] of messageCountsByTurn.entries()) {
    if (activeTurnTombstones.has(turnId)) continue;
    messageCount += count;
  }

  return {
    entryCount,
    maxId,
    messageCount,
    activeTurnTombstoneCount: activeTurnTombstones.size,
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
  if (!existsSync(filePath) || messageLimit <= 0) {
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

  const truncated = scanJournalLinesBackward(filePath, (line) => {
    if (line.trim().length === 0) return false;

    try {
      const entry = parseJournalLine(line);
      parsedDescending.push(entry);

      if (needBoundaryEntry) {
        return true;
      }

      if (entry.type === 'message') {
        messageCount += 1;
        if (messageCount >= messageLimit) {
          if (!includeBoundaryEntry) return true;
          needBoundaryEntry = true;
        }
      }
      return false;
    } catch (error) {
      quarantined.push({
        lineNumber: -1,
        error: toErrorMessage(error),
        raw: line,
      });
      return false;
    }
  });

  return {
    entries: parsedDescending.reverse(),
    quarantined,
    truncated,
  };
}

export function appendJournalEntry(filePath: string, entry: JournalEntry): void {
  appendJsonLine(filePath, entry);
}
