import { createHash } from 'node:crypto';

import type { ContextBudgetTurnCharacteristics } from '../../../shared/context-budget.js';
import type { AdaptiveContextBudgetProfile } from '../../../shared/context-budget.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import { parseIcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import {
  parseEmotionAppraisalStateSnapshot,
  type EmotionAppraisalStateSnapshot,
} from '../../emotion/appraisal-state.js';

export const BACKGROUND_WORK_KINDS = [
  'memory_extraction',
  'intention_post_turn_hooks',
  'emotion_appraisal',
  'auto_compaction',
] as const;

export type BackgroundWorkKind = typeof BACKGROUND_WORK_KINDS[number];

export const BACKGROUND_WORK_STATES = [
  'queued',
  'deferred',
  'retry_wait',
  'running',
  'succeeded',
  'failed',
  'stale_discarded',
] as const;

export type BackgroundWorkState = typeof BACKGROUND_WORK_STATES[number];

export const BACKGROUND_WORK_REASON_CODES = [
  'enqueued',
  'deduplicated',
  'foreground_active',
  'started',
  'completed',
  'handler_failed',
  'retry_scheduled',
  'retry_exhausted',
  'lease_expired',
  'shutdown',
  'source_not_ready',
  'source_missing',
  'source_mismatch',
  'superseded',
  'malformed_payload',
  'unknown_kind',
] as const;

export type BackgroundWorkReasonCode = typeof BACKGROUND_WORK_REASON_CODES[number];

export interface BackgroundWorkSourceRef {
  schemaVersion: 1;
  logicalSessionId: string;
  channelId: string;
  turnId: string;
  requestId: string;
  turnRecordFingerprint: string;
  createdAtMs: number;
  userSessionEntryId?: number;
  assistantSessionEntryId?: number;
}

export interface MemoryExtractionBackgroundPayload {
  schemaVersion: 1;
  kind: 'memory_extraction';
  source: BackgroundWorkSourceRef;
  canonicalContactId?: string;
  placeId?: string;
  icpCorrelation?: IcpConversationCorrelation;
}

export interface IntentionPostTurnBackgroundPayload {
  schemaVersion: 1;
  kind: 'intention_post_turn_hooks';
  source: BackgroundWorkSourceRef;
  canonicalContactKey?: string;
}

export interface EmotionAppraisalBackgroundPayload {
  schemaVersion: 1;
  kind: 'emotion_appraisal';
  source: BackgroundWorkSourceRef;
  emotionSessionId: string;
  internalStateSnapshotRef: string;
  appraisalState: EmotionAppraisalStateSnapshot;
  templateVariables: Record<string, string>;
  icpCorrelation?: IcpConversationCorrelation;
}

export interface AutoCompactionBackgroundPayload {
  schemaVersion: 1;
  kind: 'auto_compaction';
  source: BackgroundWorkSourceRef;
  systemPromptTokenCount: number;
  memoriesTokenCount: number;
  adaptiveProfile: AdaptiveContextBudgetProfile;
  turnBudgetCharacteristics: Omit<ContextBudgetTurnCharacteristics, 'messageText'>;
  userId?: string;
  channelMeta?: ChannelMeta;
  compactionPromptText?: string;
  icpCorrelation?: IcpConversationCorrelation;
}

export type BackgroundWorkPayload =
  | MemoryExtractionBackgroundPayload
  | IntentionPostTurnBackgroundPayload
  | EmotionAppraisalBackgroundPayload
  | AutoCompactionBackgroundPayload;

export interface EnqueueBackgroundWorkInput {
  jobId: string;
  idempotencyKey: string;
  logicalSessionId: string;
  kind: BackgroundWorkKind;
  payload: BackgroundWorkPayload;
  payloadFingerprint: string;
  sourceTurnId: string;
  sourceRequestId: string;
  sourceChannelId: string;
  createdAtMs: number;
  maxAttempts: number;
}

export interface StoredBackgroundWorkJob {
  jobId: string;
  idempotencyKey: string;
  logicalSessionId: string;
  kind: string;
  payloadSchemaVersion: number;
  payload: unknown;
  payloadFingerprint: string;
  sourceTurnId: string;
  sourceRequestId: string;
  sourceChannelId: string;
  state: BackgroundWorkState;
  reasonCode: BackgroundWorkReasonCode;
  attemptCount: number;
  maxAttempts: number;
  createdAtMs: number;
  availableAtMs: number;
  updatedAtMs: number;
  leaseOwner?: string;
  leaseExpiresAtMs?: number;
  completedAtMs?: number;
  revision: number;
}

