import type { Event as NostrEvent } from 'nostr-tools';
import {
  createBuzzCausalReplyTags,
  parseBuzzCausalEnvelope,
} from './protocol.js';

export type BuzzSuppressionReason =
  | 'autonomous_hop_limit'
  | 'duplicate_causal_edge'
  | 'unknown_causal_root'
  | 'no_information_acknowledgement'
  | 'fatigue_suppressed'
  | 'intentional_no_reply'
  | 'empty_response';

export interface BuzzCausalReplyPlan {
  rootEventId: string;
  parentEventId: string;
  hop: number;
  recipientPubkeys: readonly string[];
}

export function planBuzzCausalReply(input: {
  event: NostrEvent;
  companionPubkey: string;
  machineAuthorPubkeys: ReadonlySet<string>;
  maxAutonomousReplyHops: number;
  noInformationAcknowledgements: ReadonlySet<string>;
}): { plan?: BuzzCausalReplyPlan; suppress?: BuzzSuppressionReason; causalEdge?: {
  chainId: string;
  parentEventId: string;
  authorPubkey: string;
  eventId: string;
} } {
  if (!input.machineAuthorPubkeys.has(input.event.pubkey)) {
    return {
      plan: {
        rootEventId: input.event.id,
        parentEventId: input.event.id,
        hop: 1,
        recipientPubkeys: [input.event.pubkey],
      },
    };
  }
  const envelope = parseBuzzCausalEnvelope(
    input.event,
    input.companionPubkey,
    input.maxAutonomousReplyHops,
  );
  if (!envelope) return { suppress: 'autonomous_hop_limit' };
  if (envelope.hop >= input.maxAutonomousReplyHops) {
    return { suppress: 'autonomous_hop_limit' };
  }
  if (input.noInformationAcknowledgements.has(normalizeAcknowledgement(input.event.content))) {
    return { suppress: 'no_information_acknowledgement' };
  }
  return {
    plan: {
      rootEventId: envelope.rootEventId,
      parentEventId: input.event.id,
      hop: envelope.hop + 1,
      recipientPubkeys: [input.event.pubkey],
    },
    causalEdge: {
      chainId: envelope.chainId,
      parentEventId: envelope.parentEventId,
      authorPubkey: input.event.pubkey,
      eventId: input.event.id,
    },
  };
}

export function buzzCausalReplyTags(plan: BuzzCausalReplyPlan): string[][] {
  return createBuzzCausalReplyTags(plan);
}

export function normalizeAcknowledgement(value: string): string {
  return value.trim().toLocaleLowerCase();
}
