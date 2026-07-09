import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import type {
  CogSecPersonaConformanceCheckId,
  CogSecPersonaConformanceEventRecord,
  CogSecPersonaConformanceStatus,
} from './persona-conformance.js';

export const COGSEC_EVENT_STORE_VERSION = 1 as const;

export type CogSecCaseType =
  | 'prompt_injection'
  | 'persona_poisoning'
  | 'memory_poisoning'
  | 'policy_drift'
  | 'content_poisoning'
  | 'intake_firewall'
  | 'unknown';

export type CogSecSeverity = 'low' | 'medium' | 'high' | 'critical';
export type CogSecStatus = 'open' | 'planned' | 'applying' | 'applied' | 'failed' | 'superseded';
export type CogSecAction = 'seal' | 'tombstone' | 'search_exclude' | 'revoke' | 'regenerate' | 'epoch_cut';

export type CogSecArtifactClass =
  | 'memories'
  | 'summaries'
  | 'embeddings'
  | 'active_memory_entries'
  | 'episodic_landmarks'
  | 'profile_artifacts'
  | 'persona_artifacts'
  | 'transcript_projection_rows'
  | 'search_index_rows'
  | 'compaction_summaries';

export interface CogSecAffectedMessageRange {
  sourceChannelId?: string;
  logicalSessionId?: string;
  startEntryId?: number;
  endEntryId?: number;
  messageIds?: number[];
  discordMessageIds?: string[];
}

export interface CogSecArtifactImpact {
  ids: string[];
  count: number;
}

export type CogSecAffectedArtifacts = Partial<Record<CogSecArtifactClass, CogSecArtifactImpact>>;

export interface CogSecEpochCutRef {
  sourceChannelId: string;
  oldLogicalSessionId: string;
  newLogicalSessionId: string;
  routeGeneration?: number;
  cutAt: string;
}

export interface CogSecResultCounters {
  sealedArtifacts?: number;
  tombstonedL0Rows?: number;
  searchExcludedRows?: number;
  revokedArtifacts?: number;
  regeneratedArtifacts?: number;
  lineageGaps?: number;
  conformanceFailures?: number;
  conformanceWarnings?: number;
}

export interface CogSecEvent {
  caseId: string;
  type: CogSecCaseType;
  severity: CogSecSeverity;
  status: CogSecStatus;
  sourceChannelId: string;
  affectedLogicalSessionIds: string[];
  affectedMessageRanges: CogSecAffectedMessageRange[];
  sealedForensicPayloadRefs: string[];
  sealedForensicPayloadHashes: string[];
  tombstonedL0RowCount: number;
  affectedArtifacts: CogSecAffectedArtifacts;
  actions: CogSecAction[];
  actor: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  safeAgentSummary: string;
  failureDetails?: string;
  resultCounters: CogSecResultCounters;
  epochCuts: CogSecEpochCutRef[];
  personaConformance?: CogSecPersonaConformanceEventRecord;
}

export interface CogSecEventState {
  version: typeof COGSEC_EVENT_STORE_VERSION;
  updatedAt: string;
  events: Record<string, CogSecEvent>;
}

export interface CogSecCreateEventInput {
  caseId?: string;
  type: CogSecCaseType;
  severity: CogSecSeverity;
  status?: CogSecStatus;
  sourceChannelId: string;
  affectedLogicalSessionIds?: string[];
  affectedMessageRanges?: CogSecAffectedMessageRange[];
  sealedForensicPayloadRefs?: string[];
  sealedForensicPayloadHashes?: string[];
  tombstonedL0RowCount?: number;
  affectedArtifacts?: CogSecAffectedArtifacts;
  actions?: CogSecAction[];
  actor?: string;
  safeAgentSummary: string;
  failureDetails?: string;
  resultCounters?: CogSecResultCounters;
  epochCuts?: CogSecEpochCutRef[];
  personaConformance?: CogSecPersonaConformanceEventRecord;
}

