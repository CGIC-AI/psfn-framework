import { createHash } from 'node:crypto';

import type {
  IcpInitiationGateDecision,
  IcpInitiationPermitIssueResult,
} from '../../boundary/gateway/icp-autonomy-contract.js';
import {
  composeCompanionDmChannelId,
  parseCompanionChannelId,
} from '../../shared/contracts/companion-channels.js';
import type {
  IcpAutonomyReasonCode,
  IcpInitiationSource,
} from '../../shared/contracts/icp-autonomy.js';
import type { IcpAutonomyCandidateOrigin } from '../../shared/contracts/runtime.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type {
  IcpCompanionOutreachExecutionResult,
  KnownCompanionPeer,
} from './agent-facing-autonomy.js';
import type {
  IcpInitiationCandidateClaim,
  IcpInitiationCandidateStorePort,
} from './autonomy-store-ports.js';
import {
  toIcpInitiationCandidateSharedMetadata,
  type IcpInitiationCandidate,
  type IcpInitiationCandidateStatus,
} from './initiation-candidate.js';

export type IcpInitiationCause =
  | { kind: 'independent' }
  | { kind: 'icp_conversation'; rootInitiationId: string };

export interface IcpInitiationSourceRequest {
  source: IcpInitiationSource;
  peerContactId: string;
  preferredChannel: 'dm' | 'current_room';
  /** Required only for current_room; must be a canonical companion room. */
  currentRoomChannelId?: string;
  /** Durable source owner identity (thought/follow-up/turn/tool-call tuple). */
  sourceRecordId: string;
  /** Durable intention owner; stable when a scheduler action is recreated. */
  pendingFollowUpId?: string;
  /** Private companion-local motivation. Never projected to the gateway. */
  reasonSummary: string;
  cause: IcpInitiationCause;
  ttlMs?: number;
}

export type IcpInitiationConsent =
  | { action: 'send' }
  | { action: 'defer'; reason?: string }
  | { action: 'decline'; reason?: string };

export interface IcpInitiationConsentEvaluator {
  evaluate(input: {
    candidate: IcpInitiationCandidate;
    peer: KnownCompanionPeer;
    channelId: string;
  }): Promise<IcpInitiationConsent>;
}

export interface IcpInitiationSourcePeerPort {
  resolveKnownPeer(contactId: string): Promise<KnownCompanionPeer>;
  executeCompanionOutreach(
    contactId: string,
    permitId: string,
    candidateOrigin: IcpAutonomyCandidateOrigin,
    isExecutionAuthorized?: () => boolean,
  ): Promise<IcpCompanionOutreachExecutionResult>;
}

export interface IcpInitiationSourceGatewayPort {
  companionInitiationPreflight(input: {
    candidate: ReturnType<typeof toIcpInitiationCandidateSharedMetadata>;
    channelId: string;
  }): Promise<IcpInitiationGateDecision>;
  companionIssueInitiationPermit(input: {
    candidate: ReturnType<typeof toIcpInitiationCandidateSharedMetadata>;
    channelId: string;
    permitExpiresAtMs: number;
  }): Promise<IcpInitiationPermitIssueResult>;
}

export interface IcpInitiationSourceRuntimeDependencies {
  localCompanionId: string;
  store: IcpInitiationCandidateStorePort;
  peers: IcpInitiationSourcePeerPort;
  gateway: IcpInitiationSourceGatewayPort;
  consent: IcpInitiationConsentEvaluator;
  /** Canonical capability-tier authorization. Required for every source. */
  isExternalCompanionAuthorized(): boolean;
  policy?: {
    candidateDefaultTtlMs: number;
    retryCadenceMs: number;
    maxRetryAttempts: number;
    permitTtlMs: number;
  };
  eventBus?: EventBus;
  now?: () => number;
}

export type IcpInitiationSourceOutcome =
  | 'sent'
  | 'suppressed'
  | 'deferred'
  | 'declined'
  | 'rejected'
  | 'deduped';

export interface IcpInitiationSourceResult {
  outcome: IcpInitiationSourceOutcome;
  candidateId: string;
  status: IcpInitiationCandidateStatus;
  reasonCode?: IcpAutonomyReasonCode;
  pendingFollowUpId?: string;
  deliveryDisposition?: IcpInitiationCandidate['deliveryDisposition'];
  /** Durable queue wake time for a deferred candidate. */
  retryEligibleAtMs?: number;
}

export interface IcpInitiationSourceRuntime {
  submit(request: IcpInitiationSourceRequest): Promise<IcpInitiationSourceResult>;
  /** Resume exact Postgres-leased lifecycle work without source resubmission. */
  resumeClaim(claim: IcpInitiationCandidateClaim): Promise<IcpInitiationSourceResult>;
}

