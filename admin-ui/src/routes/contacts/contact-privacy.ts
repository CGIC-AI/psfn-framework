import { EXTERNAL_MEMORY_CHANNEL } from '../../../../src/shared/routing/external-memory-channel.js';
import type { Contact, ContactConversationChannelView, ChannelPrivacyLevel } from '$lib/types';
import {
  getChannelEnvelopeData, saveChannelEnvelopeLabel, getChannelDemotionNotice, demoteChannelToPublic,
  type ChannelEnvelopeData,
} from '$lib/api/endpoints/channels';

type PrivacyChannel = {
  channel: string;
  userId?: string;
  channelId?: string;
  policyChannelId?: string;
  privacyLevel?: ChannelPrivacyLevel;
};

export function contactPrivacyKey(channel: PrivacyChannel): string {
  if (channel.channel === EXTERNAL_MEMORY_CHANNEL || channel.policyChannelId) {
    return `policy:${channel.policyChannelId ?? EXTERNAL_MEMORY_CHANNEL}`;
  }
  return channel.channelId
    ? `conversation:${channel.channel}:${channel.channelId}`
    : `identity:${channel.channel}:${channel.userId}`;
}

export function contactChannelPrivacy(
  channel: PrivacyChannel,
  policies: ChannelEnvelopeData | null,
): ChannelPrivacyLevel | undefined {
  const key = contactPrivacyKey(channel);
  return key.startsWith('policy:')
    ? policies?.channels.find(row => `policy:${row.channelId}` === key)?.privacy
    : channel.privacyLevel;
}

type ChannelPrivacyChangeCandidate =
  | { key: string; target: 'identity'; channel: string; userId: string; privacyLevel: ChannelPrivacyLevel }
  | { key: string; target: 'conversation'; channel: string; channelId: string; privacyLevel: ChannelPrivacyLevel }
  | { key: string; target: 'policy'; channelId: string; privacyLevel: ChannelPrivacyLevel };

export function buildPrivacyChangeCandidates(
  contact: Contact,
  relatedChannels: ContactConversationChannelView[],
  policies: ChannelEnvelopeData | null,
): ChannelPrivacyChangeCandidate[] {
  const candidates = new Map<string, ChannelPrivacyChangeCandidate>();
  for (const ch of [...(contact.channels ?? []), ...relatedChannels]) {
    const key = contactPrivacyKey(ch);
    const privacyLevel = contactChannelPrivacy(ch, policies);
    if (!privacyLevel) continue;
    if (key.startsWith('policy:')) {
      candidates.set(key, { key, target: 'policy', channelId: key.slice('policy:'.length), privacyLevel });
    } else if ('channelId' in ch) {
      candidates.set(key, { key, target: 'conversation', channel: ch.channel, channelId: ch.channelId, privacyLevel });
    } else {
      candidates.set(key, { key, target: 'identity', channel: ch.channel, userId: ch.userId, privacyLevel });
    }
  }
  return [...candidates.values()];
}

/** Save the shared policy without replacing unrelated channel settings or disclosure safeguards. */
export async function saveContactPolicyPrivacy(
  channelId: string,
  privacy: ChannelPrivacyLevel,
  confirmDisclosure: (notice: string) => boolean,
): Promise<ChannelEnvelopeData | null> {
  const latest = await getChannelEnvelopeData();
  const row = latest.channels.find(channel => channel.channelId === channelId);
  if (!row) throw new Error(`Channel privacy is unavailable for ${channelId}`);
  if (row.privacy === privacy) return latest;
  if (privacy === 'public') {
    const notice = await getChannelDemotionNotice(channelId);
    if (!notice.demotable) throw new Error(notice.reason ?? 'This channel cannot be made public.');
    if (!confirmDisclosure(notice.notice)) return null;
    const result = await demoteChannelToPublic(channelId, notice.noticeVersion);
    if (!result.ok) throw new Error(result.message);
    return result.data;
  }
  const { classificationSource: _source, ...label } = row.label ?? {};
  const result = await saveChannelEnvelopeLabel(channelId, {
    ...label, privacy,
    // A broadcast channel cannot retain broadcast delivery after becoming private.
    ...(row.broadcast ? { broadcast: false } : {}),
  });
  if (!result.ok) throw new Error(result.message);
  return result.data;
}
