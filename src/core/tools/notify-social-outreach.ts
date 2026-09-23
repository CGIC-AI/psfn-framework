// ── notify outreach answers (psfn-framework-vcq8v.4) ──
//
// Inside a per-contact outreach turn the companion answers with one call:
//   notify action=outreach_send message="<exactly what she wants to say>"
//   notify action=outreach_later
// Not calling either is "no". The runtime routes the message to the contact's
// private DM (human) or through companion messaging (companion) after its
// ordinary outbound gates; there is no destination or group choice here.

import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { SocialOutreachDraftRegistry } from '../intention/social-outreach-turn/drafts.js';
import { textResult, textResultWithError } from './results.js';

const SOCIAL_OUTREACH_NOTIFY_ACTIONS = ['outreach_send', 'outreach_later'] as const;
export type SocialOutreachNotifyAction = typeof SOCIAL_OUTREACH_NOTIFY_ACTIONS[number];

export const socialOutreachSendParameters = Type.Object({
  action: Type.Literal('outreach_send'),
  message: Type.String({
    description: 'Exactly what you want to say to them, in your own voice. Blank messages are rejected.',
  }),
}, { additionalProperties: false });

export const socialOutreachLaterParameters = Type.Object({
  action: Type.Literal('outreach_later'),
}, { additionalProperties: false });

export function isSocialOutreachNotifyAction(value: unknown): value is SocialOutreachNotifyAction {
  return (SOCIAL_OUTREACH_NOTIFY_ACTIONS as readonly unknown[]).includes(value);
}

export function executeSocialOutreachNotify(
  drafts: SocialOutreachDraftRegistry | undefined,
  params: { action: SocialOutreachNotifyAction; message?: unknown },
): AgentToolResult<{ isError?: boolean }> {
  if (!drafts) {
    return textResultWithError('notify: social outreach is not wired in this runtime.', true);
  }
  try {
    const channelId = getRequestContext()?.channelId;
    if (params.action === 'outreach_later') {
      drafts.submit(channelId, { kind: 'later' });
      return textResult('notify: noted — you will be asked about them again later.');
    }
    if (typeof params.message !== 'string') {
      throw new Error('outreach_send requires message');
    }
    drafts.submit(channelId, { kind: 'message', text: params.message });
    return textResult('notify: your message will be delivered to them.');
  } catch (error) {
    return textResultWithError(`notify: social outreach blocked (${toErrorMessage(error)}).`, true);
  }
}