function requireTrimmed(value: string, field: string, maxChars: number): string {
  if (!value || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  if (value.length > maxChars) {
    throw new Error(`${field} must be ${maxChars} characters or fewer`);
  }
  return value;
}

/** Deterministic RFC-4122 v5-shaped id from private source identity. */
export function deterministicIcpUuid(label: string, value: string): string {
  const bytes = createHash('sha256').update(`${label}\0${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function resolveIcpCandidateChannelId(
  localCompanionId: string,
  peerCompanionId: string,
  request: IcpInitiationSourceRequest,
  maxChannelIdChars: number,
): string {
  if (request.preferredChannel === 'dm') {
    return composeCompanionDmChannelId(
      localCompanionId as CompanionId,
      peerCompanionId as CompanionId,
    );
  }
  const channelId = requireTrimmed(
    request.currentRoomChannelId ?? '',
    'currentRoomChannelId',
    maxChannelIdChars,
  );
  if (parseCompanionChannelId(channelId)?.kind !== 'room') {
    throw new Error('currentRoomChannelId must be a canonical companion room channel');
  }
  return channelId;
}

export function deriveIcpSourceIdentity(input: {
  localCompanionId: string;
  peerCompanionId: string;
  request: IcpInitiationSourceRequest;
}, maxSourceRecordIdChars: number): string {
  const durableSourceRecord = input.request.pendingFollowUpId === undefined
    ? requireTrimmed(input.request.sourceRecordId, 'sourceRecordId', maxSourceRecordIdChars)
    : `pending-follow-up:${requireTrimmed(
        input.request.pendingFollowUpId,
        'pendingFollowUpId',
        maxSourceRecordIdChars,
      )}`;
  if (input.request.source === 'felt_impulse' || input.request.source === 'operator_test') {
    return [input.localCompanionId, input.request.source, durableSourceRecord].join('\0');
  }
  return [
    input.localCompanionId,
    input.peerCompanionId,
    input.request.source,
    input.request.preferredChannel,
    durableSourceRecord,
  ].join('\0');
}

export function isSameIcpCandidate(
  left: IcpInitiationCandidate,
  right: IcpInitiationCandidate,
): boolean {
  return left.candidateId === right.candidateId
    && left.rootInitiationId === right.rootInitiationId
    && left.localCompanionId === right.localCompanionId
    && left.peerContactId === right.peerContactId
    && left.peerCompanionId === right.peerCompanionId
    && left.preferredChannel === right.preferredChannel
    && left.targetChannelId === right.targetChannelId
    && left.source === right.source
    && left.provenanceRef === right.provenanceRef
    && left.reasonSummary === right.reasonSummary
    && left.pendingFollowUpId === right.pendingFollowUpId;
}

export function toIcpCandidateOrigin(
  candidate: IcpInitiationCandidate,
): IcpAutonomyCandidateOrigin {
  return {
    candidateId: candidate.candidateId,
    rootInitiationId: candidate.rootInitiationId,
    source: candidate.source,
    provenanceRef: candidate.provenanceRef,
    ...(candidate.continuationTaskKind
      ? { continuationTaskKind: candidate.continuationTaskKind }
      : {}),
  };
}

export function toIcpSourceResult(
  outcome: IcpInitiationSourceOutcome,
  candidate: IcpInitiationCandidate,
  reasonCode?: IcpAutonomyReasonCode,
): IcpInitiationSourceResult {
  return {
    outcome,
    candidateId: candidate.candidateId,
    status: candidate.status,
    ...(reasonCode ? { reasonCode } : {}),
    ...(candidate.pendingFollowUpId ? { pendingFollowUpId: candidate.pendingFollowUpId } : {}),
    ...(candidate.deliveryDisposition
      ? { deliveryDisposition: candidate.deliveryDisposition }
      : {}),
    ...(candidate.status === 'deferred' && candidate.retryEligibleAtMs !== undefined
      ? { retryEligibleAtMs: candidate.retryEligibleAtMs }
      : {}),
  };
}

export function terminalIcpSourceOutcome(
  candidate: IcpInitiationCandidate,
): IcpInitiationSourceResult | null {
  switch (candidate.status) {
    case 'declined':
      return toIcpSourceResult('deduped', candidate, candidate.reasonCode ?? 'candidate_declined');
    case 'rejected':
      return toIcpSourceResult('deduped', candidate, candidate.reasonCode);
    case 'deferred':
      return toIcpSourceResult('deduped', candidate, candidate.reasonCode ?? 'candidate_deferred');
    case 'consumed':
    case 'expired':
    case 'cancelled':
      return toIcpSourceResult('deduped', candidate, candidate.reasonCode);
    case 'pending':
    case 'permitted':
      return null;
  }
}

export function resolveIcpTransitionDenial(
  decision: IcpInitiationGateDecision,
): { status: 'deferred' | 'rejected'; reasonCode: IcpAutonomyReasonCode } {
  if (decision.reasonClass === 'deferrable') {
    return { status: 'deferred', reasonCode: decision.reasonCode ?? 'candidate_deferred' };
  }
  return { status: 'rejected', reasonCode: decision.reasonCode ?? 'policy_denied' };
}
