import { isRecord } from '../../shared/utils/types.js';
import { join } from 'node:path';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { appendJsonLine } from '../jsonl.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { createComponentLogger } from '../../shared/logger.js';
import { CHANNEL_TYPES, type ChannelType, type TurnID, type TurnRecord, type TurnRecordLocation, type TurnRecordMessage, type TurnRecordToolCall, type TurnRecordVersionPointers } from '../../shared/contracts/runtime.js';
import { sanitizeChannelId } from './store-file-contracts.js';
import { backfillLegacyTurnId, parseTurnId } from '../../core/turns/id.js';
import type {
  TurnObservabilityCallType,
  TurnObservabilityRecord,
  TurnRetrievalTelemetryRecord,
  TurnSnapshotRecord,
  TurnStageTelemetryRecord,
} from '../../core/turns/observability.js';
import { cloneUnknownValue } from '../../core/turns/observability.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import {
  createTurnRecordSharedStore,
  resolveTurnRecordToolDefinitions,
  slimTurnRecordToolDefinitionsForAppend,
} from './turn-record-shared-store.js';

const log = createComponentLogger('TurnRecords');

const TURN_RECORDS_DIR = '_turn_records';
const TURN_RECORD_SCHEMA_VERSION = 1;

/**
 * Size cap for a single active turn-record segment file. When an append notices
 * the active file has reached this size it rotates: the active file is renamed
 * to a numbered segment and a fresh active file is started. Kept as a named
 * constant (no config plumbing) — records average hundreds of KB, so 64 MiB
 * holds roughly ~100 turns per segment before rotation.
 */
export const TURN_RECORD_SEGMENT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Chunk size for the bounded backward tail scan. A single turn record can exceed
 * 600 KiB, but the byte-level scanner accumulates fragments across chunks so any
 * line length is handled correctly regardless of this value — it only affects
 * how many syscalls a tail read costs.
 */
const TURN_RECORD_TAIL_SCAN_CHUNK_BYTES = 256 * 1024;

const NEWLINE_BYTE = 0x0a;
const VALID_CHANNEL_TYPES = new Set<ChannelType>(CHANNEL_TYPES);
const VALID_TURN_STATUSES = new Set<TurnRecord['status']>(['completed', 'failed']);
const VALID_OBSERVABILITY_CALL_TYPES = new Set<TurnObservabilityCallType>([
  'chat',
  'tool',
  'memory',
  'summary',
  'background',
  'scheduled',
]);
const VALID_RETRIEVAL_SOURCES = new Set<NonNullable<TurnRetrievalTelemetryRecord['retrievalSource']>>([
  'embedding',
  'lexical_fallback',
]);


function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`TurnRecord field \"${fieldName}\" must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`TurnRecord field \"${fieldName}\" cannot be empty`);
  }
  return normalized;
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`TurnRecord field \"${fieldName}\" must be a string`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseOptionalStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be an array`);
  }
  const deduped = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`TurnRecord field \"${fieldName}\" contains non-string value`);
    }
    const normalized = item.trim();
    if (normalized) deduped.add(normalized);
  }
  return [...deduped];
}

function parseRequiredNonNegativeNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be a finite non-negative number`);
  }
  return value;
}

function parseRequiredTimestamp(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be a finite non-negative number`);
  }
  return Math.floor(value);
}

function parseOptionalCallType(value: unknown, fieldName: string): TurnObservabilityCallType | undefined {
  const normalized = parseOptionalString(value, fieldName);
  if (!normalized) return undefined;
  if (!VALID_OBSERVABILITY_CALL_TYPES.has(normalized as TurnObservabilityCallType)) {
    throw new Error(`TurnRecord field \"${fieldName}\" is invalid: ${normalized}`);
  }
  return normalized as TurnObservabilityCallType;
}

