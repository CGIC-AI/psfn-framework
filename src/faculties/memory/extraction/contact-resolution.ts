import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import { inferSessionChannelType } from '../../../core/session/session-id.js';
import { COMPANION_CHANNEL_TYPE, parseCompanionChannelId } from '../../../shared/contracts/companion-channels.js';
import { EXTERNAL_MEMORY_CHANNEL, externalMemoryPolicyChannelId } from '../../../shared/routing/external-memory-channel.js';
import { normalizeSpeakerPhrase } from './strict-group-routing.js';
import type { ExtractionSourceSpeaker } from './speaker-routing.js';

const GENERIC_SOURCE_SPEAKER_KEYS = new Set([
  'assistant', 'companion', 'the assistant', 'the companion', 'the user', 'user',
]);

export function extractionContactNames(contact: Pick<Contact, 'displayName' | 'nickname'>): string[] {
  return [contact.displayName, contact.nickname].filter((name): name is string => Boolean(name?.trim()));
}

export async function resolveExtractionSourceContactId(
  channelId: string,
  speaker: ExtractionSourceSpeaker,
  store: ContactStorePort | null,
): Promise<string | undefined> {
  if (!store) return undefined;
  const authorId = speaker.authorId?.trim();
  const channel = parseCompanionChannelId(channelId)
    ? COMPANION_CHANNEL_TYPE
    : externalMemoryPolicyChannelId(channelId) === EXTERNAL_MEMORY_CHANNEL
      ? EXTERNAL_MEMORY_CHANNEL
      : inferSessionChannelType(channelId);
  if (authorId && channel) {
    const contact = await store.getByChannelIdentity(channel, authorId);
    if (contact && !contact.archivedAt) return contact.id;
    if (channel === 'discord') {
      const discordContact = await store.getByDiscordUserId(authorId);
      if (discordContact && !discordContact.archivedAt) return discordContact.id;
    }
  }
  const name = normalizeSpeakerPhrase(speaker.name);
  if (!name || GENERIC_SOURCE_SPEAKER_KEYS.has(name)) return undefined;
  const matches = (await store.listAll()).filter(contact => !contact.archivedAt
    && extractionContactNames(contact).some(alias => normalizeSpeakerPhrase(alias) === name));
  return matches.length === 1 ? matches[0]?.id : undefined;
}
