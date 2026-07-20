import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactChannelLink,
} from '../../../core/contacts/types.js';
import { defaultPrivacyForChannel } from '../../../core/contacts/store/identity-utils.js';

const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;

export interface ContactIdentityLinkView {
  channel: string;
  userId: string;
  lastSeen?: string;
}

export interface ContactConversationChannelView {
  channel: string;
  channelId: string;
  userId?: string;
  privacyLevel?: ChannelPrivacyLevel;
  lastSeen?: string;
}

function identityLinkKey(channel: string, userId: string): string {
  return `${channel.trim().toLowerCase()}:${userId.trim().toLowerCase()}`;
}

function getContactIdentityLinks(contact: Contact): ContactIdentityLinkView[] {
  const links: ContactIdentityLinkView[] = [];
  const seen = new Set<string>();

  const addLink = (link: ContactIdentityLinkView): void => {
    const key = identityLinkKey(link.channel, link.userId);
    if (!link.channel.trim() || !link.userId.trim() || seen.has(key)) return;
    links.push(link);
    seen.add(key);
  };

  if (Array.isArray(contact.channels)) {
    for (const channel of contact.channels) {
      addLink({
        channel: channel.channel,
        userId: channel.userId,
        lastSeen: channel.lastSeen,
      });
    }
  }

  if (Array.isArray(contact.channelIdentities)) {
    for (const identity of contact.channelIdentities) {
      addLink({
        channel: identity.channel,
        userId: identity.userId,
        lastSeen: contact.lastSeen,
      });
    }
  }

  return links;
}

function getPersistedConversationChannels(contact: Contact): ContactConversationChannelView[] {
  if (!Array.isArray(contact.conversationChannels) || contact.conversationChannels.length === 0) {
    return [];
  }

  return contact.conversationChannels.map(entry => ({
    channel: entry.channel,
    channelId: entry.channelId,
    ...(entry.privacyLevel ? { privacyLevel: entry.privacyLevel } : {}),
    lastSeen: entry.lastSeen,
  }));
}

function getContactChannelLinks(contact: Contact): ContactChannelLink[] {
  return Array.isArray(contact.channels) ? contact.channels : [];
}

function findLinkedChannelForConversationChannel(options: {
  channel: string;
  channelId: string;
  channelLinks: ContactChannelLink[];
  sessionStore: SessionStore;
}): ContactChannelLink | undefined {
  const sameChannelLinks = options.channelLinks.filter(link => (
    link.channel.trim().toLowerCase() === options.channel.trim().toLowerCase()
  ));
  if (sameChannelLinks.length === 1) {
    return sameChannelLinks[0];
  }

  const directMatch = sameChannelLinks.find(link => (
    sessionMatchesIdentity(options.channelId, link)
    || sessionMatchesIdentity(`${options.channel}:${options.channelId}`, link)
  ));
  if (directMatch) {
    return directMatch;
  }

  const lastEntry = options.sessionStore.getLastEntry(options.channelId)
    ?? options.sessionStore.getLastEntry(`${options.channel}:${options.channelId}`);
  const authorId = lastEntry?.authorId?.trim().toLowerCase();
  if (!authorId) {
    return undefined;
  }

  return sameChannelLinks.find(link => link.userId.trim().toLowerCase() === authorId);
}

function toConversationChannelView(options: {
  channel: string;
  channelId: string;
  lastSeen?: string;
  privacyLevel?: ChannelPrivacyLevel;
  contact: Contact;
  sessionStore: SessionStore;
}): ContactConversationChannelView {
  const linkedChannel = findLinkedChannelForConversationChannel({
    channel: options.channel,
    channelId: options.channelId,
    channelLinks: getContactChannelLinks(options.contact),
    sessionStore: options.sessionStore,
  });

  return {
    channel: options.channel,
    channelId: options.channelId,
    privacyLevel: options.privacyLevel
      ?? linkedChannel?.privacyLevel
      ?? defaultPrivacyForChannel(options.channel),
    ...(linkedChannel ? {
      userId: linkedChannel.userId,
    } : {}),
    lastSeen: options.lastSeen,
  };
}