function parseOptionalRetrievalSource(
  value: unknown,
  fieldName: string,
): TurnRetrievalTelemetryRecord['retrievalSource'] | undefined {
  const normalized = parseOptionalString(value, fieldName);
  if (!normalized) return undefined;
  if (!VALID_RETRIEVAL_SOURCES.has(normalized as NonNullable<TurnRetrievalTelemetryRecord['retrievalSource']>)) {
    throw new Error(`TurnRecord field \"${fieldName}\" is invalid: ${normalized}`);
  }
  return normalized as TurnRetrievalTelemetryRecord['retrievalSource'];
}

function parseRequiredJsonRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be an object`);
  }
  return cloneUnknownValue(value) as Record<string, unknown>;
}

function parseOptionalLocation(value: unknown): TurnRecordLocation | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error('TurnRecord field "location" must be an object');
  }
  const placeId = parseOptionalString(value.placeId, 'location.placeId');
  const satelliteId = parseOptionalString(value.satelliteId, 'location.satelliteId');
  if (!placeId && !satelliteId) return undefined;
  return {
    ...(placeId ? { placeId } : {}),
    ...(satelliteId ? { satelliteId } : {}),
  };
}

function parseTurnRecordMessage(value: unknown, fieldName: string): TurnRecordMessage {
  if (!isRecord(value)) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be an object`);
  }

  const role = parseRequiredString(value.role, `${fieldName}.role`);
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    throw new Error(`TurnRecord field \"${fieldName}.role\" must be \"user\", \"assistant\", or \"system\"`);
  }

  const content = parseRequiredString(value.content, `${fieldName}.content`);
  const timestamp = parseRequiredTimestamp(value.timestamp, `${fieldName}.timestamp`);
  const sessionEntryId = value.sessionEntryId;
  const sourceMessageId = value.sourceMessageId;
  const authorId = value.authorId;
  const authorName = value.authorName;

  return {
    role,
    content,
    timestamp,
    ...(typeof sessionEntryId === 'number' && Number.isFinite(sessionEntryId)
      ? { sessionEntryId: Math.floor(sessionEntryId) }
      : {}),
    ...(typeof sourceMessageId === 'string' && sourceMessageId.trim().length > 0
      ? { sourceMessageId: sourceMessageId.trim() }
      : {}),
    ...(typeof authorId === 'string' && authorId.trim().length > 0
      ? { authorId: authorId.trim() }
      : {}),
    ...(typeof authorName === 'string' && authorName.trim().length > 0
      ? { authorName: authorName.trim() }
      : {}),
  };
}

function parseTurnRecordToolCalls(value: unknown): TurnRecordToolCall[] {
  if (!Array.isArray(value)) {
    throw new Error('TurnRecord field "toolCalls" must be an array');
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`TurnRecord field \"toolCalls[${index}]\" must be an object`);
    }

    const toolName = parseRequiredString(entry.toolName, `toolCalls[${index}].toolName`);
    const toolCallId = entry.toolCallId;
    const isError = entry.isError;

    return {
      toolName,
      ...(typeof toolCallId === 'string' && toolCallId.trim().length > 0
        ? { toolCallId: toolCallId.trim() }
        : {}),
      ...(typeof isError === 'boolean' ? { isError } : {}),
    };
  });
}

function parseVersionPointers(value: unknown): TurnRecordVersionPointers {
  if (!isRecord(value)) {
    throw new Error('TurnRecord field "versionPointers" must be an object');
  }

  const model = parseRequiredString(value.model, 'versionPointers.model');
  const promptMode = value.promptMode;
  const promptHash = value.promptHash;
  const promptStack = value.promptStack;
  const memoryState = value.memoryState;
  const sessionState = value.sessionState;

  return {
    model,
    ...(promptMode === 'default' || promptMode === 'none' || promptMode === 'custom'
      ? { promptMode }
      : {}),
    ...(typeof promptHash === 'string' && promptHash.trim().length > 0
      ? { promptHash: promptHash.trim() }
      : {}),
    ...(typeof promptStack === 'string' && promptStack.trim().length > 0
      ? { promptStack: promptStack.trim() }
      : {}),
    ...(typeof memoryState === 'string' && memoryState.trim().length > 0
      ? { memoryState: memoryState.trim() }
      : {}),
    ...(typeof sessionState === 'string' && sessionState.trim().length > 0
      ? { sessionState: sessionState.trim() }
      : {}),
  };
}

