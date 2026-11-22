import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { Contact } from '../../core/contacts/types.js';
import type { ProcessableConversationKind } from '../../core/session/conversational-activity.js';
import {
  inferSessionChannelType,
  isExperientialSelfDirectedSessionId,
} from '../../core/session/session-id.js';
import type { SessionEntry } from '../../core/session/types.js';
import {
  COMPANION_CHANNEL_TYPE,
  parseCompanionChannelId,
} from '../../shared/contracts/companion-channels.js';
import {
  EXTERNAL_MEMORY_CHANNEL,
  externalMemoryPolicyChannelId,
} from '../../shared/routing/external-memory-channel.js';
import { extractionContactNames } from './extraction/contact-resolution.js';
import { normalizeSpeakerPhrase } from './extraction/strict-group-routing.js';

export type SessionCounterpartyContactStore = Partial<Pick<
  ContactStorePort,
  'getById' | 'getByChannelIdentity' | 'getByDiscordUserId' | 'listAll' | 'listRoomRoster'
>>;

export type SessionMemoryAttribution =
  | { kind: 'single_contact'; contactId: string }
  | { kind: 'companion_private' }
  | { kind: 'none' };

export interface ResolveSessionMemoryAttributionInput {
  sessionId: string;
  activityKind?: ProcessableConversationKind;
  entries?: readonly SessionEntry[];
  contactStore?: SessionCounterpartyContactStore | null;
  localCompanionId?: string;
  companionAuthorIds?: readonly string[];
}

const GENERIC_SPEAKER_KEYS = new Set([
  'assistant',
  'companion',
  'the assistant',
  'the companion',
  'the user',
  'user',
]);

const ROSTER_PROBE_SLOTS = 3;

function isActiveContact(contact: Contact | undefined): contact is Contact {
  return contact !== undefined && !contact.archivedAt && contact.id.trim().length > 0;
}

function contactChannelLinks(contact: Contact): ReadonlyArray<{ channel: string; userId: string }> {
  return [
    ...(contact.channels ?? []),
    ...(contact.channelIdentities ?? []),
  ];
}

function resolveChannelForSession(sessionId: string): string | undefined {
  if (parseCompanionChannelId(sessionId)) return COMPANION_CHANNEL_TYPE;
  if (externalMemoryPolicyChannelId(sessionId) === EXTERNAL_MEMORY_CHANNEL) {
    return EXTERNAL_MEMORY_CHANNEL;
  }
  return inferSessionChannelType(sessionId);
}

function extractSessionUserSuffix(sessionId: string, channel: string): string | undefined {
  const prefix = `${channel}:`;
  if (!sessionId.startsWith(prefix)) return undefined;
  const suffix = sessionId.slice(prefix.length).trim();
  if (!suffix || suffix.includes(':')) return undefined;
  return suffix;
}

async function resolveCompanionDmPeerContactId(
  participants: readonly [string, string],
  contactStore: SessionCounterpartyContactStore,
  localCompanionId: string | undefined,
): Promise<string | undefined> {
  const normalizedLocal = localCompanionId?.trim();
  const candidatePeerIds = normalizedLocal && participants.includes(normalizedLocal)
    ? participants.filter(id => id !== normalizedLocal)
    : [...participants];

  const resolvedIds = new Set<string>();
  if (contactStore.getByChannelIdentity) {
    for (const peerId of candidatePeerIds) {
      const contact = await contactStore.getByChannelIdentity(COMPANION_CHANNEL_TYPE, peerId);
      if (isActiveContact(contact)) {
        resolvedIds.add(contact.id);
      }
    }
  }
  if (resolvedIds.size === 0 && contactStore.listAll) {
    const allContacts = await contactStore.listAll();
    const candidateSet = new Set(candidatePeerIds);
    for (const contact of allContacts) {
      if (!isActiveContact(contact)) continue;
      if (contactChannelLinks(contact).some(
        link => link.channel === COMPANION_CHANNEL_TYPE && candidateSet.has(link.userId),
      )) {
        resolvedIds.add(contact.id);
      }
    }
  }
  return resolvedIds.size === 1 ? [...resolvedIds][0] : undefined;
}

async function resolveSpeakerContactId(
  sessionId: string,
  speaker: { authorId?: string; name?: string },
  contactStore: SessionCounterpartyContactStore,
  cachedContacts: { loaded: boolean; contacts: Contact[] },
): Promise<string | undefined> {
  const authorId = speaker.authorId?.trim();
  const channel = resolveChannelForSession(sessionId);
  if (authorId && channel) {
    if (contactStore.getByChannelIdentity) {
      const contact = await contactStore.getByChannelIdentity(channel, authorId);
      if (isActiveContact(contact)) return contact.id;
    }
    if (channel === 'discord' && contactStore.getByDiscordUserId) {
      const discordContact = await contactStore.getByDiscordUserId(authorId);
      if (isActiveContact(discordContact)) return discordContact.id;
    }
  }
  const normalizedName = speaker.name ? normalizeSpeakerPhrase(speaker.name) : '';
  if (!normalizedName || GENERIC_SPEAKER_KEYS.has(normalizedName)) return undefined;
  if (!contactStore.listAll) return undefined;
  if (!cachedContacts.loaded) {
    cachedContacts.contacts = (await contactStore.listAll()).filter(isActiveContact);
    cachedContacts.loaded = true;
  }
  const matches = cachedContacts.contacts.filter(contact => (
    extractionContactNames(contact).some(alias => normalizeSpeakerPhrase(alias) === normalizedName)
  ));
  return matches.length === 1 ? matches[0]?.id : undefined;
}

