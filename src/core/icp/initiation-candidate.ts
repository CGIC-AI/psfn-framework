import {
  ICP_AUTONOMY_REASON_CODES,
  ICP_INITIATION_SOURCES,
  parseIcpProvenanceHandle,
  type IcpAutonomyReasonCode,
  type IcpInitiationSource,
} from '../../shared/contracts/icp-autonomy.js';
import {
  assertNoUnknownKeys,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';
import {
  isIcpContinuationTaskKind,
  type IcpContinuationTaskKind,
} from '../../shared/contracts/runtime.js';

/** Private companion-local motivation. Never serialize this object to shared state. */
export interface IcpInitiationCandidate {
  candidateId: string;
  rootInitiationId: string;
  localCompanionId: string;
  peerContactId: string;
  peerCompanionId: string;
  preferredChannel: 'dm' | 'current_room';
  source: IcpInitiationSource;
  provenanceRef: string;
  /** Bounded private motivation; prohibited from shared schema and gateway payloads. */
  reasonSummary: string;
  /** Private scheduler-owned intent. Never included in shared arbitration. */
  continuationTaskKind?: IcpContinuationTaskKind;
  createdAtMs: number;
  expiresAtMs: number;
  status: IcpInitiationCandidateStatus;
  reasonCode?: IcpAutonomyReasonCode;
  revision: number;
}

export const ICP_INITIATION_CANDIDATE_STATUSES = [
  'pending',
  'deferred',
  'declined',
  'rejected',
  'permitted',
  'consumed',
  'expired',
  'cancelled',
] as const;
export type IcpInitiationCandidateStatus = typeof ICP_INITIATION_CANDIDATE_STATUSES[number];

/** The only candidate projection allowed to cross into shared arbitration state. */
export type IcpInitiationCandidateSharedMetadata = Omit<
  IcpInitiationCandidate,
  'peerContactId' | 'reasonSummary' | 'continuationTaskKind'
>;

export const MAX_ICP_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_ICP_CANDIDATE_REASON_CHARS = 1_000;

const CANDIDATE_KEYS = [
  'candidateId', 'rootInitiationId', 'localCompanionId', 'peerContactId',
  'peerCompanionId', 'preferredChannel', 'source', 'provenanceRef', 'reasonSummary',
  'continuationTaskKind', 'createdAtMs', 'expiresAtMs', 'status', 'reasonCode', 'revision',
] as const;
const SHARED_CANDIDATE_KEYS = [
  'candidateId', 'rootInitiationId', 'localCompanionId', 'peerCompanionId',
  'preferredChannel', 'source', 'provenanceRef', 'createdAtMs', 'expiresAtMs',
  'status', 'reasonCode', 'revision',
] as const;

const TRANSITIONS: Readonly<Record<IcpInitiationCandidateStatus, readonly IcpInitiationCandidateStatus[]>> = {
  pending: ['deferred', 'declined', 'rejected', 'permitted', 'expired', 'cancelled'],
  deferred: ['pending', 'declined', 'rejected', 'expired', 'cancelled'],
  permitted: ['consumed', 'expired', 'cancelled'],
  declined: [],
  rejected: [],
  consumed: [],
  expired: [],
  cancelled: [],
};

function requireString(value: unknown, field: string, maxLength = 1_024): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer`);
  }
  return value;
}

function requireUuid(value: unknown, field: string): string {
  if (!isRfc4122Uuid(value)) throw new Error(`${field} must be a lowercase RFC-4122 UUID`);
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${field} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

export function parseIcpInitiationCandidate(
  value: unknown,
  options: { nowMs?: number; requireCurrent?: boolean } = {},
): IcpInitiationCandidate {
  if (!isRecord(value)) throw new Error('ICP initiation candidate must be an object');
  assertNoUnknownKeys(value, CANDIDATE_KEYS, 'ICP initiation candidate');
  const localCompanionId = requireUuid(value.localCompanionId, 'ICP candidate.localCompanionId');
  const peerCompanionId = requireUuid(value.peerCompanionId, 'ICP candidate.peerCompanionId');
  if (localCompanionId === peerCompanionId) {
    throw new Error('ICP initiation candidate must target a different companion');
  }
  const createdAtMs = requireTimestamp(value.createdAtMs, 'ICP candidate.createdAtMs');
  const expiresAtMs = requireTimestamp(value.expiresAtMs, 'ICP candidate.expiresAtMs');
  if (expiresAtMs <= createdAtMs) {
    throw new Error('ICP candidate.expiresAtMs must be later than createdAtMs');
  }
  if (expiresAtMs - createdAtMs > MAX_ICP_CANDIDATE_TTL_MS) {
    throw new Error(`ICP initiation candidate exceeds maximum TTL ${MAX_ICP_CANDIDATE_TTL_MS}ms`);
  }
  if (options.requireCurrent === true) {
    const nowMs = requireTimestamp(options.nowMs, 'ICP candidate validation nowMs');
    if (createdAtMs > nowMs) throw new Error('ICP initiation candidate is not yet valid');
    if (expiresAtMs <= nowMs) throw new Error('ICP initiation candidate is expired');
  }
  const reasonCode = value.reasonCode === undefined
    ? undefined
    : requireEnum(value.reasonCode, ICP_AUTONOMY_REASON_CODES, 'ICP candidate.reasonCode');
  if (value.continuationTaskKind !== undefined
    && !isIcpContinuationTaskKind(value.continuationTaskKind)) {
    throw new Error('ICP candidate.continuationTaskKind is invalid');
  }
  const revision = value.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('ICP candidate.revision must be a positive safe integer');
  }
  return {
    candidateId: requireUuid(value.candidateId, 'ICP candidate.candidateId'),
    rootInitiationId: requireUuid(value.rootInitiationId, 'ICP candidate.rootInitiationId'),
    localCompanionId,
    peerContactId: requireString(value.peerContactId, 'ICP candidate.peerContactId', 512),
    peerCompanionId,
    preferredChannel: requireEnum(
      value.preferredChannel,
      ['dm', 'current_room'] as const,
      'ICP candidate.preferredChannel',
    ),
    source: requireEnum(value.source, ICP_INITIATION_SOURCES, 'ICP candidate.source'),
    provenanceRef: parseIcpProvenanceHandle(value.provenanceRef, 'ICP candidate.provenanceRef'),
    reasonSummary: requireString(
      value.reasonSummary,
      'ICP candidate.reasonSummary',
      MAX_ICP_CANDIDATE_REASON_CHARS,
    ),
    ...(value.continuationTaskKind !== undefined
      ? { continuationTaskKind: value.continuationTaskKind }
      : {}),
    createdAtMs,
    expiresAtMs,
    status: requireEnum(
      value.status,
      ICP_INITIATION_CANDIDATE_STATUSES,
      'ICP candidate.status',
    ),
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    revision,
  };
}

export function assertIcpInitiationCandidateStatusTransition(
  from: IcpInitiationCandidateStatus,
  to: IcpInitiationCandidateStatus,
): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid ICP candidate status transition: ${from} -> ${to}`);
  }
}

