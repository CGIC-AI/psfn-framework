import { describe, expect, it } from 'vitest';
import type { Contact } from '../../../contacts/types.js';
import type { SessionStore } from '../../../session/store.js';
import { buildRelatedConversationChannelMap } from './contact-session-linker.js';

function createSessionStoreStub(options: {
  channels?: Array<{ sessionId?: string; channelId: string }>;
  entries?: Record<string, { authorId?: string; timestamp: number }>;
}): SessionStore {
  return {
    listChannels: () => (options.channels ?? []).map(channel => ({
      sessionId: channel.sessionId ?? channel.channelId,
      channelId: channel.channelId,
      messageCount: 0,
    })),
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

  it('prefers explicit persisted conversation-channel privacy over linked identity privacy', () => {
    const contact = createContact({
      channels: [{
        channel: 'discord',
        userId: '388908766306893854',
        privacyLevel: 'private',
      }],
      conversationChannels: [{
        channel: 'discord',
        channelId: '1313001762793197678',
        privacyLevel: 'public',
        firstSeen: '2026-03-18T00:00:00.000Z',
        lastSeen: '2026-03-18T06:00:00.000Z',
      }],
    });

    const relatedChannels = buildRelatedConversationChannelMap({
      contacts: [contact],
      sessionStore: createSessionStoreStub({}),
    }).get(contact.id);

    expect(relatedChannels).toEqual([{
      channel: 'discord',
      channelId: '1313001762793197678',
      userId: '388908766306893854',
      privacyLevel: 'public',
      lastSeen: '2026-03-18T06:00:00.000Z',
    }]);
  });

  it('keeps derived session matches alongside persisted conversation channels', () => {
    const contact = createContact({
      channels: [{
        channel: 'discord',
        userId: 'user-b',
        privacyLevel: 'private',
      }],
      conversationChannels: [{
        channel: 'discord',
        channelId: '1313001762793197678',
        privacyLevel: 'private',
        firstSeen: '2026-03-18T00:00:00.000Z',
        lastSeen: '2026-03-18T06:00:00.000Z',
      }],
    });
    const sessionStore = createSessionStoreStub({
      channels: [
        { channelId: '1313001762793197678' },
        { channelId: 'discord:other-thread:user-b' },
      ],
      entries: {
        'discord:other-thread:user-b': {
          authorId: 'user-b',
          timestamp: Date.parse('2026-03-18T07:00:00.000Z'),
        },
      },
    });

    const relatedChannels = buildRelatedConversationChannelMap({
      contacts: [contact],
      sessionStore,
    }).get(contact.id);

    expect(relatedChannels).toEqual([
      {
        channel: 'discord',
        channelId: '1313001762793197678',
        userId: 'user-b',
        privacyLevel: 'private',
        lastSeen: '2026-03-18T06:00:00.000Z',
      },
      {
        channel: 'discord',
        channelId: 'other-thread:user-b',
        userId: 'user-b',
        privacyLevel: 'private',
        lastSeen: '2026-03-18T07:00:00.000Z',
      },
    ]);
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
