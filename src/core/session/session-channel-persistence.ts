import { isSocialOutreachChannelId } from '../../shared/contracts/social-outreach-channel.js';

const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';

/**
 * Internal reflection channels and per-contact social-outreach channels are
 * ephemeral and never persist to session stores: every outreach turn starts
 * fresh and nothing from it accumulates or leaks into conversation history.
 */
export function shouldPersistSessionChannel(channelId: string): boolean {
  return !channelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX)
    && !isSocialOutreachChannelId(channelId);
}
