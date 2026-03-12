import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonLine } from '../persistence/jsonl.js';
import type {
  ChannelType,
  TurnID,
  TurnRecord,
  TurnRecordMessage,
  TurnRecordToolCall,
  TurnRecordVersionPointers,
} from '../types.js';
import { sanitizeChannelId } from './store-primitives.js';
import { backfillLegacyTurnId, parseTurnId } from '../turns/id.js';

const TURN_RECORDS_DIR = '_turn_records';
const TURN_RECORD_SCHEMA_VERSION = 1;
const VALID_CHANNEL_TYPES = new Set<ChannelType>(['discord', 'terminal', 'api', 'telegram']);
const VALID_TURN_STATUSES = new Set<TurnRecord['status']>(['completed', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function parseRequiredTimestamp(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be a finite non-negative number`);
  }
  return Math.floor(value);
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

  return {
    schemaVersion: TURN_RECORD_SCHEMA_VERSION,
    turnId,
    requestId,
    channelId,
    channelType: channelType as ChannelType,
    startedAt,
    completedAt,
    status: status as TurnRecord['status'],
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
    versionPointers,
    provenanceRefs: parseOptionalStringArray(raw.provenanceRefs, 'provenanceRefs'),
  };
}

function turnRecordPath(sessionsDir: string, channelId: string): string {
  return join(sessionsDir, TURN_RECORDS_DIR, `${sanitizeChannelId(channelId)}.jsonl`);
}

export function appendTurnRecord(sessionsDir: string, record: TurnRecord): void {
  const normalized = normalizeTurnRecord(record, record.channelId);
  appendJsonLine(turnRecordPath(sessionsDir, record.channelId), normalized);
}

export function readRecentTurnRecords(
  sessionsDir: string,
  channelId: string,
  limit: number,
): TurnRecord[] {
  if (limit <= 0) return [];

  const path = turnRecordPath(sessionsDir, channelId);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const records = lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`TurnRecord JSON parse failed at line ${index + 1} for channel ${channelId}`);
    }
    return normalizeTurnRecord(parsed, channelId);
  });

  if (records.length <= limit) return records;
  return records.slice(-limit);
}