export interface CogSecUpdateEventInput {
  status?: CogSecStatus;
  affectedLogicalSessionIds?: string[];
  affectedMessageRanges?: CogSecAffectedMessageRange[];
  sealedForensicPayloadRefs?: string[];
  sealedForensicPayloadHashes?: string[];
  tombstonedL0RowCount?: number;
  affectedArtifacts?: CogSecAffectedArtifacts;
  actions?: CogSecAction[];
  appliedAt?: string;
  safeAgentSummary?: string;
  failureDetails?: string;
  resultCounters?: CogSecResultCounters;
  epochCuts?: CogSecEpochCutRef[];
  personaConformance?: CogSecPersonaConformanceEventRecord;
}

const EVENT_STATE_KEYS = new Set(['version', 'updatedAt', 'events']);
const EVENT_KEYS = new Set([
  'caseId',
  'type',
  'severity',
  'status',
  'sourceChannelId',
  'affectedLogicalSessionIds',
  'affectedMessageRanges',
  'sealedForensicPayloadRefs',
  'sealedForensicPayloadHashes',
  'tombstonedL0RowCount',
  'affectedArtifacts',
  'actions',
  'actor',
  'createdAt',
  'updatedAt',
  'appliedAt',
  'safeAgentSummary',
  'failureDetails',
  'resultCounters',
  'epochCuts',
  'personaConformance',
]);
const CONFORMANCE_RECORD_KEYS = new Set([
  'status',
  'checkedAt',
  'summary',
  'failureCount',
  'warningCount',
  'promptContextHash',
  'checks',
]);
const CONFORMANCE_CHECK_KEYS = new Set(['id', 'status', 'reasonCodes']);
const MESSAGE_RANGE_KEYS = new Set([
  'sourceChannelId',
  'logicalSessionId',
  'startEntryId',
  'endEntryId',
  'messageIds',
  'discordMessageIds',
]);
const ARTIFACT_IMPACT_KEYS = new Set(['ids', 'count']);
const RESULT_COUNTER_KEYS = new Set([
  'sealedArtifacts',
  'tombstonedL0Rows',
  'searchExcludedRows',
  'revokedArtifacts',
  'regeneratedArtifacts',
  'lineageGaps',
  'conformanceFailures',
  'conformanceWarnings',
]);
const EPOCH_CUT_KEYS = new Set([
  'sourceChannelId',
  'oldLogicalSessionId',
  'newLogicalSessionId',
  'routeGeneration',
  'cutAt',
]);

const CASE_TYPES: ReadonlySet<CogSecCaseType> = new Set([
  'prompt_injection',
  'persona_poisoning',
  'memory_poisoning',
  'policy_drift',
  'content_poisoning',
  'intake_firewall',
  'unknown',
]);
const SEVERITIES: ReadonlySet<CogSecSeverity> = new Set(['low', 'medium', 'high', 'critical']);
const STATUSES: ReadonlySet<CogSecStatus> = new Set(['open', 'planned', 'applying', 'applied', 'failed', 'superseded']);
const CONFORMANCE_STATUSES: ReadonlySet<CogSecPersonaConformanceStatus> = new Set(['pass', 'warning', 'fail']);
const CONFORMANCE_CHECK_IDS: ReadonlySet<CogSecPersonaConformanceCheckId> = new Set([
  'voice_fidelity',
  'value_fidelity',
  'refusal_boundary_consistency',
  'assistant_genericness',
  'relationship_continuity',
  'unauthorized_persona_mutation',
  'sealed_material_absence',
]);
const ACTIONS: ReadonlySet<CogSecAction> = new Set([
  'seal',
  'tombstone',
  'search_exclude',
  'revoke',
  'regenerate',
  'epoch_cut',
]);
const ARTIFACT_CLASSES: ReadonlySet<CogSecArtifactClass> = new Set([
  'memories',
  'summaries',
  'embeddings',
  'active_memory_entries',
  'episodic_landmarks',
  'profile_artifacts',
  'persona_artifacts',
  'transcript_projection_rows',
  'search_index_rows',
  'compaction_summaries',
]);

