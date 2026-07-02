import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from './store.js';

const PRIMARY_USER_ID = 'discord-primary-123';

describe('ContactStore social graph', () => {
  let db: Database.Database;
  let store: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ContactStore(db, PRIMARY_USER_ID);
  });

  it('backfills a stable graph entity for contacts', () => {
    const contact = store.upsert({ displayName: 'Alice', discordUserId: 'alice-1' });

    const entity = store.getSocialGraphEntityByContactId(contact.id);
    expect(entity).toMatchObject({
      id: `contact:${contact.id}`,
      displayName: 'Alice',
      contactId: contact.id,
      entityKind: 'person',
      source: 'contact',
      sensitivity: 'personal',
    });
  });

  it('stores typed relationship edges with trust-gated visibility', () => {
    const alice = store.upsert({ displayName: 'Alice', discordUserId: 'alice-1' });
    const bob = store.upsert({ displayName: 'Bob', discordUserId: 'bob-1' });
    const charlie = store.upsert({ displayName: 'Charlie', discordUserId: 'charlie-1' });

    const aliceEntity = store.getSocialGraphEntityByContactId(alice.id)!;
    const bobEntity = store.getSocialGraphEntityByContactId(bob.id)!;
    const charlieEntity = store.getSocialGraphEntityByContactId(charlie.id)!;

    store.upsertSocialRelationshipEdge({
      sourceEntityId: aliceEntity.id,
      targetEntityId: bobEntity.id,
      relationshipType: 'friend',
      directional: false,
      sensitivity: 'public',
      provenanceRefs: ['memory:friendship'],
      evidenceMemoryIds: ['mem-friend-1'],
      confidence: 0.8,
    });
    store.upsertSocialRelationshipEdge({
      sourceEntityId: aliceEntity.id,
      targetEntityId: charlieEntity.id,
      relationshipType: 'family',
      directional: false,
      sensitivity: 'personal',
      provenanceRefs: ['memory:family'],
      evidenceMemoryIds: ['mem-family-1'],
      confidence: 0.9,
    });

    const publicVisible = store.listSocialRelationshipEdges({
      contactId: alice.id,
      viewerTrustLevel: 'public',
      viewerChannelPrivacy: 'private',
    });
    expect(publicVisible).toHaveLength(0);

    const regularVisible = store.listSocialRelationshipEdges({
      contactId: alice.id,
      viewerTrustLevel: 'regular',
      viewerChannelPrivacy: 'private',
    });
    expect(regularVisible).toHaveLength(2);

    const trustedVisible = store.listSocialRelationshipEdges({
      contactId: alice.id,
      viewerTrustLevel: 'trusted',
      viewerChannelPrivacy: 'private',
    });
    expect(trustedVisible).toHaveLength(2);
    expect(trustedVisible.map(edge => edge.relationshipType).sort()).toEqual(['family', 'friend']);
  });

  it('canonicalizes undirected edges and reuses the existing edge on upsert', () => {
    const alice = store.upsert({ displayName: 'Alice', discordUserId: 'alice-1' });
    const bob = store.upsert({ displayName: 'Bob', discordUserId: 'bob-1' });
    const aliceEntity = store.getSocialGraphEntityByContactId(alice.id)!;
    const bobEntity = store.getSocialGraphEntityByContactId(bob.id)!;

    const first = store.upsertSocialRelationshipEdge({
      sourceEntityId: aliceEntity.id,
      targetEntityId: bobEntity.id,
      relationshipType: 'friend',
      directional: false,
      confidence: 0.7,
      provenanceRefs: ['memory:first'],
    });
    const second = store.upsertSocialRelationshipEdge({
      sourceEntityId: bobEntity.id,
      targetEntityId: aliceEntity.id,
      relationshipType: 'friend',
      directional: false,
      confidence: 0.9,
      provenanceRefs: ['memory:second'],
      evidenceMemoryIds: ['mem-2'],
    });

    expect(second.id).toBe(first.id);
    expect(second.confidence).toBe(0.9);
    expect(second.provenanceRefs).toEqual(expect.arrayContaining(['memory:first', 'memory:second']));
    expect(second.evidenceMemoryIds).toEqual(['mem-2']);
  });

  it('merges graph entities and edges when contacts merge', () => {
    const source = store.upsert({ displayName: 'Source', discordUserId: 'source-1' });
    const target = store.upsert({ displayName: 'Target', discordUserId: 'target-1' });
    const third = store.upsert({ displayName: 'Third', discordUserId: 'third-1' });

    const sourceEntity = store.getSocialGraphEntityByContactId(source.id)!;
    const targetEntity = store.getSocialGraphEntityByContactId(target.id)!;
    const thirdEntity = store.getSocialGraphEntityByContactId(third.id)!;

    store.upsertSocialRelationshipEdge({
      sourceEntityId: sourceEntity.id,
      targetEntityId: thirdEntity.id,
      relationshipType: 'friend',
      directional: false,
      provenanceRefs: ['memory:source'],
      confidence: 0.6,
    });
    store.upsertSocialRelationshipEdge({
      sourceEntityId: targetEntity.id,
      targetEntityId: thirdEntity.id,
      relationshipType: 'friend',
      directional: false,
      provenanceRefs: ['memory:target'],
      confidence: 0.85,
    });

    expect(store.mergeContacts(source.id, target.id)).toBe(true);

    expect(store.getSocialGraphEntityByContactId(source.id)).toBeUndefined();
    const mergedEdges = store.listSocialRelationshipEdges({
      contactId: target.id,
      viewerTrustLevel: 'trusted',
      viewerChannelPrivacy: 'private',
    });
    expect(mergedEdges).toHaveLength(1);
    expect(mergedEdges[0]?.confidence).toBe(0.85);
    expect(mergedEdges[0]?.provenanceRefs).toEqual(expect.arrayContaining(['memory:source', 'memory:target']));

    const relatedContacts = store.listRelatedContacts(target.id, {
      viewerTrustLevel: 'trusted',
      viewerChannelPrivacy: 'private',
    });
    expect(relatedContacts.map(contact => contact.id)).toEqual([third.id]);
  });
});