export function toIcpInitiationCandidateSharedMetadata(
  candidate: IcpInitiationCandidate,
): IcpInitiationCandidateSharedMetadata {
  return {
    candidateId: candidate.candidateId,
    rootInitiationId: candidate.rootInitiationId,
    localCompanionId: candidate.localCompanionId,
    peerCompanionId: candidate.peerCompanionId,
    preferredChannel: candidate.preferredChannel,
    source: candidate.source,
    provenanceRef: candidate.provenanceRef,
    createdAtMs: candidate.createdAtMs,
    expiresAtMs: candidate.expiresAtMs,
    status: candidate.status,
    ...(candidate.reasonCode !== undefined ? { reasonCode: candidate.reasonCode } : {}),
    revision: candidate.revision,
  };
}

/**
 * Parse the only candidate projection permitted at the gateway boundary.
 * Private peer-contact identifiers and motivation text are rejected as unknown
 * fields before validation, so callers cannot accidentally leak either into
 * shared arbitration, telemetry, or audit state.
 */
export function parseIcpInitiationCandidateSharedMetadata(
  value: unknown,
  options: { nowMs?: number; requireCurrent?: boolean } = {},
): IcpInitiationCandidateSharedMetadata {
  if (!isRecord(value)) {
    throw new Error('ICP shared initiation candidate must be an object');
  }
  assertNoUnknownKeys(value, SHARED_CANDIDATE_KEYS, 'ICP shared initiation candidate');
  const candidate = parseIcpInitiationCandidate({
    ...value,
    // Validation-only sentinels. They are immediately removed by the explicit
    // shared projection and can never enter the returned object.
    peerContactId: '[private]',
    reasonSummary: '[private]',
  }, options);
  return toIcpInitiationCandidateSharedMetadata(candidate);
}
