import type { IcpPermitConsumptionOutcome } from '../../core/icp/autonomy-store-ports.js';
import {
  parseIcpInitiationCandidateSharedMetadata,
  type IcpInitiationCandidateSharedMetadata,
} from '../../core/icp/initiation-candidate.js';
import {
  ICP_AVAILABILITY_STATES,
  ICP_INITIATION_SOURCES,
  MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
  MAX_ICP_PERMIT_TTL_MS,
  type IcpAutonomyReasonCode,
  type IcpAvailabilityLease,
  type IcpAvailabilityState,
  type IcpDyadDeliveryOutcome,
  type IcpDyadParticipantState,
  type IcpDyadSideAction,
  type IcpDyadStatus,
  type IcpConversationEpisode,
  type IcpInitiationPermit,
  type IcpPermitStatus,
} from '../../shared/contracts/icp-autonomy.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
import { requireUuid } from '../../shared/utils/uuid.js';

export type IcpGateReasonClass = 'deferrable' | 'terminal';

export interface IcpOpenDyadProjection {
  dyadId: string;
  peerCompanionId: string;
  channelId: string;
  status: 'open';
  lifecycleRevision: number;
  availability: IcpPeerAvailabilityResult;
  lastDeliveryOutcome?: IcpDyadDeliveryOutcome;
  lastDeliveryAtMs?: number;
}

export interface IcpDyadLifecycleProjection {
  dyadId: string;
  peerCompanionId: string;
  channelId: string;
  status: IcpDyadStatus;
  ownState: IcpDyadParticipantState;
  peerState: IcpDyadParticipantState;
  lifecycleRevision: number;
}

export interface IcpDyadContinuationAuthorization {
  dyadId: string;
  deliveryId: string;
  peerCompanionId: string;
  channelId: string;
  dyadLifecycleRevision: number;
  episode: IcpConversationEpisode;
}

export type IcpDyadContinuationPrepareResult =
  | { status: 'authorized'; authorization: IcpDyadContinuationAuthorization }
  | {
      status: 'need_initiation';
      reasonCode: Extract<IcpAutonomyReasonCode,
        'dyad_not_found' | 'dyad_closed' | 'stale_provenance'>;
    }
  | {
      status: 'unavailable';
      reasonCode: IcpAutonomyReasonCode;
    };

interface IcpDyadLifecycleUpdatedResult {
  outcome: 'updated';
  dyadId: string;
  status: IcpDyadStatus;
  ownState: IcpDyadParticipantState;
  peerState: IcpDyadParticipantState;
  lifecycleRevision: number;
  revokedPermitCount: number;
  fencedDeliveryCount: number;
}

export type IcpDyadLifecycleResult = IcpDyadLifecycleUpdatedResult | {
  outcome: 'unavailable';
  reasonCode: Extract<IcpAutonomyReasonCode,
    'dyad_not_found' | 'dyad_paused' | 'dyad_closed' | 'dyad_blocked' | 'dyad_stale_revision'>;
};

/** Strict content-free deterministic facts owned by the initiating runtime. */
export interface IcpInitiationPolicySnapshot {
  canonicalPeerContact: boolean;
  trustAllows: boolean;
  senderBlocksPeer: boolean;
  peerBlocksSender: boolean;
  provenanceFresh: boolean;
  recursiveMiOnlyRoot: boolean;
  socialPressureAllows: boolean;
  chargeAllows: boolean;
  fatigueAllows: boolean;
  costAllows: boolean;
}

export interface IcpInitiationPreflightInput {
  candidate: IcpInitiationCandidateSharedMetadata;
  channelId: string;
}

export interface IcpInitiationPermitIssueInput extends IcpInitiationPreflightInput {
  permitExpiresAtMs: number;
}

export interface IcpInitiationGateDecision {
  eligible: boolean;
  reasonCode?: IcpAutonomyReasonCode;
  reasonClass?: IcpGateReasonClass;
}

export interface IcpInitiationPermitIssueResult {
  decision: IcpInitiationGateDecision;
  permit?: IcpInitiationPermit;
}

export interface IcpPeerAvailabilityResult {
  peerCompanionId: string;
  connectionState: 'online' | 'offline';
  eligible: boolean;
  reasonCode?: IcpAutonomyReasonCode;
  lease?: IcpAvailabilityLease;
}