function splitSessionChannelId(channelId: string): { channel: string; channelId: string } {
  const separatorIndex = channelId.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= channelId.length - 1) {
    return { channel: 'session', channelId };
  }

  return {
    channel: channelId.slice(0, separatorIndex),
    channelId: channelId.slice(separatorIndex + 1),
  };
}

function normalizeSessionChannelType(channelId: string): string {
  const parsed = splitSessionChannelId(channelId);
  if (parsed.channel !== 'session') return parsed.channel;
  if (DISCORD_CHANNEL_ID_PATTERN.test(channelId)) return 'discord';
  return parsed.channel;
}

function sessionMatchesConversationChannel(
  sessionChannelId: string,
  conversationChannel: ContactConversationChannelView,
): boolean {
  const normalizedSession = sessionChannelId.trim().toLowerCase();
  const normalizedChannel = conversationChannel.channel.trim().toLowerCase();
  const normalizedChannelId = conversationChannel.channelId.trim().toLowerCase();
  if (!normalizedChannelId) return false;
  return normalizedSession === normalizedChannelId
    || normalizedSession === `${normalizedChannel}:${normalizedChannelId}`;
}

function sessionMatchesIdentity(
  sessionChannelId: string,
  identity: ContactIdentityLinkView,
): boolean {
  const normalizedSession = sessionChannelId.trim().toLowerCase();
  const normalizedChannel = identity.channel.trim().toLowerCase();
  const normalizedUserId = identity.userId.trim().toLowerCase();
  if (!normalizedUserId) return false;

  if (normalizedSession === normalizedUserId) return true;
  if (normalizedSession === `${normalizedChannel}:${normalizedUserId}`) return true;
  return normalizedSession.startsWith(`${normalizedChannel}:`) && normalizedSession.endsWith(`:${normalizedUserId}`);
}

/**
 * Stable-attribution session→contact resolution for the fleet subject-bound
 * session projection (88u3). Unlike {@link getLinkedContactForSession}, this
 * MUST NOT consult the mutable last-entry-author heuristic: in a
 * multi-participant channel that heuristic attributes the session to whoever
 * posted last, which would let any participant claim the whole transcript by
 * posting a message. Authorization therefore only accepts:
 *
 * - a persisted conversation-channel binding, or an identity-link match — both
 *   stable, persisted attributions; and
 * - a journal with at most ONE distinct non-companion author identity. A
 *   session with two or more distinct author identities (rooms, group DMs) is
 *   unattributable to a single subject and resolves to undefined, fail closed.
 * - when the journal's sole author identity is resolvable for the channel
 *   type, it must belong to the matched contact's identity links (when any
 *   exist for that type): a persisted channel binding cannot claim another
 *   author's words.
 *
 * Display/decoration paths may keep the heuristic resolver; this one is for
 * authorization decisions.
 */
export function getStableLinkedContactForSession(options: {
  sessionId?: string;
  channelId: string;
  contacts: Contact[];
  sessionStore: SessionStore;
}): Contact | undefined {
  const { channelId, contacts, sessionStore } = options;
  if (contacts.length === 0) return undefined;

  let matched: Contact | undefined;
  for (const contact of contacts) {
    const stableMatch = getPersistedConversationChannels(contact)
      .some(entry => sessionMatchesConversationChannel(channelId, entry))
      || getContactIdentityLinks(contact)
        .some(identity => sessionMatchesIdentity(channelId, identity));
    if (!stableMatch) continue;
    if (matched && matched.id !== contact.id) {
      // Two different contacts hold stable bindings to the same channel:
      // ambiguous attribution, fail closed.
      return undefined;
    }
    matched = contact;
  }
  if (!matched) return undefined;

  // Multi-participant guard: scan the journal's non-companion author
  // identities. More than one distinct identity means the transcript contains
  // other subjects' words and is not visible to any single subject.
  const journalKey = options.sessionId ?? channelId;
  const authorIds = new Set<string>();
  for (const entry of sessionStore.getEntriesInRange(journalKey, 1, Number.MAX_SAFE_INTEGER)) {
    if (entry.role === 'assistant') continue;
    const authorId = entry.authorId?.trim().toLowerCase();
    if (authorId) authorIds.add(authorId);
    if (authorIds.size > 1) return undefined;
  }

  if (authorIds.size === 1) {
    const [soleAuthorId] = authorIds;
    const channelType = normalizeSessionChannelType(channelId);
    if (channelType !== 'session') {
      const typedIdentities = getContactIdentityLinks(matched)
        .filter(identity => identity.channel.trim().toLowerCase() === channelType);
      if (typedIdentities.length > 0
        && !typedIdentities.some(identity => identity.userId.trim().toLowerCase() === soleAuthorId)) {
        return undefined;
      }
    }
  }

  return matched;
}

