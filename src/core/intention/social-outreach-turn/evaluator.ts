// ── Companion-turn consent moment for social desires (psfn-framework-vcq8v.4) ──
//
// When a contact's social pressure is eligible, the companion herself — with
// her persona, at chat priority — is asked in that contact's dedicated outreach
// channel whether she wants to message them. The turn is fresh every time (the
// channel is never persisted) and its answer comes only from the outreach tool:
//   outreach_send  -> message (the exact words she wrote)
//   outreach_later -> defer   (re-queued for later re-evaluation)
//   no tool call   -> decline (her reply, including __no_reply__, is "no")
// Routing, gates, and delivery stay with the existing outbound path.

import { randomUUID } from 'node:crypto';
import type { SubstrateMessage } from '../../../shared/contracts/runtime-base.js';
import type {
  SocialDesireConsentDecision,
  SocialDesireConsentEvaluationInput,
  SocialDesireConsentEvaluator,
} from '../social-desire-outreach.js';
import {
  gatherSocialOutreachTurnContext,
  type SocialOutreachContextPorts,
} from './context.js';
import type { SocialOutreachDraftRegistry } from './drafts.js';
import { buildSocialOutreachTurnPrompt } from './prompt.js';

const SOCIAL_OUTREACH_TURN_AUTHOR_ID = 'system:social-outreach';

export interface SocialOutreachTurnEvaluatorOptions {
  turns: { handleMessage(message: SubstrateMessage): Promise<unknown> };
  drafts: SocialOutreachDraftRegistry;
  context: SocialOutreachContextPorts;
  companionName: string;
  now?: () => number;
}

export function createSocialOutreachTurnEvaluator(
  options: SocialOutreachTurnEvaluatorOptions,
): SocialDesireConsentEvaluator {
  const now = options.now ?? Date.now;
  return {
    async evaluate(input: SocialDesireConsentEvaluationInput): Promise<SocialDesireConsentDecision> {
      const nowMs = now();
      const context = await gatherSocialOutreachTurnContext(options.context, {
        contactId: input.contactId,
        ...(input.contactName ? { contactName: input.contactName } : {}),
        conversationChannelId: input.channelId,
        companionTarget: input.companionTarget,
        nowMs,
      });
      const slot = options.drafts.open(input.contactId);
      try {
        await options.turns.handleMessage({
          id: `social-outreach-${randomUUID()}`,
          channelId: slot.channelId,
          channelType: 'terminal',
          authorId: SOCIAL_OUTREACH_TURN_AUTHOR_ID,
          authorName: options.companionName,
          content: buildSocialOutreachTurnPrompt({
            context,
            orientation: input.orientation,
            ...(input.reason ? { reason: input.reason } : {}),
            nowMs,
          }),
          timestamp: new Date(nowMs),
          routing: { source: 'terminal', privateTurnTrigger: true },
        });
        const answer = slot.answer();
        if (!answer) return { action: 'decline' };
        if (answer.kind === 'later') return { action: 'defer' };
        return { action: 'message', content: answer.text };
      } finally {
        slot.close();
      }
    },
  };
}