export interface ClaimedBackgroundWorkJob extends StoredBackgroundWorkJob {
  state: 'running';
  leaseOwner: string;
  leaseExpiresAtMs: number;
}

const MAX_EMOTION_TEMPLATE_VARIABLES = 64;
const MAX_EMOTION_TEMPLATE_VALUE_CHARS = 16_384;

export function isEmotionAppraisalTemplateVariableKey(key: string): boolean {
  return key === 'personality'
    || key === 'character.personality'
    || key.startsWith('hexaco.')
    || key.startsWith('hexaco_')
    || key.startsWith('character.hexaco.')
    || key.startsWith('character.hexaco_');
}

/** Select only the static personality inputs consumed by emotion appraisal. */
export function selectEmotionAppraisalTemplateVariables(
  templateVariables: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(templateVariables)
      .filter(([key]) => isEmotionAppraisalTemplateVariableKey(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_EMOTION_TEMPLATE_VARIABLES)
      .map(([key, value]) => [key, value.slice(0, MAX_EMOTION_TEMPLATE_VALUE_CHARS)]),
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(value).find(key => !allowed.has(key));
  if (unsupported) throw new Error(`${field} contains unsupported field ${unsupported}`);
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function parseSourceRef(value: unknown): BackgroundWorkSourceRef {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('background payload source must use schemaVersion 1');
  }
  assertOnlyKeys(value, [
    'schemaVersion',
    'logicalSessionId',
    'channelId',
    'turnId',
    'requestId',
    'turnRecordFingerprint',
    'createdAtMs',
    'userSessionEntryId',
    'assistantSessionEntryId',
  ], 'background payload source');
  return {
    schemaVersion: 1,
    logicalSessionId: requireString(value.logicalSessionId, 'source.logicalSessionId'),
    channelId: requireString(value.channelId, 'source.channelId'),
    turnId: requireString(value.turnId, 'source.turnId'),
    requestId: requireString(value.requestId, 'source.requestId'),
    turnRecordFingerprint: requireString(
      value.turnRecordFingerprint,
      'source.turnRecordFingerprint',
    ),
    createdAtMs: requireNonNegativeInteger(value.createdAtMs, 'source.createdAtMs'),
    ...(optionalPositiveInteger(value.userSessionEntryId, 'source.userSessionEntryId') !== undefined
      ? { userSessionEntryId: optionalPositiveInteger(value.userSessionEntryId, 'source.userSessionEntryId') }
      : {}),
    ...(optionalPositiveInteger(value.assistantSessionEntryId, 'source.assistantSessionEntryId') !== undefined
      ? { assistantSessionEntryId: optionalPositiveInteger(value.assistantSessionEntryId, 'source.assistantSessionEntryId') }
      : {}),
  };
}

function parseTemplateVariables(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error('emotion templateVariables must be an object');
  const entries = Object.entries(value);
  if (entries.length > MAX_EMOTION_TEMPLATE_VARIABLES) {
    throw new Error(`emotion templateVariables supports at most ${String(MAX_EMOTION_TEMPLATE_VARIABLES)} entries`);
  }
  const parsed: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!isEmotionAppraisalTemplateVariableKey(key)) {
      throw new Error(`emotion templateVariables contains unsupported key ${key}`);
    }
    if (typeof entry !== 'string') {
      throw new Error(`emotion templateVariables.${key} must be a string`);
    }
    if (entry.length > MAX_EMOTION_TEMPLATE_VALUE_CHARS) {
      throw new Error(
        `emotion templateVariables.${key} must be ${String(MAX_EMOTION_TEMPLATE_VALUE_CHARS)} characters or fewer`,
      );
    }
    parsed[key] = entry;
  }
  return parsed;
}

function parseOptionalIcpCorrelation(value: unknown): IcpConversationCorrelation | undefined {
  return value === undefined ? undefined : parseIcpConversationCorrelation(value);
}

function parseChannelMeta(value: unknown): ChannelMeta | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('compaction channelMeta must be an object');
  assertOnlyKeys(value, [
    'isDirectMessage',
    'broadcastApprovalToken',
    'privacyLevel',
    'disclosureConsentGranted',
  ], 'compaction channelMeta');
  const result: ChannelMeta = {};
  if (value.isDirectMessage !== undefined) {
    if (typeof value.isDirectMessage !== 'boolean') {
      throw new Error('compaction channelMeta.isDirectMessage must be boolean');
    }
    result.isDirectMessage = value.isDirectMessage;
  }
  for (const field of ['broadcastApprovalToken', 'privacyLevel'] as const) {
    const normalized = optionalString(value[field], `compaction channelMeta.${field}`);
    if (normalized !== undefined) Object.assign(result, { [field]: normalized });
  }
  if (value.disclosureConsentGranted !== undefined) {
    if (typeof value.disclosureConsentGranted !== 'boolean') {
      throw new Error('compaction channelMeta.disclosureConsentGranted must be boolean');
    }
    result.disclosureConsentGranted = value.disclosureConsentGranted;
  }
  return result;
}

