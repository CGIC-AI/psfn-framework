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
import { createComponentLogger } from '../../shared/logger.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import type {
  IcpCompanionOutreachExecutionResult,
  KnownCompanionPeer,
} from './agent-facing-autonomy.js';
import type { IcpInitiationCandidateStorePort } from './autonomy-store-ports.js';
import {
  MAX_ICP_CANDIDATE_TTL_MS,
  parseIcpInitiationCandidate,
  toIcpInitiationCandidateSharedMetadata,
  type IcpInitiationCandidate,
  type IcpInitiationCandidateStatus,
} from './initiation-candidate.js';

const DEFAULT_CANDIDATE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_PERMIT_TTL_MS = 5 * 60_000;
export const ICP_INITIATION_RETRY_COOLDOWN_MS = 5 * 60_000;
export const MAX_ICP_INITIATION_RETRY_ATTEMPTS = 3;
const MAX_SOURCE_RECORD_ID_CHARS = 1_024;
const log = createComponentLogger('IcpInitiationSource');

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

function toCandidateOrigin(
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

export interface IcpInitiationSourceRuntime {
  submit(request: IcpInitiationSourceRequest): Promise<IcpInitiationSourceResult>;
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
function deterministicUuid(label: string, value: string): string {
  const bytes = createHash('sha256').update(`${label}\0${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resolveChannelId(
  localCompanionId: string,
  peerCompanionId: string,
  request: IcpInitiationSourceRequest,
): string {
  if (request.preferredChannel === 'dm') {
    return composeCompanionDmChannelId(localCompanionId, peerCompanionId);
  }
  const channelId = requireTrimmed(
    request.currentRoomChannelId ?? '',
    'currentRoomChannelId',
    1_024,
  );
  if (parseCompanionChannelId(channelId)?.kind !== 'room') {
    throw new Error('currentRoomChannelId must be a canonical companion room channel');
  }
  return channelId;
}

function sourceIdentity(input: {
  localCompanionId: string;
  peerCompanionId: string;
  request: IcpInitiationSourceRequest;
}): string {
  return [
    input.localCompanionId,
    input.peerCompanionId,
    input.request.source,
    input.request.preferredChannel,
    input.request.pendingFollowUpId === undefined
      ? requireTrimmed(
        input.request.sourceRecordId,
        'sourceRecordId',
        MAX_SOURCE_RECORD_ID_CHARS,
      )
      : `pending-follow-up:${requireTrimmed(
        input.request.pendingFollowUpId,
        'pendingFollowUpId',
        MAX_SOURCE_RECORD_ID_CHARS,
      )}`,
  ].join('\0');
}

function sameCandidate(left: IcpInitiationCandidate, right: IcpInitiationCandidate): boolean {
  return left.candidateId === right.candidateId
    && left.rootInitiationId === right.rootInitiationId
    && left.localCompanionId === right.localCompanionId
    && left.peerContactId === right.peerContactId
    && left.peerCompanionId === right.peerCompanionId
    && left.preferredChannel === right.preferredChannel
    && left.source === right.source
    && left.provenanceRef === right.provenanceRef
    && left.reasonSummary === right.reasonSummary
    && left.pendingFollowUpId === right.pendingFollowUpId;
}

function result(
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

function terminalOutcome(candidate: IcpInitiationCandidate): IcpInitiationSourceResult | null {
  switch (candidate.status) {
    case 'declined':
      return result('deduped', candidate, candidate.reasonCode ?? 'candidate_declined');
    case 'rejected':
      return result('deduped', candidate, candidate.reasonCode);
    case 'deferred':
      return result('deduped', candidate, candidate.reasonCode ?? 'candidate_deferred');
    case 'consumed':
    case 'expired':
    case 'cancelled':
      return result('deduped', candidate, candidate.reasonCode);
    case 'pending':
    case 'permitted':
      return null;
  }
}

function transitionReason(
  decision: IcpInitiationGateDecision,
): { status: 'deferred' | 'rejected'; reasonCode: IcpAutonomyReasonCode } {
  if (decision.reasonClass === 'deferrable') {
    return { status: 'deferred', reasonCode: decision.reasonCode ?? 'candidate_deferred' };
  }
  return { status: 'rejected', reasonCode: decision.reasonCode ?? 'policy_denied' };
}

export function createIcpInitiationSourceRuntime(
  dependencies: IcpInitiationSourceRuntimeDependencies,
): IcpInitiationSourceRuntime {
  if (!isRfc4122Uuid(dependencies.localCompanionId)) {
    throw new Error('ICP initiation source runtime requires a lowercase RFC-4122 localCompanionId');
  }
  const now = dependencies.now ?? Date.now;
  const inFlight = new Map<string, Promise<IcpInitiationSourceResult>>();

  const emitLifecycle = async (
    candidate: IcpInitiationCandidate,
    previousStatus: IcpInitiationCandidateStatus | null,
  ): Promise<void> => {
    if (!dependencies.eventBus) return;
    try {
      await dependencies.eventBus.emit('icp.initiation.candidate.lifecycle', {
        candidateId: candidate.candidateId,
        localCompanionId: candidate.localCompanionId,
        peerCompanionId: candidate.peerCompanionId,
        source: candidate.source,
        previousStatus,
        status: candidate.status,
        ...(candidate.reasonCode ? { reasonCode: candidate.reasonCode } : {}),
        timestamp: now(),
      });
    } catch (error) {
      // Audit telemetry is deliberately non-transactional: a listener failure
      // must never roll back or replay a durable candidate transition.
      log.warn('ICP candidate lifecycle telemetry emit failed', {
        candidateId: candidate.candidateId,
        status: candidate.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const transition = async (
    candidate: IcpInitiationCandidate,
    status: IcpInitiationCandidateStatus,
    reasonCode?: IcpAutonomyReasonCode,
    deliveryDisposition?: IcpInitiationCandidate['deliveryDisposition'],
  ): Promise<IcpInitiationCandidate> => {
    const next = await dependencies.store.transitionCandidate({
      candidateId: candidate.candidateId,
      expectedStatus: candidate.status,
      expectedRevision: candidate.revision,
      status,
      ...(reasonCode ? { reasonCode } : {}),
      ...(deliveryDisposition ? { deliveryDisposition } : {}),
    });
    await emitLifecycle(next, candidate.status);
    return next;
  };

  const run = async (
    request: IcpInitiationSourceRequest,
    peer: KnownCompanionPeer,
    candidateId: string,
  ): Promise<IcpInitiationSourceResult> => {
    const currentNow = now();
    if (request.pendingFollowUpId !== undefined && request.source !== 'intention') {
      throw new Error('pendingFollowUpId is only valid for intention initiation sources');
    }
    const ttlMs = Math.min(
      MAX_ICP_CANDIDATE_TTL_MS,
      Math.max(1, Math.floor(request.ttlMs ?? DEFAULT_CANDIDATE_TTL_MS)),
    );
    const identity = sourceIdentity({
      localCompanionId: dependencies.localCompanionId,
      peerCompanionId: peer.peerCompanionId,
      request,
    });
    const provenanceRef = `icp-prov:${deterministicUuid('icp-provenance', identity)}`;
    const rootInitiationId = request.cause.kind === 'independent'
      ? candidateId
      : request.cause.rootInitiationId;
    if (!isRfc4122Uuid(rootInitiationId)) {
      throw new Error('Inherited ICP rootInitiationId must be a lowercase RFC-4122 UUID');
    }
    const proposed = parseIcpInitiationCandidate({
      candidateId,
      rootInitiationId,
      localCompanionId: dependencies.localCompanionId,
      peerContactId: peer.contactId,
      peerCompanionId: peer.peerCompanionId,
      preferredChannel: request.preferredChannel,
      source: request.source,
      provenanceRef,
      reasonSummary: request.reasonSummary,
      createdAtMs: currentNow,
      expiresAtMs: currentNow + ttlMs,
      status: 'pending',
      ...(request.pendingFollowUpId ? { pendingFollowUpId: request.pendingFollowUpId } : {}),
      retryAttempt: 0,
      revision: 1,
    });

    let candidate = await dependencies.store.getCandidate(candidateId);
    if (!candidate) {
      try {
        candidate = await dependencies.store.createCandidate(proposed);
        await emitLifecycle(candidate, null);
      } catch (error) {
        candidate = await dependencies.store.getCandidate(candidateId);
        if (!candidate) throw error;
      }
    }
    if (!sameCandidate(candidate, proposed)) {
      // A deterministic identity collision or mutated source input is an
      // invariant violation. Never silently reuse another private motivation.
      throw new Error(`ICP candidate identity conflict for ${candidateId}`);
    }
    if (candidate.expiresAtMs <= now()
      && ['pending', 'deferred', 'permitted'].includes(candidate.status)) {
      const expired = await transition(candidate, 'expired', 'candidate_expired');
      return result('deduped', expired, 'candidate_expired');
    }
    if (candidate.status === 'deferred') {
      const retryNow = now();
      if (candidate.retryEligibleAtMs === undefined || retryNow < candidate.retryEligibleAtMs) {
        return result('deduped', candidate, candidate.reasonCode ?? 'candidate_deferred');
      }
      const pending = await dependencies.store.transitionCandidate({
        candidateId: candidate.candidateId,
        expectedStatus: candidate.status,
        expectedRevision: candidate.revision,
        status: 'pending',
        clearRetryEligibility: true,
      });
      await emitLifecycle(pending, candidate.status);
      candidate = pending;
    }
    const terminal = terminalOutcome(candidate);
    if (terminal) return terminal;
    if (!dependencies.isExternalCompanionAuthorized()) {
      if (candidate.status === 'pending') {
        const rejected = await transition(candidate, 'rejected', 'policy_denied');
        return result('rejected', rejected, 'policy_denied');
      }
      throw new Error(`Cannot execute unauthorized ICP candidate from ${candidate.status}`);
    }
    if (candidate.status === 'permitted') {
      if (!candidate.permitId) {
        throw new Error(`Permitted ICP candidate ${candidate.candidateId} has no recovery permit binding`);
      }
      if (!dependencies.isExternalCompanionAuthorized()) {
        throw new Error('companion outreach authorization is unavailable during permit recovery');
      }
      const execution = await dependencies.peers.executeCompanionOutreach(
        peer.contactId,
        candidate.permitId,
        toCandidateOrigin(candidate),
        dependencies.isExternalCompanionAuthorized,
      );
      const consumed = await transition(candidate, 'consumed', undefined, execution.disposition);
      return result(execution.disposition === 'delivered' ? 'sent' : 'suppressed', consumed);
    }

    const channelId = resolveChannelId(
      dependencies.localCompanionId,
      peer.peerCompanionId,
      request,
    );
    const expireIfElapsed = async (): Promise<IcpInitiationCandidate | null> => {
      if (candidate.expiresAtMs > now()) return null;
      const expired = await transition(candidate, 'expired', 'candidate_expired');
      candidate = expired;
      return expired;
    };
    const deferForCooldown = async (
      reasonCode: IcpAutonomyReasonCode,
    ): Promise<IcpInitiationCandidate> => {
      const transitionNow = now();
      if (candidate.expiresAtMs <= transitionNow) {
        const expired = await transition(candidate, 'expired', 'candidate_expired');
        candidate = expired;
        return expired;
      }
      const completedRetryAttempts = candidate.retryAttempt ?? 0;
      if (completedRetryAttempts >= MAX_ICP_INITIATION_RETRY_ATTEMPTS) {
        const cancelled = await dependencies.store.transitionCandidate({
          candidateId: candidate.candidateId,
          expectedStatus: candidate.status,
          expectedRevision: candidate.revision,
          status: 'cancelled',
          reasonCode,
          retryAttempt: completedRetryAttempts,
        });
        await emitLifecycle(cancelled, candidate.status);
        return cancelled;
      }
      const retryAttempt = completedRetryAttempts + 1;
      const deferred = await dependencies.store.transitionCandidate({
        candidateId: candidate.candidateId,
        expectedStatus: candidate.status,
        expectedRevision: candidate.revision,
        status: 'deferred',
        reasonCode,
        retryAttempt,
        retryEligibleAtMs: Math.min(
          candidate.expiresAtMs,
          transitionNow + ICP_INITIATION_RETRY_COOLDOWN_MS,
        ),
      });
      await emitLifecycle(deferred, candidate.status);
      return deferred;
    };
    let projection = toIcpInitiationCandidateSharedMetadata(candidate);
    const preflight = await dependencies.gateway.companionInitiationPreflight({
      candidate: projection,
      channelId,
    });
    const expiredAfterPreflight = await expireIfElapsed();
    if (expiredAfterPreflight) {
      return result('deduped', expiredAfterPreflight, 'candidate_expired');
    }
    const reconcilingCommittedPermit = !preflight.eligible
      && preflight.reasonCode === 'invitation_outstanding';
    if (!preflight.eligible && !reconcilingCommittedPermit) {
      if (preflight.reasonClass === 'deferrable') {
        const reasonCode = preflight.reasonCode ?? 'candidate_deferred';
        const deferred = await deferForCooldown(reasonCode);
        return result('deferred', deferred, reasonCode);
      }
      const denied = transitionReason(preflight);
      const transitioned = await transition(candidate, denied.status, denied.reasonCode);
      return result(denied.status === 'deferred' ? 'deferred' : 'rejected', transitioned, denied.reasonCode);
    }

    if (!reconcilingCommittedPermit) {
      const consent = await dependencies.consent.evaluate({ candidate, peer, channelId });
      const expiredAfterConsent = await expireIfElapsed();
      if (expiredAfterConsent) {
        return result('deduped', expiredAfterConsent, 'candidate_expired');
      }
      if (consent.action === 'defer') {
        const deferred = await deferForCooldown('candidate_deferred');
        return result('deferred', deferred, 'candidate_deferred');
      }
      if (consent.action === 'decline') {
        const declined = await transition(candidate, 'declined', 'candidate_declined');
        return result('declined', declined, 'candidate_declined');
      }
    }

    projection = toIcpInitiationCandidateSharedMetadata(candidate);
    const permitRequestNow = now();
    const permitResult = await dependencies.gateway.companionIssueInitiationPermit({
      candidate: projection,
      channelId,
      permitExpiresAtMs: Math.min(candidate.expiresAtMs, permitRequestNow + DEFAULT_PERMIT_TTL_MS),
    });
    const expiredAfterPermit = await expireIfElapsed();
    if (expiredAfterPermit) {
      return result('deduped', expiredAfterPermit, 'candidate_expired');
    }
    if (!permitResult.decision.eligible || !permitResult.permit) {
      if (permitResult.decision.reasonClass === 'deferrable') {
        const reasonCode = permitResult.decision.reasonCode ?? 'candidate_deferred';
        const deferred = await deferForCooldown(reasonCode);
        return result('deferred', deferred, reasonCode);
      }
      const denied = transitionReason(permitResult.decision);
      const transitioned = await transition(candidate, denied.status, denied.reasonCode);
      return result(denied.status === 'deferred' ? 'deferred' : 'rejected', transitioned, denied.reasonCode);
    }

    const permitted = await dependencies.store.transitionCandidate({
      candidateId: candidate.candidateId,
      expectedStatus: candidate.status,
      expectedRevision: candidate.revision,
      status: 'permitted',
      permitId: permitResult.permit.permitId,
    });
    await emitLifecycle(permitted, candidate.status);
    const execution = await dependencies.peers.executeCompanionOutreach(
      peer.contactId,
      permitResult.permit.permitId,
      toCandidateOrigin(permitted),
      dependencies.isExternalCompanionAuthorized,
    );
    const consumed = await transition(permitted, 'consumed', undefined, execution.disposition);
    return result(execution.disposition === 'delivered' ? 'sent' : 'suppressed', consumed);
  };

  return {
    async submit(request) {
      const peer = await dependencies.peers.resolveKnownPeer(request.peerContactId);
      if (peer.contactId !== request.peerContactId) {
        throw new Error('Resolved ICP peer contact does not match the requested canonical contact');
      }
      const identity = sourceIdentity({
        localCompanionId: dependencies.localCompanionId,
        peerCompanionId: peer.peerCompanionId,
        request,
      });
      const candidateId = deterministicUuid('icp-candidate', identity);
      const existing = inFlight.get(candidateId);
      if (existing) return await existing;
      const pending = run(request, peer, candidateId);
      inFlight.set(candidateId, pending);
      try {
        return await pending;
      } finally {
        if (inFlight.get(candidateId) === pending) inFlight.delete(candidateId);
      }
    },
  };
}
