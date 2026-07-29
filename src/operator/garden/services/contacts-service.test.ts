import { describe, expect, it } from 'vitest';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import { AdminContactsDataService } from './contacts-service.js';
import type { AdminContactRelationshipScoreReader } from './types.js';
import { createContactRelationshipScoreReader } from '../../../core/contacts/trust-drift-signals.js';
import type { EmotionalTimeSeriesPoint } from '../../../core/contacts/store/emotional-baseline.js';
import { createTestPostgresContactStore } from '../../../test-support/postgres-contact-store.js';
import type { GardenRequestContext } from '../garden-request-context.js';

function fleetContext(contactId: string): GardenRequestContext {
  return {
    kind: 'fleet_principal',
    actor: { principalId: `principal-${contactId}`, contactId },
  } as unknown as GardenRequestContext;
}

async function createServiceHarness(options?: {
  relationshipScoreReader?: AdminContactRelationshipScoreReader;
}) {
  const { store: contactStore } = await createTestPostgresContactStore();
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
  return { contactStore, service, profiles, memoryStore, sessionStore };
}

describe('AdminContactsDataService', () => {
  it('does not expose another contact through fleet list projections', async () => {
    const { contactStore, service, profiles } = await createServiceHarness();
    const current = await contactStore.upsert({ displayName: 'Current Contact' });
    const other = await contactStore.upsert({ displayName: 'Other Contact' });
    for (const contact of [current, other]) {
      profiles.set(contact.id, {
        contactId: contact.id,
        summary: `profile-${contact.id}`,
        sourceMemoryIds: [],
        confidenceScore: 1,
        noveltyScore: 0,
        updatedAt: 1,
      });
    }

    const result = await service.listContacts(undefined, fleetContext(current.id));

    expect(result.contacts.map(contact => contact.id)).toEqual([current.id]);
    expect([...result.profileMap.keys()]).toEqual([current.id]);
    expect(result.socialGraphMap.size).toBe(0);
    expect(result.verifications).toEqual([]);
    expect(result.mutationAudits).toEqual([]);
  });

  it('surfaces archivedAt on the contact list and detail after archiving (klbgi)', async () => {
    const { contactStore, service } = await createServiceHarness();
    const live = await contactStore.upsert({ displayName: 'Still Here' });
    const gone = await contactStore.upsert({ displayName: 'Archived One' });
    expect(await contactStore.archiveContact(gone.id, 'operator:test')).toBe(true);

    // The admin list response must carry archivedAt so the UI can gray out and
    // filter archived contacts (bead psfn-framework-klbgi).
    const list = await service.listContacts();
    const archivedRow = list.contacts.find(contact => contact.id === gone.id);
    const liveRow = list.contacts.find(contact => contact.id === live.id);
    expect(archivedRow?.archivedAt).toBeTruthy();
    expect(liveRow?.archivedAt).toBeUndefined();

    // The detail response carries it too.
    const detail = await service.getContactDetail(gone.id);
    expect(detail?.contact.archivedAt).toBeTruthy();
  });

  it('returns a fleet profile only on the exact current-subject detail', async () => {
    const { contactStore, service, profiles } = await createServiceHarness();
    const current = await contactStore.upsert({ displayName: 'Current Contact' });
    const other = await contactStore.upsert({ displayName: 'Other Contact' });
    for (const contact of [current, other]) {
      profiles.set(contact.id, {
        contactId: contact.id,
        summary: `profile-${contact.id}`,
        sourceMemoryIds: [],
        confidenceScore: 1,
        noveltyScore: 0,
        updatedAt: 1,
      });
    }

    await expect(service.getContactDetail(current.id, fleetContext(current.id)))
      .resolves.toMatchObject({ profile: { contactId: current.id } });
    await expect(service.getContactDetail(other.id, fleetContext(current.id)))
      .resolves.toBeNull();
  });

  it('deletes a persisted conversation channel from a contact', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Primary User' });
    await contactStore.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:test:stale-channel', 'invite_only');
    await contactStore.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:test:active-channel', 'private');

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
  });

  it('fails closed when the conversation channel is not on the contact', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Primary User' });

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
  });

  it('rejects invalid contact timezone updates without mutating the contact', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({
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
    expect((await contactStore.getById(contact.id))?.timezone).toBe('America/New_York');
  });

  it('accepts valid contact timezone updates and clears null timezone', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Timezone User' });

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
    expect((await contactStore.getById(contact.id))?.timezone).toBeUndefined();
  });

  it('applies channel-bonding opt-in updates per linked identity', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Bonded Partner' });
    await contactStore.linkChannelIdentity(contact.id, 'discord', 'bond-user', { privacyLevel: 'private' });

    const bondedResult = await service.updateContact(contact.id, JSON.stringify({
      channelBonding: [{ channel: 'discord', userId: 'bond-user', bonded: true }],
    }));
    expect(bondedResult.ok).toBe(true);
    expect(bondedResult.contact?.channels?.find(link => link.userId === 'bond-user')?.bonded).toBe(true);

    const unbondedResult = await service.updateContact(contact.id, JSON.stringify({
      channelBonding: [{ channel: 'discord', userId: 'bond-user', bonded: false }],
    }));
    expect(unbondedResult.ok).toBe(true);
    expect(unbondedResult.contact?.channels?.find(link => link.userId === 'bond-user')?.bonded).not.toBe(true);
  });

  it('rejects channel-bonding updates for unknown identities and malformed payloads', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Bonded Partner' });

    await expect(service.updateContact(contact.id, JSON.stringify({
      channelBonding: [{ channel: 'discord', userId: 'never-linked', bonded: true }],
    }))).resolves.toEqual({ ok: false, message: 'Unable to update bonding for discord:never-linked' });

    await expect(service.updateContact(contact.id, JSON.stringify({
      channelBonding: [{ channel: 'discord', userId: '', bonded: true }],
    }))).resolves.toEqual({ ok: false, message: 'channelBonding entries require channel and userId' });

    await expect(service.updateContact(contact.id, JSON.stringify({
      channelBonding: [{ channel: 'discord', userId: 'x', bonded: 'yes' }],
    }))).resolves.toEqual({ ok: false, message: 'channelBonding.bonded must be a boolean' });
  });

  it('includes social graph inspector data for linked and mention-only contacts', async () => {
    const { contactStore, service, profiles } = await createServiceHarness();
    const owner = await contactStore.upsert({ displayName: 'Owner', trustLevel: 'trusted', relationshipType: 'friend' });
    const friend = await contactStore.upsert({ displayName: 'Friend', trustLevel: 'trusted', relationshipType: 'friend' });
    const sibling = await contactStore.upsert(
      { displayName: 'Sibling', relationshipType: 'family' },
      { actor: 'operator:test-setup' },
    );

    profiles.set(friend.id, {
      contactId: friend.id,
      summary: 'Shows up often in supportive contexts.',
      sourceMemoryIds: ['mem-friend-1'],
      confidenceScore: 0.81,
      noveltyScore: 0.4,
      updatedAt: 1_740_000_000_000,
    });

    await contactStore.linkChannelIdentity(friend.id, 'discord', 'friend-user', { privacyLevel: 'private' });

    const ownerEntity = await contactStore.getSocialGraphEntityByContactId(owner.id);
    const friendEntity = await contactStore.getSocialGraphEntityByContactId(friend.id);
    const siblingEntity = await contactStore.getSocialGraphEntityByContactId(sibling.id);
    if (!ownerEntity || !friendEntity || !siblingEntity) {
      throw new Error('Postgres contact fixture did not create social graph entities');
    }

    await contactStore.upsertSocialRelationshipEdge({
      sourceEntityId: ownerEntity.id,
      targetEntityId: friendEntity.id,
      relationshipType: 'friend',
      directional: false,
      sensitivity: 'personal',
      provenanceRefs: ['memory:friendship'],
      evidenceMemoryIds: ['mem-friend-1'],
      confidence: 0.91,
    });
    await contactStore.upsertSocialRelationshipEdge({
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
  });

  it('includes dynamic relationship score display data when a reader is available', async () => {
    let requestedContactIds: readonly string[] = [];
    const { contactStore, service } = await createServiceHarness({
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
    const contact = await contactStore.upsert({ displayName: 'Score Contact', relationshipType: 'acquaintance' });

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
  });

  it('populates relationshipScoreMap from the production score reader (kada.4)', async () => {
    const { contactStore, memoryStore, sessionStore } = await createServiceHarness();
    // A public contact that has cleared every autonomous public→regular drift
    // component: 3 positive valence points above threshold, no negatives, and
    // one verified identity link. This must surface progressToNextTier === 1.
    const contact = await contactStore.upsert({ displayName: 'Score Contact', trustLevel: 'public' });
    const positivePoints: EmotionalTimeSeriesPoint[] = [
      { valence: 0.5, confidence: 0.5, observedAtMs: 1 },
      { valence: 0.4, confidence: 0.6, observedAtMs: 2 },
      { valence: 0.6, confidence: 0.7, observedAtMs: 3 },
    ];
    // Production reader over a fake read store exposing exactly the three
    // methods createContactRelationshipScoreReader depends on.
    const reader = createContactRelationshipScoreReader({
      getById: id => contactStore.getById(id),
      getEmotionalTimeSeries: id => (id === contact.id ? positivePoints : []),
      countVerifiedIdentityLinks: id => (id === contact.id ? 1 : 0),
    });
    const service = new AdminContactsDataService({
      contactStore,
      memoryStore,
      sessionStore,
      relationshipScoreReader: reader,
    });

    const result = await service.listContacts();
    const score = result.relationshipScoreMap?.get(contact.id);

    expect(score).toBeDefined();
    expect(score?.resolvedTier).toBe('public');
    expect(score?.nextTier).toBe('regular');
    expect(score?.progressToNextTier).toBe(1);
  });
});
