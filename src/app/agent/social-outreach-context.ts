import type { Contact } from '../../core/contacts/types.js';
import { parseSessionMessageAddressing } from '../../core/session/message-addressing.js';
import type { SessionStore } from '../../persistence/sessions/store.js';

/**
 * A configured proactive channel belongs to a canonical human only when the
 * latest transport-addressed entry there is a direct message from one of that
 * contact's Discord identities (PR #609). Proactive human outreach and
 * follow-ups must not reach a channel merely configured as "the heartbeat".
 */
export function resolvePrimaryContactOutreachIdentity(
  sessions: Pick<SessionStore, 'findLatestEntries'>,
  contact: Contact,
  channelId: string,
): string | undefined {
  const entry = sessions.findLatestEntries(channelId, candidate => (
    parseSessionMessageAddressing(candidate.metadata) !== null
  ), 1).at(0);
  const addressing = entry ? parseSessionMessageAddressing(entry.metadata) : null;
  const identities = new Set([
    contact.discordUserId,
    ...contact.channels?.filter(identity => identity.channel === 'discord').map(identity => identity.userId) ?? [],
  ]);
  return addressing?.source === 'discord'
    && addressing.channel.channelId === channelId
    && addressing.channel.scope === 'direct'
    && identities.has(addressing.author.authorId)
    ? addressing.author.authorId : undefined;
}
