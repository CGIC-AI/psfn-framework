import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';
import type { Contact } from '../contacts/types.js';
import {
  evaluateProactiveOutboundTimeGate,
  isValidProactiveTimeZone,
} from './proactive-time-gate.js';

export type SocialDesireHumanDeliveryDecision =
  | { allowed: true }
  | { allowed: false; reason: string; rescheduleAt?: number };

export interface SocialDesireHumanDeliveryPolicy {
  evaluate(input: {
    contactId: string;
    channelId: string;
    channelType: ChannelType;
    nowMs: number;
    earliestSendAtMs?: number;
  }): Promise<SocialDesireHumanDeliveryDecision>;
}

/** Re-resolves mutable human-contact policy immediately before every attempt. */
export function createSocialDesireHumanDeliveryPolicy(options: {
  contacts: { getById(id: string): Contact | undefined | Promise<Contact | undefined> };
  approvedHeartbeatChannel: { channelId: string; channelType: ChannelType };
  quietHours: EpisodicProcessingRestWindowConfig;
}): SocialDesireHumanDeliveryPolicy {
  const approvedChannelId = options.approvedHeartbeatChannel.channelId.trim();
  return {
    evaluate: async (input) => {
      const contact = await options.contacts.getById(input.contactId);
      if (!contact) return { allowed: false, reason: 'social_desire_contact_missing' };
      if (contact.isMachineIntelligence) {
        return { allowed: false, reason: 'social_desire_human_target_is_companion' };
      }
      if (contact.trustLevel !== 'primary') {
        return { allowed: false, reason: 'social_desire_contact_not_primary' };
      }
      if (input.channelId.trim() !== approvedChannelId
        || input.channelType !== options.approvedHeartbeatChannel.channelType) {
        return { allowed: false, reason: 'social_desire_channel_not_approved' };
      }
      if (options.quietHours.enabled
        && (typeof contact.timezone !== 'string'
          || !isValidProactiveTimeZone(contact.timezone.trim()))) {
        return { allowed: false, reason: 'social_desire_recipient_timezone_unavailable' };
      }
      const timeGate = evaluateProactiveOutboundTimeGate({
        nowMs: input.nowMs,
        earliestSendAtMs: input.earliestSendAtMs,
        quietHours: options.quietHours,
        contactTimeZone: contact.timezone,
      });
      return timeGate.allowed
        ? { allowed: true }
        : {
            allowed: false,
            reason: timeGate.reason,
            rescheduleAt: timeGate.nextEligibleAtMs,
          };
    },
  };
}
