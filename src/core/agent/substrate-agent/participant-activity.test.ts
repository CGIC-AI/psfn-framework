import { describe, expect, it, vi } from 'vitest';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { Contact } from '../../contacts/types.js';
import { createGroupConversationScope } from '../../session/conversation-scope.js';
import { resolveParticipantActivityProfilesForTurn } from './participant-activity.js';

function message(): SubstrateMessage {
  return {
    id: 'message-1',
    channelId: 'discord-room-1',
    channelType: 'discord',
    authorId: 'discord-alice',
    authorName: 'Alice',
    content: 'hello room',
    timestamp: new Date('2026-07-01T12:00:00.000Z'),
    isDirectMessage: false,
  };
}

function contact(overrides: Partial<Contact>): Contact {
  return {
    id: 'contact-alice',
    displayName: 'Alice',
    trustLevel: 'trusted',
    relationshipType: 'friend',
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveParticipantActivityProfilesForTurn', () => {
  it('projects only a human contact timestamp for the bounded group roster', async () => {
    const alice = contact({ timezone: 'America/Chicago' });
    const peer = contact({
      id: 'contact-peer',
      displayName: 'Peer',
      isMachineIntelligence: true,
      relationshipType: 'ai_companion',
    });
    const contacts = new Map([
      ['discord-alice', alice],
      ['discord-peer', peer],
    ]);
    const getByChannelIdentity = vi.fn(async (_channel: string, authorId: string) => contacts.get(authorId));
    const getPrivateRelationshipActivity = vi.fn((contactId: string) => (
      contactId === alice.id ? { lastDirectInteractionAtMs: 1_751_370_300_000 } : null
    ));

    const profiles = await resolveParticipantActivityProfilesForTurn({
      message: message(),
      conversationScope: createGroupConversationScope({
        channelId: 'discord-room-1',
        recentSpeakers: [
          { authorId: 'discord-peer', name: 'Peer' },
          { authorId: 'discord-unknown', name: 'Unknown' },
        ],
      }),
      contactStore: { getByChannelIdentity } as unknown as ContactStorePort,
      activityReader: { getPrivateRelationshipActivity },
    });

    expect(profiles).toEqual([{
      user_id: 'discord-alice',
      display_name: 'Alice',
      timezone: 'America/Chicago',
      lastDirectInteractionAtMs: 1_751_370_300_000,
    }]);
    expect(getPrivateRelationshipActivity).toHaveBeenCalledTimes(1);
    expect(getPrivateRelationshipActivity).toHaveBeenCalledWith(alice.id);
  });

  it('prioritizes the current author when the stored roster is already full', async () => {
    const alice = contact({});
    const getByChannelIdentity = vi.fn(async (_channel: string, authorId: string) => (
      authorId === 'discord-alice' ? alice : undefined
    ));

    const profiles = await resolveParticipantActivityProfilesForTurn({
      message: message(),
      conversationScope: createGroupConversationScope({
        channelId: 'discord-room-1',
        recentSpeakers: Array.from({ length: 5 }, (_, index) => ({
          authorId: `discord-old-${index}`,
          name: `Old ${index}`,
        })),
      }),
      contactStore: { getByChannelIdentity } as unknown as ContactStorePort,
      activityReader: {
        getPrivateRelationshipActivity: vi.fn(() => ({
          lastDirectInteractionAtMs: 1_751_370_300_000,
        })),
      },
    });

    expect(profiles).toEqual([expect.objectContaining({ user_id: 'discord-alice' })]);
    expect(getByChannelIdentity).toHaveBeenCalledTimes(5);
  });

  it('fails closed to no profile when participant identity lookup throws', async () => {
    const profiles = await resolveParticipantActivityProfilesForTurn({
      message: message(),
      conversationScope: createGroupConversationScope({
        channelId: 'discord-room-1',
        recentSpeakers: [{ authorId: 'discord-alice', name: 'Alice' }],
      }),
      contactStore: {
        getByChannelIdentity: vi.fn(async () => { throw new Error('lookup failed'); }),
      } as unknown as ContactStorePort,
      activityReader: { getPrivateRelationshipActivity: vi.fn() },
    });

    expect(profiles).toEqual([]);
  });
});
