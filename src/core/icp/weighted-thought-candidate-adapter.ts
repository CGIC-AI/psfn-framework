import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import type { IcpWeightedThoughtCandidateAdapter } from '../intention/weighted-thought-outreach.js';
import {
  CanonicalCompanionPeerValidationError,
  type KnownCompanionPeer,
} from './agent-facing-autonomy.js';
import type { IcpInitiationSourceRuntime } from './initiation-source-runtime.js';

/** Route only canonical MI contacts into ICP; human thoughts keep the legacy lane. */
export function createIcpWeightedThoughtCandidateAdapter(input: {
  sourceRuntime: IcpInitiationSourceRuntime;
  peers: { resolveKnownPeer(contactId: string): Promise<KnownCompanionPeer> };
}): IcpWeightedThoughtCandidateAdapter {
  return {
    async submit({ thought }) {
      const contactId = thought.contactId;
      if (!contactId) return null;
      try {
        await input.peers.resolveKnownPeer(contactId);
      } catch (error) {
        if (error instanceof CanonicalCompanionPeerValidationError) return null;
        throw error;
      }
      const sourceChannelId = thought.provenance.sourceChannelId;
      const parsedChannel = sourceChannelId
        ? parseCompanionChannelId(sourceChannelId)
        : null;
      return await input.sourceRuntime.submit({
        source: 'weighted_thought',
        peerContactId: contactId,
        preferredChannel: parsedChannel?.kind === 'room' ? 'current_room' : 'dm',
        ...(parsedChannel?.kind === 'room' && sourceChannelId
          ? { currentRoomChannelId: sourceChannelId }
          : {}),
        sourceRecordId: thought.id,
        reasonSummary: thought.content.slice(0, 1_000),
        cause: thought.provenance.icpRootInitiationId
          ? {
              kind: 'icp_conversation',
              rootInitiationId: thought.provenance.icpRootInitiationId,
            }
          : { kind: 'independent' },
      });
    },
  };
}