function parseAdaptiveProfile(value: unknown): AdaptiveContextBudgetProfile {
  if (!isRecord(value)) throw new Error('compaction adaptiveProfile must be an object');
  assertOnlyKeys(value, [
    'enabled',
    'source',
    'category',
    'sessionHistoryBudgetPct',
    'memoryRetrievalBudgetPct',
  ], 'compaction adaptiveProfile');
  const source = value.source;
  const category = value.category;
  if (source !== 'disabled' && source !== 'default' && source !== 'adaptive') {
    throw new Error('compaction adaptiveProfile.source is invalid');
  }
  if (!['default', 'temporal', 'recall', 'task', 'emotional', 'creative', 'factual'].includes(String(category))) {
    throw new Error('compaction adaptiveProfile.category is invalid');
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error('compaction adaptiveProfile.enabled must be boolean');
  }
  const sessionHistoryBudgetPct = Number(value.sessionHistoryBudgetPct);
  const memoryRetrievalBudgetPct = Number(value.memoryRetrievalBudgetPct);
  if (!Number.isFinite(sessionHistoryBudgetPct) || !Number.isFinite(memoryRetrievalBudgetPct)) {
    throw new Error('compaction adaptiveProfile budgets must be finite');
  }
  return {
    enabled: value.enabled,
    source,
    category: category as AdaptiveContextBudgetProfile['category'],
    sessionHistoryBudgetPct,
    memoryRetrievalBudgetPct,
  };
}

function parseTurnBudgetCharacteristics(
  value: unknown,
): Omit<ContextBudgetTurnCharacteristics, 'messageText'> {
  if (!isRecord(value)) throw new Error('compaction turnBudgetCharacteristics must be an object');
  assertOnlyKeys(value, [
    'channelId',
    'channelType',
    'isDirectMessage',
    'messageText',
    'taskKind',
    'modelSelection',
  ], 'compaction turnBudgetCharacteristics');
  if (value.messageText !== undefined) {
    throw new Error('compaction payload must not persist messageText');
  }
  const result: Omit<ContextBudgetTurnCharacteristics, 'messageText'> = {};
  for (const field of ['channelId', 'channelType', 'taskKind'] as const) {
    const normalized = optionalString(value[field], `compaction turnBudgetCharacteristics.${field}`);
    if (normalized !== undefined) Object.assign(result, { [field]: normalized });
  }
  if (value.isDirectMessage !== undefined) {
    if (typeof value.isDirectMessage !== 'boolean') {
      throw new Error('compaction turnBudgetCharacteristics.isDirectMessage must be boolean');
    }
    result.isDirectMessage = value.isDirectMessage;
  }
  if (value.modelSelection !== undefined) {
    if (!isRecord(value.modelSelection)) {
      throw new Error('compaction turnBudgetCharacteristics.modelSelection must be an object');
    }
    result.modelSelection = { ...value.modelSelection };
  }
  return result;
}

