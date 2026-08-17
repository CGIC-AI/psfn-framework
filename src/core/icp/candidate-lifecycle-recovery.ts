import type { KnownCompanionPeer } from './agent-facing-autonomy.js';
import type { IcpInitiationCandidateClaim } from './autonomy-store-ports.js';
import type {
  IcpInitiationSourceRequest,
  IcpInitiationSourceResult,
} from './initiation-source-support.js';

export interface IcpCandidateClaimRecoveryOptions {
  localCompanionId: string;
  now(): number;
  expire(claim: IcpInitiationCandidateClaim): Promise<IcpInitiationSourceResult>;
  resolvePeer(contactId: string): Promise<KnownCompanionPeer>;
  execute(
    request: IcpInitiationSourceRequest,
    peer: KnownCompanionPeer,
    claim: IcpInitiationCandidateClaim,
  ): Promise<IcpInitiationSourceResult>;
}

/** Reconstruct and execute exact source-independent work from one durable claim. */
export function createIcpCandidateClaimRecovery(
  options: IcpCandidateClaimRecoveryOptions,
): (claim: IcpInitiationCandidateClaim) => Promise<IcpInitiationSourceResult> {
  return async claim => {
    const candidate = claim.candidate;
    if (candidate.localCompanionId !== options.localCompanionId) {
      throw new Error('ICP lifecycle claim belongs to another companion');
    }
    if (candidate.expiresAtMs <= options.now()
      && ['pending', 'deferred', 'permitted'].includes(candidate.status)) {
      return await options.expire(claim);
    }
    const peer = await options.resolvePeer(candidate.peerContactId);
    if (peer.peerCompanionId !== candidate.peerCompanionId) {
      throw new Error('ICP lifecycle claim peer binding no longer matches canonical contact');
    }
    const request: IcpInitiationSourceRequest = {
      source: candidate.source,
      peerContactId: candidate.peerContactId,
      preferredChannel: candidate.preferredChannel,
      ...(candidate.preferredChannel === 'current_room' && candidate.targetChannelId
        ? { currentRoomChannelId: candidate.targetChannelId }
        : {}),
      sourceRecordId: `lifecycle-claim:${candidate.candidateId}`,
      ...(candidate.pendingFollowUpId
        ? { pendingFollowUpId: candidate.pendingFollowUpId }
        : {}),
      reasonSummary: candidate.reasonSummary,
      cause: candidate.rootInitiationId === candidate.candidateId
        ? { kind: 'independent' }
        : { kind: 'icp_conversation', rootInitiationId: candidate.rootInitiationId },
      ttlMs: candidate.expiresAtMs - candidate.createdAtMs,
    };
    return await options.execute(request, peer, claim);
  };
}
