import type { AgentFacingIcpAutonomyRuntime } from '../../core/icp/agent-facing-autonomy.js';
import {
  deriveIcpInitiationCandidateId,
  type IcpInitiationSourceRequest,
  type IcpInitiationSourceRuntime,
} from '../../core/icp/initiation-source-runtime.js';
import type { AdminIcpTestInitiationPort } from '../../operator/garden/services/types.js';
import { createComponentLogger } from '../../shared/logger.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';

const log = createComponentLogger('IcpTestInitiation');

export function createIcpTestInitiationTrigger(input: {
  localCompanionId: string;
  sourceRuntime: IcpInitiationSourceRuntime;
  peers: Pick<AgentFacingIcpAutonomyRuntime, 'listKnownPeerAvailability'>;
}): AdminIcpTestInitiationPort {
  return {
    async trigger(request) {
      if (!isRfc4122Uuid(input.localCompanionId)
        || !isRfc4122Uuid(request.peerCompanionId)
        || !isRfc4122Uuid(request.requestId)) {
        throw new Error('ICP operator test initiation requires lowercase RFC-4122 identities');
      }
      const peers = await input.peers.listKnownPeerAvailability();
      const matches = peers.filter(peer => peer.peerCompanionId === request.peerCompanionId);
      if (matches.length !== 1) {
        throw new Error('ICP operator test initiation requires exactly one known canonical peer');
      }
      const peer = matches[0]!;
      const sourceRequest: IcpInitiationSourceRequest = {
        source: 'operator_test',
        peerContactId: peer.contactId,
        preferredChannel: 'dm',
        sourceRecordId: request.requestId,
        reasonSummary: 'Authenticated operator requested an ICP test initiation.',
        cause: { kind: 'independent' },
      };
      const candidateId = deriveIcpInitiationCandidateId({
        localCompanionId: input.localCompanionId,
        peerCompanionId: peer.peerCompanionId,
        request: sourceRequest,
      });
      void input.sourceRuntime.submit(sourceRequest).catch(error => {
        log.error('Accepted ICP operator test initiation failed in background', {
          candidateId,
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return {
        outcome: 'accepted',
        candidateId,
        status: 'pending',
        deliveryDisposition: 'pending',
      };
    },
  };
}
