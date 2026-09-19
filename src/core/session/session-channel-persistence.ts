const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';
export const SOCIAL_OUTREACH_REFLECTION_CHANNEL_ID = 'internal:reflection:social-outreach';

/** Social outreach retains deliberation history; other reflection channels are scratch sessions. */
export function shouldPersistSessionChannel(channelId: string): boolean {
  return channelId === SOCIAL_OUTREACH_REFLECTION_CHANNEL_ID
    || !channelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX);
}