export interface IcpOwnAvailabilityResult {
  eligible: boolean;
  reasonCode?: IcpAutonomyReasonCode;
  lease?: IcpAvailabilityLease;
  control: 'missing' | 'expired' | 'companion' | 'runtime' | 'operator_override';
  mutableByCompanion: boolean;
}

export interface IcpOwnAvailabilityReadParams {
  companionId?: string;
}

export interface IcpRuntimeAvailabilityRefreshParams {
  state: Extract<IcpAvailabilityState, 'available' | 'resting'>;
  expiresAtMs: number;
  companionId?: string;
}

export interface IcpRuntimeAvailabilityClearParams {
  companionId?: string;
}

export type IcpInitiationHandoffPrepareResult =
  | {
      authorized: true;
      permit: IcpInitiationPermit;
      rootInitiationId: string;
    }
  | {
      authorized: false;
      reasonCode: IcpAutonomyReasonCode;
    };

export interface IcpPermitConsumeResult {
  outcome: IcpPermitConsumptionOutcome;
  reasonCode?: IcpAutonomyReasonCode;
  status?: IcpPermitStatus;
  revision?: number;
}

const POLICY_KEYS = [
  'canonicalPeerContact', 'trustAllows', 'senderBlocksPeer', 'peerBlocksSender',
  'provenanceFresh', 'recursiveMiOnlyRoot', 'socialPressureAllows',
  'chargeAllows', 'fatigueAllows', 'costAllows',
] as const;

const PREFLIGHT_KEYS = ['candidate', 'channelId', 'companionId'] as const;
const ISSUE_KEYS = [...PREFLIGHT_KEYS, 'permitExpiresAtMs'] as const;

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function requirePositiveRevision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireTrimmedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

export function parseIcpInitiationPolicySnapshot(value: unknown): IcpInitiationPolicySnapshot {
  if (!isRecord(value)) throw new Error('ICP initiation policy snapshot must be an object');
  assertNoUnknownKeys(value, POLICY_KEYS, 'ICP initiation policy snapshot');
  return {
    canonicalPeerContact: requireBoolean(value.canonicalPeerContact, 'policy.canonicalPeerContact'),
    trustAllows: requireBoolean(value.trustAllows, 'policy.trustAllows'),
    senderBlocksPeer: requireBoolean(value.senderBlocksPeer, 'policy.senderBlocksPeer'),
    peerBlocksSender: requireBoolean(value.peerBlocksSender, 'policy.peerBlocksSender'),
    provenanceFresh: requireBoolean(value.provenanceFresh, 'policy.provenanceFresh'),
    recursiveMiOnlyRoot: requireBoolean(value.recursiveMiOnlyRoot, 'policy.recursiveMiOnlyRoot'),
    socialPressureAllows: requireBoolean(value.socialPressureAllows, 'policy.socialPressureAllows'),
    chargeAllows: requireBoolean(value.chargeAllows, 'policy.chargeAllows'),
    fatigueAllows: requireBoolean(value.fatigueAllows, 'policy.fatigueAllows'),
    costAllows: requireBoolean(value.costAllows, 'policy.costAllows'),
  };
}

export function parseIcpInitiationPreflightInput(
  value: unknown,
  nowMs: number,
): IcpInitiationPreflightInput {
  if (!isRecord(value)) throw new Error('ICP initiation preflight params must be an object');
  assertNoUnknownKeys(value, PREFLIGHT_KEYS, 'ICP initiation preflight params');
  return {
    candidate: parseIcpInitiationCandidateSharedMetadata(value.candidate, {
      nowMs,
      requireCurrent: true,
    }),
    channelId: requireTrimmedString(value.channelId, 'channelId'),
  };
}