export async function getLinkedContactForSession(options: {
  sessionId?: string;
  channelId: string;
  contacts: Contact[];
  sessionStore: SessionStore;
  contactStore?: ContactStorePort | null;
}): Promise<Contact | undefined> {
  const {
    channelId,
    contacts,
    sessionStore,
    contactStore,
  } = options;

  if (!contactStore || contacts.length === 0) return undefined;

  const channelType = normalizeSessionChannelType(channelId);
  const lastEntry = sessionStore.getLastEntry(options.sessionId ?? channelId);
  if (channelType !== 'session' && lastEntry?.authorId) {
    const contactByAuthor = await contactStore.getByChannelIdentity(channelType, lastEntry.authorId);
    if (contactByAuthor) return contactByAuthor;
  }

  for (const contact of contacts) {
    const persistedChannels = getPersistedConversationChannels(contact);
    if (persistedChannels.some(entry => sessionMatchesConversationChannel(channelId, entry))) {
      return contact;
    }

    const identities = getContactIdentityLinks(contact);
    if (identities.some(identity => sessionMatchesIdentity(channelId, identity))) {
      return contact;
    }
  }

  const parsed = splitSessionChannelId(channelId);
  if (channelType !== 'session') {
    const userIdHint = parsed.channelId.split(':').pop();
    if (userIdHint) {
      const contactByHint = await contactStore.getByChannelIdentity(channelType, userIdHint);
      if (contactByHint) return contactByHint;
    }
  }

  return undefined;
}

export function buildRelatedConversationChannelMap(options: {
  contacts: Contact[];
  sessionStore: SessionStore;
}): Map<string, ContactConversationChannelView[]> {
  const {
    contacts,
    sessionStore,
  } = options;
  const sessions = sessionStore.listChannels();
  const map = new Map<string, ContactConversationChannelView[]>();

  for (const contact of contacts) {
    const persistedChannels = getPersistedConversationChannels(contact);
    const identities = getContactIdentityLinks(contact);
    const relatedChannels: ContactConversationChannelView[] = [];
    const seen = new Set<string>();

    for (const entry of persistedChannels) {
      const key = `${entry.channel}:${entry.channelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relatedChannels.push(toConversationChannelView({
        channel: entry.channel,
        channelId: entry.channelId,
        lastSeen: entry.lastSeen,
        privacyLevel: entry.privacyLevel,
        contact,
        sessionStore,
      }));
    }

    for (const session of sessions) {
      if (!identities.some(identity => sessionMatchesIdentity(session.channelId, identity))) continue;

      const parsed = splitSessionChannelId(session.channelId);
      const key = `${parsed.channel}:${parsed.channelId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const lastEntry = sessionStore.getLastEntry(session.sessionId);
      relatedChannels.push(toConversationChannelView({
        channel: parsed.channel,
        channelId: parsed.channelId,
        lastSeen: lastEntry ? new Date(lastEntry.timestamp).toISOString() : undefined,
        privacyLevel: persistedChannels.find(entry => (
          entry.channel === parsed.channel && entry.channelId === parsed.channelId
        ))?.privacyLevel,
        contact,
        sessionStore,
      }));
    }

    if (relatedChannels.length === 0) {
      for (const identity of identities) {
        const key = `${identity.channel}:${identity.userId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const linkedChannel = getContactChannelLinks(contact).find(link => (
          link.channel === identity.channel && link.userId === identity.userId
        ));
        relatedChannels.push({
          channel: identity.channel,
          channelId: identity.userId,
          userId: identity.userId,
          privacyLevel: linkedChannel?.privacyLevel,
          lastSeen: identity.lastSeen ?? contact.lastSeen,
        });
      }
    }

    map.set(contact.id, relatedChannels);
  }

  return map;
}
