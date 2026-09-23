import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { AgentFacingIcpAutonomyRuntime } from '../../core/icp/agent-facing-autonomy.js';
import type { IntentionFollowUpDestinationResolver } from '../../core/intention/follow-up-destination.js';
import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import { resolvePrimaryContactOutreachIdentity } from './social-outreach-context.js';

/**
 * Authorized destinations for a model-chosen follow-up target (PR #609,
 * re-homed onto the per-contact outreach routing of vcq8v.4): the primary
 * human's verified private DM, or an open companion dyad. Anything else is
 * unauthorized and rejects only that follow-up.
 */
export function createIntentionFollowUpDestinationResolver(options: {
  heartbeatChannel?: { channelId: string; channelType: 'discord' };
  contactStore: Pick<ContactStorePort, 'getByTrustLevel'>;
  sessionStore: Pick<SessionStore, 'findLatestEntries'>;
  icpAutonomy?: Pick<AgentFacingIcpAutonomyRuntime, 'listOpenDyads'>;
  capabilityRuntime: Pick<CapabilityRuntime, 'has'>;
}): IntentionFollowUpDestinationResolver {
  return async ({ channelId, channelType }) => {
    const requested = channelId.trim();
    const heartbeat = options.heartbeatChannel;
    if (heartbeat && requested === heartbeat.channelId
      && (channelType === undefined || channelType === heartbeat.channelType)) {
      if (!options.capabilityRuntime.has('external.discord')) return null;
      const owners = (await options.contactStore.getByTrustLevel('primary')).filter(contact => (
        !contact.archivedAt && !contact.isMachineIntelligence && contact.trustLevel === 'primary'
        && resolvePrimaryContactOutreachIdentity(options.sessionStore, contact, heartbeat.channelId)
      ));
      return owners.length === 1
        ? { channelId: heartbeat.channelId, channelType: heartbeat.channelType, contactId: owners[0]!.id }
        : null;
    }
    if (parseCompanionChannelId(requested)?.kind === 'dm'
      && (channelType === undefined || channelType === 'companion')) {
      if (!options.icpAutonomy || !options.capabilityRuntime.has('external.companion')) return null;
      const dyads = (await options.icpAutonomy.listOpenDyads()).filter(dyad => dyad.channelId === requested);
      return dyads.length === 1
        ? { channelId: requested, channelType: 'companion', contactId: dyads[0]!.peerContactId }
        : null;
    }
    return null;
  };
}