/**
 * Resolves subject attribution for memories written by background session-level
 * passes (sleeptime review and episodic behavioral summaries).
 *
 * - Self-directed sessions (`experiential_free_time`, reflection) -> `companion_private`
 * - Multi-party rooms (`group_conversation`, `companion-room:*`) -> `none` (fail closed)
 * - Single-counterparty sessions (`companion-dm:*`, human DM, Hermes) -> `single_contact`
 *   when exactly one active canonical contact is unambiguously resolved.
 */
export async function resolveSessionMemoryAttribution(
  input: ResolveSessionMemoryAttributionInput,
): Promise<SessionMemoryAttribution> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return { kind: 'none' };

  if (
    input.activityKind === 'experiential_free_time'
    || isExperientialSelfDirectedSessionId(sessionId)
  ) {
    return { kind: 'companion_private' };
  }

  const companionChannel = parseCompanionChannelId(sessionId);
  if (companionChannel?.kind === 'room' || input.activityKind === 'group_conversation') {
    return { kind: 'none' };
  }

  const contactStore = input.contactStore;
  if (!contactStore) return { kind: 'none' };

  if (companionChannel?.kind === 'dm') {
    const peerContactId = await resolveCompanionDmPeerContactId(
      companionChannel.participants,
      contactStore,
      input.localCompanionId,
    );
    if (peerContactId) {
      return { kind: 'single_contact', contactId: peerContactId };
    }
  }

  const excludedAuthors = new Set(
    [...(input.companionAuthorIds ?? []), ...(input.localCompanionId ? [input.localCompanionId] : [])]
      .map(id => id.trim())
      .filter(Boolean),
  );
  const cachedContacts = { loaded: false, contacts: [] as Contact[] };
  const resolvedSpeakerIds = new Set<string>();
  const seenSpeakers = new Set<string>();
  let unresolvedSpeakerCount = 0;
  for (const entry of input.entries ?? []) {
    if (entry.role !== 'user') continue;
    const authorId = entry.authorId?.trim();
    if (authorId && excludedAuthors.has(authorId)) continue;
    const authorName = entry.authorName?.trim();
    if (!authorId && !authorName) continue;
    const speakerKey = `${authorId ?? ''}\u001f${authorName ?? ''}`;
    if (seenSpeakers.has(speakerKey)) continue;
    seenSpeakers.add(speakerKey);
    const contactId = await resolveSpeakerContactId(
      sessionId,
      { ...(authorId ? { authorId } : {}), ...(authorName ? { name: authorName } : {}) },
      contactStore,
      cachedContacts,
    );
    if (contactId) {
      resolvedSpeakerIds.add(contactId);
    } else if (
      authorId
      || (authorName && !GENERIC_SPEAKER_KEYS.has(normalizeSpeakerPhrase(authorName)))
    ) {
      unresolvedSpeakerCount += 1;
    }
  }
  if (resolvedSpeakerIds.size === 1 && unresolvedSpeakerCount === 0) {
    return { kind: 'single_contact', contactId: [...resolvedSpeakerIds][0]! };
  }
  if (resolvedSpeakerIds.size > 1 || (resolvedSpeakerIds.size === 1 && unresolvedSpeakerCount > 0)) {
    return { kind: 'none' };
  }

  // Fallback for DM/Hermes sessions whose entries lacked author metadata or
  // when resuming without a loaded transcript slice.
  const inferredChannel = resolveChannelForSession(sessionId);
  const sessionUserSuffix = inferredChannel
    ? extractSessionUserSuffix(sessionId, inferredChannel)
    : undefined;
  if (inferredChannel && sessionUserSuffix && contactStore.getByChannelIdentity) {
    const bySessionIdentity = await contactStore.getByChannelIdentity(
      inferredChannel,
      sessionUserSuffix,
    );
    if (isActiveContact(bySessionIdentity)) {
      return { kind: 'single_contact', contactId: bySessionIdentity.id };
    }
  }

  if (contactStore.listAll) {
    if (!cachedContacts.loaded) {
      cachedContacts.contacts = (await contactStore.listAll()).filter(isActiveContact);
      cachedContacts.loaded = true;
    }
    const matchingChannelContacts = cachedContacts.contacts.filter(contact => (
      contact.conversationChannels?.some(channel => channel.channelId === sessionId) === true
      || (
        inferredChannel !== undefined
        && sessionUserSuffix !== undefined
        && contactChannelLinks(contact).some(
          link => link.channel === inferredChannel && link.userId === sessionUserSuffix,
        )
      )
    ));
    if (matchingChannelContacts.length === 1) {
      return { kind: 'single_contact', contactId: matchingChannelContacts[0]!.id };
    }
    if (matchingChannelContacts.length > 1) {
      return { kind: 'none' };
    }
  }

  if (contactStore.listRoomRoster) {
    const roster = await contactStore.listRoomRoster(sessionId, { limit: ROSTER_PROBE_SLOTS });
    const uniqueRosterIds = [...new Set(roster.map(member => member.contactId.trim()).filter(Boolean))];
    if (uniqueRosterIds.length === 1) {
      const candidateId = uniqueRosterIds[0]!;
      if (contactStore.getById) {
        const contact = await contactStore.getById(candidateId);
        if (isActiveContact(contact)) {
          return { kind: 'single_contact', contactId: contact.id };
        }
      } else {
        return { kind: 'single_contact', contactId: candidateId };
      }
    }
  }

  return { kind: 'none' };
}
