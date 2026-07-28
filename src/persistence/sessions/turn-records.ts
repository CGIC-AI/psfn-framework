import { isRecord } from '../../shared/utils/types.js';
import { normalizeRuntimeFallbackProvenance } from '../../shared/runtime-fallback-provenance.js';
import { join } from 'node:path';
import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  linkSync,
  openSync,
  statSync,
  type Stats,
  unlinkSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { appendJsonLine } from '../jsonl.js';
import { withCrossProcessWriteLock } from './cross-process-write-lock.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  CHANNEL_TYPES,
  isToolCallErrorOutcome,
  isToolCallOutcome,
  type ChannelType,
  type ParentTurnContinuationStop,
  type TurnID,
  type TurnRecord,
  type TurnRecordAuditPrivacy,
  type TurnRecordBackgroundWorkHandoff,
  type TurnRecordBackgroundWorkKind,
  type TurnRecordLocation,
  type TurnRecordMessage,
  type TurnRecordToolCall,
  type TurnRecordVersionPointers,
} from '../../shared/contracts/runtime.js';
import { isChannelPrivacy } from '../../system/trust/context-envelope.js';
import {
  isObservabilityCallType,
  type ObservabilityCallType,
} from '../../shared/contracts/observability-call-types.js';
import { sanitizeChannelId } from './store-file-contracts.js';
import { backfillLegacyTurnId, parseTurnId } from '../../core/turns/id.js';
import type {
  TurnObservabilityRecord,
  TurnRetrievalTelemetryRecord,
  TurnSnapshotRecord,
  TurnStageTelemetryRecord,
} from '../../core/turns/observability.js';
import { cloneUnknownValue } from '../../core/turns/observability.js';
import type {
  TurnRecordPage,
  TurnRecordPageCursor,
  TurnRecordStorePort,
  TurnRecordUsageRecord,
} from './turn-record-store-port.js';
import { parseIcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import { resolveToolCallOutcome } from '../../shared/contracts/tool-call-outcome.js';
import {
  createTurnRecordSharedStore,
  resolveTurnRecordStaticPrompt,
  resolveTurnRecordToolDefinitions,
  resolveTurnRecordWirePayload,
  slimTurnRecordStaticPromptForAppend,
  slimTurnRecordToolDefinitionsForAppend,
  slimTurnRecordWirePayloadForAppend,
} from './turn-record-shared-store.js';
import {
  fileIdentityKey,
  listNumberedJsonlSegments,
  scanJsonlFileBackward,
  type NumberedJsonlSegment,
} from '../jsonl-segments.js';
import {
  readJsonlSnapshotPage,
  type JsonlSnapshotPageStats,
} from '../jsonl-snapshot-cursor.js';

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

/**
 * Rotation lock parameters. Rotation shares the mkdir-based cross-process lock
 * mechanism the session-journal write path uses (agent, gateway, and garden
 * all mount the sessions dir), scoped per channel via the active-file path.
 */
const ROTATION_LOCK_SUFFIX = '.rotate-lock';
const ROTATION_LOCK_POLL_MS = 10;
const ROTATION_LOCK_STALE_MS = 30_000;
const ROTATION_LOCK_TIMEOUT_MS = 5_000;
/** Attempts to claim a free segment number before rotation fails loudly. */
const ROTATION_SEGMENT_CLAIM_ATTEMPTS = 100;
/**
 * Restarts a tail read is allowed after losing a race with a concurrent
 * rotation (a listed file vanished between listing and open) before the read
 * fails loudly.
 */
const TAIL_READ_ROTATION_RETRIES = 3;

/** Process-lifetime count of quarantined turn-record lines (finding: the
 * quarantine warn alone was easy to miss; this backs a stable counter event). */
let quarantinedTurnRecordLineCount = 0;

/** Test/observability hook: process-lifetime quarantined-line counter. */
export function getQuarantinedTurnRecordLineCount(): number {
  return quarantinedTurnRecordLineCount;
}
const VALID_CHANNEL_TYPES = new Set<ChannelType>(CHANNEL_TYPES);
const VALID_TURN_STATUSES = new Set<TurnRecord['status']>(['completed', 'failed']);
const VALID_BACKGROUND_WORK_KINDS = new Set<TurnRecordBackgroundWorkKind>([
  'memory_extraction',
  'intention_post_turn_hooks',
  'emotion_appraisal',
  'auto_compaction',
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

function parseOptionalCallType(value: unknown, fieldName: string): ObservabilityCallType | undefined {
  const normalized = parseOptionalString(value, fieldName);
  if (!normalized) return undefined;
  if (!isObservabilityCallType(normalized)) {
    throw new Error(`TurnRecord field \"${fieldName}\" is invalid: ${normalized}`);
  }
  return normalized;
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

function parseRequiredSafeInteger(value: unknown, fieldName: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function parseOptionalContinuationStop(value: unknown): ParentTurnContinuationStop | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('TurnRecord field "continuationStop" must be an object');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('TurnRecord field "continuationStop.schemaVersion" must be 1');
  }
  const reason = value.reason;
  if (reason !== 'wall_clock_limit' && reason !== 'prompt_entry_limit') {
    throw new Error('TurnRecord field "continuationStop.reason" is invalid');
  }
  const outcome = value.outcome;
  if (outcome !== 'failed' && outcome !== 'partial') {
    throw new Error('TurnRecord field "continuationStop.outcome" is invalid');
  }
  const promptEntries = parseRequiredSafeInteger(
    value.promptEntries,
    'continuationStop.promptEntries',
    0,
  );
  const maxPromptEntries = parseRequiredSafeInteger(
    value.maxPromptEntries,
    'continuationStop.maxPromptEntries',
    1,
  );
  if (promptEntries > maxPromptEntries) {
    throw new Error('TurnRecord continuationStop.promptEntries exceeds maxPromptEntries');
  }
  return {
    schemaVersion: 1,
    reason,
    outcome,
    promptEntries,
    maxPromptEntries,
    elapsedMs: parseRequiredSafeInteger(value.elapsedMs, 'continuationStop.elapsedMs', 0),
    maxWallTimeMs: parseRequiredSafeInteger(
      value.maxWallTimeMs,
      'continuationStop.maxWallTimeMs',
      1,
    ),
  };
}

function parseOptionalAuditPrivacy(value: unknown): TurnRecordAuditPrivacy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('TurnRecord field "auditPrivacy" must be an object');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('TurnRecord field "auditPrivacy.schemaVersion" must be 1');
  }
  const contentMode = value.contentMode;
  if (contentMode !== 'verbatim_public' && contentMode !== 'emotional_signal_only') {
    throw new Error('TurnRecord field "auditPrivacy.contentMode" is invalid');
  }
  const reason = value.reason;
  const validReasons: TurnRecordAuditPrivacy['reason'][] = [
    'explicit_public_non_dm',
    'direct_message',
    'non_public_channel',
    'intimate_content',
    'missing_or_ambiguous_content_sensitivity',
    'missing_or_ambiguous_privacy',
  ];
  if (!validReasons.includes(reason as TurnRecordAuditPrivacy['reason'])) {
    throw new Error('TurnRecord field "auditPrivacy.reason" is invalid');
  }
  const channelPrivacy = value.channelPrivacy;
  if (channelPrivacy !== undefined && !isChannelPrivacy(channelPrivacy)) {
    throw new Error('TurnRecord field "auditPrivacy.channelPrivacy" is invalid');
  }
  const contentSensitivity = value.contentSensitivity;
  if (
    contentSensitivity !== 'non_intimate'
    && contentSensitivity !== 'intimate'
    && contentSensitivity !== 'ambiguous'
  ) {
    throw new Error('TurnRecord field "auditPrivacy.contentSensitivity" is invalid');
  }
  const contentSensitivityActor = value.contentSensitivityActor;
  if (contentSensitivityActor !== undefined && (
    !isRecord(contentSensitivityActor)
    || contentSensitivityActor.kind !== 'companion'
    || Object.keys(contentSensitivityActor).length !== 3
    || Object.keys(contentSensitivityActor).some(key => !['kind', 'turnId', 'requestId'].includes(key))
  )) {
    throw new Error('TurnRecord field "auditPrivacy.contentSensitivityActor" is invalid');
  }
  const normalizedSensitivityActor = contentSensitivityActor === undefined
    ? undefined
    : {
      kind: 'companion' as const,
      turnId: parseRequiredString(contentSensitivityActor.turnId, 'auditPrivacy.contentSensitivityActor.turnId') as TurnID,
      requestId: parseRequiredString(contentSensitivityActor.requestId, 'auditPrivacy.contentSensitivityActor.requestId'),
    };
  if (
    contentMode === 'verbatim_public'
    && (
      channelPrivacy !== 'public'
      || contentSensitivity !== 'non_intimate'
      || !normalizedSensitivityActor
      || reason !== 'explicit_public_non_dm'
    )
  ) {
    throw new Error('TurnRecord auditPrivacy verbatim mode requires explicit non-intimate public provenance');
  }
  return {
    schemaVersion: 1,
    contentMode,
    ...(channelPrivacy ? { channelPrivacy } : {}),
    contentSensitivity,
    ...(normalizedSensitivityActor ? { contentSensitivityActor: normalizedSensitivityActor } : {}),
    reason: reason as TurnRecordAuditPrivacy['reason'],
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
  const replyToMessageId = value.replyToMessageId;
  const runtimeFallbackProvenance = value.runtimeFallbackProvenance;

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
    ...(typeof replyToMessageId === 'string' && replyToMessageId.trim().length > 0
      ? { replyToMessageId: replyToMessageId.trim() }
      : {}),
    ...(runtimeFallbackProvenance !== undefined
      ? {
        runtimeFallbackProvenance: normalizeRuntimeFallbackProvenance(
          runtimeFallbackProvenance,
          `${fieldName}.runtimeFallbackProvenance`,
        ),
      }
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
    const outcome = entry.outcome;
    const isError = entry.isError;
    const resultText = entry.resultText;
    if (outcome !== undefined && !isToolCallOutcome(outcome)) {
      throw new Error(`TurnRecord field "toolCalls[${index}].outcome" is unsupported`);
    }
    if (
      outcome !== undefined
      && typeof isError === 'boolean'
      && isError !== isToolCallErrorOutcome(outcome)
    ) {
      throw new Error(`TurnRecord fields "toolCalls[${index}].outcome" and "isError" conflict`);
    }

    return {
      toolName,
      ...(typeof toolCallId === 'string' && toolCallId.trim().length > 0
        ? { toolCallId: toolCallId.trim() }
        : {}),
      ...(outcome !== undefined ? { outcome } : {}),
      ...(outcome !== undefined
        ? { isError: isToolCallErrorOutcome(outcome) }
        : typeof isError === 'boolean'
          ? { isError }
          : {}),
      ...(typeof resultText === 'string' && resultText.length > 0 ? { resultText } : {}),
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

function parseBackgroundWorkSafeInteger(
  value: unknown,
  fieldName: string,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`TurnRecord field \"${fieldName}\" must be a safe integer >= ${String(minimum)}`);
  }
  return value as number;
}

function parseBackgroundWorkHandoff(
  value: unknown,
  expected: {
    turnId: TurnID;
    requestId: string;
    sessionId: string;
    channelId: string;
    completedAt: number;
  },
): TurnRecordBackgroundWorkHandoff | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('TurnRecord field "backgroundWorkHandoff" must use schemaVersion 1');
  }
  if (Object.keys(value).some(key => key !== 'schemaVersion' && key !== 'jobs')) {
    throw new Error('TurnRecord field "backgroundWorkHandoff" contains unsupported fields');
  }
  if (!Array.isArray(value.jobs) || value.jobs.length < 1 || value.jobs.length > 4) {
    throw new Error('TurnRecord field "backgroundWorkHandoff.jobs" must contain 1-4 jobs');
  }
  const seenKinds = new Set<TurnRecordBackgroundWorkKind>();
  const jobs = value.jobs.map((rawJob, index) => {
    const fieldName = `backgroundWorkHandoff.jobs[${String(index)}]`;
    if (!isRecord(rawJob)) throw new Error(`TurnRecord field \"${fieldName}\" must be an object`);
    const allowedKeys = new Set([
      'jobId',
      'idempotencyKey',
      'logicalSessionId',
      'kind',
      'payload',
      'payloadFingerprint',
      'sourceTurnId',
      'sourceRequestId',
      'sourceChannelId',
      'createdAtMs',
      'maxAttempts',
    ]);
    if (Object.keys(rawJob).some(key => !allowedKeys.has(key))) {
      throw new Error(`TurnRecord field \"${fieldName}\" contains unsupported fields`);
    }
    const kind = parseRequiredString(rawJob.kind, `${fieldName}.kind`) as TurnRecordBackgroundWorkKind;
    if (!VALID_BACKGROUND_WORK_KINDS.has(kind) || seenKinds.has(kind)) {
      throw new Error(`TurnRecord field \"${fieldName}.kind\" is invalid or duplicated`);
    }
    seenKinds.add(kind);
    if (!isRecord(rawJob.payload)) {
      throw new Error(`TurnRecord field \"${fieldName}.payload\" must be an object`);
    }
    const logicalSessionId = parseRequiredString(rawJob.logicalSessionId, `${fieldName}.logicalSessionId`);
    const sourceTurnId = parseRequiredString(rawJob.sourceTurnId, `${fieldName}.sourceTurnId`);
    const sourceRequestId = parseRequiredString(rawJob.sourceRequestId, `${fieldName}.sourceRequestId`);
    const sourceChannelId = parseRequiredString(rawJob.sourceChannelId, `${fieldName}.sourceChannelId`);
    const createdAtMs = parseBackgroundWorkSafeInteger(rawJob.createdAtMs, `${fieldName}.createdAtMs`, 0);
    if (logicalSessionId !== expected.sessionId
      || sourceTurnId !== expected.turnId
      || sourceRequestId !== expected.requestId
      || sourceChannelId !== expected.channelId
      || createdAtMs !== expected.completedAt) {
      throw new Error(`TurnRecord field \"${fieldName}\" does not bind to its owning turn`);
    }
    return {
      jobId: parseRequiredString(rawJob.jobId, `${fieldName}.jobId`),
      idempotencyKey: parseRequiredString(rawJob.idempotencyKey, `${fieldName}.idempotencyKey`),
      logicalSessionId,
      kind,
      payload: cloneUnknownValue(rawJob.payload),
      payloadFingerprint: parseRequiredString(
        rawJob.payloadFingerprint,
        `${fieldName}.payloadFingerprint`,
      ),
      sourceTurnId,
      sourceRequestId,
      sourceChannelId,
      createdAtMs,
      maxAttempts: parseBackgroundWorkSafeInteger(rawJob.maxAttempts, `${fieldName}.maxAttempts`, 1),
    };
  });
  return { schemaVersion: 1, jobs };
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
  const sessionId = raw.sessionId === undefined
    ? undefined
    : parseRequiredString(raw.sessionId, 'sessionId');
  const startedAt = parseRequiredTimestamp(raw.startedAt, 'startedAt');
  const completedAt = parseRequiredTimestamp(raw.completedAt, 'completedAt');
  const backgroundWorkHandoff = parseBackgroundWorkHandoff(raw.backgroundWorkHandoff, {
    turnId,
    requestId,
    sessionId: sessionId ?? channelId,
    channelId,
    completedAt,
  });

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
    ...(sessionId ? { sessionId } : {}),
    channelId,
  });
  const roleEnvelopeRefs = parseOptionalStringArray(raw.roleEnvelopeRefs, 'roleEnvelopeRefs');
  const location = parseOptionalLocation(raw.location);
  const icpCorrelation = raw.icpCorrelation === undefined
    ? undefined
    : parseIcpConversationCorrelation(raw.icpCorrelation);
  if (icpCorrelation
    && (icpCorrelation.channelId !== channelId
      || icpCorrelation.turnId !== turnId
      || icpCorrelation.requestId !== requestId)) {
    throw new Error('TurnRecord ICP correlation does not match its channel/turn/request binding');
  }
  const auditPrivacy = parseOptionalAuditPrivacy(raw.auditPrivacy);
  const channelPrivacy = raw.channelPrivacy;
  if (channelPrivacy !== undefined && !isChannelPrivacy(channelPrivacy)) {
    throw new Error('TurnRecord field "channelPrivacy" is invalid');
  }
  const continuationStop = parseOptionalContinuationStop(raw.continuationStop);
  if (continuationStop && status !== 'failed') {
    throw new Error('TurnRecord continuationStop requires status "failed"');
  }
  if (backgroundWorkHandoff && status !== 'completed') {
    throw new Error('TurnRecord backgroundWorkHandoff requires status "completed"');
  }
  if (
    auditPrivacy?.contentSensitivityActor
    && (
      auditPrivacy.contentSensitivityActor.turnId !== turnId
      || auditPrivacy.contentSensitivityActor.requestId !== requestId
    )
  ) {
    throw new Error('TurnRecord auditPrivacy sensitivity actor must match the owning turn');
  }

  return {
    schemaVersion: TURN_RECORD_SCHEMA_VERSION,
    turnId,
    requestId,
    ...(sessionId ? { sessionId } : {}),
    channelId,
    channelType: channelType as ChannelType,
    startedAt,
    completedAt,
    status: status as TurnRecord['status'],
    ...(continuationStop ? { continuationStop } : {}),
    ...(location ? { location } : {}),
    ...(auditPrivacy ? { auditPrivacy } : {}),
    ...(channelPrivacy ? { channelPrivacy } : {}),
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
    ...(icpCorrelation ? { icpCorrelation } : {}),
    versionPointers,
    provenanceRefs: parseOptionalStringArray(raw.provenanceRefs, 'provenanceRefs'),
    ...(backgroundWorkHandoff ? { backgroundWorkHandoff } : {}),
  };
}

