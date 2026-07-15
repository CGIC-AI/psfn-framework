import { createHash } from 'node:crypto';

import {
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
  type AdaptiveContextBudgetProfile,
  type ContextBudgetTurnCharacteristics,
} from '../../../shared/context-budget.js';
import type { ContextBudgetModelSelectionLike } from '../../../shared/context-budget-contracts.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import { parseIcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import { isRecord } from '../../../shared/utils/types.js';
import type {
  ModelPurpose,
  TurnRecord,
  TurnRecordBackgroundWorkHandoff,
} from '../../../shared/contracts/runtime.js';
import {
  isChannelPrivacy,
  type ChannelPrivacy,
} from '../../../system/trust/context-envelope.js';
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

const MODEL_PURPOSES: Readonly<Record<ModelPurpose, true>> = {
  chat: true,
  background: true,
  memory: true,
  context: true,
  reasoning: true,
  longContext: true,
  vision: true,
  moa: true,
};

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
  'effect_outcome_unknown',
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
  /** Stable owner reference; personality prose is re-read from canonical identity config. */
  personalityOwnerRef: 'character-card';
  /** Audit binding only. The queue never persists the underlying personality prose. */
  personalityProjectionHash: string;
  icpCorrelation?: IcpConversationCorrelation;
}

export interface BackgroundChannelProjection {
  isDirectMessage?: boolean;
  privacyLevel?: ChannelPrivacy;
  disclosureConsentGranted?: boolean;
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
  channelMeta?: BackgroundChannelProjection;
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
  deferredFromState?: 'queued' | 'retry_wait';
  deferredFromAvailableAtMs?: number;
}

export interface ClaimedBackgroundWorkJob extends StoredBackgroundWorkJob {
  state: 'running';
  leaseOwner: string;
  leaseExpiresAtMs: number;
}

export function isEmotionAppraisalTemplateVariableKey(key: string): boolean {
  return key === 'personality'
    || key === 'character.personality'
    || key.startsWith('hexaco.')
    || key.startsWith('hexaco_')
    || key.startsWith('character.hexaco.')
    || key.startsWith('character.hexaco_');
}

