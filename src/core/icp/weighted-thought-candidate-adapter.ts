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
      if (!contactId) return { kind: 'not_companion' };
      try {
        await input.peers.resolveKnownPeer(contactId);
      } catch (error) {
        if (error instanceof CanonicalCompanionPeerValidationError) {
          return { kind: 'not_companion' };
        }
        throw error;
      }
      if (!thought.provenance.icpRootInitiationId && !thought.provenance.coLocationRef) {
        // A peer-derived thought with a missing root must never be upgraded to
        // an independent initiation merely because an adapter failed to stamp
        // lineage. Co-location is the one production independent writer here.
        return { kind: 'blocked', reason: 'recursive_trigger' };
      }
      const sourceChannelId = thought.provenance.sourceChannelId;
      const parsedChannel = sourceChannelId
        ? parseCompanionChannelId(sourceChannelId)
        : null;
      const result = await input.sourceRuntime.submit({
        source: 'weighted_thought',
        peerContactId: contactId,
        preferredChannel: parsedChannel?.kind === 'room' ? 'current_room' : 'dm',
        ...(parsedChannel?.kind === 'room' && sourceChannelId
          ? { currentRoomChannelId: sourceChannelId }
          : {}),
        // A scheduler replay of the same reinforcement epoch must dedupe, while
        // a genuinely new reinforcement after defer/decline may ask again.
        sourceRecordId: `${thought.id}:r${thought.reinforcementCount}`,
        reasonSummary: thought.content.slice(0, 1_000),
        cause: thought.provenance.icpRootInitiationId
          ? {
              kind: 'icp_conversation',
              rootInitiationId: thought.provenance.icpRootInitiationId,
            }
          : { kind: 'independent' },
      });
      return { kind: 'submitted', result };
    },
  };
}
