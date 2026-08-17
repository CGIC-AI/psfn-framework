import { composeCompanionDmChannelId } from '../../shared/contracts/companion-channels.js';
import type { IcpAutonomyReasonCode } from '../../shared/contracts/icp-autonomy.js';
import { createComponentLogger } from '../../shared/logger.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { KnownCompanionPeer } from './agent-facing-autonomy.js';
import type {
  IcpInitiationCandidateClaim,
  IcpInitiationCandidateTransitionInput,
} from './autonomy-store-ports.js';
import {
  MAX_ICP_CANDIDATE_TTL_MS,
  parseIcpInitiationCandidate,
  toIcpInitiationCandidateSharedMetadata,
  type IcpInitiationCandidate,
  type IcpInitiationCandidateStatus,
} from './initiation-candidate.js';
import { createIcpCandidateClaimRecovery } from './candidate-lifecycle-recovery.js';
import {
  deriveIcpSourceIdentity,
  deterministicIcpUuid,
  isSameIcpCandidate,
  resolveIcpCandidateChannelId,
  resolveIcpTransitionDenial,
  terminalIcpSourceOutcome,
  toIcpCandidateOrigin,
  toIcpSourceResult,
  type IcpInitiationSourceRequest,
  type IcpInitiationSourceResult,
  type IcpInitiationSourceRuntime,
  type IcpInitiationSourceRuntimeDependencies,
} from './initiation-source-support.js';

export type {
  IcpInitiationCause,
  IcpInitiationConsent,
  IcpInitiationConsentEvaluator,
  IcpInitiationSourceGatewayPort,
  IcpInitiationSourceOutcome,
  IcpInitiationSourcePeerPort,
  IcpInitiationSourceRequest,
  IcpInitiationSourceResult,
  IcpInitiationSourceRuntime,
  IcpInitiationSourceRuntimeDependencies,
} from './initiation-source-support.js';

const log = createComponentLogger('IcpInitiationSource');
const DEFAULT_CANDIDATE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_PERMIT_TTL_MS = 5 * 60_000;
export const ICP_INITIATION_RETRY_COOLDOWN_MS = 5 * 60_000;
export const MAX_ICP_INITIATION_RETRY_ATTEMPTS = 3;
const MAX_SOURCE_RECORD_ID_CHARS = 1_024;

export function deriveIcpInitiationCandidateId(input: {
  localCompanionId: string;
  peerCompanionId: string;
  request: IcpInitiationSourceRequest;
}): string {
  return deterministicIcpUuid(
    'icp-candidate',
    deriveIcpSourceIdentity(input, MAX_SOURCE_RECORD_ID_CHARS),
  );
}

