import { isRecord } from '../../shared/utils/types.js';
import { join } from 'node:path';
import { appendJsonLine, readJsonLines } from '../jsonl.js';
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

const TURN_RECORDS_DIR = '_turn_records';
const TURN_RECORD_SCHEMA_VERSION = 1;
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

function turnRecordPath(sessionsDir: string, channelId: string): string {
  return join(sessionsDir, TURN_RECORDS_DIR, `${sanitizeChannelId(channelId)}.jsonl`);
}

function readRecentTurnRecordsFromPath(
  path: string,
  channelId: string,
  limit: number,
): TurnRecord[] {
  if (limit <= 0) return [];
  const records = readJsonLines<TurnRecord>(
    path,
    raw => normalizeTurnRecord(raw, channelId),
    {
      onError: ({ line, error }) => {
        if (error instanceof SyntaxError) {
          throw new Error(`TurnRecord JSON parse failed at line ${line} for channel ${channelId}`);
        }
        throw error instanceof Error ? error : new Error(String(error));
      },
    },
  ).entries;

  if (records.length <= limit) return records;
  return records.slice(-limit);
}

export function createFilesystemTurnRecordStorePort(sessionsDir: string): TurnRecordStorePort {
  return {
    appendTurnRecord: (record) => {
      const normalized = normalizeTurnRecord(record, record.channelId);
      appendJsonLine(turnRecordPath(sessionsDir, record.channelId), normalized);
    },
    readRecentTurnRecords: (channelId, limit) => (
      readRecentTurnRecordsFromPath(turnRecordPath(sessionsDir, channelId), channelId, limit)
    ),
  };
}