const COGSEC_CASE_ID_PATTERN = /^cogsec_[A-Za-z0-9_-]+$/u;
const REF_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SAFE_TEXT_BLOCKLIST = [
  /```/u,
  /\bpayload\s*:/iu,
  /\breproducer\b/iu,
  /\bbypass\b/iu,
  /\bexploit\b/iu,
  /\bunicode trick\b/iu,
  /\bignore (?:previous|all) instructions\b/iu,
  /[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/u,
];

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${field} contains unknown field "${key}"`);
    }
  }
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must be non-empty`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return normalizeRequiredString(value, field);
}

function normalizeSafeText(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field);
  if (normalized.length > 600) {
    throw new Error(`${field} must be 600 characters or fewer`);
  }
  if (/[\r\n]/u.test(normalized)) {
    throw new Error(`${field} must be a single line`);
  }
  for (const pattern of SAFE_TEXT_BLOCKLIST) {
    if (pattern.test(normalized)) {
      throw new Error(`${field} contains unsafe implementation or payload detail`);
    }
  }
  return normalized;
}

function parseEnumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<T>,
): T {
  if (typeof value === 'string' && allowed.has(value as T)) return value as T;
  throw new Error(`${field} has unsupported value "${String(value)}"`);
}

function parseIsoInstant(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field);
  if (!ISO_INSTANT_PATTERN.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${field} must be an ISO instant`);
  }
  return normalized;
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => normalizeRequiredString(item, `${field}[${index}]`));
}

function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  return parseStringArray(value, field);
}

function parseNumberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => parsePositiveInteger(item, `${field}[${index}]`));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function parseCaseId(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field);
  if (!COGSEC_CASE_ID_PATTERN.test(normalized)) {
    throw new Error(`${field} must match cogsec_[A-Za-z0-9_-]+`);
  }
  return normalized;
}

function parseRef(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field);
  if (!REF_PATTERN.test(normalized)) {
    throw new Error(`${field} must be an opaque URI ref`);
  }
  return normalized;
}