export function createIcpInitiationSourceRuntime(
  dependencies: IcpInitiationSourceRuntimeDependencies,
): IcpInitiationSourceRuntime {
  if (!isRfc4122Uuid(dependencies.localCompanionId)) {
    throw new Error('ICP initiation source runtime requires a lowercase RFC-4122 localCompanionId');
  }
  const now = dependencies.now ?? Date.now;
  const policy = dependencies.policy ?? {
    candidateDefaultTtlMs: DEFAULT_CANDIDATE_TTL_MS,
    retryCadenceMs: ICP_INITIATION_RETRY_COOLDOWN_MS,
    maxRetryAttempts: MAX_ICP_INITIATION_RETRY_ATTEMPTS,
    permitTtlMs: DEFAULT_PERMIT_TTL_MS,
  };
  const inFlight = new Map<string, Promise<IcpInitiationSourceResult>>();
  const resolvePeer = async (contactId: string): Promise<KnownCompanionPeer> => {
    const peer = await dependencies.peers.resolveKnownPeer(contactId);
    if (peer.contactId !== contactId) {
      throw new Error('Resolved ICP peer contact does not match the requested canonical contact');
    }
    return peer;
  };

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

  const requireClaimTransition = () => {
    const claimedTransition = dependencies.store.transitionClaimedCandidate;
    if (!claimedTransition) {
      throw new Error('ICP lifecycle recovery requires a claim-capable candidate store');
    }
    return claimedTransition.bind(dependencies.store);
  };

  const applyTransition = async (
    candidate: IcpInitiationCandidate,
    input: IcpInitiationCandidateTransitionInput,
    claimToken?: string,
  ): Promise<IcpInitiationCandidate> => {
    const next = claimToken === undefined
      ? await dependencies.store.transitionCandidate(input)
      : await requireClaimTransition()(claimToken, input);
    await emitLifecycle(next, candidate.status);
    return next;
  };

  const transition = async (
    candidate: IcpInitiationCandidate,
    status: IcpInitiationCandidateStatus,
    reasonCode?: IcpAutonomyReasonCode,
    deliveryDisposition?: IcpInitiationCandidate['deliveryDisposition'],
    claimToken?: string,
  ): Promise<IcpInitiationCandidate> => await applyTransition(candidate, {
    candidateId: candidate.candidateId,
    expectedStatus: candidate.status,
    expectedRevision: candidate.revision,
    status,
    ...(reasonCode ? { reasonCode } : {}),
    ...(deliveryDisposition ? { deliveryDisposition } : {}),
  }, claimToken);

  const run = async (
    request: IcpInitiationSourceRequest,
    initialPeer: KnownCompanionPeer,
    candidateId: string,
    recoveryClaim?: IcpInitiationCandidateClaim,
  ): Promise<IcpInitiationSourceResult> => {
    const currentNow = now();
    if (request.pendingFollowUpId !== undefined && request.source !== 'intention') {
      throw new Error('pendingFollowUpId is only valid for intention initiation sources');
    }
    const ttlMs = Math.min(
      MAX_ICP_CANDIDATE_TTL_MS,
      Math.max(1, Math.floor(request.ttlMs ?? policy.candidateDefaultTtlMs)),
    );
    let peer = initialPeer;
    let candidate: IcpInitiationCandidate;
    const existingCandidate = recoveryClaim?.candidate
      ?? await dependencies.store.getCandidate(candidateId);
    if (request.source === 'felt_impulse'
      && existingCandidate
      && existingCandidate.peerContactId !== peer.contactId) {
      peer = await resolvePeer(existingCandidate.peerContactId);
    }
    const identity = deriveIcpSourceIdentity({
      localCompanionId: dependencies.localCompanionId,
      peerCompanionId: peer.peerCompanionId,
      request,
    }, MAX_SOURCE_RECORD_ID_CHARS);
    const provenanceRef = `icp-prov:${deterministicIcpUuid('icp-provenance', identity)}`;
    const rootInitiationId = request.cause.kind === 'independent'
      ? candidateId
      : request.cause.rootInitiationId;
    if (!isRfc4122Uuid(rootInitiationId)) {
      throw new Error('Inherited ICP rootInitiationId must be a lowercase RFC-4122 UUID');
    }
    const targetChannelId = recoveryClaim?.candidate.targetChannelId
      ?? (request.preferredChannel === 'dm'
        ? resolveIcpCandidateChannelId(
            dependencies.localCompanionId,
            peer.peerCompanionId,
            request,
            MAX_SOURCE_RECORD_ID_CHARS,
          )
        : request.currentRoomChannelId);
    let proposed = recoveryClaim?.candidate ?? parseIcpInitiationCandidate({
      candidateId,
      rootInitiationId,
      localCompanionId: dependencies.localCompanionId,
      peerContactId: peer.contactId,
      peerCompanionId: peer.peerCompanionId,
      preferredChannel: request.preferredChannel,
      ...(targetChannelId ? { targetChannelId } : {}),
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
    if (recoveryClaim) {
      candidate = recoveryClaim.candidate;
    } else if (existingCandidate) {
      candidate = existingCandidate;
    } else {
      try {
        candidate = await dependencies.store.createCandidate(proposed);
        await emitLifecycle(candidate, null);
      } catch (error) {
        const racedCandidate = await dependencies.store.getCandidate(candidateId);
        if (!racedCandidate) throw error;
        candidate = racedCandidate;
        if (request.source === 'felt_impulse'
          && candidate.peerContactId !== peer.contactId) {
          peer = await resolvePeer(candidate.peerContactId);
          proposed = parseIcpInitiationCandidate({
            ...proposed,
            peerContactId: peer.contactId,
            peerCompanionId: peer.peerCompanionId,
          });
        }
      }
    }
    if (!recoveryClaim && !isSameIcpCandidate(candidate, proposed)) {
      // A deterministic identity collision or mutated source input is an
      // invariant violation. Never silently reuse another private motivation.
      throw new Error(`ICP candidate identity conflict for ${candidateId}`);
    }
    if (candidate.expiresAtMs <= now()
      && ['pending', 'deferred', 'permitted'].includes(candidate.status)) {
      const expired = await transition(
        candidate,
        'expired',
        'candidate_expired',
        undefined,
        recoveryClaim?.claimToken,
      );
      return toIcpSourceResult('deduped', expired, 'candidate_expired');
    }
    if (candidate.status === 'deferred') {
      const retryNow = now();
      if (candidate.retryEligibleAtMs === undefined || retryNow < candidate.retryEligibleAtMs) {
        return toIcpSourceResult('deduped', candidate, candidate.reasonCode ?? 'candidate_deferred');
      }
      const pendingInput: IcpInitiationCandidateTransitionInput = {
        candidateId: candidate.candidateId,
        expectedStatus: candidate.status,
        expectedRevision: candidate.revision,
        status: 'pending',
        clearRetryEligibility: true,
      };
      const pending = await applyTransition(candidate, pendingInput, recoveryClaim?.claimToken);
      candidate = pending;
    }
    const terminal = terminalIcpSourceOutcome(candidate);
    if (terminal) return terminal;
    if (!dependencies.isExternalCompanionAuthorized()) {
      if (candidate.status === 'pending') {
        const rejected = await transition(
          candidate,
          'rejected',
          'policy_denied',
          undefined,
          recoveryClaim?.claimToken,
        );
        return toIcpSourceResult('rejected', rejected, 'policy_denied');
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
        toIcpCandidateOrigin(candidate),
        dependencies.isExternalCompanionAuthorized,
      );
      const consumed = await transition(
        candidate,
        'consumed',
        undefined,
        execution.disposition,
        recoveryClaim?.claimToken,
      );
      return toIcpSourceResult(
        execution.disposition === 'delivered' ? 'sent' : 'suppressed',
        consumed,
      );
    }

    const channelId = candidate.targetChannelId
      ?? (candidate.preferredChannel === 'dm'
        ? composeCompanionDmChannelId(
            dependencies.localCompanionId as CompanionId,
            candidate.peerCompanionId as CompanionId,
          )
        : undefined);
    if (!channelId) {
      const cancelled = await transition(
        candidate,
        'cancelled',
        'policy_denied',
        undefined,
        recoveryClaim?.claimToken,
      );
      return toIcpSourceResult('suppressed', cancelled, 'policy_denied');
    }
    const expireIfElapsed = async (): Promise<IcpInitiationCandidate | null> => {
      if (candidate.expiresAtMs > now()) return null;
      const expired = await transition(
        candidate,
        'expired',
        'candidate_expired',
        undefined,
        recoveryClaim?.claimToken,
      );
      candidate = expired;
      return expired;
    };
    const deferForCooldown = async (
      reasonCode: IcpAutonomyReasonCode,
    ): Promise<IcpInitiationCandidate> => {
      const transitionNow = now();
      if (candidate.expiresAtMs <= transitionNow) {
        const expired = await transition(
          candidate,
          'expired',
          'candidate_expired',
          undefined,
          recoveryClaim?.claimToken,
        );
        candidate = expired;
        return expired;
      }
      const completedRetryAttempts = candidate.retryAttempt ?? 0;
      if (completedRetryAttempts >= policy.maxRetryAttempts) {
        const cancelledInput: IcpInitiationCandidateTransitionInput = {
          candidateId: candidate.candidateId,
          expectedStatus: candidate.status,
          expectedRevision: candidate.revision,
          status: 'cancelled',
          reasonCode,
          retryAttempt: completedRetryAttempts,
        };
        const cancelled = await applyTransition(
          candidate,
          cancelledInput,
          recoveryClaim?.claimToken,
        );
        return cancelled;
      }
      const retryAttempt = completedRetryAttempts + 1;
      const deferredInput: IcpInitiationCandidateTransitionInput = {
        candidateId: candidate.candidateId,
        expectedStatus: candidate.status,
        expectedRevision: candidate.revision,
        status: 'deferred',
        reasonCode,
        retryAttempt,
        retryEligibleAtMs: Math.min(
          candidate.expiresAtMs,
          transitionNow + policy.retryCadenceMs,
        ),
      };
      const deferred = await applyTransition(
        candidate,
        deferredInput,
        recoveryClaim?.claimToken,
      );
      return deferred;
    };
    let projection = toIcpInitiationCandidateSharedMetadata(candidate);
    const preflight = await dependencies.gateway.companionInitiationPreflight({
      candidate: projection,
      channelId,
    });
    const expiredAfterPreflight = await expireIfElapsed();
    if (expiredAfterPreflight) {
      return toIcpSourceResult('deduped', expiredAfterPreflight, 'candidate_expired');
    }
    const reconcilingCommittedPermit = !preflight.eligible
      && preflight.reasonCode === 'invitation_outstanding';
    if (!preflight.eligible && !reconcilingCommittedPermit) {
      if (preflight.reasonClass === 'deferrable') {
        const reasonCode = preflight.reasonCode ?? 'candidate_deferred';
        const deferred = await deferForCooldown(reasonCode);
        return toIcpSourceResult('deferred', deferred, reasonCode);
      }
      const denied = resolveIcpTransitionDenial(preflight);
      const transitioned = await transition(
        candidate,
        denied.status,
        denied.reasonCode,
        undefined,
        recoveryClaim?.claimToken,
      );
      return toIcpSourceResult(
        denied.status === 'deferred' ? 'deferred' : 'rejected',
        transitioned,
        denied.reasonCode,
      );
    }

    if (!dependencies.isExternalCompanionAuthorized()) {
      const rejected = await transition(
        candidate,
        'rejected',
        'policy_denied',
        undefined,
        recoveryClaim?.claimToken,
      );
      return toIcpSourceResult('rejected', rejected, 'policy_denied');
    }

    // The authenticated Garden request is the explicit consent for a
    // provenance-marked test initiation. It bypasses only the companion LLM
    // consent question; authorization, preflight, permit, fatigue, cost, trust,
    // availability, and delivery policy remain on the canonical broker path.
    if (!reconcilingCommittedPermit && request.source !== 'operator_test') {
      const consent = await dependencies.consent.evaluate({ candidate, peer, channelId });
      const expiredAfterConsent = await expireIfElapsed();
      if (expiredAfterConsent) {
        return toIcpSourceResult('deduped', expiredAfterConsent, 'candidate_expired');
      }
      if (consent.action === 'defer') {
        const deferred = await deferForCooldown('candidate_deferred');
        return toIcpSourceResult('deferred', deferred, 'candidate_deferred');
      }
      if (consent.action === 'decline') {
        const declined = await transition(
          candidate,
          'declined',
          'candidate_declined',
          undefined,
          recoveryClaim?.claimToken,
        );
        return toIcpSourceResult('declined', declined, 'candidate_declined');
      }
    }

    if (!dependencies.isExternalCompanionAuthorized()) {
      const rejected = await transition(
        candidate,
        'rejected',
        'policy_denied',
        undefined,
        recoveryClaim?.claimToken,
      );
      return toIcpSourceResult('rejected', rejected, 'policy_denied');
    }

    projection = toIcpInitiationCandidateSharedMetadata(candidate);
    const permitRequestNow = now();
    const permitResult = await dependencies.gateway.companionIssueInitiationPermit({
      candidate: projection,
      channelId,
      permitExpiresAtMs: Math.min(candidate.expiresAtMs, permitRequestNow + policy.permitTtlMs),
    });
    const expiredAfterPermit = await expireIfElapsed();
    if (expiredAfterPermit) {
      return toIcpSourceResult('deduped', expiredAfterPermit, 'candidate_expired');
    }
    if (!permitResult.decision.eligible || !permitResult.permit) {
      if (permitResult.decision.reasonClass === 'deferrable') {
        const reasonCode = permitResult.decision.reasonCode ?? 'candidate_deferred';
        const deferred = await deferForCooldown(reasonCode);
        return toIcpSourceResult('deferred', deferred, reasonCode);
      }
      const denied = resolveIcpTransitionDenial(permitResult.decision);
      const transitioned = await transition(
        candidate,
        denied.status,
        denied.reasonCode,
        undefined,
        recoveryClaim?.claimToken,
      );
      return toIcpSourceResult(
        denied.status === 'deferred' ? 'deferred' : 'rejected',
        transitioned,
        denied.reasonCode,
      );
    }

    const permittedInput: IcpInitiationCandidateTransitionInput = {
      candidateId: candidate.candidateId,
      expectedStatus: candidate.status,
      expectedRevision: candidate.revision,
      status: 'permitted',
      permitId: permitResult.permit.permitId,
    };
    const permitted = await applyTransition(
      candidate,
      permittedInput,
      recoveryClaim?.claimToken,
    );
    const execution = await dependencies.peers.executeCompanionOutreach(
      peer.contactId,
      permitResult.permit.permitId,
      toIcpCandidateOrigin(permitted),
      dependencies.isExternalCompanionAuthorized,
    );
    const consumed = await transition(
      permitted,
      'consumed',
      undefined,
      execution.disposition,
      recoveryClaim?.claimToken,
    );
    return toIcpSourceResult(
      execution.disposition === 'delivered' ? 'sent' : 'suppressed',
      consumed,
    );
  };

  const resumeClaim = createIcpCandidateClaimRecovery({
    localCompanionId: dependencies.localCompanionId,
    now,
    resolvePeer,
    expire: async claim => {
      const expired = await transition(
        claim.candidate,
        'expired',
        'candidate_expired',
        undefined,
        claim.claimToken,
      );
      return toIcpSourceResult('deduped', expired, 'candidate_expired');
    },
    execute: async (request, peer, claim) => (
      await run(request, peer, claim.candidate.candidateId, claim)
    ),
  });

  return {
    async submit(request) {
      const peer = await resolvePeer(request.peerContactId);
      const candidateId = deriveIcpInitiationCandidateId({
        localCompanionId: dependencies.localCompanionId,
        peerCompanionId: peer.peerCompanionId,
        request,
      });
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
    resumeClaim,
  };
}
