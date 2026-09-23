// ── Live answer slots for per-contact outreach turns (psfn-framework-vcq8v.4) ──
//
// The outreach turn for a contact runs in that contact's dedicated channel. The
// companion answers by calling `notify action=outreach_send message=...` (she
// wants to message them now) or `notify action=outreach_later` (not now, ask me
// again later); saying nothing is "no". The tool can only answer the turn that
// is live in its own channel: a call from any other channel, or with no live
// slot, is rejected (fail closed). Slots are process-local on purpose — an
// answer belongs to the moment it was given.

import {
  composeSocialOutreachChannelId,
  parseSocialOutreachChannelContactId,
} from '../../../shared/contracts/social-outreach-channel.js';
import { normalizeProactiveOutboundContent } from '../proactive-outbound.js';

type SocialOutreachTurnAnswer =
  | { kind: 'message'; text: string }
  | { kind: 'later' };

interface SocialOutreachTurnSlot {
  channelId: string;
  /** The companion's answer, or null when she chose not to reach out. */
  answer(): SocialOutreachTurnAnswer | null;
  close(): void;
}

export interface SocialOutreachDraftRegistry {
  open(contactId: string): SocialOutreachTurnSlot;
  /** Records the companion's answer for the live turn bound to `channelId`. */
  submit(channelId: string | undefined, answer: SocialOutreachTurnAnswer): { contactId: string };
}

export function createSocialOutreachDraftRegistry(): SocialOutreachDraftRegistry {
  const live = new Map<string, { answer: SocialOutreachTurnAnswer | null }>();
  return {
    open(contactId) {
      const channelId = composeSocialOutreachChannelId(contactId);
      if (live.has(channelId)) {
        throw new Error('A social outreach turn is already live for this contact');
      }
      const slot = { answer: null as SocialOutreachTurnAnswer | null };
      live.set(channelId, slot);
      return {
        channelId,
        answer: () => slot.answer,
        close: () => {
          if (live.get(channelId) === slot) live.delete(channelId);
        },
      };
    },
    submit(channelId, answer) {
      const contactId = channelId ? parseSocialOutreachChannelContactId(channelId) : null;
      const slot = channelId ? live.get(channelId) : undefined;
      if (!contactId || !slot) {
        throw new Error('outreach answers are only accepted inside a live social outreach turn');
      }
      if (slot.answer) {
        throw new Error('this outreach turn has already been answered');
      }
      if (answer.kind === 'message') {
        const text = normalizeProactiveOutboundContent(answer.text);
        if (!text) throw new Error('message must contain the words you want to send');
        slot.answer = { kind: 'message', text };
      } else {
        slot.answer = { kind: 'later' };
      }
      return { contactId };
    },
  };
}
