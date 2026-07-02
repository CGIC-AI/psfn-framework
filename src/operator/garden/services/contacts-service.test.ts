import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ContactStore } from '../../../core/contacts/store.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import { AdminContactsDataService } from './contacts-service.js';
import type { AdminContactRelationshipScoreReader } from './types.js';

function createServiceHarness(options?: {
  relationshipScoreReader?: AdminContactRelationshipScoreReader;
}) {
  const db = new Database(':memory:');
  const contactStore = new ContactStore(db);
  const sessionStore = {
    listChannels: () => [],
    getLastEntry: () => undefined,
  } as unknown as SessionStore;
  const profiles = new Map<string, {
    contactId: string;
    summary: string;
    sourceMemoryIds: string[];
    confidenceScore: number;
    noveltyScore: number;
    updatedAt: number;
  }>();
  const memoryStore = {
    listContactProfiles: () => [...profiles.values()],
    getContactProfile: (contactId: string) => profiles.get(contactId),
  } as unknown as MemoryStorePort;
  const service = new AdminContactsDataService({
    contactStore,
    memoryStore,
    sessionStore,
    relationshipScoreReader: options?.relationshipScoreReader,
  });
  return { db, contactStore, service, profiles };
}

describe('AdminContactsDataService', () => {
  it('deletes a persisted conversation channel from a contact', async () => {
    const { db, contactStore, service } = createServiceHarness();
    try {
      const contact = contactStore.upsert({ displayName: 'Primary User' });
      contactStore.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:test:stale-channel', 'invite_only');
      contactStore.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:test:active-channel', 'private');

      const result = await service.deleteConversationChannel(
        contact.id,
        JSON.stringify({
          channel: 'psfn-amica',
          channelId: 'psfn-amica:test:stale-channel',
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.contact?.conversationChannels).toEqual([
        expect.objectContaining({
          channel: 'psfn-amica',
          channelId: 'psfn-amica:test:active-channel',
        }),
      ]);
      expect(result.relatedChannels).toEqual([
        expect.objectContaining({
          channel: 'psfn-amica',
          channelId: 'psfn-amica:test:active-channel',
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('fails closed when the conversation channel is not on the contact', async () => {
    const { db, contactStore, service } = createServiceHarness();
    try {
      const contact = contactStore.upsert({ displayName: 'Primary User' });

      const result = await service.deleteConversationChannel(
        contact.id,
        JSON.stringify({
          channel: 'psfn-amica',
          channelId: 'psfn-amica:missing',
        }),
      );

      expect(result).toEqual({
        ok: false,
        message: 'Conversation channel not found on contact',
      });
    } finally {
      db.close();
    }
  });

  it('rejects invalid contact timezone updates without mutating the contact', async () => {
    const { db, contactStore, service } = createServiceHarness();
    try {
      const contact = contactStore.upsert({
        displayName: 'Timezone User',
        timezone: 'America/New_York',
      });

      const result = await service.updateContact(contact.id, JSON.stringify({
        timezone: 'Mars/Olympus',
      }));

      expect(result).toEqual({
        ok: false,
        message: 'Invalid timezone: Mars/Olympus. timezone must be a valid IANA timezone name',
      });
      expect(contactStore.getById(contact.id)?.timezone).toBe('America/New_York');
    } finally {
      db.close();
    }
  });

  it('accepts valid contact timezone updates and clears null timezone', async () => {
    const { db, contactStore, service } = createServiceHarness();
    try {
      const contact = contactStore.upsert({ displayName: 'Timezone User' });

      const updated = await service.updateContact(contact.id, JSON.stringify({
        timezone: 'America/Los_Angeles',
      }));

      expect(updated.ok).toBe(true);
      expect(updated.contact?.timezone).toBe('America/Los_Angeles');
      await expect(service.getContactDetail(contact.id)).resolves.toMatchObject({
        contact: expect.objectContaining({
          timezone: 'America/Los_Angeles',
        }),
      });

      const cleared = await service.updateContact(contact.id, JSON.stringify({
        timezone: null,
      }));

      expect(cleared.ok).toBe(true);
      expect(cleared.contact?.timezone).toBeUndefined();
      expect(contactStore.getById(contact.id)?.timezone).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('includes social graph inspector data for linked and mention-only contacts', async () => {
    const { db, contactStore, service, profiles } = createServiceHarness();
    try {
      const owner = contactStore.upsert({ displayName: 'Owner', trustLevel: 'trusted', relationshipType: 'friend' });
      const friend = contactStore.upsert({ displayName: 'Friend', trustLevel: 'trusted', relationshipType: 'friend' });
      const sibling = contactStore.upsert({ displayName: 'Sibling', relationshipType: 'family' });

      profiles.set(friend.id, {
        contactId: friend.id,
        summary: 'Shows up often in supportive contexts.',
        sourceMemoryIds: ['mem-friend-1'],
        confidenceScore: 0.81,
        noveltyScore: 0.4,
        updatedAt: 1_740_000_000_000,
      });

      contactStore.linkChannelIdentity(friend.id, 'discord', 'friend-user', { privacyLevel: 'private' });

      const ownerEntity = contactStore.getSocialGraphEntityByContactId(owner.id)!;
      const friendEntity = contactStore.getSocialGraphEntityByContactId(friend.id)!;
      const siblingEntity = contactStore.getSocialGraphEntityByContactId(sibling.id)!;

      contactStore.upsertSocialRelationshipEdge({
        sourceEntityId: ownerEntity.id,
        targetEntityId: friendEntity.id,
        relationshipType: 'friend',
        directional: false,
        sensitivity: 'personal',
        provenanceRefs: ['memory:friendship'],
        evidenceMemoryIds: ['mem-friend-1'],
        confidence: 0.91,
      });
      contactStore.upsertSocialRelationshipEdge({
        sourceEntityId: siblingEntity.id,
        targetEntityId: ownerEntity.id,
        relationshipType: 'sibling',
        directional: true,
        sensitivity: 'private',
        provenanceRefs: ['memory:family'],
        evidenceMemoryIds: ['mem-family-1'],
        confidence: 0.78,
      });

      const result = await service.listContacts();
      const graph = result.socialGraphMap.get(owner.id);

      expect(graph?.entity).toMatchObject({
        id: ownerEntity.id,
        displayName: 'Owner',
        source: 'contact',
      });
      expect(graph?.edgeCount).toBe(2);
      expect(graph?.neighborCount).toBe(2);
      expect(graph?.evidenceCount).toBe(2);
      expect(graph?.mentionOnlyNeighborCount).toBe(1);
      expect(graph?.connections).toEqual(expect.arrayContaining([
        expect.objectContaining({
          relationshipType: 'friend',
          direction: 'undirected',
          evidenceMemoryIds: ['mem-friend-1'],
          neighbor: expect.objectContaining({
            contactId: friend.id,
            mentionOnly: false,
            trustLevel: 'trusted',
            profileSummary: 'Shows up often in supportive contexts.',
          }),
        }),
        expect.objectContaining({
          relationshipType: 'sibling',
          // E4.3: sibling is a SYMMETRIC kind — a directional write is
          // normalized to one undirected canonical row.
          direction: 'undirected',
          neighbor: expect.objectContaining({
            contactId: sibling.id,
            mentionOnly: true,
            relationshipType: 'family',
          }),
        }),
      ]));
    } finally {
      db.close();
    }
  });

  it('includes dynamic relationship score display data when a reader is available', async () => {
    let requestedContactIds: readonly string[] = [];
    const { db, contactStore, service } = createServiceHarness({
      relationshipScoreReader: {
        async listContactRelationshipScores(contactIds) {
          requestedContactIds = contactIds;
          return new Map(contactIds.map(contactId => [contactId, {
            score: 42.5,
            resolvedTier: 'acquaintance',
            previousTierThreshold: 20,
            nextTier: 'friend',
            nextTierThreshold: 60,
            progressToNextTier: 0.5625,
            updatedAt: '2026-06-29T16:45:00.000Z',
          }]));
        },
      },
    });
    try {
      const contact = contactStore.upsert({ displayName: 'Score Contact', relationshipType: 'acquaintance' });

      const result = await service.listContacts();

      expect(requestedContactIds).toEqual([contact.id]);
      expect(result.relationshipScoreMap?.get(contact.id)).toEqual({
        score: 42.5,
        resolvedTier: 'acquaintance',
        previousTierThreshold: 20,
        nextTier: 'friend',
        nextTierThreshold: 60,
        progressToNextTier: 0.5625,
        updatedAt: '2026-06-29T16:45:00.000Z',
      });
    } finally {
      db.close();
    }
  });
});