export function parseIcpInitiationPermitIssueInput(
  value: unknown,
  nowMs: number,
): IcpInitiationPermitIssueInput {
  if (!isRecord(value)) throw new Error('ICP permit issue params must be an object');
  assertNoUnknownKeys(value, ISSUE_KEYS, 'ICP permit issue params');
  const base = parseIcpInitiationPreflightInput({
    candidate: value.candidate,
    channelId: value.channelId,
    ...(value.companionId !== undefined ? { companionId: value.companionId } : {}),
  }, nowMs);
  const permitExpiresAtMs = requireTimestamp(value.permitExpiresAtMs, 'permitExpiresAtMs');
  if (permitExpiresAtMs <= nowMs) throw new Error('permitExpiresAtMs must be in the future');
  if (permitExpiresAtMs - nowMs > MAX_ICP_PERMIT_TTL_MS) {
    throw new Error(`ICP initiation permit exceeds maximum TTL ${MAX_ICP_PERMIT_TTL_MS}ms`);
  }
  if (permitExpiresAtMs > base.candidate.expiresAtMs) {
    throw new Error('permitExpiresAtMs must not outlive the initiation candidate');
  }
  return { ...base, permitExpiresAtMs };
}

export function parseIcpAvailabilityPublishParams(
  value: unknown,
): { state: IcpAvailabilityState; expiresAtMs: number; revision: number } {
  if (!isRecord(value)) throw new Error('ICP availability publish params must be an object');
  assertNoUnknownKeys(value, ['state', 'expiresAtMs', 'revision', 'companionId'], 'ICP availability publish params');
  if (typeof value.state !== 'string' || !ICP_AVAILABILITY_STATES.includes(value.state as IcpAvailabilityState)) {
    throw new Error(`state must be one of: ${ICP_AVAILABILITY_STATES.join(', ')}`);
  }
  return {
    state: value.state as IcpAvailabilityState,
    expiresAtMs: requireTimestamp(value.expiresAtMs, 'expiresAtMs'),
    revision: requirePositiveRevision(value.revision, 'revision'),
  };
}

export function parseIcpAvailabilityClearParams(value: unknown): { expectedRevision: number } {
  if (!isRecord(value)) throw new Error('ICP availability clear params must be an object');
  assertNoUnknownKeys(value, ['expectedRevision', 'companionId'], 'ICP availability clear params');
  return { expectedRevision: requirePositiveRevision(value.expectedRevision, 'expectedRevision') };
}

export function parseIcpRuntimeAvailabilityRefreshParams(
  value: unknown,
  nowMs: number,
): Omit<IcpRuntimeAvailabilityRefreshParams, 'companionId'> {
  if (!isRecord(value)) throw new Error('ICP runtime availability refresh params must be an object');
  assertNoUnknownKeys(
    value,
    ['state', 'expiresAtMs', 'companionId'],
    'ICP runtime availability refresh params',
  );
  if (value.state !== 'available' && value.state !== 'resting') {
    throw new Error('ICP runtime availability state must be available or resting');
  }
  const expiresAtMs = requireTimestamp(value.expiresAtMs, 'expiresAtMs');
  if (expiresAtMs <= nowMs) throw new Error('expiresAtMs must be in the future');
  if (expiresAtMs - nowMs > MAX_ICP_AVAILABILITY_LEASE_TTL_MS) {
    throw new Error(
      `ICP runtime availability exceeds maximum TTL ${MAX_ICP_AVAILABILITY_LEASE_TTL_MS}ms`,
    );
  }
  return { state: value.state, expiresAtMs };
}

export function parseIcpRuntimeAvailabilityClearParams(
  value: unknown,
): IcpRuntimeAvailabilityClearParams {
  if (!isRecord(value)) throw new Error('ICP runtime availability clear params must be an object');
  assertNoUnknownKeys(value, ['companionId'], 'ICP runtime availability clear params');
  const companionId = value.companionId === undefined
    ? undefined
    : requireUuid(value.companionId, 'companionId');
  return companionId === undefined ? {} : { companionId };
}

export function parseIcpPeerAvailabilityReadParams(value: unknown): { peerCompanionId: string } {
  if (!isRecord(value)) throw new Error('ICP peer availability params must be an object');
  assertNoUnknownKeys(value, ['peerCompanionId', 'companionId'], 'ICP peer availability params');
  return { peerCompanionId: requireUuid(value.peerCompanionId, 'peerCompanionId') };
}

export function parseIcpOwnAvailabilityReadParams(value: unknown): IcpOwnAvailabilityReadParams {
  if (!isRecord(value)) throw new Error('ICP own availability params must be an object');
  assertNoUnknownKeys(value, ['companionId'], 'ICP own availability params');
  const companionId = value.companionId === undefined
    ? undefined
    : requireUuid(value.companionId, 'companionId');
  return companionId === undefined ? {} : { companionId };
}

