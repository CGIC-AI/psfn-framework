import {
  ICP_AUTONOMY_REASON_CODES,
  ICP_INITIATION_CANDIDATE_STATUSES,
  ICP_INITIATION_SOURCES,
  parseIcpProvenanceHandle,
  type IcpAutonomyReasonCode,
  type IcpInitiationCandidateStatus,
  type IcpInitiationSource,
} from '../../shared/contracts/icp-autonomy.js';

export { ICP_INITIATION_CANDIDATE_STATUSES } from '../../shared/contracts/icp-autonomy.js';
export type { IcpInitiationCandidateStatus } from '../../shared/contracts/icp-autonomy.js';
import {
  assertNoUnknownKeys,
  isRecord,
} from '../../shared/utils/types.js';
import { requireUuid } from '../../shared/utils/uuid.js';
import {
  isIcpContinuationTaskKind,
  type IcpContinuationTaskKind,
} from '../../shared/contracts/runtime.js';
import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';

/** Private companion-local motivation. Never serialize this object to shared state. */
export type IcpInitiationDeliveryDisposition = 'delivered' | 'suppressed';

export interface IcpInitiationCandidate {
  candidateId: string;
  rootInitiationId: string;
  localCompanionId: string;
  peerContactId: string;
  peerCompanionId: string;
  preferredChannel: 'dm' | 'current_room';
  /** Exact private delivery route needed for source-independent current-room recovery. */
  targetChannelId?: string;
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
  /** Private recovery binding for a permit issued before target-turn delivery. */
  permitId?: string;
  /** Durable intention owner used to reconcile delivery across action identities. */
  pendingFollowUpId?: string;
  /** Durable target result, written with the terminal consumed transition. */
  deliveryDisposition?: IcpInitiationDeliveryDisposition;
  /** Durable count of cooldown-gated retries already scheduled. */
  retryAttempt?: number;
  /** Earliest durable time at which a deferred candidate may return to pending. */
  retryEligibleAtMs?: number;
  revision: number;
}

/** The only candidate projection allowed to cross into shared arbitration state. */
export type IcpInitiationCandidateSharedMetadata = Omit<
  IcpInitiationCandidate,
  | 'peerContactId'
  | 'targetChannelId'
  | 'reasonSummary'
  | 'continuationTaskKind'
  | 'permitId'
  | 'pendingFollowUpId'
  | 'deliveryDisposition'
  | 'retryAttempt'
  | 'retryEligibleAtMs'
>;

export const MAX_ICP_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_ICP_CANDIDATE_REASON_CHARS = 1_000;

const CANDIDATE_KEYS = [
  'candidateId', 'rootInitiationId', 'localCompanionId', 'peerContactId',
  'peerCompanionId', 'preferredChannel', 'source', 'provenanceRef', 'reasonSummary',
  'targetChannelId',
  'continuationTaskKind', 'createdAtMs', 'expiresAtMs', 'status', 'reasonCode', 'permitId',
  'pendingFollowUpId', 'deliveryDisposition', 'retryAttempt', 'retryEligibleAtMs',
  'revision',
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
  const permitId = value.permitId === undefined
    ? undefined
    : requireUuid(value.permitId, 'ICP candidate.permitId');
  const pendingFollowUpId = value.pendingFollowUpId === undefined
    ? undefined
    : requireString(value.pendingFollowUpId, 'ICP candidate.pendingFollowUpId');
  const deliveryDisposition = value.deliveryDisposition === undefined
    ? undefined
    : requireEnum(
      value.deliveryDisposition,
      ['delivered', 'suppressed'] as const,
      'ICP candidate.deliveryDisposition',
    );
  const retryAttempt = value.retryAttempt === undefined
    ? undefined
    : requireTimestamp(value.retryAttempt, 'ICP candidate.retryAttempt');
  const retryEligibleAtMs = value.retryEligibleAtMs === undefined
    ? undefined
    : requireTimestamp(value.retryEligibleAtMs, 'ICP candidate.retryEligibleAtMs');
  if (pendingFollowUpId !== undefined && value.source !== 'intention') {
    throw new Error('ICP candidate.pendingFollowUpId is only valid for intention sources');
  }
  if (deliveryDisposition !== undefined && value.status !== 'consumed') {
    throw new Error('ICP candidate.deliveryDisposition requires consumed status');
  }
  if (retryEligibleAtMs !== undefined && value.status !== 'deferred') {
    throw new Error('ICP candidate.retryEligibleAtMs requires deferred status');
  }
  const preferredChannel = requireEnum(
    value.preferredChannel,
    ['dm', 'current_room'] as const,
    'ICP candidate.preferredChannel',
  );
  const targetChannelId = value.targetChannelId === undefined
    ? undefined
    : requireString(value.targetChannelId, 'ICP candidate.targetChannelId');
  if (targetChannelId !== undefined) {
    const target = parseCompanionChannelId(targetChannelId);
    if (!target || target.kind !== (preferredChannel === 'dm' ? 'dm' : 'room')) {
      throw new Error('ICP candidate.targetChannelId must match preferredChannel');
    }
    if (target.kind === 'dm'
      && !(
        target.participants.some(participant => participant === localCompanionId)
        && target.participants.some(participant => participant === peerCompanionId)
      )) {
      throw new Error('ICP candidate.targetChannelId must bind the candidate companion pair');
    }
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
    preferredChannel,
    ...(targetChannelId !== undefined ? { targetChannelId } : {}),
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
    ...(permitId !== undefined ? { permitId } : {}),
    ...(pendingFollowUpId !== undefined ? { pendingFollowUpId } : {}),
    ...(deliveryDisposition !== undefined ? { deliveryDisposition } : {}),
    ...(retryAttempt !== undefined ? { retryAttempt } : {}),
    ...(retryEligibleAtMs !== undefined ? { retryEligibleAtMs } : {}),
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