function parseHash(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field);
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a sha256 digest`);
  }
  return normalized;
}

function parseMessageRange(value: unknown, field: string): CogSecAffectedMessageRange {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  assertKnownKeys(value, MESSAGE_RANGE_KEYS, field);

  const startEntryId = value.startEntryId === undefined
    ? undefined
    : parsePositiveInteger(value.startEntryId, `${field}.startEntryId`);
  const endEntryId = value.endEntryId === undefined
    ? undefined
    : parsePositiveInteger(value.endEntryId, `${field}.endEntryId`);
  if (startEntryId !== undefined && endEntryId !== undefined && endEntryId < startEntryId) {
    throw new Error(`${field}.endEntryId must be greater than or equal to startEntryId`);
  }

  return {
    ...(value.sourceChannelId !== undefined
      ? { sourceChannelId: normalizeRequiredString(value.sourceChannelId, `${field}.sourceChannelId`) }
      : {}),
    ...(value.logicalSessionId !== undefined
      ? { logicalSessionId: normalizeRequiredString(value.logicalSessionId, `${field}.logicalSessionId`) }
      : {}),
    ...(startEntryId !== undefined ? { startEntryId } : {}),
    ...(endEntryId !== undefined ? { endEntryId } : {}),
    ...(value.messageIds !== undefined ? { messageIds: parseNumberArray(value.messageIds, `${field}.messageIds`) } : {}),
    ...(value.discordMessageIds !== undefined
      ? { discordMessageIds: parseStringArray(value.discordMessageIds, `${field}.discordMessageIds`) }
      : {}),
  };
}

function parseMessageRanges(value: unknown, field: string): CogSecAffectedMessageRange[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => parseMessageRange(item, `${field}[${index}]`));
}

function parseArtifactImpact(value: unknown, field: string): CogSecArtifactImpact {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  assertKnownKeys(value, ARTIFACT_IMPACT_KEYS, field);
  return {
    ids: uniqueStrings(parseStringArray(value.ids, `${field}.ids`)),
    count: parseNonNegativeInteger(value.count, `${field}.count`),
  };
}

function parseAffectedArtifacts(value: unknown, field: string): CogSecAffectedArtifacts {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const parsed: CogSecAffectedArtifacts = {};
  for (const [key, rawImpact] of Object.entries(value)) {
    if (!ARTIFACT_CLASSES.has(key as CogSecArtifactClass)) {
      throw new Error(`${field} contains unknown artifact class "${key}"`);
    }
    parsed[key as CogSecArtifactClass] = parseArtifactImpact(rawImpact, `${field}.${key}`);
  }
  return parsed;
}

function parseActions(value: unknown, field: string): CogSecAction[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return uniqueStrings(value.map((item, index) => parseEnumValue(item, `${field}[${index}]`, ACTIONS))) as CogSecAction[];
}

function parseResultCounters(value: unknown, field: string): CogSecResultCounters {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  assertKnownKeys(value, RESULT_COUNTER_KEYS, field);
  const parsed: CogSecResultCounters = {};
  for (const key of RESULT_COUNTER_KEYS) {
    const raw = value[key];
    if (raw !== undefined) {
      parsed[key as keyof CogSecResultCounters] = parseNonNegativeInteger(raw, `${field}.${key}`);
    }
  }
  return parsed;
}

function parseEpochCutRef(value: unknown, field: string): CogSecEpochCutRef {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  assertKnownKeys(value, EPOCH_CUT_KEYS, field);
  return {
    sourceChannelId: normalizeRequiredString(value.sourceChannelId, `${field}.sourceChannelId`),
    oldLogicalSessionId: normalizeRequiredString(value.oldLogicalSessionId, `${field}.oldLogicalSessionId`),
    newLogicalSessionId: normalizeRequiredString(value.newLogicalSessionId, `${field}.newLogicalSessionId`),
    ...(value.routeGeneration !== undefined
      ? { routeGeneration: parsePositiveInteger(value.routeGeneration, `${field}.routeGeneration`) }
      : {}),
    cutAt: parseIsoInstant(value.cutAt, `${field}.cutAt`),
  };
}

function parseEpochCuts(value: unknown, field: string): CogSecEpochCutRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => parseEpochCutRef(item, `${field}[${index}]`));
}

function parseConformanceReasonCode(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field);
  if (!/^[a-z0-9_:-]{1,80}$/u.test(normalized)) {
    throw new Error(`${field} must be a safe reason code`);
  }
  return normalized;
}

function parseConformanceCheck(value: unknown, field: string): CogSecPersonaConformanceEventRecord['checks'][number] {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  assertKnownKeys(value, CONFORMANCE_CHECK_KEYS, field);
  return {
    id: parseEnumValue(value.id, `${field}.id`, CONFORMANCE_CHECK_IDS),
    status: parseEnumValue(value.status, `${field}.status`, CONFORMANCE_STATUSES),
    reasonCodes: uniqueStrings((Array.isArray(value.reasonCodes) ? value.reasonCodes : [])
      .map((item, index) => parseConformanceReasonCode(item, `${field}.reasonCodes[${index}]`))),
  };
}

function parseConformanceChecks(value: unknown, field: string): CogSecPersonaConformanceEventRecord['checks'] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => parseConformanceCheck(item, `${field}[${index}]`));
}

function parseSha256(value: unknown, field: string): string {
  return parseHash(value, field);
}

function parsePersonaConformance(
  value: unknown,
  field: string,
): CogSecPersonaConformanceEventRecord {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  assertKnownKeys(value, CONFORMANCE_RECORD_KEYS, field);
  return {
    status: parseEnumValue(value.status, `${field}.status`, CONFORMANCE_STATUSES),
    checkedAt: parseIsoInstant(value.checkedAt, `${field}.checkedAt`),
    summary: normalizeSafeText(value.summary, `${field}.summary`),
    failureCount: parseNonNegativeInteger(value.failureCount, `${field}.failureCount`),
    warningCount: parseNonNegativeInteger(value.warningCount, `${field}.warningCount`),
    promptContextHash: parseSha256(value.promptContextHash, `${field}.promptContextHash`),
    checks: parseConformanceChecks(value.checks, `${field}.checks`),
  };
}

function parseEvent(value: unknown, key: string): CogSecEvent {
  if (!isRecord(value)) {
    throw new Error(`CogSec event "${key}" must be an object`);
  }
  assertKnownKeys(value, EVENT_KEYS, `CogSec event "${key}"`);
  const caseId = parseCaseId(value.caseId, `CogSec event "${key}".caseId`);
  if (caseId !== key) {
    throw new Error(`CogSec event key mismatch: expected "${key}", found "${caseId}"`);
  }
  return {
    caseId,
    type: parseEnumValue(value.type, `CogSec event "${key}".type`, CASE_TYPES),
    severity: parseEnumValue(value.severity, `CogSec event "${key}".severity`, SEVERITIES),
    status: parseEnumValue(value.status, `CogSec event "${key}".status`, STATUSES),
    sourceChannelId: normalizeRequiredString(value.sourceChannelId, `CogSec event "${key}".sourceChannelId`),
    affectedLogicalSessionIds: uniqueStrings(parseStringArray(
      value.affectedLogicalSessionIds,
      `CogSec event "${key}".affectedLogicalSessionIds`,
    )),
    affectedMessageRanges: parseMessageRanges(value.affectedMessageRanges, `CogSec event "${key}".affectedMessageRanges`),
    sealedForensicPayloadRefs: uniqueStrings(parseStringArray(value.sealedForensicPayloadRefs, `CogSec event "${key}".sealedForensicPayloadRefs`))
      .map((ref, index) => parseRef(ref, `CogSec event "${key}".sealedForensicPayloadRefs[${index}]`)),
    sealedForensicPayloadHashes: uniqueStrings(parseStringArray(
      value.sealedForensicPayloadHashes,
      `CogSec event "${key}".sealedForensicPayloadHashes`,
    )).map((hash, index) => parseHash(hash, `CogSec event "${key}".sealedForensicPayloadHashes[${index}]`)),
    tombstonedL0RowCount: parseNonNegativeInteger(value.tombstonedL0RowCount, `CogSec event "${key}".tombstonedL0RowCount`),
    affectedArtifacts: parseAffectedArtifacts(value.affectedArtifacts, `CogSec event "${key}".affectedArtifacts`),
    actions: parseActions(value.actions, `CogSec event "${key}".actions`),
    actor: normalizeRequiredString(value.actor, `CogSec event "${key}".actor`),
    createdAt: parseIsoInstant(value.createdAt, `CogSec event "${key}".createdAt`),
    updatedAt: parseIsoInstant(value.updatedAt, `CogSec event "${key}".updatedAt`),
    ...(value.appliedAt !== undefined ? { appliedAt: parseIsoInstant(value.appliedAt, `CogSec event "${key}".appliedAt`) } : {}),
    safeAgentSummary: normalizeSafeText(value.safeAgentSummary, `CogSec event "${key}".safeAgentSummary`),
    ...(value.failureDetails !== undefined
      ? { failureDetails: normalizeSafeText(value.failureDetails, `CogSec event "${key}".failureDetails`) }
      : {}),
    resultCounters: parseResultCounters(value.resultCounters, `CogSec event "${key}".resultCounters`),
    epochCuts: parseEpochCuts(value.epochCuts, `CogSec event "${key}".epochCuts`),
    ...(value.personaConformance !== undefined
      ? { personaConformance: parsePersonaConformance(value.personaConformance, `CogSec event "${key}".personaConformance`) }
      : {}),
  };
}

function parseEventState(value: unknown): CogSecEventState {
  if (!isRecord(value)) {
    throw new Error('CogSec event state must be an object');
  }
  assertKnownKeys(value, EVENT_STATE_KEYS, 'CogSec event state');
  if (value.version !== COGSEC_EVENT_STORE_VERSION) {
    throw new Error(`unsupported CogSec event state version: ${String(value.version)}`);
  }
  if (!isRecord(value.events)) {
    throw new Error('CogSec event state events must be an object');
  }
  const events: Record<string, CogSecEvent> = {};
  for (const [key, event] of Object.entries(value.events)) {
    events[key] = parseEvent(event, key);
  }
  return {
    version: COGSEC_EVENT_STORE_VERSION,
    updatedAt: parseIsoInstant(value.updatedAt, 'CogSec event state.updatedAt'),
    events,
  };
}

function cloneMessageRange(range: CogSecAffectedMessageRange): CogSecAffectedMessageRange {
  return {
    ...range,
    ...(range.messageIds ? { messageIds: [...range.messageIds] } : {}),
    ...(range.discordMessageIds ? { discordMessageIds: [...range.discordMessageIds] } : {}),
  };
}

function cloneAffectedArtifacts(artifacts: CogSecAffectedArtifacts): CogSecAffectedArtifacts {
  const cloned: CogSecAffectedArtifacts = {};
  for (const [key, impact] of Object.entries(artifacts)) {
    cloned[key as CogSecArtifactClass] = {
      ids: [...impact.ids],
      count: impact.count,
    };
  }
  return cloned;
}

function cloneResultCounters(counters: CogSecResultCounters): CogSecResultCounters {
  return { ...counters };
}

function cloneEpochCut(ref: CogSecEpochCutRef): CogSecEpochCutRef {
  return { ...ref };
}

function cloneEvent(event: CogSecEvent): CogSecEvent {
  return {
    ...event,
    affectedLogicalSessionIds: [...event.affectedLogicalSessionIds],
    affectedMessageRanges: event.affectedMessageRanges.map(cloneMessageRange),
    sealedForensicPayloadRefs: [...event.sealedForensicPayloadRefs],
    sealedForensicPayloadHashes: [...event.sealedForensicPayloadHashes],
    affectedArtifacts: cloneAffectedArtifacts(event.affectedArtifacts),
    actions: [...event.actions],
    resultCounters: cloneResultCounters(event.resultCounters),
    epochCuts: event.epochCuts.map(cloneEpochCut),
    ...(event.personaConformance
      ? {
        personaConformance: {
          ...event.personaConformance,
          checks: event.personaConformance.checks.map(check => ({
            ...check,
            reasonCodes: [...check.reasonCodes],
          })),
        },
      }
      : {}),
  };
}

function createEmptyState(now: Date): CogSecEventState {
  return {
    version: COGSEC_EVENT_STORE_VERSION,
    updatedAt: now.toISOString(),
    events: {},
  };
}

function createCaseId(now: Date): string {
  const compactTime = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  return `cogsec_${compactTime}_${randomUUID().slice(0, 8)}`;
}

function normalizeCreateInput(input: CogSecCreateEventInput, now: Date): CogSecEvent {
  const caseId = input.caseId ? parseCaseId(input.caseId, 'caseId') : createCaseId(now);
  const createdAt = now.toISOString();
  const resultCounters = input.resultCounters
    ? parseResultCounters(input.resultCounters, 'resultCounters')
    : {};
  return {
    caseId,
    type: parseEnumValue(input.type, 'type', CASE_TYPES),
    severity: parseEnumValue(input.severity, 'severity', SEVERITIES),
    status: input.status ? parseEnumValue(input.status, 'status', STATUSES) : 'open',
    sourceChannelId: normalizeRequiredString(input.sourceChannelId, 'sourceChannelId'),
    affectedLogicalSessionIds: uniqueStrings(input.affectedLogicalSessionIds?.map(
      (value, index) => normalizeRequiredString(value, `affectedLogicalSessionIds[${index}]`),
    ) ?? []),
    affectedMessageRanges: input.affectedMessageRanges?.map(
      (range, index) => parseMessageRange(range, `affectedMessageRanges[${index}]`),
    ) ?? [],
    sealedForensicPayloadRefs: uniqueStrings(input.sealedForensicPayloadRefs?.map(
      (ref, index) => parseRef(ref, `sealedForensicPayloadRefs[${index}]`),
    ) ?? []),
    sealedForensicPayloadHashes: uniqueStrings(input.sealedForensicPayloadHashes?.map(
      (hash, index) => parseHash(hash, `sealedForensicPayloadHashes[${index}]`),
    ) ?? []),
    tombstonedL0RowCount: input.tombstonedL0RowCount === undefined
      ? 0
      : parseNonNegativeInteger(input.tombstonedL0RowCount, 'tombstonedL0RowCount'),
    affectedArtifacts: input.affectedArtifacts ? parseAffectedArtifacts(input.affectedArtifacts, 'affectedArtifacts') : {},
    actions: input.actions ? parseActions(input.actions, 'actions') : [],
    actor: normalizeOptionalString(input.actor, 'actor') ?? 'operator',
    createdAt,
    updatedAt: createdAt,
    safeAgentSummary: normalizeSafeText(input.safeAgentSummary, 'safeAgentSummary'),
    ...(input.failureDetails ? { failureDetails: normalizeSafeText(input.failureDetails, 'failureDetails') } : {}),
    resultCounters,
    epochCuts: input.epochCuts?.map((ref, index) => parseEpochCutRef(ref, `epochCuts[${index}]`)) ?? [],
    ...(input.personaConformance
      ? { personaConformance: parsePersonaConformance(input.personaConformance, 'personaConformance') }
      : {}),
  };
}

function mergeResultCounters(
  existing: CogSecResultCounters,
  patch: CogSecResultCounters | undefined,
): CogSecResultCounters {
  if (!patch) return cloneResultCounters(existing);
  return parseResultCounters({ ...existing, ...patch }, 'resultCounters');
}

export class CogSecEventStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private state: CogSecEventState;

  constructor(filePath: string, options: { now?: () => Date } = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date());
    this.state = this.load();
  }

  createEvent(input: CogSecCreateEventInput): CogSecEvent {
    const event = normalizeCreateInput(input, this.now());
    if (Object.prototype.hasOwnProperty.call(this.state.events, event.caseId)) {
      throw new Error(`CogSec event already exists: ${event.caseId}`);
    }
    this.state = {
      version: COGSEC_EVENT_STORE_VERSION,
      updatedAt: event.updatedAt,
      events: {
        ...this.state.events,
        [event.caseId]: event,
      },
    };
    this.persist();
    return cloneEvent(event);
  }

  getEvent(caseId: string): CogSecEvent | null {
    const normalized = parseCaseId(caseId, 'caseId');
    if (!Object.prototype.hasOwnProperty.call(this.state.events, normalized)) {
      return null;
    }
    return cloneEvent(this.state.events[normalized]);
  }

  listEvents(): CogSecEvent[] {
    return Object.values(this.state.events)
      .map(cloneEvent)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  updateEvent(caseId: string, input: CogSecUpdateEventInput): CogSecEvent {
    const normalized = parseCaseId(caseId, 'caseId');
    if (!Object.prototype.hasOwnProperty.call(this.state.events, normalized)) {
      throw new Error(`CogSec event not found: ${normalized}`);
    }
    const existing = this.state.events[normalized];

    const updatedAt = this.now().toISOString();
    const next: CogSecEvent = {
      ...existing,
      ...(input.status ? { status: parseEnumValue(input.status, 'status', STATUSES) } : {}),
      ...(input.affectedLogicalSessionIds
        ? { affectedLogicalSessionIds: uniqueStrings(parseOptionalStringArray(
          input.affectedLogicalSessionIds,
          'affectedLogicalSessionIds',
        ) ?? []) }
        : {}),
      ...(input.affectedMessageRanges
        ? { affectedMessageRanges: parseMessageRanges(input.affectedMessageRanges, 'affectedMessageRanges') }
        : {}),
      ...(input.sealedForensicPayloadRefs
        ? {
          sealedForensicPayloadRefs: uniqueStrings(input.sealedForensicPayloadRefs.map(
            (ref, index) => parseRef(ref, `sealedForensicPayloadRefs[${index}]`),
          )),
        }
        : {}),
      ...(input.sealedForensicPayloadHashes
        ? {
          sealedForensicPayloadHashes: uniqueStrings(input.sealedForensicPayloadHashes.map(
            (hash, index) => parseHash(hash, `sealedForensicPayloadHashes[${index}]`),
          )),
        }
        : {}),
      ...(input.tombstonedL0RowCount !== undefined
        ? { tombstonedL0RowCount: parseNonNegativeInteger(input.tombstonedL0RowCount, 'tombstonedL0RowCount') }
        : {}),
      ...(input.affectedArtifacts ? { affectedArtifacts: parseAffectedArtifacts(input.affectedArtifacts, 'affectedArtifacts') } : {}),
      ...(input.actions ? { actions: parseActions(input.actions, 'actions') } : {}),
      ...(input.appliedAt ? { appliedAt: parseIsoInstant(input.appliedAt, 'appliedAt') } : {}),
      ...(input.safeAgentSummary ? { safeAgentSummary: normalizeSafeText(input.safeAgentSummary, 'safeAgentSummary') } : {}),
      ...(input.failureDetails ? { failureDetails: normalizeSafeText(input.failureDetails, 'failureDetails') } : {}),
      resultCounters: mergeResultCounters(existing.resultCounters, input.resultCounters),
      ...(input.epochCuts ? { epochCuts: parseEpochCuts(input.epochCuts, 'epochCuts') } : {}),
      ...(input.personaConformance
        ? { personaConformance: parsePersonaConformance(input.personaConformance, 'personaConformance') }
        : {}),
      updatedAt,
    };

    this.state = {
      version: COGSEC_EVENT_STORE_VERSION,
      updatedAt,
      events: {
        ...this.state.events,
        [normalized]: next,
      },
    };
    this.persist();
    return cloneEvent(next);
  }

  appendEpochCut(caseId: string, epochCut: CogSecEpochCutRef): CogSecEvent {
    const normalized = parseCaseId(caseId, 'caseId');
    if (!Object.prototype.hasOwnProperty.call(this.state.events, normalized)) {
      throw new Error(`CogSec event not found: ${normalized}`);
    }
    const existing = this.state.events[normalized];
    return this.updateEvent(normalized, {
      actions: uniqueStrings([...existing.actions, 'epoch_cut']) as CogSecAction[],
      epochCuts: [...existing.epochCuts, parseEpochCutRef(epochCut, 'epochCut')],
    });
  }

  private load(): CogSecEventState {
    if (!existsSync(this.filePath)) {
      return createEmptyState(this.now());
    }
    const raw = readFileSync(this.filePath, 'utf-8');
    return parseEventState(JSON.parse(raw) as unknown);
  }

  private persist(): void {
    writeJsonAtomic(this.filePath, this.state);
  }
}
