import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { IntentionActionDecision } from './appraisal.js';
import { isInternalSessionId } from '../session/session-id.js';

export type IntentionFollowUpDestinationResolver = (input: {
  channelId: string;
  channelType?: ChannelType;
}) => Promise<{ channelId: string; channelType: ChannelType; contactId: string } | null>;

export interface IntentionFollowUpDestinationBinding {
  /** Contact each bound follow-up is for (the source contact or the resolved destination's). */
  contacts: Map<IntentionActionDecision, string | undefined>;
  /**
   * Follow-ups whose model-chosen target is not an authorized destination.
   * Each is rejected on its own (psfn-framework-vcq8v): the other decisions of
   * the same appraisal, including concerns, still apply.
   */
  unauthorized: IntentionActionDecision[];
}

/** Bind model targets once, before either the pending store or queue sees them. */
export async function bindIntentionFollowUpDestinations(input: {
  decisions: readonly IntentionActionDecision[];
  sourceChannelId: string;
  sourceChannelType: ChannelType;
  sourceContactId?: string;
  resolveDestination?: IntentionFollowUpDestinationResolver;
}): Promise<IntentionFollowUpDestinationBinding> {
  const contacts = new Map<IntentionActionDecision, string | undefined>();
  const unauthorized: IntentionActionDecision[] = [];
  for (const decision of input.decisions) {
    if (decision.type !== 'followUp' || !decision.followUp) continue;
    const followUp = decision.followUp;
    const requestedId = followUp.channelId?.trim() || input.sourceChannelId;
    const requestedType = followUp.channelType;
    if ((followUp.delivery !== 'external' || !isInternalSessionId(input.sourceChannelId))
      && requestedId === input.sourceChannelId
      && (requestedType === undefined || requestedType === input.sourceChannelType)) {
      decision.followUp = { ...followUp, channelId: input.sourceChannelId, channelType: input.sourceChannelType };
      contacts.set(decision, input.sourceContactId);
      continue;
    }
    const destination = await input.resolveDestination?.({
      channelId: requestedId,
      ...(requestedType ? { channelType: requestedType } : {}),
    });
    if (!destination) {
      unauthorized.push(decision);
      continue;
    }
    decision.followUp = { ...followUp, channelId: destination.channelId, channelType: destination.channelType };
    contacts.set(decision, destination.contactId);
  }
  return { contacts, unauthorized };
}
