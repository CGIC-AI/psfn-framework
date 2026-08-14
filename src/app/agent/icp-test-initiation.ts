import type { AgentFacingIcpAutonomyRuntime } from '../../core/icp/agent-facing-autonomy.js';
import type { IcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';
import type { AdminIcpTestInitiationPort } from '../../operator/garden/services/types.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';

export function createIcpTestInitiationTrigger(input: {
  sourceRuntime: IcpInitiationSourceRuntime;
  peers: Pick<AgentFacingIcpAutonomyRuntime, 'listKnownPeerAvailability'>;
}): AdminIcpTestInitiationPort {
  return {
    async trigger(request) {
      if (!isRfc4122Uuid(request.peerCompanionId) || !isRfc4122Uuid(request.requestId)) {
        throw new Error('ICP operator test initiation requires lowercase RFC-4122 identities');
      }
      const peers = await input.peers.listKnownPeerAvailability();
      const matches = peers.filter(peer => peer.peerCompanionId === request.peerCompanionId);
      if (matches.length !== 1) {
        throw new Error('ICP operator test initiation requires exactly one known canonical peer');
      }
      const peer = matches[0]!;
      return await input.sourceRuntime.submit({
        source: 'operator_test',
        peerContactId: peer.contactId,
        preferredChannel: 'dm',
        sourceRecordId: request.requestId,
        reasonSummary: 'Authenticated operator requested an ICP test initiation.',
        cause: { kind: 'independent' },
      });
    },
  };
}