function parseTurnStageTelemetryRecord(
  value: unknown,
  expected: { turnId: TurnID; requestId: string; channelId: string },
  index: number,
): TurnStageTelemetryRecord {
  const fieldName = `observability.stages[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be an object`);
  }

  const turnId = parseRequiredString(value.turnId, `${fieldName}.turnId`);
  if (turnId !== expected.turnId) {
    throw new Error(`TurnRecord field \"${fieldName}.turnId\" must match turnId`);
  }

  const channelId = parseRequiredString(value.channelId, `${fieldName}.channelId`);
  if (channelId !== expected.channelId) {
    throw new Error(`TurnRecord field \"${fieldName}.channelId\" must match channelId`);
  }

  const requestId = parseOptionalString(value.requestId, `${fieldName}.requestId`);
  if (requestId && requestId !== expected.requestId) {
    throw new Error(`TurnRecord field \"${fieldName}.requestId\" must match requestId`);
  }
  const callType = parseOptionalCallType(value.callType, `${fieldName}.callType`);
  const purpose = parseOptionalString(value.purpose, `${fieldName}.purpose`);

  return {
    observedAt: parseRequiredTimestamp(value.observedAt, `${fieldName}.observedAt`),
    turnId,
    ...(requestId ? { requestId } : {}),
    channelId,
    ...(callType ? { callType } : {}),
    ...(purpose ? { purpose } : {}),
    stage: parseRequiredString(value.stage, `${fieldName}.stage`),
    elapsedMs: parseRequiredNonNegativeNumber(value.elapsedMs, `${fieldName}.elapsedMs`),
    data: parseRequiredJsonRecord(value.data, `${fieldName}.data`),
  };
}

function parseTurnRetrievalTelemetryRecord(
  value: unknown,
  expected: { turnId: TurnID; requestId: string; channelId: string },
  index: number,
): TurnRetrievalTelemetryRecord {
  const fieldName = `observability.retrievals[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be an object`);
  }

  const turnId = parseRequiredString(value.turnId, `${fieldName}.turnId`);
  if (turnId !== expected.turnId) {
    throw new Error(`TurnRecord field \"${fieldName}.turnId\" must match turnId`);
  }

  const channelId = parseRequiredString(value.channelId, `${fieldName}.channelId`);
  if (channelId !== expected.channelId) {
    throw new Error(`TurnRecord field \"${fieldName}.channelId\" must match channelId`);
  }

  const requestId = parseOptionalString(value.requestId, `${fieldName}.requestId`);
  if (requestId && requestId !== expected.requestId) {
    throw new Error(`TurnRecord field \"${fieldName}.requestId\" must match requestId`);
  }

  const callType = parseOptionalCallType(value.callType, `${fieldName}.callType`);
  const purpose = parseOptionalString(value.purpose, `${fieldName}.purpose`);
  const reason = parseOptionalString(value.reason, `${fieldName}.reason`);
  const retrievalSource = parseOptionalRetrievalSource(value.retrievalSource, `${fieldName}.retrievalSource`);

  return {
    observedAt: parseRequiredTimestamp(value.observedAt, `${fieldName}.observedAt`),
    turnId,
    ...(requestId ? { requestId } : {}),
    channelId,
    ...(callType ? { callType } : {}),
    ...(purpose ? { purpose } : {}),
    count: parseRequiredNonNegativeNumber(value.count, `${fieldName}.count`),
    ...(reason ? { reason } : {}),
    ...(retrievalSource ? { retrievalSource } : {}),
    data: parseRequiredJsonRecord(value.data, `${fieldName}.data`),
  };
}