export function parseBackgroundWorkPayload(
  kind: string,
  value: unknown,
): BackgroundWorkPayload {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== kind) {
    throw new Error(`background payload for ${kind || 'unknown'} is malformed`);
  }
  const source = parseSourceRef(value.source);
  const icpCorrelation = parseOptionalIcpCorrelation(value.icpCorrelation);
  switch (kind) {
    case 'memory_extraction':
      assertOnlyKeys(value, [
        'schemaVersion', 'kind', 'source', 'canonicalContactId', 'placeId', 'icpCorrelation',
      ], 'memory extraction payload');
      return {
        schemaVersion: 1,
        kind,
        source,
        ...(optionalString(value.canonicalContactId, 'memory canonicalContactId')
          ? { canonicalContactId: optionalString(value.canonicalContactId, 'memory canonicalContactId') }
          : {}),
        ...(optionalString(value.placeId, 'memory placeId')
          ? { placeId: optionalString(value.placeId, 'memory placeId') }
          : {}),
        ...(icpCorrelation ? { icpCorrelation } : {}),
      };
    case 'intention_post_turn_hooks':
      assertOnlyKeys(value, [
        'schemaVersion', 'kind', 'source', 'canonicalContactKey',
      ], 'intention post-turn payload');
      return {
        schemaVersion: 1,
        kind,
        source,
        ...(optionalString(value.canonicalContactKey, 'intention canonicalContactKey')
          ? { canonicalContactKey: optionalString(value.canonicalContactKey, 'intention canonicalContactKey') }
          : {}),
      };
    case 'emotion_appraisal':
      assertOnlyKeys(value, [
        'schemaVersion', 'kind', 'source', 'emotionSessionId', 'internalStateSnapshotRef',
        'appraisalState',
        'templateVariables', 'icpCorrelation',
      ], 'emotion appraisal payload');
      return {
        schemaVersion: 1,
        kind,
        source,
        emotionSessionId: requireString(value.emotionSessionId, 'emotion emotionSessionId'),
        internalStateSnapshotRef: requireString(
          value.internalStateSnapshotRef,
          'emotion internalStateSnapshotRef',
        ),
        appraisalState: parseEmotionAppraisalStateSnapshot(value.appraisalState),
        templateVariables: parseTemplateVariables(value.templateVariables),
        ...(icpCorrelation ? { icpCorrelation } : {}),
      };
    case 'auto_compaction':
      assertOnlyKeys(value, [
        'schemaVersion', 'kind', 'source', 'systemPromptTokenCount', 'memoriesTokenCount',
        'adaptiveProfile', 'turnBudgetCharacteristics', 'userId', 'channelMeta',
        'compactionPromptText', 'icpCorrelation',
      ], 'auto-compaction payload');
      return {
        schemaVersion: 1,
        kind,
        source,
        systemPromptTokenCount: requireNonNegativeInteger(
          value.systemPromptTokenCount,
          'compaction systemPromptTokenCount',
        ),
        memoriesTokenCount: requireNonNegativeInteger(
          value.memoriesTokenCount,
          'compaction memoriesTokenCount',
        ),
        adaptiveProfile: parseAdaptiveProfile(value.adaptiveProfile),
        turnBudgetCharacteristics: parseTurnBudgetCharacteristics(value.turnBudgetCharacteristics),
        ...(optionalString(value.userId, 'compaction userId')
          ? { userId: optionalString(value.userId, 'compaction userId') }
          : {}),
        ...(parseChannelMeta(value.channelMeta) ? { channelMeta: parseChannelMeta(value.channelMeta) } : {}),
        ...(optionalString(value.compactionPromptText, 'compaction compactionPromptText')
          ? { compactionPromptText: optionalString(value.compactionPromptText, 'compaction compactionPromptText') }
          : {}),
        ...(icpCorrelation ? { icpCorrelation } : {}),
      };
    default:
      throw new Error(`unknown background work kind: ${kind || '(empty)'}`);
  }
}

export function stableBackgroundWorkStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(entry => stableBackgroundWorkStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${stableBackgroundWorkStringify(record[key])}`
  )).join(',')}}`;
}

export function fingerprintBackgroundWorkPayload(payload: BackgroundWorkPayload): string {
  return createHash('sha256').update(stableBackgroundWorkStringify(payload)).digest('hex');
}

/** Hash-only binding to the canonical turn record; the queue never copies its content. */
export function fingerprintBackgroundWorkTurnRecord(record: TurnRecord): string {
  // The turn-record store normalizes rows and content-addresses large tool
  // definitions on append. Bind only fields that round-trip unchanged so the
  // durable queue can rehydrate the canonical record without treating storage
  // compaction as source tampering.
  const sourceBinding = {
    schemaVersion: record.schemaVersion,
    turnId: record.turnId,
    requestId: record.requestId,
    sessionId: record.sessionId,
    channelId: record.channelId,
    channelType: record.channelType,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    status: record.status,
    continuationStop: record.continuationStop,
    location: record.location,
    auditPrivacy: record.auditPrivacy,
    channelPrivacy: record.channelPrivacy,
    userMessage: record.userMessage,
    assistantMessage: record.assistantMessage,
    internalStateSnapshotRef: record.internalStateSnapshotRef,
    versionPointers: record.versionPointers,
    icpCorrelation: record.icpCorrelation,
  };
  return createHash('sha256').update(stableBackgroundWorkStringify(sourceBinding)).digest('hex');
}

export function createBackgroundWorkIdentity(input: {
  logicalSessionId: string;
  turnId: string;
  kind: BackgroundWorkKind;
}): { jobId: string; idempotencyKey: string } {
  const idempotencyKey = `background-work:v1:${input.logicalSessionId}:${input.turnId}:${input.kind}`;
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return {
    jobId: `bgw_${digest.slice(0, 32)}`,
    idempotencyKey,
  };
}