/** Hash the canonical personality projection without persisting its prose. */
export function fingerprintEmotionAppraisalPersonalityProjection(
  templateVariables: Record<string, string>,
): string {
  const selected = Object.fromEntries(Object.entries(templateVariables)
    .filter(([key]) => isEmotionAppraisalTemplateVariableKey(key))
    .sort(([left], [right]) => left.localeCompare(right)));
  return createHash('sha256').update(stableBackgroundWorkStringify(selected)).digest('hex');
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireSha256(value: unknown, field: string): string {
  const normalized = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
  return normalized;
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

function requirePercentageInRange(
  value: unknown,
  field: string,
  range: { min: number; max: number },
): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < range.min
    || (value as number) > range.max) {
    throw new Error(`${field} must be a safe integer from ${String(range.min)} to ${String(range.max)}`);
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
    turnRecordFingerprint: requireSha256(
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

function parseOptionalIcpCorrelation(value: unknown): IcpConversationCorrelation | undefined {
  return value === undefined ? undefined : parseIcpConversationCorrelation(value);
}

function parseChannelMeta(value: unknown): BackgroundChannelProjection | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('compaction channelMeta must be an object');
  assertOnlyKeys(value, [
    'isDirectMessage',
    'privacyLevel',
    'disclosureConsentGranted',
  ], 'compaction channelMeta');
  const result: BackgroundChannelProjection = {};
  if (value.isDirectMessage !== undefined) {
    if (typeof value.isDirectMessage !== 'boolean') {
      throw new Error('compaction channelMeta.isDirectMessage must be boolean');
    }
    result.isDirectMessage = value.isDirectMessage;
  }
  if (value.privacyLevel !== undefined) {
    if (!isChannelPrivacy(value.privacyLevel)) {
      throw new Error('compaction channelMeta.privacyLevel is invalid');
    }
    result.privacyLevel = value.privacyLevel;
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
  const hasValidProducerShape = source === 'disabled'
    ? value.enabled === false && category === 'default'
    : source === 'default'
      ? value.enabled === true && category === 'default'
      : value.enabled === true && category !== 'default';
  if (!hasValidProducerShape) {
    throw new Error('compaction adaptiveProfile enabled/source/category combination is invalid');
  }
  const sessionHistoryBudgetPct = requirePercentageInRange(
    value.sessionHistoryBudgetPct,
    'compaction adaptiveProfile.sessionHistoryBudgetPct',
    SESSION_HISTORY_BUDGET_PCT_RANGE,
  );
  const memoryRetrievalBudgetPct = requirePercentageInRange(
    value.memoryRetrievalBudgetPct,
    'compaction adaptiveProfile.memoryRetrievalBudgetPct',
    MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  );
  return {
    enabled: value.enabled,
    source,
    category: category as AdaptiveContextBudgetProfile['category'],
    sessionHistoryBudgetPct,
    memoryRetrievalBudgetPct,
  };
}

function parseModelSelection(value: unknown): ContextBudgetModelSelectionLike {
  if (!isRecord(value)) {
    throw new Error('compaction turnBudgetCharacteristics.modelSelection must be an object');
  }
  assertOnlyKeys(value, [
    'purpose',
    'slotKey',
    'provider',
    'model',
    'contextWindow',
  ], 'compaction turnBudgetCharacteristics.modelSelection');
  const result: ContextBudgetModelSelectionLike = {};
  if (value.purpose !== undefined) {
    if (typeof value.purpose !== 'string' || !Object.hasOwn(MODEL_PURPOSES, value.purpose)) {
      throw new Error('compaction turnBudgetCharacteristics.modelSelection.purpose is invalid');
    }
    result.purpose = value.purpose;
  }
  for (const field of ['slotKey', 'provider', 'model'] as const) {
    const normalized = optionalString(
      value[field],
      `compaction turnBudgetCharacteristics.modelSelection.${field}`,
    );
    if (normalized !== undefined) Object.assign(result, { [field]: normalized });
  }
  const contextWindow = optionalPositiveInteger(
    value.contextWindow,
    'compaction turnBudgetCharacteristics.modelSelection.contextWindow',
  );
  if (contextWindow !== undefined) result.contextWindow = contextWindow;
  return result;
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
    result.modelSelection = parseModelSelection(value.modelSelection);
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
        'appraisalState', 'personalityOwnerRef', 'personalityProjectionHash', 'icpCorrelation',
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
        personalityOwnerRef: requirePersonalityOwnerRef(value.personalityOwnerRef),
        personalityProjectionHash: requireSha256(
          value.personalityProjectionHash,
          'emotion personalityProjectionHash',
        ),
        ...(icpCorrelation ? { icpCorrelation } : {}),
      };
    case 'auto_compaction':
      assertOnlyKeys(value, [
        'schemaVersion', 'kind', 'source', 'systemPromptTokenCount', 'memoriesTokenCount',
        'adaptiveProfile', 'turnBudgetCharacteristics', 'userId', 'channelMeta',
        'icpCorrelation',
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
        ...(icpCorrelation ? { icpCorrelation } : {}),
      };
    default:
      throw new Error(`unknown background work kind: ${kind || '(empty)'}`);
  }
}

function requirePersonalityOwnerRef(value: unknown): 'character-card' {
  if (value !== 'character-card') throw new Error('emotion personalityOwnerRef is invalid');
  return value;
}

/** Recompute every persisted binding at claim time, not just at enqueue time. */
export function assertClaimedBackgroundWorkBinding(
  job: ClaimedBackgroundWorkJob,
  payload: BackgroundWorkPayload,
): void {
  const expectedIdentity = createBackgroundWorkIdentity({
    logicalSessionId: job.logicalSessionId,
    turnId: job.sourceTurnId,
    kind: payload.kind,
  });
  if (job.jobId !== expectedIdentity.jobId
    || job.idempotencyKey !== expectedIdentity.idempotencyKey
    || job.payloadSchemaVersion !== payload.schemaVersion
    || fingerprintBackgroundWorkPayload(payload) !== job.payloadFingerprint
    || payload.source.logicalSessionId !== job.logicalSessionId
    || payload.source.turnId !== job.sourceTurnId
    || payload.source.requestId !== job.sourceRequestId
    || payload.source.channelId !== job.sourceChannelId
    || payload.source.createdAtMs !== job.createdAtMs) {
    throw new Error('claimed background work payload binding mismatch');
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

export function fingerprintBackgroundWorkHandoff(
  jobs: readonly EnqueueBackgroundWorkInput[],
): string {
  const canonicalJobs = [...jobs].sort((left, right) => left.kind.localeCompare(right.kind));
  return createHash('sha256')
    .update(stableBackgroundWorkStringify({ schemaVersion: 1, jobs: canonicalJobs }))
    .digest('hex');
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

/** Build the replay marker written atomically with the canonical TurnRecord. */
export function createTurnRecordBackgroundWorkHandoff(
  jobs: readonly EnqueueBackgroundWorkInput[],
): TurnRecordBackgroundWorkHandoff {
  if (jobs.length < 1 || jobs.length > BACKGROUND_WORK_KINDS.length) {
    throw new Error('Background work handoff must contain 1-4 jobs');
  }
  const seenKinds = new Set<BackgroundWorkKind>();
  const parsedJobs = jobs.map((job) => {
    if (!BACKGROUND_WORK_KINDS.includes(job.kind) || seenKinds.has(job.kind)) {
      throw new Error(`Background work handoff kind is invalid or duplicated: ${job.kind}`);
    }
    seenKinds.add(job.kind);
    const payload = parseBackgroundWorkPayload(job.kind, job.payload);
    if (fingerprintBackgroundWorkPayload(payload) !== job.payloadFingerprint) {
      throw new Error(`Background work handoff payload fingerprint mismatch: ${job.kind}`);
    }
    return { ...job, payload };
  });
  return {
    schemaVersion: 1,
    jobs: parsedJobs,
  };
}

/**
 * Re-validate the whole handoff at its replay boundary. A TurnRecord parser
 * protects the outer shape; this owner additionally proves queue identities,
 * payload fingerprints, and source-row bindings before any enqueue occurs.
 */
export function parseTurnRecordBackgroundWorkHandoff(
  record: TurnRecord,
): EnqueueBackgroundWorkInput[] {
  const handoff = record.backgroundWorkHandoff;
  if (!handoff) return [];
  if (record.status !== 'completed'
    || handoff.jobs.length < 1 || handoff.jobs.length > BACKGROUND_WORK_KINDS.length) {
    throw new Error('TurnRecord background work handoff is malformed');
  }
  const logicalSessionId = record.sessionId ?? record.channelId;
  const expectedTurnFingerprint = fingerprintBackgroundWorkTurnRecord(record);
  const seenKinds = new Set<BackgroundWorkKind>();
  return handoff.jobs.map((job) => {
    if (!BACKGROUND_WORK_KINDS.includes(job.kind) || seenKinds.has(job.kind)) {
      throw new Error(`TurnRecord background work kind is invalid or duplicated: ${job.kind}`);
    }
    seenKinds.add(job.kind);
    const payload = parseBackgroundWorkPayload(job.kind, job.payload);
    const identity = createBackgroundWorkIdentity({
      logicalSessionId,
      turnId: record.turnId,
      kind: job.kind,
    });
    const bindingMismatches: string[] = [];
    if (job.jobId !== identity.jobId) bindingMismatches.push('job_id');
    if (job.idempotencyKey !== identity.idempotencyKey) bindingMismatches.push('idempotency_key');
    if (job.logicalSessionId !== logicalSessionId) bindingMismatches.push('logical_session_id');
    if (job.sourceTurnId !== record.turnId) bindingMismatches.push('source_turn_id');
    if (job.sourceRequestId !== record.requestId) bindingMismatches.push('source_request_id');
    if (job.sourceChannelId !== record.channelId) bindingMismatches.push('source_channel_id');
    if (job.createdAtMs !== record.completedAt) bindingMismatches.push('created_at_ms');
    if (!Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1) bindingMismatches.push('max_attempts');
    if (payload.source.logicalSessionId !== logicalSessionId) bindingMismatches.push('payload.logical_session_id');
    if (payload.source.turnId !== record.turnId) bindingMismatches.push('payload.turn_id');
    if (payload.source.requestId !== record.requestId) bindingMismatches.push('payload.request_id');
    if (payload.source.channelId !== record.channelId) bindingMismatches.push('payload.channel_id');
    if (payload.source.createdAtMs !== record.completedAt) bindingMismatches.push('payload.created_at_ms');
    if (payload.source.turnRecordFingerprint !== expectedTurnFingerprint) {
      bindingMismatches.push('payload.turn_record_fingerprint');
    }
    if (job.payloadFingerprint !== fingerprintBackgroundWorkPayload(payload)) {
      bindingMismatches.push('payload_fingerprint');
    }
    if (bindingMismatches.length > 0) {
      throw new Error(
        `TurnRecord background work binding mismatch for ${job.kind}: ${bindingMismatches.join(', ')}`,
      );
    }
    return {
      ...job,
      kind: job.kind,
      payload,
    };
  });
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
