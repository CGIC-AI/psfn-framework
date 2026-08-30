import type {
  Contact,
  ContactChannelLink,
} from '../types.js';
import {
  LEGACY_DISCORD_CHANNEL,
  identityKey,
  normalizeChannelLinkInput,
  normalizeIdentity,
} from './identity-utils.js';

export function collectUpsertIdentities(partial: Partial<Contact>): ContactChannelLink[] {
  const identities: ContactChannelLink[] = [];
  const seen = new Set<string>();

  const addIdentity = (identity: ContactChannelLink): void => {
    const key = identityKey(identity);
    if (seen.has(key)) return;
    identities.push(identity);
    seen.add(key);
  };

  if (Array.isArray(partial.channels)) {
    for (const channel of partial.channels) {
      if (!channel.channel || !channel.userId) continue;
      const normalized = normalizeIdentity(channel.channel, channel.userId);
      addIdentity(normalizeChannelLinkInput(normalized, {
        privacyLevel: channel.privacyLevel,
        ...(channel.introducedAtPlaceId !== undefined
          ? { introducedAtPlaceId: channel.introducedAtPlaceId }
          : {}),
        ...(channel.introducedAtWorld !== undefined
          ? { introducedAtWorld: channel.introducedAtWorld }
          : {}),
        ...(channel.introducedVia !== undefined ? { introducedVia: channel.introducedVia } : {}),
      }));
    }
  }

  if (Array.isArray(partial.channelIdentities)) {
    for (const identity of partial.channelIdentities) {
      if (!identity.channel || !identity.userId) continue;
      const normalized = normalizeIdentity(identity.channel, identity.userId);
      addIdentity(normalizeChannelLinkInput(normalized));
    }
  }

  if (partial.discordUserId) {
    const normalized = normalizeIdentity(LEGACY_DISCORD_CHANNEL, partial.discordUserId);
    addIdentity(normalizeChannelLinkInput(normalized));
  }

  return identities;
}
