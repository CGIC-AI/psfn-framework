import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { SpeakingEgressLeasePhase } from '../../../core/agent/arbiter/egress-lease-phase.js';
import type { SpeakingReservationPhase } from '../../../core/agent/arbiter/reservation-phase.js';
import type { CompanionAvailabilityRuntime } from '../../../core/agent/companion-availability.js';
import { ContactBlockListStore } from '../../../core/cogsec/contact-block-list.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type {
  SocialImpulseOutreachMode,
  SocialImpulseOutreachRuntime,
  SocialImpulseOutreachStorePort,
} from '../../../core/emotion/social-impulse-outreach.js';
import type { AgentFacingIcpAutonomyRuntime } from '../../../core/icp/agent-facing-autonomy.js';
import type { IcpInitiationSourceRuntime } from '../../../core/icp/initiation-source-runtime.js';
import type { ProactiveOutboundDispatcher } from '../../../core/intention/proactive-outbound.js';
import type { SocialDesireHumanDeliveryPolicy } from '../../../core/intention/social-desire-human-policy.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import { resolveContactBlockListPath } from '../../../persistence/layout.js';
import type { CapabilityRuntime } from '../../../system/capabilities/runtime.js';
import { createProductionSocialImpulseOutreachRuntime } from '../social-impulse-outreach-runtime.js';

export interface SocialImpulseOutreachLaneDeps {
  companionId: string;
  companionName: string;
  companionDataDir: string;
  store: SocialImpulseOutreachStorePort;
  getMode(): SocialImpulseOutreachMode;
  agentLoop: Pick<SubstrateAgent, 'handleMessage'>;
  contactStore: Pick<ContactStorePort, 'getByDiscordUserId' | 'listKnownRooms'>;
  sessionStore: Pick<SessionStore, 'listChannels'>;
  primaryDiscordUserId?: string;
  heartbeatChannel?: { channelId: string; channelType: 'discord' };
  icpAutonomy?: AgentFacingIcpAutonomyRuntime;
  icpInitiation?: IcpInitiationSourceRuntime;
  capabilityRuntime: Pick<CapabilityRuntime, 'has'>;
  availability: Pick<CompanionAvailabilityRuntime, 'snapshot'>;
}

export interface SocialImpulseOutreachLane {
  runtime: SocialImpulseOutreachRuntime;
  setProactiveOutbound(value: ProactiveOutboundDispatcher | null): void;
  setHumanPolicy(value: SocialDesireHumanDeliveryPolicy | undefined): void;
  setSpeakingPhases(input: {
    reservationPhase: SpeakingReservationPhase | undefined;
    egressLeasePhase: SpeakingEgressLeasePhase | undefined;
  }): void;
}

export function registerSocialImpulseOutreachLane(
  deps: SocialImpulseOutreachLaneDeps,
): SocialImpulseOutreachLane {
  let proactiveOutbound: ProactiveOutboundDispatcher | null = null;
  let humanPolicy: SocialDesireHumanDeliveryPolicy | undefined;
  let reservationPhase: SpeakingReservationPhase | undefined;
  let egressLeasePhase: SpeakingEgressLeasePhase | undefined;
  const blockList = new ContactBlockListStore(resolveContactBlockListPath(deps.companionDataDir));

  const runtime = createProductionSocialImpulseOutreachRuntime({
    companionId: deps.companionId,
    companionName: deps.companionName,
    store: deps.store,
    getMode: deps.getMode,
    agentLoop: deps.agentLoop,
    contactStore: deps.contactStore,
    sessionStore: deps.sessionStore,
    ...(deps.primaryDiscordUserId
      ? { primaryDiscordUserId: deps.primaryDiscordUserId }
      : {}),
    ...(deps.heartbeatChannel ? { heartbeatChannel: deps.heartbeatChannel } : {}),
    ...(deps.icpAutonomy ? { icpAutonomy: deps.icpAutonomy } : {}),
    ...(deps.icpInitiation ? { icpInitiation: deps.icpInitiation } : {}),
    capabilityRuntime: deps.capabilityRuntime,
    availability: deps.availability,
    // The canonical speaking egress sender currently supports Discord only.
    // Buzz stays in the typed room contract until a matching sender is composed.
    isRoomTransportAvailable: channelType => channelType === 'discord',
    isHumanContactAllowed: async ({ contactId }) => {
      if (!deps.primaryDiscordUserId) return false;
      const contact = await deps.contactStore.getByDiscordUserId(deps.primaryDiscordUserId);
      return contact?.id === contactId
        && !contact.archivedAt
        && !contact.isMachineIntelligence
        && contact.trustLevel === 'primary'
        && blockList.evaluate({
          channelType: 'discord',
          contactId: deps.primaryDiscordUserId,
          isDirectMessage: true,
        }).action === 'allow';
    },
    getPhases: () => ({ proactiveOutbound, humanPolicy, reservationPhase, egressLeasePhase }),
  });

  return {
    runtime,
    setProactiveOutbound(value) {
      proactiveOutbound = value;
    },
    setHumanPolicy(value) {
      humanPolicy = value;
    },
    setSpeakingPhases(input) {
      reservationPhase = input.reservationPhase;
      egressLeasePhase = input.egressLeasePhase;
    },
  };
}
