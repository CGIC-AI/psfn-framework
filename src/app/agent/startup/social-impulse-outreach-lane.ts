import { resolvePrimaryContactOutreachIdentity } from '../social-outreach-context.js';
import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { PostTurnActionRuntime } from '../../../core/agent/post-turn-action-runtime.js';
import type { SpeakingEgressLeasePhase } from '../../../core/agent/arbiter/egress-lease-phase.js';
import type { SpeakingReservationPhase } from '../../../core/agent/arbiter/reservation-phase.js';
import type { RoomParticipationLeaseCoordinator } from '../../../core/participation/room-participation-lease-coordinator.js';
import type { CompanionAvailabilityRuntime } from '../../../core/agent/companion-availability.js';
import { ContactBlockListStore } from '../../../core/cogsec/contact-block-list.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type {
  SocialImpulseOutreachMode,
  SocialImpulseOutreachStorePort,
} from '../../../core/emotion/social-impulse-outreach.js';
import type { AgentFacingIcpAutonomyRuntime } from '../../../core/icp/agent-facing-autonomy.js';
import type { IcpInitiationSourceRuntime } from '../../../core/icp/initiation-source-runtime.js';
import type { ProactiveOutboundDispatcher } from '../../../core/intention/proactive-outbound.js';
import type { SocialDesireHumanDeliveryPolicy } from '../../../core/intention/social-desire-human-policy.js';
import type { ProactiveQuietHoursConfig } from '../../../core/intention/proactive-time-gate.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import { resolveContactBlockListPath } from '../../../persistence/layout.js';
import type { CapabilityRuntime } from '../../../system/capabilities/runtime.js';
import { createProductionSocialImpulseOutreachRuntime } from '../social-impulse-outreach-runtime.js';

export interface SocialImpulseOutreachLaneDeps {
  companionId: string;
  companionName: string;
  quietHours: ProactiveQuietHoursConfig;
  companionDataDir: string;
  store: SocialImpulseOutreachStorePort;
  getMode(): SocialImpulseOutreachMode;
  agentLoop: Pick<SubstrateAgent, 'handleMessage'>;
  postTurnActions: Pick<PostTurnActionRuntime, 'enqueue' | 'registerHandler'>;
  contactStore: Pick<ContactStorePort, 'getByTrustLevel' | 'getById' | 'listKnownRooms'>;
  sessionStore: Pick<SessionStore, 'listChannels' | 'getSessionActivity' | 'findLatestEntries'>;
  heartbeatChannel?: { channelId: string; channelType: 'discord' };
  icpAutonomy?: AgentFacingIcpAutonomyRuntime;
  icpInitiation?: IcpInitiationSourceRuntime;
  capabilityRuntime: Pick<CapabilityRuntime, 'has'>;
  availability: Pick<CompanionAvailabilityRuntime, 'snapshot'>;
}

export interface SocialImpulseOutreachLane {
  runtime: ReturnType<typeof createProductionSocialImpulseOutreachRuntime>;
  setProactiveOutbound(value: ProactiveOutboundDispatcher | null): void;
  setHumanPolicy(value: SocialDesireHumanDeliveryPolicy | undefined): void;
  setSpeakingPhases(input: {
    reservationPhase: SpeakingReservationPhase | undefined;
    egressLeasePhase: SpeakingEgressLeasePhase | undefined;
    roomParticipationLease: RoomParticipationLeaseCoordinator | undefined;
  }): void;
}

export function registerSocialImpulseOutreachLane(
  deps: SocialImpulseOutreachLaneDeps,
): SocialImpulseOutreachLane {
  let proactiveOutbound: ProactiveOutboundDispatcher | null = null;
  let humanPolicy: SocialDesireHumanDeliveryPolicy | undefined;
  let reservationPhase: SpeakingReservationPhase | undefined;
  let egressLeasePhase: SpeakingEgressLeasePhase | undefined;
  let roomParticipationLease: RoomParticipationLeaseCoordinator | undefined;
  const blockList = new ContactBlockListStore(resolveContactBlockListPath(deps.companionDataDir));

  const runtime = createProductionSocialImpulseOutreachRuntime({
    companionId: deps.companionId,
    companionName: deps.companionName,
    quietHours: deps.quietHours,
    store: deps.store,
    getMode: deps.getMode,
    agentLoop: deps.agentLoop,
    postTurnActions: deps.postTurnActions,
    contactStore: deps.contactStore,
    sessionStore: deps.sessionStore,
    ...(deps.heartbeatChannel ? { heartbeatChannel: deps.heartbeatChannel } : {}),
    ...(deps.icpAutonomy ? { icpAutonomy: deps.icpAutonomy } : {}),
    ...(deps.icpInitiation ? { icpInitiation: deps.icpInitiation } : {}),
    capabilityRuntime: deps.capabilityRuntime,
    availability: deps.availability,
    // The canonical speaking egress sender currently supports Discord only.
    // Buzz stays in the typed room contract until a matching sender is composed.
    isRoomTransportAvailable: channelType => channelType === 'discord',
    isHumanContactAllowed: async ({ contactId, channelId }) => {
      const contact = await deps.contactStore.getById(contactId);
      const discordUserId = contact
        ? resolvePrimaryContactOutreachIdentity(deps.sessionStore, contact, channelId)
        : undefined;
      if (!discordUserId) return false;
      return contact?.id === contactId
        && !contact.archivedAt
        && !contact.isMachineIntelligence
        && contact.trustLevel === 'primary'
        && blockList.evaluate({
          channelType: 'discord',
          contactId: discordUserId,
          isDirectMessage: true,
        }).action === 'allow';
    },
    getPhases: () => ({
      proactiveOutbound,
      humanPolicy,
      reservationPhase,
      egressLeasePhase,
      roomParticipationLease,
    }),
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
      roomParticipationLease = input.roomParticipationLease;
    },
  };
}