function parseTurnSnapshotRecord(
  value: unknown,
  expected: { turnId: TurnID; requestId: string; channelId: string },
): TurnSnapshotRecord {
  const fieldName = 'observability.snapshot';
  if (!isRecord(value)) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be an object`);
  }

  const turnId = parseRequiredString(value.turnId, `${fieldName}.turnId`);
  if (turnId !== expected.turnId) {
    throw new Error(`TurnRecord field \"${fieldName}.turnId\" must match turnId`);
  }

  const requestId = parseRequiredString(value.requestId, `${fieldName}.requestId`);
  if (requestId !== expected.requestId) {
    throw new Error(`TurnRecord field \"${fieldName}.requestId\" must match requestId`);
  }

  const channelId = parseRequiredString(value.channelId, `${fieldName}.channelId`);
  if (channelId !== expected.channelId) {
    throw new Error(`TurnRecord field \"${fieldName}.channelId\" must match channelId`);
  }

  parseRequiredTimestamp(value.capturedAt, `${fieldName}.capturedAt`);
  parseRequiredString(value.trustLevel, `${fieldName}.trustLevel`);
  return cloneUnknownValue(value) as unknown as TurnSnapshotRecord;
}

function parseTurnObservability(
  value: unknown,
  expected: { turnId: TurnID; requestId: string; channelId: string },
): TurnObservabilityRecord | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('TurnRecord field "observability" must be an object');
  }

  const stagesRaw = value.stages;
  if (!Array.isArray(stagesRaw)) {
    throw new Error('TurnRecord field "observability.stages" must be an array');
  }

  const retrievalsRaw = value.retrievals;
  if (!Array.isArray(retrievalsRaw)) {
    throw new Error('TurnRecord field "observability.retrievals" must be an array');
  }

  const snapshotRaw = value.snapshot;

  return {
    stages: stagesRaw.map((entry, index) => parseTurnStageTelemetryRecord(entry, expected, index)),
    retrievals: retrievalsRaw.map((entry, index) => parseTurnRetrievalTelemetryRecord(entry, expected, index)),
    ...(snapshotRaw !== undefined && snapshotRaw !== null
      ? { snapshot: parseTurnSnapshotRecord(snapshotRaw, expected) }
      : {}),
  };
}

function parseTurnIdOrBackfill(raw: Record<string, unknown>, channelId: string): TurnID {
  const parsed = parseTurnId(raw.turnId, 'turnId');
  if (parsed) return parsed;

  const requestId = parseRequiredString(raw.requestId, 'requestId');
  const startedAt = parseRequiredTimestamp(raw.startedAt, 'startedAt');
  const completedAt = parseRequiredTimestamp(raw.completedAt, 'completedAt');
  const seed = `${channelId}:${requestId}:${startedAt}:${completedAt}`;
  return backfillLegacyTurnId(seed);
}

