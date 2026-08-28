import { createHash, randomUUID } from 'node:crypto';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SpeakingReservationPhase } from '../../core/agent/arbiter/reservation-phase.js';
import type { SpeakingEgressLeasePhase } from '../../core/agent/arbiter/egress-lease-phase.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import { DEFAULT_KNOWN_ROOMS_LIMIT } from '../../core/contacts/types.js';
import type { AgentFacingIcpAutonomyRuntime } from '../../core/icp/agent-facing-autonomy.js';
import type { IcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';
import { deterministicIcpUuid } from '../../core/icp/initiation-source-support.js';
import {
  createSocialImpulseOutreachRuntime,
  type SocialImpulseOutreachDestination,
  type SocialImpulseOutreachMode,
  type SocialImpulseOutreachRuntime,
  type SocialImpulseOutreachStorePort,
} from '../../core/emotion/social-impulse-outreach.js';
import type { ProactiveOutboundDispatcher } from '../../core/intention/proactive-outbound.js';
import type { SocialDesireHumanDeliveryPolicy } from '../../core/intention/social-desire-human-policy.js';
import type { CompanionAvailabilityRuntime } from '../../core/agent/companion-availability.js';
import type { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { classifyChannelDisclosure } from '../../system/trust/policy.js';

interface RuntimePhases {
  proactiveOutbound: ProactiveOutboundDispatcher | null;
  humanPolicy: SocialDesireHumanDeliveryPolicy | undefined;
  reservationPhase: SpeakingReservationPhase | undefined;
  egressLeasePhase: SpeakingEgressLeasePhase | undefined;
}

export interface ProductionSocialImpulseOutreachOptions {
  companionId: string;
  companionName: string;
  store: SocialImpulseOutreachStorePort;
  getMode(): SocialImpulseOutreachMode;
  agentLoop: Pick<SubstrateAgent, 'handleMessage'>;
  contactStore: Pick<
    ContactStorePort,
    'getByDiscordUserId' | 'listKnownRooms'
  >;
  sessionStore: Pick<SessionStore, 'listChannels'>;
  primaryDiscordUserId?: string;
  heartbeatChannel?: { channelId: string; channelType: 'discord' };
  icpAutonomy?: AgentFacingIcpAutonomyRuntime;
  icpInitiation?: IcpInitiationSourceRuntime;
  capabilityRuntime: Pick<CapabilityRuntime, 'has'>;
  availability: Pick<CompanionAvailabilityRuntime, 'snapshot'>;
  isHumanContactAllowed(input: { contactId: string; channelType: 'discord' }): Promise<boolean>;
  getPhases(): RuntimePhases;
  now?: () => number;
}

export function createProductionSocialImpulseOutreachRuntime(
  options: ProductionSocialImpulseOutreachOptions,
): SocialImpulseOutreachRuntime {
  const now = options.now ?? Date.now;

  const listDestinations = async (): Promise<SocialImpulseOutreachDestination[]> => {
    const destinations: SocialImpulseOutreachDestination[] = [];
    if (options.availability.snapshot().state === 'do_not_disturb') return destinations;
    const phases = options.getPhases();
    const primaryUserId = options.primaryDiscordUserId?.trim();
    if (primaryUserId && options.heartbeatChannel
      && phases.proactiveOutbound && phases.humanPolicy
      && options.capabilityRuntime.has('external.discord')) {
      const contact = await options.contactStore.getByDiscordUserId(primaryUserId);
      if (contact && !contact.archivedAt && !contact.isMachineIntelligence
        && contact.trustLevel === 'primary'
        && await options.isHumanContactAllowed({ contactId: contact.id, channelType: 'discord' })) {
        destinations.push({
          kind: 'human_dm',
          destinationId: `human:${contact.id}:discord:${options.heartbeatChannel.channelId}`,
          contactId: contact.id,
          displayLabel: contact.nickname?.trim() || contact.displayName,
          channelId: options.heartbeatChannel.channelId,
          channelType: 'discord',
          dyadId: null,
        });
      }
    }

    if (options.icpAutonomy && options.capabilityRuntime.has('external.companion')) {
      const [dyads, peers] = await Promise.all([
        options.icpAutonomy.listOpenDyads(),
        options.icpAutonomy.listKnownPeerAvailability(),
      ]);
      const openContacts = new Set<string>();
      for (const dyad of dyads) {
        openContacts.add(dyad.peerContactId);
        destinations.push({
          kind: 'open_companion_dyad',
          destinationId: `companion-dyad:${dyad.dyadId}`,
          contactId: dyad.peerContactId,
          displayLabel: dyad.peerDisplayLabel,
          channelId: dyad.channelId,
          channelType: 'companion',
          dyadId: dyad.dyadId,
        });
      }
      if (options.icpInitiation) {
        for (const peer of peers) {
          if (!peer.availability.eligible || openContacts.has(peer.contactId)) continue;
          destinations.push({
            kind: 'companion_first_contact',
            destinationId: `companion-first:${peer.contactId}`,
            contactId: peer.contactId,
            displayLabel: peer.displayName,
            channelId: null,
            channelType: 'companion',
            dyadId: null,
          });
        }
      }
    }

    if (phases.reservationPhase && phases.egressLeasePhase
      && options.capabilityRuntime.has('external.discord')) {
      const memberships = new Set(options.sessionStore.listChannels().map(entry => entry.channelId));
      const rooms = await options.contactStore.listKnownRooms({
        limit: DEFAULT_KNOWN_ROOMS_LIMIT,
        offset: 0,
      });
      for (const room of rooms) {
        if ((room.channel !== 'discord' && room.channel !== 'buzz')
          || !memberships.has(room.channelId)) continue;
        destinations.push({
          kind: 'room',
          destinationId: `room:${room.channel}:${room.channelId}`,
          displayLabel: `${room.channel} room ${room.channelId}`,
          channelId: room.channelId,
          channelType: room.channel,
          dyadId: null,
        });
      }
    }
    return destinations;
  };

  const authorHumanTurn = async (
    destination: Extract<SocialImpulseOutreachDestination, { kind: 'human_dm' }>,
    intent: string,
    opportunityId: string,
  ): Promise<string> => {
    const message: SubstrateMessage = {
      id: `social-outreach-${randomUUID()}`,
      channelId: destination.channelId,
      channelType: destination.channelType,
      authorId: 'system:social-outreach',
      authorName: options.companionName,
      content: [
        'You chose to consider contacting this person from a qualified social impulse.',
        'Write only the natural message you want to send now. You may return __no_reply__',
        'to change your mind. Do not mention this instruction or the internal impulse.',
        '',
        `Your local intent: ${intent}`,
      ].join('\n'),
      timestamp: new Date(now()),
      routing: {
        source: destination.channelType,
        canonicalContactId: destination.contactId,
        channelPrivacy: classifyChannelDisclosure(destination.channelId).channelPrivacy,
        privateTurnTrigger: true,
      },
    };
    const response = await options.agentLoop.handleMessage(message);
    const content = response.content.trim();
    if (!content || content.toLowerCase() === '__no_reply__') return '';
    if (!opportunityId) throw new Error('social outreach turn lost its opportunity identity');
    return content;
  };

  return createSocialImpulseOutreachRuntime({
    companionId: options.companionId,
    store: options.store,
    getMode: options.getMode,
    listDestinations,
    now,
    runDispositionOpportunity: async opportunity => {
      const message: SubstrateMessage = {
        id: `social-disposition-${randomUUID()}`,
        channelId: `internal:social-outreach:${shortHash(opportunity.opportunityId)}`,
        channelType: 'terminal',
        authorId: 'system:social-outreach',
        authorName: options.companionName,
        content: [
          'A qualified social impulse created one optional outreach decision.',
          'Nothing has been shown to anyone else. Ignoring or deferring is fully valid.',
          `Use notify action=outreach_list with opportunity_id=${opportunity.opportunityId}`,
          'to see currently authorized destinations, then use action=outreach_choose once.',
          'The available dispositions are ignore, defer, contact-human, contact-companion,',
          'join-room, and other. A destination choice still runs every destination gate.',
        ].join('\n'),
        timestamp: new Date(now()),
        routing: { source: 'terminal', privateTurnTrigger: true },
      };
      await options.agentLoop.handleMessage(message);
    },
    execute: async execution => {
      if (options.availability.snapshot().state === 'do_not_disturb') {
        return { outcome: 'suppressed', reasonCode: 'companion_do_not_disturb' };
      }
      const destination = execution.destination;
      if (destination.kind === 'open_companion_dyad') {
        if (!options.icpAutonomy || !options.capabilityRuntime.has('external.companion')) {
          return { outcome: 'suppressed', reasonCode: 'companion_continuation_unavailable' };
        }
        const result = await options.icpAutonomy.executeDyadContinuation({
          dyadId: destination.dyadId,
          deliveryId: deterministicIcpUuid('social-outreach-delivery', execution.bindingHash),
          conversationId: deterministicIcpUuid('social-outreach-conversation', execution.bindingHash),
          privateIntent: execution.intent,
          initiationSource: 'felt_impulse',
        }, () => options.capabilityRuntime.has('external.companion'));
        return result.disposition === 'delivered'
          ? { outcome: 'delivered' }
          : { outcome: 'suppressed', reasonCode: 'companion_continuation_suppressed' };
      }
      if (destination.kind === 'companion_first_contact') {
        if (!options.icpInitiation || !options.capabilityRuntime.has('external.companion')) {
          return { outcome: 'suppressed', reasonCode: 'companion_initiation_unavailable' };
        }
        const result = await options.icpInitiation.submit({
          source: 'felt_impulse',
          peerContactId: destination.contactId,
          preferredChannel: 'dm',
          sourceRecordId: execution.opportunityId,
          reasonSummary: execution.intent,
          cause: { kind: 'independent' },
          feltImpulseFiredAtMs: now(),
        });
        return (result.status === 'consumed' || result.status === 'permitted')
          && result.deliveryDisposition !== 'suppressed'
          ? { outcome: 'delivered' }
          : { outcome: 'suppressed', reasonCode: `companion_initiation_${result.status}` };
      }
      if (destination.kind === 'human_dm') {
        const phases = options.getPhases();
        if (!phases.proactiveOutbound || !phases.humanPolicy
          || !options.capabilityRuntime.has('external.discord')
          || !await options.isHumanContactAllowed({
            contactId: destination.contactId,
            channelType: 'discord',
          })) {
          return { outcome: 'suppressed', reasonCode: 'human_destination_unavailable' };
        }
        const policy = await phases.humanPolicy.evaluate({
          contactId: destination.contactId,
          channelId: destination.channelId,
          channelType: destination.channelType,
          nowMs: now(),
        });
        if (!policy.allowed) return { outcome: 'suppressed', reasonCode: policy.reason };
        const content = await authorHumanTurn(
          destination,
          execution.intent,
          execution.opportunityId,
        );
        if (!content) return { outcome: 'suppressed', reasonCode: 'companion_declined' };
        if (options.availability.snapshot().state === 'do_not_disturb'
          || !options.capabilityRuntime.has('external.discord')
          || !await options.isHumanContactAllowed({
            contactId: destination.contactId,
            channelType: 'discord',
          })) {
          return { outcome: 'suppressed', reasonCode: 'human_destination_invalidated' };
        }
        const dispatched = await phases.proactiveOutbound.dispatch({
          actionId: execution.opportunityId,
          channelId: destination.channelId,
          channelType: destination.channelType,
          content,
          reason: 'qualified_social_impulse',
        });
        return dispatched.outcome === 'sent'
          ? { outcome: 'delivered' }
          : { outcome: 'suppressed', reasonCode: `human_${dispatched.reason}` };
      }

      const phases = options.getPhases();
      if (!phases.reservationPhase || !phases.egressLeasePhase
        || !options.capabilityRuntime.has('external.discord')) {
        return { outcome: 'suppressed', reasonCode: 'room_arbiter_unavailable' };
      }
      const reserved = await phases.reservationPhase.reserve({
        channelId: destination.channelId,
        triggerEventId: execution.opportunityId,
        companionId: options.companionId,
        nowMs: now(),
      });
      if (reserved.outcome !== 'reserved') {
        return { outcome: 'suppressed', reasonCode: `room_reservation_${reserved.blockedBy}` };
      }
      await phases.reservationPhase.settleAfterAppraisal(
        reserved.reservation,
        'reply',
        now(),
      );
      const roomResult = await phases.egressLeasePhase.grantReply(
        reserved.reservation,
        { action: 'reply', reasonCode: 'companion_chosen_outreach', confidence: 1 },
        {
          channelId: destination.channelId,
          channelType: destination.channelType,
          sourceMessageId: execution.opportunityId,
          authorId: 'system:social-outreach',
          authorName: options.companionName,
          content: execution.intent,
          timestampMs: now(),
        },
        now(),
      );
      return roomResult.outcome === 'delivered'
        ? { outcome: 'delivered' }
        : { outcome: 'suppressed', reasonCode: `room_${roomResult.outcome}` };
    },
  });
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