export function parseIcpOpenDyadListParams(value: unknown): Record<string, never> {
  if (!isRecord(value)) throw new Error('ICP open dyad list params must be an object');
  assertNoUnknownKeys(value, ['companionId'], 'ICP open dyad list params');
  return {};
}

export function parseIcpDyadLifecycleParams(value: unknown): {
  dyadId: string;
  expectedRevision: number;
  action: IcpDyadSideAction;
} {
  if (!isRecord(value)) throw new Error('ICP dyad lifecycle params must be an object');
  assertNoUnknownKeys(
    value,
    ['dyadId', 'expectedRevision', 'action', 'companionId'],
    'ICP dyad lifecycle params',
  );
  if (value.action !== 'pause' && value.action !== 'resume' && value.action !== 'close'
    && value.action !== 'block' && value.action !== 'unblock') {
    throw new Error('ICP dyad lifecycle action is invalid');
  }
  return {
    dyadId: requireUuid(value.dyadId, 'dyadId'),
    expectedRevision: requirePositiveRevision(value.expectedRevision, 'expectedRevision'),
    action: value.action,
  };
}

export function parseIcpDyadContinuationPrepareParams(value: unknown): {
  dyadId: string;
  deliveryId: string;
  conversationId: string;
  peerContactId: string;
  initiationSource: typeof ICP_INITIATION_SOURCES[number];
  sourceDyadId?: string;
} {
  if (!isRecord(value)) throw new Error('ICP dyad continuation params must be an object');
  assertNoUnknownKeys(value, [
    'dyadId', 'deliveryId', 'conversationId', 'peerContactId', 'initiationSource',
    'sourceDyadId', 'companionId',
  ], 'ICP dyad continuation params');
  if (typeof value.initiationSource !== 'string'
    || !ICP_INITIATION_SOURCES.includes(value.initiationSource as typeof ICP_INITIATION_SOURCES[number])) {
    throw new Error('ICP dyad continuation initiationSource is invalid');
  }
  return {
    dyadId: requireUuid(value.dyadId, 'dyadId'),
    deliveryId: requireUuid(value.deliveryId, 'deliveryId'),
    conversationId: requireUuid(value.conversationId, 'conversationId'),
    peerContactId: requireTrimmedString(value.peerContactId, 'peerContactId'),
    initiationSource: value.initiationSource as typeof ICP_INITIATION_SOURCES[number],
    ...(value.sourceDyadId === undefined
      ? {}
      : { sourceDyadId: requireUuid(value.sourceDyadId, 'sourceDyadId') }),
  };
}

export function parseIcpDyadContinuationOutcomeParams(value: unknown): {
  dyadId: string;
  deliveryId: string;
  peerContactId: string;
  outcome: 'suppressed' | 'failed' | 'retrying';
  attempt: number;
  reasonCode?: Extract<IcpAutonomyReasonCode, 'delivery_failed' | 'conversation_ended'>;
} {
  if (!isRecord(value)) throw new Error('ICP dyad continuation outcome params must be an object');
  assertNoUnknownKeys(value, [
    'dyadId', 'deliveryId', 'peerContactId', 'outcome', 'attempt', 'reasonCode', 'companionId',
  ], 'ICP dyad continuation outcome params');
  if (value.outcome !== 'suppressed' && value.outcome !== 'failed' && value.outcome !== 'retrying') {
    throw new Error('ICP dyad continuation outcome is invalid');
  }
  if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 0) {
    throw new Error('ICP dyad continuation attempt is invalid');
  }
  if (value.reasonCode !== undefined
    && value.reasonCode !== 'delivery_failed' && value.reasonCode !== 'conversation_ended') {
    throw new Error('ICP dyad continuation reasonCode is invalid');
  }
  return {
    dyadId: requireUuid(value.dyadId, 'dyadId'),
    deliveryId: requireUuid(value.deliveryId, 'deliveryId'),
    peerContactId: requireTrimmedString(value.peerContactId, 'peerContactId'),
    outcome: value.outcome,
    attempt: Number(value.attempt),
    ...(value.reasonCode ? { reasonCode: value.reasonCode } : {}),
  };
}