function normalizeTurnRecord(raw: unknown, expectedChannelId: string): TurnRecord {
  if (!isRecord(raw)) {
    throw new Error('TurnRecord entry must be a JSON object');
  }

  const schemaVersionRaw = raw.schemaVersion;
  if (
    typeof schemaVersionRaw !== 'number'
    || !Number.isFinite(schemaVersionRaw)
    || Math.floor(schemaVersionRaw) !== TURN_RECORD_SCHEMA_VERSION
  ) {
    throw new Error('TurnRecord schemaVersion must be 1');
  }

  const channelId = parseRequiredString(raw.channelId, 'channelId');
  if (channelId !== expectedChannelId) {
    throw new Error(`TurnRecord channel mismatch: expected ${expectedChannelId}, got ${channelId}`);
  }

  const channelType = parseRequiredString(raw.channelType, 'channelType');
  if (!VALID_CHANNEL_TYPES.has(channelType as ChannelType)) {
    throw new Error(`TurnRecord field \"channelType\" is invalid: ${channelType}`);
  }

  const status = parseRequiredString(raw.status, 'status');
  if (!VALID_TURN_STATUSES.has(status as TurnRecord['status'])) {
    throw new Error(`TurnRecord field \"status\" is invalid: ${status}`);
  }

  const turnId = parseTurnIdOrBackfill(raw, channelId);
  const requestId = parseRequiredString(raw.requestId, 'requestId');
  const startedAt = parseRequiredTimestamp(raw.startedAt, 'startedAt');
  const completedAt = parseRequiredTimestamp(raw.completedAt, 'completedAt');

  const userMessage = parseTurnRecordMessage(raw.userMessage, 'userMessage');
  const assistantMessage = raw.assistantMessage === undefined
    ? undefined
    : parseTurnRecordMessage(raw.assistantMessage, 'assistantMessage');
  const toolCalls = parseTurnRecordToolCalls(raw.toolCalls);

  if (raw.versionPointers === undefined) {
    throw new Error('TurnRecord field "versionPointers" is required');
  }
  const versionPointers = parseVersionPointers(raw.versionPointers);

  const contextManifestRef = raw.contextManifestRef;
  const internalStateSnapshotRef = raw.internalStateSnapshotRef;
  const observability = parseTurnObservability(raw.observability, {
    turnId,
    requestId,
    channelId,
  });
  const roleEnvelopeRefs = parseOptionalStringArray(raw.roleEnvelopeRefs, 'roleEnvelopeRefs');
  const location = parseOptionalLocation(raw.location);

  return {
    schemaVersion: TURN_RECORD_SCHEMA_VERSION,
    turnId,
    requestId,
    channelId,
    channelType: channelType as ChannelType,
    startedAt,
    completedAt,
    status: status as TurnRecord['status'],
    ...(location ? { location } : {}),
    userMessage,
    ...(assistantMessage ? { assistantMessage } : {}),
    toolCalls,
    ...(typeof contextManifestRef === 'string' && contextManifestRef.trim().length > 0
      ? { contextManifestRef: contextManifestRef.trim() }
      : {}),
    ...(typeof internalStateSnapshotRef === 'string' && internalStateSnapshotRef.trim().length > 0
      ? { internalStateSnapshotRef: internalStateSnapshotRef.trim() }
      : {}),
    extractedMemoryIds: parseOptionalStringArray(raw.extractedMemoryIds, 'extractedMemoryIds'),
    concernDeltaRefs: parseOptionalStringArray(raw.concernDeltaRefs, 'concernDeltaRefs'),
    contactDeltaRefs: parseOptionalStringArray(raw.contactDeltaRefs, 'contactDeltaRefs'),
    ...(roleEnvelopeRefs.length > 0
      ? { roleEnvelopeRefs }
      : {}),
    ...(observability ? { observability } : {}),
    versionPointers,
    provenanceRefs: parseOptionalStringArray(raw.provenanceRefs, 'provenanceRefs'),
  };
}

function turnRecordsDir(sessionsDir: string): string {
  return join(sessionsDir, TURN_RECORDS_DIR);
}

