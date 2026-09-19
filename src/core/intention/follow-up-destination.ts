import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { IntentionActionDecision } from './appraisal.js';
import { isInternalSessionId } from '../session/session-id.js';

export type IntentionFollowUpDestinationResolver = (input: {
  channelId: string;
  channelType?: ChannelType;
}) => Promise<{ channelId: string; channelType: ChannelType; contactId: string } | null>;

/** Bind model targets once, before either the pending store or queue sees them. */
export async function bindIntentionFollowUpDestinations(input: {
  decisions: readonly IntentionActionDecision[];
  sourceChannelId: string;
  sourceChannelType: ChannelType;
  sourceContactId?: string;
  resolveDestination?: IntentionFollowUpDestinationResolver;
}): Promise<Map<IntentionActionDecision, string | undefined>> {
  const contacts = new Map<IntentionActionDecision, string | undefined>();
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
    if (!destination) throw new Error('Intention follow-up destination is not authorized');
    decision.followUp = { ...followUp, channelId: destination.channelId, channelType: destination.channelType };
    contacts.set(decision, destination.contactId);
  }
  return contacts;
}