function turnRecordsDir(sessionsDir: string): string {
  return join(sessionsDir, TURN_RECORDS_DIR);
}

function segmentFileName(sanitizedChannelId: string, segmentNumber: number): string {
  return `${sanitizedChannelId}.${String(segmentNumber).padStart(5, '0')}.jsonl`;
}

/**
 * Discover rotated segments for a channel via a strict filename pattern.
 * Active file: `<sanitized>.jsonl`. Rotated segments: `<sanitized>.00001.jsonl`,
 * `<sanitized>.00002.jsonl`, ... where a higher number is newer. No manifest —
 * the directory listing is the source of truth.
 */
function listRotatedSegments(dir: string, sanitizedChannelId: string): NumberedJsonlSegment[] {
  return listNumberedJsonlSegments(join(dir, `${sanitizedChannelId}.jsonl`));
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

/**
 * Finish a rotation that a previous process started but did not complete: it
 * hard-linked the active file to a segment name and crashed before unlinking
 * the active name, so both names point at the same inode. Appends after the
 * crash landed in that shared inode (i.e. in the segment), so simply dropping
 * the active name completes the rotation without losing or duplicating data.
 */
function completeInterruptedRotation(
  dir: string,
  sanitizedChannelId: string,
  activePath: string,
  activeIdentity: string,
): boolean {
  for (const segment of listRotatedSegments(dir, sanitizedChannelId)) {
    let segmentStat;
    try {
      segmentStat = statSync(segment.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (fileIdentityKey(segmentStat) !== activeIdentity) continue;
    unlinkSync(activePath);
    log.warn('completed an interrupted turn-record rotation', {
      channel: sanitizedChannelId,
      segment: segment.segmentNumber,
    });
    return true;
  }
  return false;
}

/**
 * Rotate the active file into the next free numbered segment. MUST run under
 * the per-channel rotation lock. The destination is claimed with linkSync —
 * an exclusive primitive that fails EEXIST instead of clobbering — so even a
 * writer that bypasses the lock (older binary, manual tooling) can never
 * overwrite a completed segment; a collision just advances to the next number.
 */
function rotateActiveSegmentLocked(dir: string, sanitizedChannelId: string, activePath: string): void {
  const activeIdentity = fileIdentityKey(statSync(activePath));
  if (completeInterruptedRotation(dir, sanitizedChannelId, activePath, activeIdentity)) {
    return;
  }
  for (let attempt = 0; attempt < ROTATION_SEGMENT_CLAIM_ATTEMPTS; attempt++) {
    const segmentNumber = nextFreeSegmentNumber(dir, sanitizedChannelId);
    const target = join(dir, segmentFileName(sanitizedChannelId, segmentNumber));
    try {
      linkSync(activePath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another writer claimed this number between our scan and the link.
      // The claimed segment is left untouched; retry with the next number.
      continue;
    }
    unlinkSync(activePath);
    log.info('rotated turn-record segment', {
      channel: sanitizedChannelId,
      segment: segmentNumber,
    });
    return;
  }
  throw new Error(
    `Failed to claim a free turn-record segment number for channel ${sanitizedChannelId} `
    + `after ${ROTATION_SEGMENT_CLAIM_ATTEMPTS} attempts`,
  );
}

/**
 * Rotate the active file if it reached the size cap. The whole decision +
 * rename runs under a cross-process per-channel lock (same mkdir mechanism as
 * session-journal writes) so two writers can never pick the same "free"
 * segment number or rotate a freshly-created active file; the size check is
 * re-evaluated under the lock because the loser of the race sees the new,
 * small active file and must skip.
 */
function maybeRotateActiveSegment(
  dir: string,
  sanitizedChannelId: string,
  activePath: string,
  segmentMaxBytes: number,
): void {
  let preLockSize: number;
  try {
    preLockSize = statSync(activePath).size;
  } catch (error) {
    // No active file (never written, or a concurrent rotation just moved it):
    // nothing to rotate; the append recreates it.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (preLockSize < segmentMaxBytes) return;
  withCrossProcessWriteLock(`${activePath}${ROTATION_LOCK_SUFFIX}`, {
    pollMs: ROTATION_LOCK_POLL_MS,
    staleMs: ROTATION_LOCK_STALE_MS,
    timeoutMs: ROTATION_LOCK_TIMEOUT_MS,
  }, () => {
    let size: number;
    try {
      size = statSync(activePath).size;
    } catch (error) {
      // A concurrent writer already rotated while we waited for the lock.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (size < segmentMaxBytes) return;
    rotateActiveSegmentLocked(dir, sanitizedChannelId, activePath);
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
  // Stable counter event: quarantining keeps reads alive but makes the served
  // window incomplete, which must be observable beyond the warn line above.
  // The error-level record lands in the diagnostic log ring (Garden-visible);
  // no telemetry port is reachable from this layer, so this is the emission.
  quarantinedTurnRecordLineCount += 1;
  log.error('turn_record_line_quarantined', {
    channelId,
    path,
    reason,
    quarantinedLinesThisProcess: quarantinedTurnRecordLineCount,
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
function scanSegmentBackward<T>(
  path: string,
  channelId: string,
  limit: number,
  chunkBytes: number,
  stats: TurnRecordTailStats | undefined,
  scannedFileIdentities: Set<string>,
  project: (record: TurnRecord) => T,
): T[] {
  const collected: T[] = [];
  if (limit <= 0) return collected;

  scanJsonlFileBackward(path, {
    chunkBytes,
    stats,
    scannedFileIdentities,
  }, (line) => {
    const text = line.trim();
    if (text.length === 0) return false;
    try {
      const parsed = JSON.parse(text) as unknown;
      collected.push(project(normalizeTurnRecord(parsed, channelId)));
    } catch (error) {
      quarantineTurnRecordLine(path, channelId, text, error);
      return false;
    }
    return collected.length >= limit;
  });

  return collected;
}

export interface ReadRecentTurnRecordsOptions {
  scanChunkBytes?: number;
  stats?: TurnRecordTailStats;
}

export interface TurnRecordPageStats extends TurnRecordTailStats, JsonlSnapshotPageStats {
  /** Rows that normalized successfully before shared-reference resolution. */
  normalizedRecords: number;
}

export interface ReadTurnRecordPageOptions {
  scanChunkBytes?: number;
  stats?: TurnRecordPageStats;
}

/**
 * Read one bounded physical page from a fixed active+rotated segment snapshot.
 *
 * Page order matches the historical recent-read contract (oldest-to-newest
 * within each page), while continuation advances from newest toward older
 * rows. Exactly `limit` physical JSONL rows at most are parsed per call.
 */
export function readTurnRecordPageAcrossSegments(
  sessionsDir: string,
  channelId: string,
  limit: number,
  cursor?: TurnRecordPageCursor,
  options: ReadTurnRecordPageOptions = {},
): TurnRecordPage {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('TurnRecord page limit must be a positive safe integer');
  }
  const sanitized = sanitizeChannelId(channelId);
  const dir = turnRecordsDir(sessionsDir);
  const page = readJsonlSnapshotPage(
    join(dir, `${sanitized}.jsonl`),
    channelId,
    limit,
    cursor,
    {
      chunkBytes: options.scanChunkBytes ?? TURN_RECORD_TAIL_SCAN_CHUNK_BYTES,
      rotationRetries: TAIL_READ_ROTATION_RETRIES,
      stats: options.stats,
    },
  );
  const newestFirst: TurnRecord[] = [];
  for (const raw of page.lines) {
    const text = raw.line.trim();
    if (!text) continue;
    try {
      newestFirst.push(normalizeTurnRecord(JSON.parse(text) as unknown, channelId));
      if (options.stats) options.stats.normalizedRecords += 1;
    } catch (error) {
      quarantineTurnRecordLine(
        raw.path,
        channelId,
        text,
        error,
      );
    }
  }
  return {
    records: newestFirst.reverse(),
    exhausted: page.exhausted,
    ...(page.nextCursor
      ? { nextCursor: page.nextCursor as TurnRecordPageCursor }
      : {}),
  };
}

/**
 * One full tail pass over the active file plus rotated segments, newest first.
 * Throws ENOENT if a listed file vanished before it could be opened (a
 * concurrent rotation won the race); the caller restarts from a fresh listing.
 */
function readRecentTurnRecordProjectionOnce<T>(
  dir: string,
  sanitized: string,
  channelId: string,
  limit: number,
  chunkBytes: number,
  project: (record: TurnRecord) => T,
  stats?: TurnRecordTailStats,
): T[] {
  const collectedNewestFirst: T[] = [];
  const scannedFileIdentities = new Set<string>();

  const scanOne = (path: string): void => {
    if (collectedNewestFirst.length >= limit) return;
    if (!existsSync(path)) return;
    const remaining = limit - collectedNewestFirst.length;
    const records = scanSegmentBackward(
      path,
      channelId,
      remaining,
      chunkBytes,
      stats,
      scannedFileIdentities,
      project,
    );
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
 * Read the most recent `limit` turn records for a channel across all segments,
 * newest segment first, until the limit is satisfied. Returns records in
 * ascending (oldest-first) order to match the historical contract.
 *
 * Coherent against concurrent rotation: a file that disappears between the
 * existence check and the open (ENOENT) restarts the whole scan from a fresh
 * segment listing (bounded retries, then a loud error), and files already
 * scanned in this read are skipped by (dev, ino) so a rotated active file is
 * never counted twice.
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

  for (let attempt = 0; ; attempt++) {
    try {
      return readRecentTurnRecordProjectionOnce(
        dir,
        sanitized,
        channelId,
        limit,
        chunkBytes,
        record => record,
        options.stats,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (attempt >= TAIL_READ_ROTATION_RETRIES) {
        throw new Error(
          `Turn-record tail read for channel ${channelId} kept losing races with segment rotation `
          + `after ${TAIL_READ_ROTATION_RETRIES} restarts: ${toErrorMessage(error)}`,
        );
      }
      log.warn('turn-record tail read raced a rotation; restarting from a fresh segment listing', {
        channelId,
        attempt: attempt + 1,
        error: toErrorMessage(error),
      });
    }
  }
}

/**
 * Read the content-free projection consumed by the deterministic tool-usage
 * evaluator. Each full JSON row is normalized and immediately projected while
 * scanning; only the small projection is retained across rows. Session-context
 * references and captured bodies are deliberately not resolved because this
 * caller neither observes nor returns them.
 */
export function readRecentTurnRecordUsageAcrossSegments(
  sessionsDir: string,
  channelId: string,
  limit: number,
  options: ReadRecentTurnRecordsOptions = {},
): TurnRecordUsageRecord[] {
  if (limit <= 0) return [];

  const sanitized = sanitizeChannelId(channelId);
  const dir = turnRecordsDir(sessionsDir);
  const chunkBytes = options.scanChunkBytes ?? TURN_RECORD_TAIL_SCAN_CHUNK_BYTES;

  for (let attempt = 0; ; attempt++) {
    try {
      return readRecentTurnRecordProjectionOnce(
        dir,
        sanitized,
        channelId,
        limit,
        chunkBytes,
        record => ({
          turnId: record.turnId,
          startedAt: record.startedAt,
          toolCalls: record.toolCalls.map((toolCall) => {
            const outcome = resolveToolCallOutcome(toolCall);
            return {
              toolName: toolCall.toolName,
              ...(outcome ? { outcome } : {}),
              ...(typeof toolCall.isError === 'boolean'
                ? { isError: toolCall.isError }
                : {}),
            };
          }),
        }),
        options.stats,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (attempt >= TAIL_READ_ROTATION_RETRIES) {
        throw new Error(
          `Turn-record usage tail read for channel ${channelId} kept losing races with segment rotation `
          + `after ${TAIL_READ_ROTATION_RETRIES} restarts: ${toErrorMessage(error)}`,
        );
      }
      log.warn('turn-record usage tail read raced a rotation; restarting from a fresh segment listing', {
        channelId,
        attempt: attempt + 1,
        error: toErrorMessage(error),
      });
    }
  }
}

/**
 * Async, constant-retention scan for one-time startup recovery. Segment files
 * are snapshotted oldest-to-newest and de-duplicated by inode, including the
 * interrupted-rotation hard-link case. The iterator yields to the event loop
 * after at most eight normalized rows so admin health and inbound delivery stay
 * responsive while a large historical archive is inspected.
 */
async function* streamTurnRecordsForRecovery(
  sessionsDir: string,
  channelId: string,
): AsyncGenerator<TurnRecord> {
  const sanitized = sanitizeChannelId(channelId);
  const dir = turnRecordsDir(sessionsDir);
  const activePath = join(dir, `${sanitized}.jsonl`);
  const scannedFileIdentities = new Set<string>();
  let recordsSinceYield = 0;
  const scanOpenSnapshot = async function* (
    path: string,
    fd: number,
    snapshot: Stats,
  ): AsyncGenerator<TurnRecord> {
    const identity = fileIdentityKey(snapshot);
    if (scannedFileIdentities.has(identity) || snapshot.size === 0) {
      closeSync(fd);
      return;
    }
    scannedFileIdentities.add(identity);
    const input = createReadStream(path, {
      fd,
      autoClose: true,
      start: 0,
      end: snapshot.size - 1,
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          yield normalizeTurnRecord(JSON.parse(line) as unknown, channelId);
        } catch (error) {
          quarantineTurnRecordLine(path, channelId, line, error);
        }
        recordsSinceYield += 1;
        if (recordsSinceYield >= 8) {
          recordsSinceYield = 0;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
  };
  const openSnapshot = (path: string): {
    fd: number;
    snapshot: Stats;
  } | null => {
    try {
      const fd = openSync(path, 'r');
      try {
        return { fd, snapshot: fstatSync(fd) };
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  // Pin the active inode before listing rotated segments. If rotation races
  // this scan, the old active inode is either scanned through this descriptor
  // or through its new numbered hard link (with inode de-duplication), while a
  // new active file belongs to the next recovery snapshot.
  const activeSnapshot = openSnapshot(activePath);
  let activeSnapshotHandedOff = false;
  try {
    const rotatedPaths = listRotatedSegments(dir, sanitized)
      .sort((left, right) => left.segmentNumber - right.segmentNumber)
      .map(segment => segment.path);
    for (const path of rotatedPaths) {
      const opened = openSnapshot(path);
      if (!opened) continue;
      yield* scanOpenSnapshot(path, opened.fd, opened.snapshot);
    }
    if (activeSnapshot) {
      activeSnapshotHandedOff = true;
      yield* scanOpenSnapshot(activePath, activeSnapshot.fd, activeSnapshot.snapshot);
    }
  } finally {
    if (activeSnapshot && !activeSnapshotHandedOff) {
      closeSync(activeSnapshot.fd);
    }
  }
}

function findTurnRecordOnce(
  dir: string,
  sanitized: string,
  channelId: string,
  turnId: string,
  chunkBytes: number,
): TurnRecord | null {
  const scannedFileIdentities = new Set<string>();
  const scanOne = (path: string): TurnRecord | null => {
    if (!existsSync(path)) return null;
    let found: TurnRecord | null = null;
    scanJsonlFileBackward(path, {
      chunkBytes,
      scannedFileIdentities,
    }, (rawLine) => {
      const line = rawLine.trim();
      if (line.length === 0) return false;
      try {
        const record = normalizeTurnRecord(JSON.parse(line) as unknown, channelId);
        if (record.turnId !== turnId) return false;
        found = record;
        return true;
      } catch (error) {
        quarantineTurnRecordLine(path, channelId, line, error);
        return false;
      }
    });
    return found;
  };

  const activeMatch = scanOne(join(dir, `${sanitized}.jsonl`));
  if (activeMatch) return activeMatch;
  const rotated = listRotatedSegments(dir, sanitized).sort(
    (left, right) => right.segmentNumber - left.segmentNumber,
  );
  for (const segment of rotated) {
    const match = scanOne(segment.path);
    if (match) return match;
  }
  return null;
}

function findTurnRecordAcrossSegments(
  sessionsDir: string,
  channelId: string,
  turnId: string,
  chunkBytes: number,
): TurnRecord | null {
  const sanitized = sanitizeChannelId(channelId);
  const dir = turnRecordsDir(sessionsDir);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return findTurnRecordOnce(dir, sanitized, channelId, turnId, chunkBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (attempt >= TAIL_READ_ROTATION_RETRIES) {
        throw new Error(
          `Turn-record lookup for channel ${channelId} kept losing races with segment rotation `
          + `after ${TAIL_READ_ROTATION_RETRIES} restarts: ${toErrorMessage(error)}`,
        );
      }
      log.warn('turn-record lookup raced a rotation; restarting from a fresh segment listing', {
        channelId,
        turnId,
        attempt: attempt + 1,
        error: toErrorMessage(error),
      });
    }
  }
}

function countTurnRecordMatchesOnce(
  dir: string,
  sanitized: string,
  channelId: string,
  turnId: string,
  chunkBytes: number,
): number {
  const scannedFileIdentities = new Set<string>();
  let matches = 0;
  const scanOne = (path: string): void => {
    if (matches >= 2 || !existsSync(path)) return;
    scanJsonlFileBackward(path, {
      chunkBytes,
      scannedFileIdentities,
    }, (rawLine) => {
      const line = rawLine.trim();
      if (!line) return false;
      try {
        if (normalizeTurnRecord(JSON.parse(line) as unknown, channelId).turnId === turnId) {
          matches += 1;
        }
      } catch (error) {
        quarantineTurnRecordLine(path, channelId, line, error);
      }
      return matches >= 2;
    });
  };
  scanOne(join(dir, `${sanitized}.jsonl`));
  for (const segment of listRotatedSegments(dir, sanitized)
    .sort((left, right) => right.segmentNumber - left.segmentNumber)) {
    scanOne(segment.path);
    if (matches >= 2) break;
  }
  return matches;
}

function countTurnRecordsByTurnIdAcrossSegments(
  sessionsDir: string,
  channelId: string,
  turnId: string,
  chunkBytes: number,
): number {
  const sanitized = sanitizeChannelId(channelId);
  const dir = turnRecordsDir(sessionsDir);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return countTurnRecordMatchesOnce(
        dir,
        sanitized,
        channelId,
        turnId,
        chunkBytes,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (attempt >= TAIL_READ_ROTATION_RETRIES) {
        throw new Error(
          `Turn-record identity count for channel ${channelId} kept losing races with segment rotation `
          + `after ${TAIL_READ_ROTATION_RETRIES} restarts: ${toErrorMessage(error)}`,
        );
      }
    }
  }
}

/**
 * Append a turn record to the active segment, rotating first if the active file
 * has reached the size cap. Rotation hard-links the active file to the next
 * free numbered segment under a cross-process per-channel lock (exclusive
 * create, never a clobbering rename) and lets the append recreate a fresh
 * active file.
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

  maybeRotateActiveSegment(dir, sanitized, activePath, segmentMaxBytes);

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
      // Content-address duplicated tool definitions (bead hgw3.3), captured
      // wire bodies (bead hgw3-80f6), and the session-stable static system
      // prompt prefix (bead auiu) before the rotation-aware append (bead
      // hgw3.4). Each projection touches an independent field, so ordering is
      // irrelevant. Slimming runs on the normalized record; every ref
      // round-trips normalizeTurnRecord, so the re-normalize inside
      // appendTurnRecordWithRotation preserves them.
      const slimmed = slimTurnRecordStaticPromptForAppend(
        slimTurnRecordWirePayloadForAppend(
          slimTurnRecordToolDefinitionsForAppend(
            normalizeTurnRecord(record, record.channelId),
            sharedStore,
          ),
          sharedStore,
        ),
        sharedStore,
      );
      appendTurnRecordWithRotation(sessionsDir, slimmed, segmentMaxBytes);
    },
    readRecentTurnRecords: (channelId, limit) => {
      if (limit <= 0) return [];
      const rows = readRecentTurnRecordsAcrossSegments(
        sessionsDir,
        channelId,
        limit,
        { scanChunkBytes },
      );
      // Refs resolve at the read boundary — only for records actually
      // returned — so every consumer above persistence sees fully inline
      // records. Fail closed: a dangling ref is a loud error (hgw3.3).
      return rows.map(record => resolveTurnRecordStaticPrompt(
        resolveTurnRecordWirePayload(
          resolveTurnRecordToolDefinitions(record, sharedStore),
          sharedStore,
        ),
        sharedStore,
      ));
    },
    readTurnRecordPage: (channelId, limit, cursor) => {
      const page = readTurnRecordPageAcrossSegments(
        sessionsDir,
        channelId,
        limit,
        cursor,
        { scanChunkBytes },
      );
      return {
        ...page,
        records: page.records.map(record => resolveTurnRecordStaticPrompt(
          resolveTurnRecordWirePayload(
            resolveTurnRecordToolDefinitions(record, sharedStore),
            sharedStore,
          ),
          sharedStore,
        )),
      };
    },
    readRecentTurnRecordUsage: (channelId, limit) => (
      readRecentTurnRecordUsageAcrossSegments(
        sessionsDir,
        channelId,
        limit,
        { scanChunkBytes },
      )
    ),
    streamTurnRecordsForRecovery: channelId => (
      streamTurnRecordsForRecovery(sessionsDir, channelId)
    ),
    countTurnRecordsByTurnId: (channelId, turnId) => (
      countTurnRecordsByTurnIdAcrossSegments(
        sessionsDir,
        channelId,
        turnId,
        scanChunkBytes,
      )
    ),
    findTurnRecord: (channelId, turnId) => {
      const record = findTurnRecordAcrossSegments(
        sessionsDir,
        channelId,
        turnId,
        scanChunkBytes,
      );
      return record
        ? resolveTurnRecordStaticPrompt(
          resolveTurnRecordWirePayload(
            resolveTurnRecordToolDefinitions(record, sharedStore),
            sharedStore,
          ),
          sharedStore,
        )
        : null;
    },
  };
}