function segmentFileName(sanitizedChannelId: string, segmentNumber: number): string {
  return `${sanitizedChannelId}.${String(segmentNumber).padStart(5, '0')}.jsonl`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface RotatedSegment {
  segmentNumber: number;
  path: string;
}

/**
 * Discover rotated segments for a channel via a strict filename pattern.
 * Active file: `<sanitized>.jsonl`. Rotated segments: `<sanitized>.00001.jsonl`,
 * `<sanitized>.00002.jsonl`, ... where a higher number is newer. No manifest —
 * the directory listing is the source of truth.
 */
function listRotatedSegments(dir: string, sanitizedChannelId: string): RotatedSegment[] {
  if (!existsSync(dir)) return [];
  const pattern = new RegExp(`^${escapeRegExp(sanitizedChannelId)}\\.(\\d{5,})\\.jsonl$`);
  const segments: RotatedSegment[] = [];
  for (const name of readdirSync(dir)) {
    const match = pattern.exec(name);
    if (!match) continue;
    segments.push({ segmentNumber: Number(match[1]), path: join(dir, name) });
  }
  return segments;
}

function nextFreeSegmentNumber(dir: string, sanitizedChannelId: string): number {
  let maxSegment = 0;
  for (const segment of listRotatedSegments(dir, sanitizedChannelId)) {
    if (segment.segmentNumber > maxSegment) maxSegment = segment.segmentNumber;
  }
  let candidate = maxSegment + 1;
  while (existsSync(join(dir, segmentFileName(sanitizedChannelId, candidate)))) {
    candidate += 1;
  }
  return candidate;
}

function rotateActiveSegment(dir: string, sanitizedChannelId: string, activePath: string): void {
  const segmentNumber = nextFreeSegmentNumber(dir, sanitizedChannelId);
  const target = join(dir, segmentFileName(sanitizedChannelId, segmentNumber));
  renameSync(activePath, target);
  log.info('rotated turn-record segment', {
    channel: sanitizedChannelId,
    segment: segmentNumber,
  });
}

/**
 * Report a line that failed to parse/normalize during a tail read. Consistent
 * with the L0 journal reader: the offending line is quarantined to a sidecar and
 * logged loudly, then the scan continues so a single interrupted append (or a
 * damaged line) never blocks reads of the surrounding valid records. The raw
 * bytes are not copied into the sidecar (they already live in the source file
 * and can carry conversation content) — only the length and reason are recorded.
 */
function quarantineTurnRecordLine(
  path: string,
  channelId: string,
  rawLine: string,
  error: unknown,
): void {
  const reason = toErrorMessage(error);
  log.warn('quarantined unparseable turn-record line', {
    path,
    channelId,
    rawLength: rawLine.length,
    reason,
  });
  try {
    appendJsonLine(`${path}.quarantine`, {
      quarantinedAt: Date.now(),
      channelId,
      rawLength: rawLine.length,
      reason,
    });
  } catch (sidecarError) {
    // A quarantine-sidecar write failure must not mask the records we did read.
    log.warn('failed to persist turn-record quarantine sidecar', {
      path,
      error: toErrorMessage(sidecarError),
    });
  }
}

export interface TurnRecordTailStats {
  bytesRead: number;
}

/**
 * Read up to `limit` turn records from the end of a single segment file without
 * parsing the whole file. Returns records newest-first. Splitting is done at the
 * byte level — a newline (0x0a) can never appear inside a multi-byte UTF-8
 * sequence — so line boundaries and unicode content survive chunk boundaries
 * intact. Lines longer than `chunkBytes` are reassembled across chunks.
 */
function scanSegmentBackward(
  path: string,
  channelId: string,
  limit: number,
  chunkBytes: number,
  stats?: TurnRecordTailStats,
): TurnRecord[] {
  const collected: TurnRecord[] = [];
  if (limit <= 0) return collected;

  const fd = openSync(path, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize <= 0) return collected;

    // Returns true once `limit` records are collected (caller should stop).
    const handleLine = (lineBytes: Buffer): boolean => {
      const text = lineBytes.toString('utf8').trim();
      if (text.length === 0) return false;
      try {
        const parsed = JSON.parse(text) as unknown;
        collected.push(normalizeTurnRecord(parsed, channelId));
      } catch (error) {
        quarantineTurnRecordLine(path, channelId, text, error);
        return false;
      }
      return collected.length >= limit;
    };

    const buffer = Buffer.allocUnsafe(chunkBytes);
    let position = fileSize;
    // Bytes to the LEFT (older) of everything processed so far in the current
    // window that have not yet been terminated by a preceding newline.
    let remainder = Buffer.alloc(0);

    while (position > 0) {
      const bytesToRead = Math.min(chunkBytes, position);
      position -= bytesToRead;
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      if (stats) stats.bytesRead += bytesRead;

      // Freshly-read (older) bytes on the left, carried remainder (newer) on the right.
      const combined = Buffer.concat([buffer.subarray(0, bytesRead), remainder]);
      let lineEnd = combined.length;
      for (let i = combined.length - 1; i >= 0; i--) {
        if (combined[i] !== NEWLINE_BYTE) continue;
        if (handleLine(combined.subarray(i + 1, lineEnd))) return collected;
        lineEnd = i;
      }
      // Everything before the earliest newline is an unterminated fragment that
      // continues into the next (older) chunk.
      remainder = combined.subarray(0, lineEnd);
    }

    if (remainder.length > 0) {
      handleLine(remainder);
    }
  } finally {
    closeSync(fd);
  }

  return collected;
}

export interface ReadRecentTurnRecordsOptions {
  scanChunkBytes?: number;
  stats?: TurnRecordTailStats;
}