export function parseIcpInitiationHandoffPrepareParams(value: unknown): {
  permitId: string;
  peerContactId: string;
} {
  if (!isRecord(value)) throw new Error('ICP initiation handoff params must be an object');
  assertNoUnknownKeys(
    value,
    ['permitId', 'peerContactId', 'companionId'],
    'ICP initiation handoff params',
  );
  return {
    permitId: requireUuid(value.permitId, 'permitId'),
    peerContactId: requireTrimmedString(value.peerContactId, 'peerContactId'),
  };
}

export function parseIcpPermitConsumeParams(value: unknown): {
  permitId: string;
  conversationId: string;
  recipientCompanionId: string;
  channelId: string;
  rootInitiationId: string;
  peerContactId: string;
  terminalReasonCode?: IcpAutonomyReasonCode;
} {
  if (!isRecord(value)) throw new Error('ICP permit consume params must be an object');
  assertNoUnknownKeys(
    value,
    [
      'permitId',
      'conversationId',
      'recipientCompanionId',
      'channelId',
      'rootInitiationId',
      'peerContactId',
      'terminalReasonCode',
      'companionId',
    ],
    'ICP permit consume params',
  );
  const terminalReasonCode = value.terminalReasonCode;
  if (terminalReasonCode !== undefined && ![
    'fatigue_exhausted',
    'charge_pressure',
    'cost_hard_stop',
    'inactivity_timeout',
    'conversation_ended',
  ].includes(String(terminalReasonCode))) {
    throw new Error('ICP permit consume terminalReasonCode is not an activity terminal reason');
  }
  return {
    permitId: requireUuid(value.permitId, 'permitId'),
    conversationId: requireUuid(value.conversationId, 'conversationId'),
    recipientCompanionId: requireUuid(value.recipientCompanionId, 'recipientCompanionId'),
    channelId: requireTrimmedString(value.channelId, 'channelId'),
    rootInitiationId: requireUuid(value.rootInitiationId, 'rootInitiationId'),
    peerContactId: requireTrimmedString(value.peerContactId, 'peerContactId'),
    ...(terminalReasonCode !== undefined
      ? { terminalReasonCode: terminalReasonCode as IcpAutonomyReasonCode }
      : {}),
  };
}

export function parseIcpEpisodeActivityEndParams(value: unknown): {
  conversationId: string;
  reasonCode: Extract<IcpAutonomyReasonCode,
    'fatigue_exhausted' | 'charge_pressure' | 'cost_hard_stop'
      | 'inactivity_timeout' | 'conversation_ended'>;
} {
  if (!isRecord(value)) throw new Error('ICP episode activity end params must be an object');
  assertNoUnknownKeys(
    value,
    ['conversationId', 'reasonCode', 'companionId'],
    'ICP episode activity end params',
  );
  if (![
    'fatigue_exhausted',
    'charge_pressure',
    'cost_hard_stop',
    'inactivity_timeout',
    'conversation_ended',
  ].includes(String(value.reasonCode))) {
    throw new Error('ICP episode activity end reasonCode is not an activity terminal reason');
  }
  return {
    conversationId: requireUuid(value.conversationId, 'conversationId'),
    reasonCode: value.reasonCode as Extract<IcpAutonomyReasonCode,
      'fatigue_exhausted' | 'charge_pressure' | 'cost_hard_stop'
        | 'inactivity_timeout' | 'conversation_ended'>,
  };
}

export function parseIcpPermitRevokeParams(value: unknown): {
  permitId: string;
  expectedRevision: number;
} {
  if (!isRecord(value)) throw new Error('ICP permit revoke params must be an object');
  assertNoUnknownKeys(value, ['permitId', 'expectedRevision', 'companionId'], 'ICP permit revoke params');
  return {
    permitId: requireUuid(value.permitId, 'permitId'),
    expectedRevision: requirePositiveRevision(value.expectedRevision, 'expectedRevision'),
  };
}

export function parseIcpPermitInvalidateSelfParams(value: unknown): { reasonCode: 'peer_blocked' } {
  if (!isRecord(value)) throw new Error('ICP permit self-invalidation params must be an object');
  assertNoUnknownKeys(value, ['reasonCode', 'companionId'], 'ICP permit self-invalidation params');
  if (value.reasonCode !== 'peer_blocked') {
    throw new Error('ICP permit self-invalidation reasonCode must be peer_blocked');
  }
  return { reasonCode: value.reasonCode };
}
