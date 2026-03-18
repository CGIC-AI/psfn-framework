import { describe, expect, it } from 'vitest';
import type { Contact } from '../../../contacts/types.js';
import type { SessionStore } from '../../../session/store.js';
import { buildRelatedConversationChannelMap } from './contact-session-linker.js';

function createSessionStoreStub(options: {
  channels?: Array<{ channelId: string }>;
  entries?: Record<string, { authorId?: string; timestamp: number }>;
}): SessionStore {
  return {
    listChannels: () => options.channels ?? [],
    getLastEntry: (channelId: string) => options.entries?.[channelId],
  } as unknown as SessionStore;
}

function createContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    displayName: 'Contact',
    trustLevel: 'regular',
    relationshipType: 'friend',
    firstSeen: '2026-03-18T00:00:00.000Z',
    lastSeen: '2026-03-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildRelatedConversationChannelMap', () => {
  it('enriches persisted conversation channels with linked identity privacy', () => {
    const contact = createContact({
      channels: [{
        channel: 'discord',
        userId: '388908766306893854',
        privacyLevel: 'private',
      }],
      conversationChannels: [{
        channel: 'discord',
        channelId: '1313001762793197678',
        firstSeen: '2026-03-18T00:00:00.000Z',
        lastSeen: '2026-03-18T06:00:00.000Z',
      }],
    });
    const sessionStore = createSessionStoreStub({});

    const relatedChannels = buildRelatedConversationChannelMap({
      contacts: [contact],
      sessionStore,
    }).get(contact.id);

    expect(relatedChannels).toEqual([{
      channel: 'discord',
      channelId: '1313001762793197678',
      userId: '388908766306893854',
      privacyLevel: 'private',
      lastSeen: '2026-03-18T06:00:00.000Z',
    }]);
  });

  it('uses the latest session author to disambiguate same-channel identities', () => {
    const contact = createContact({
      channels: [
        {
          channel: 'discord',
          userId: 'user-a',
          privacyLevel: 'semi_private',
        },
        {
          channel: 'discord',
          userId: 'user-b',
          privacyLevel: 'private',
        },
      ],
      conversationChannels: [{
        channel: 'discord',
        channelId: '1313001762793197678',
        firstSeen: '2026-03-18T00:00:00.000Z',
        lastSeen: '2026-03-18T06:00:00.000Z',
      }],
    });
    const sessionStore = createSessionStoreStub({
      entries: {
        '1313001762793197678': {
          authorId: 'user-b',
          timestamp: Date.parse('2026-03-18T06:00:00.000Z'),
        },
      },
    });

    const relatedChannels = buildRelatedConversationChannelMap({
      contacts: [contact],
      sessionStore,
    }).get(contact.id);

    expect(relatedChannels).toEqual([{
      channel: 'discord',
      channelId: '1313001762793197678',
      userId: 'user-b',
      privacyLevel: 'private',
      lastSeen: '2026-03-18T06:00:00.000Z',
    }]);
  });
});