/**
 * Read the most recent `limit` turn records for a channel across all segments,
 * newest segment first, until the limit is satisfied. Returns records in
 * ascending (oldest-first) order to match the historical contract.
 */
export function readRecentTurnRecordsAcrossSegments(
  sessionsDir: string,
  channelId: string,
  limit: number,
  options: ReadRecentTurnRecordsOptions = {},
): TurnRecord[] {
  if (limit <= 0) return [];

  const sanitized = sanitizeChannelId(channelId);
  const dir = turnRecordsDir(sessionsDir);
  const chunkBytes = options.scanChunkBytes ?? TURN_RECORD_TAIL_SCAN_CHUNK_BYTES;
  const collectedNewestFirst: TurnRecord[] = [];

  const scanOne = (path: string): void => {
    if (collectedNewestFirst.length >= limit) return;
    if (!existsSync(path)) return;
    const remaining = limit - collectedNewestFirst.length;
    const records = scanSegmentBackward(path, channelId, remaining, chunkBytes, options.stats);
    for (const record of records) collectedNewestFirst.push(record);
  };

  scanOne(join(dir, `${sanitized}.jsonl`));

  const rotated = listRotatedSegments(dir, sanitized).sort(
    (a, b) => b.segmentNumber - a.segmentNumber,
  );
  for (const segment of rotated) {
    if (collectedNewestFirst.length >= limit) break;
    scanOne(segment.path);
  }

  return collectedNewestFirst.slice(0, limit).reverse();
}

/**
 * Append a turn record to the active segment, rotating first if the active file
 * has reached the size cap. Rotation renames the active file to the next free
 * numbered segment (collision-safe) and lets the append recreate a fresh active
 * file. Single writer per process; rename picks the next free number so parallel
 * store instances do not reuse a segment number.
 */
export function appendTurnRecordWithRotation(
  sessionsDir: string,
  record: TurnRecord,
  segmentMaxBytes: number,
): void {
  const normalized = normalizeTurnRecord(record, record.channelId);
  const sanitized = sanitizeChannelId(record.channelId);
  const dir = turnRecordsDir(sessionsDir);
  const activePath = join(dir, `${sanitized}.jsonl`);

  if (existsSync(activePath) && statSync(activePath).size >= segmentMaxBytes) {
    rotateActiveSegment(dir, sanitized, activePath);
  }

  appendJsonLine(activePath, normalized);
}

export interface FilesystemTurnRecordStoreOptions {
  segmentMaxBytes?: number;
  scanChunkBytes?: number;
}

export function createFilesystemTurnRecordStorePort(
  sessionsDir: string,
  options: FilesystemTurnRecordStoreOptions = {},
): TurnRecordStorePort {
  const segmentMaxBytes = options.segmentMaxBytes ?? TURN_RECORD_SEGMENT_MAX_BYTES;
  const scanChunkBytes = options.scanChunkBytes ?? TURN_RECORD_TAIL_SCAN_CHUNK_BYTES;
  const sharedStore = createTurnRecordSharedStore(turnRecordsDir(sessionsDir));
  return {
    appendTurnRecord: (record) => {
      // Content-address duplicated tool definitions (bead hgw3.3) before the
      // rotation-aware append (bead hgw3.4). Slimming runs on the normalized
      // record; the ref round-trips normalizeTurnRecord, so the re-normalize
      // inside appendTurnRecordWithRotation preserves it.
      const slimmed = slimTurnRecordToolDefinitionsForAppend(
        normalizeTurnRecord(record, record.channelId),
        sharedStore,
      );
      appendTurnRecordWithRotation(sessionsDir, slimmed, segmentMaxBytes);
    },
    readRecentTurnRecords: (channelId, limit) => (
      // Refs resolve at the read boundary — only for records actually
      // returned — so every consumer above persistence sees fully inline
      // records. Fail closed: a dangling ref is a loud error (hgw3.3).
      readRecentTurnRecordsAcrossSegments(sessionsDir, channelId, limit, { scanChunkBytes })
        .map(record => resolveTurnRecordToolDefinitions(record, sharedStore))
    ),
  };
}
