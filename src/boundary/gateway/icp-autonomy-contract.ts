import type { IcpPermitConsumptionOutcome } from '../../core/icp/autonomy-store-ports.js';
import {
  parseIcpInitiationCandidateSharedMetadata,
  type IcpInitiationCandidateSharedMetadata,
} from '../../core/icp/initiation-candidate.js';
import {
  ICP_AVAILABILITY_STATES,
  MAX_ICP_PERMIT_TTL_MS,
  type IcpAutonomyReasonCode,
  type IcpAvailabilityLease,
  type IcpAvailabilityState,
  type IcpInitiationPermit,
  type IcpPermitStatus,
} from '../../shared/contracts/icp-autonomy.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
import { requireUuid } from '../../shared/utils/uuid.js';

export type IcpGateReasonClass = 'deferrable' | 'terminal';

/** Strict content-free deterministic facts owned by the initiating runtime. */
export interface IcpInitiationPolicySnapshot {
  canonicalPeerContact: boolean;
  trustAllows: boolean;
  senderBlocksPeer: boolean;
  peerBlocksSender: boolean;
  quietHours: boolean;
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
  'quietHours', 'provenanceFresh', 'recursiveMiOnlyRoot', 'socialPressureAllows',
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
    quietHours: requireBoolean(value.quietHours, 'policy.quietHours'),
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
      'companionId',
    ],
    'ICP permit consume params',
  );
  return {
    permitId: requireUuid(value.permitId, 'permitId'),
    conversationId: requireUuid(value.conversationId, 'conversationId'),
    recipientCompanionId: requireUuid(value.recipientCompanionId, 'recipientCompanionId'),
    channelId: requireTrimmedString(value.channelId, 'channelId'),
    rootInitiationId: requireUuid(value.rootInitiationId, 'rootInitiationId'),
    peerContactId: requireTrimmedString(value.peerContactId, 'peerContactId'),
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
