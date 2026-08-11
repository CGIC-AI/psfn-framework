import { describe, it, expect, beforeEach } from 'vitest';
import type { ContactStorePort } from './contact-store-port.js';
import { createTestPostgresContactStore } from '../../test-support/postgres-contact-store.js';
import type { FakePostgresPool } from '../../test-support/fake-postgres-contact-pool.js';

const PRIMARY_USER_ID = 'discord-primary-123';

describe('Postgres contact store behavior', () => {
  let pool: FakePostgresPool;
  let store: ContactStorePort;

  beforeEach(async () => {
    ({ pool, store } = await createTestPostgresContactStore(PRIMARY_USER_ID));
  });

  describe('upsert', () => {
    it('rejects autonomous creation at approval-gated relationship classifications', async () => {
      await expect(store.upsert(
        { displayName: 'Autonomous Family', relationshipType: 'family' },
        { actor: 'agent:tool:test' },
      )).rejects.toThrow(/relationship assignment denied/);
      await expect(store.upsert(
        { displayName: 'Extracted Partner', relationshipType: 'partner' },
        { actor: 'system:memory_extraction:mention_contact' },
      )).rejects.toThrow(/relationship assignment denied/);
    });

    it('creates new contact with generated UUID', async () => {
      const contact = await store.upsert({ displayName: 'Alice' });
      expect(contact.id).toBeDefined();
      expect(contact.id.length).toBeGreaterThan(0);
      expect(contact.displayName).toBe('Alice');
      expect(contact.trustLevel).toBe('regular');
      expect(contact.relationshipType).toBe('stranger');
      expect(contact.firstSeen).toBeDefined();
      expect(contact.lastSeen).toBeDefined();
    });

    it('updates existing contact by discordUserId', async () => {
      const c1 = await store.upsert({
        displayName: 'Bob',
        discordUserId: 'discord-bob',
        trustLevel: 'regular',
      });
      const c2 = await store.upsert({
        displayName: 'Robert',
        discordUserId: 'discord-bob',
        trustLevel: 'trusted',
      });

      // Same internal ID
      expect(c2.id).toBe(c1.id);
      // Updated fields
      expect(c2.displayName).toBe('Robert');
      expect(c2.trustLevel).toBe('trusted');
      // firstSeen should not change
      expect(c2.firstSeen).toBe(c1.firstSeen);
    });

    it('forces primary trust for primaryUserId', async () => {
      const contact = await store.upsert({
        displayName: 'Morgan',
        discordUserId: PRIMARY_USER_ID,
        trustLevel: 'regular',  // Should be overridden
      });
      expect(contact.trustLevel).toBe('primary');
      expect(contact.relationshipType).toBe('stranger');
    });

    it('keeps primary trust independent from relationship on an unrelated upsert', async () => {
      const contact = await store.upsert({
        displayName: 'Primary Relationship',
        discordUserId: PRIMARY_USER_ID,
        relationshipType: 'acquaintance',
      });

      const updated = await store.upsert({
        id: contact.id,
        displayName: 'Primary Relationship Renamed',
      });

      expect(updated.trustLevel).toBe('primary');
      expect(updated.relationshipType).toBe('acquaintance');
    });

    it('forces primary trust when updating existing primary user', async () => {
      await store.upsert({ displayName: 'Morgan', discordUserId: PRIMARY_USER_ID });
      const updated = await store.upsert({
        displayName: 'Morgan Updated',
        discordUserId: PRIMARY_USER_ID,
        trustLevel: 'public',  // Should be overridden
      });
      expect(updated.trustLevel).toBe('primary');
    });

    it('rejects unauthorized primary trust assignment via upsert and audits denial', async () => {
      const contact = await store.upsert({
        displayName: 'Mallory',
        discordUserId: 'discord-mallory',
        trustLevel: 'trusted',
      });

      await expect(store.upsert({
        id: contact.id,
        displayName: 'Mallory',
        trustLevel: 'primary',
      })).rejects.toThrow(/Primary trust assignment denied/);

      const unchanged = await store.getById(contact.id);
      expect(unchanged?.trustLevel).toBe('trusted');

      const entries = await store.listMutationAuditEntries({
        contactId: contact.id,
        field: 'trust_level',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        contactId: contact.id,
        field: 'trust_level',
        oldValue: 'trusted',
        newValue: 'primary',
      });
      expect(entries[0].actor).toContain('primary_denied');
    });

    it('audits allowed owner-mapped upsert primary assignment', async () => {
      const contact = await store.upsert({
        displayName: 'Morgan',
        discordUserId: PRIMARY_USER_ID,
        trustLevel: 'regular',
      });
      expect(contact.trustLevel).toBe('primary');

      const entries = await store.listMutationAuditEntries({
        contactId: contact.id,
        field: 'trust_level',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        contactId: contact.id,
        field: 'trust_level',
        oldValue: null,
        newValue: 'primary',
      });
      expect(entries[0].actor).toContain('primary_allowed');
    });

    it('preserves existing fields when partial update', async () => {
      await store.upsert({
        displayName: 'Carol',
        discordUserId: 'discord-carol',
        notes: 'Old notes',
        emotionalBaseline: { warmth: 0.5 },
      });
      const updated = await store.upsert({
        displayName: 'Carol Updated',
        discordUserId: 'discord-carol',
      });
      expect(updated.notes).toBe('Old notes');
      expect(updated.emotionalBaseline).toEqual({ warmth: 0.5 });
    });

    it('does not overwrite a relationship changed while an unrelated upsert is in flight', async () => {
      const contact = await store.upsert({ displayName: 'Concurrent Profile', relationshipType: 'friend' });
      pool.beforeNextContactProfileUpdate = (row) => {
        row.relationship_type = 'family';
      };

      const updated = await store.upsert({
        id: contact.id,
        displayName: 'Concurrent Profile Renamed',
      });

      expect(updated.displayName).toBe('Concurrent Profile Renamed');
      expect(updated.relationshipType).toBe('family');
    });

    it('audits an operator-authorized relationship assignment through upsert', async () => {
      const contact = await store.upsert({ displayName: 'Upsert Relationship Audit', relationshipType: 'friend' });
      const updated = await store.upsert({
        id: contact.id,
        displayName: contact.displayName,
        relationshipType: 'family',
      }, { actor: 'operator:test' });

      expect(updated.relationshipType).toBe('family');
      expect(await store.listMutationAuditEntries({ contactId: contact.id, field: 'relationship_type' }))
        .toEqual([expect.objectContaining({
          actor: 'operator:test',
          oldValue: 'friend',
          newValue: 'family',
        })]);
    });

    it('persists, hydrates, preserves, updates, and clears optional timezone', async () => {
      const created = await store.upsert({
        displayName: 'Timezone Contact',
        discordUserId: 'timezone-contact',
        timezone: '  America/Los_Angeles  ',
      });
      expect(created.timezone).toBe('America/Los_Angeles');
      expect((await store.getById(created.id))?.timezone).toBe('America/Los_Angeles');

      const unrelatedUpdate = await store.upsert({
        displayName: 'Timezone Contact Renamed',
        discordUserId: 'timezone-contact',
      });
      expect(unrelatedUpdate.timezone).toBe('America/Los_Angeles');

      const changed = await store.upsert({
        displayName: 'Timezone Contact Renamed',
        discordUserId: 'timezone-contact',
        timezone: 'Europe/London',
      }, { actor: 'admin:api' });
      expect(changed.timezone).toBe('Europe/London');

      const cleared = await store.upsert({
        displayName: 'Timezone Contact Renamed',
        discordUserId: 'timezone-contact',
        timezone: undefined,
      }, { actor: 'admin:api' });
      expect(cleared.timezone).toBeUndefined();

      const entries = await store.listMutationAuditEntries({
        contactId: created.id,
        field: 'timezone',
        limit: 10,
      });
      expect(entries).toEqual([
        expect.objectContaining({
          actor: 'admin:api',
          field: 'timezone',
          oldValue: 'Europe/London',
          newValue: null,
        }),
        expect.objectContaining({
          actor: 'admin:api',
          field: 'timezone',
          oldValue: 'America/Los_Angeles',
          newValue: 'Europe/London',
        }),
      ]);
    });

    it('persists, hydrates, and audits demographic fields with operator provenance (bead fnyb)', async () => {
      const created = await store.upsert({ displayName: 'Demographics Contact' });
      expect(created.gender).toBeUndefined();
      expect(created.pronouns).toBeUndefined();
      expect(created.age).toBeUndefined();

      expect(await store.updateDemographics(
        created.id,
        { gender: '  woman  ', pronouns: 'she/her', age: 29 },
        'operator:test',
      )).toBe(true);

      const hydrated = await store.getById(created.id);
      expect(hydrated?.gender).toBe('woman');
      expect(hydrated?.pronouns).toBe('she/her');
      expect(hydrated?.age).toBe(29);

      // Per-field audit rows carry the specified-provenance actor.
      for (const field of ['gender', 'pronouns', 'age'] as const) {
        expect(await store.listMutationAuditEntries({ contactId: created.id, field }))
          .toEqual([expect.objectContaining({ actor: 'operator:test', field })]);
      }

      // Absent keys leave values unchanged; a null clears a field.
      expect(await store.updateDemographics(created.id, { age: null }, 'operator:test')).toBe(true);
      const afterClear = await store.getById(created.id);
      expect(afterClear?.age).toBeUndefined();
      expect(afterClear?.gender).toBe('woman');
      expect(afterClear?.pronouns).toBe('she/her');

      // A no-op update writes no new audit rows.
      expect(await store.updateDemographics(created.id, { gender: 'woman' }, 'operator:test')).toBe(true);
      expect(await store.listMutationAuditEntries({ contactId: created.id, field: 'gender' }))
        .toHaveLength(1);
    });

  });

  describe('getById', () => {
    it('returns contact when found', async () => {
      const created = await store.upsert({ displayName: 'Dave' });
      const found = await store.getById(created.id);
      expect(found).toBeDefined();
      expect(found!.displayName).toBe('Dave');
    });

    it('returns undefined when not found', async () => {
      expect(await store.getById('nonexistent')).toBeUndefined();
    });
  });

  describe('getByDiscordUserId', () => {
    it('returns contact when found', async () => {
      await store.upsert({ displayName: 'Eve', discordUserId: 'discord-eve' });
      const found = await store.getByDiscordUserId('discord-eve');
      expect(found).toBeDefined();
      expect(found!.displayName).toBe('Eve');
    });

    it('returns undefined when not found', async () => {
      expect(await store.getByDiscordUserId('nonexistent')).toBeUndefined();
    });
  });

  describe('getByChannelIdentity', () => {
    it('returns contact when identity mapping exists', async () => {
      const contact = await store.upsert({
        displayName: 'Cross',
        channelIdentities: [{ channel: 'api', userId: 'cross-api-1' }],
      });

      const found = await store.getByChannelIdentity('api', 'cross-api-1');
      expect(found?.id).toBe(contact.id);
      expect(found?.displayName).toBe('Cross');
    });

    it('falls back to legacy discord_user_id rows', async () => {
      const contact = await store.upsert({ displayName: 'Legacy', discordUserId: 'legacy-discord' });

      const found = await store.getByChannelIdentity('discord', 'legacy-discord');
      expect(found?.id).toBe(contact.id);
      expect(found?.discordUserId).toBe('legacy-discord');
    });
  });

  describe('getByTrustLevel', () => {
    it('filters contacts correctly', async () => {
      await store.upsert({ displayName: 'Trusted1', trustLevel: 'trusted', discordUserId: 't1' });
      await store.upsert({ displayName: 'Trusted2', trustLevel: 'trusted', discordUserId: 't2' });
      await store.upsert({ displayName: 'Regular1', trustLevel: 'regular', discordUserId: 'r1' });

      const trusted = await store.getByTrustLevel('trusted');
      expect(trusted).toHaveLength(2);
      expect(trusted.map(c => c.displayName).sort()).toEqual(['Trusted1', 'Trusted2']);

      const regular = await store.getByTrustLevel('regular');
      expect(regular).toHaveLength(1);
      expect(regular[0].displayName).toBe('Regular1');
    });

    it('returns empty array when no contacts at level', async () => {
      expect(await store.getByTrustLevel('public')).toEqual([]);
    });
  });

  describe('setTrustLevel', () => {
    it('updates trust level', async () => {
      const contact = await store.upsert({ displayName: 'Frank', discordUserId: 'discord-frank' });
      const result = await store.setTrustLevel(contact.id, 'trusted');
      expect(result).toBe(true);

      const updated = await store.getById(contact.id);
      expect(updated!.trustLevel).toBe('trusted');
    });

    it('cannot change primary user trust', async () => {
      const primary = await store.upsert({ displayName: 'Morgan', discordUserId: PRIMARY_USER_ID });
      const result = await store.setTrustLevel(primary.id, 'public');
      expect(result).toBe(false);

      const unchanged = await store.getById(primary.id);
      expect(unchanged!.trustLevel).toBe('primary');
    });

    it('denies unauthorized promotion to primary via setTrustLevel and audits denial', async () => {
      const contact = await store.upsert({ displayName: 'Frank', discordUserId: 'discord-frank' });
      expect(await store.setTrustLevel(contact.id, 'primary', 'admin:gui')).toBe(false);

      const unchanged = await store.getById(contact.id);
      expect(unchanged?.trustLevel).toBe('regular');

      const entries = await store.listMutationAuditEntries({
        contactId: contact.id,
        field: 'trust_level',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        contactId: contact.id,
        field: 'trust_level',
        actor: 'admin:gui:primary_denied',
        oldValue: 'regular',
        newValue: 'primary',
      });
    });

    it('allows owner-mapped promotion to primary via setTrustLevel and audits allowance', async () => {
      const owner = await store.upsert({
        displayName: 'Owner Legacy',
        discordUserId: PRIMARY_USER_ID,
        relationshipType: 'friend',
      });
      const ownerRow = pool.contacts.get(owner.id);
      if (!ownerRow) throw new Error('Missing owner contact fixture');
      ownerRow.trust_level = 'regular';
      pool.contactMutationAudit = [];

      expect(await store.setTrustLevel(owner.id, 'primary', 'admin:api')).toBe(true);
      expect((await store.getById(owner.id))?.trustLevel).toBe('primary');

      const entries = await store.listMutationAuditEntries({
        contactId: owner.id,
        field: 'trust_level',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        contactId: owner.id,
        field: 'trust_level',
        actor: 'admin:api:primary_allowed',
        oldValue: 'regular',
        newValue: 'primary',
      });
    });

    it('returns false for nonexistent id', async () => {
      expect(await store.setTrustLevel('nonexistent', 'trusted')).toBe(false);
    });

    it('records trust mutations with actor and old/new values', async () => {
      const contact = await store.upsert({ displayName: 'Audit Trust Target', trustLevel: 'regular' });
      expect(await store.setTrustLevel(contact.id, 'trusted', 'admin:gui')).toBe(true);

      const entries = await store.listMutationAuditEntries({
        contactId: contact.id,
        field: 'trust_level',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        contactId: contact.id,
        field: 'trust_level',
        actor: 'admin:gui',
        oldValue: 'regular',
        newValue: 'trusted',
      });
      expect(Number.isNaN(Date.parse(entries[0].timestamp))).toBe(false);
    });
  });

  describe('updateLastSeen', () => {
    it('updates timestamp', async () => {
      // Insert with an old timestamp so updateLastSeen will definitely produce a newer one
      const oldTime = '2020-01-01T00:00:00.000Z';
      const contact = await store.upsert({
        displayName: 'Grace',
        firstSeen: oldTime,
        lastSeen: oldTime,
      });
      expect(contact.lastSeen).toBe(oldTime);

      await store.updateLastSeen(contact.id);

      const updated = await store.getById(contact.id);
      expect(updated!.lastSeen).not.toBe(oldTime);
      // Updated timestamp should be more recent
      expect(new Date(updated!.lastSeen).getTime()).toBeGreaterThan(new Date(oldTime).getTime());
    });
  });

  describe('recordChannelActivity', () => {
    it('records channel activity and hydrates conversationChannels', async () => {
      const contact = await store.upsert({ displayName: 'Activity User', discordUserId: 'activity-user-1' });
      await store.recordChannelActivity(contact.id, 'Discord', 'guild:123');

      const hydrated = await store.getById(contact.id);
      expect(hydrated?.conversationChannels).toEqual([
        expect.objectContaining({
          channel: 'discord',
          channelId: 'guild:123',
        }),
      ]);
      expect(hydrated?.conversationChannels?.[0].firstSeen).toBeDefined();
      expect(hydrated?.conversationChannels?.[0].lastSeen).toBeDefined();
    });

    it('records explicit conversation-channel privacy and persists direct channel edits', async () => {
      const contact = await store.upsert({ displayName: 'DM User', discordUserId: 'dm-user-1' });
      await store.recordChannelActivity(contact.id, 'Discord', '1313001762793197678', 'private');

      expect((await store.getById(contact.id))?.conversationChannels).toEqual([
        expect.objectContaining({
          channel: 'discord',
          channelId: '1313001762793197678',
          privacyLevel: 'private',
        }),
      ]);

      expect(await store.setConversationChannelPrivacy(contact.id, 'discord', '1313001762793197678', 'public')).toBe(true);
      expect(await store.getConversationChannelPrivacy(contact.id, 'discord', '1313001762793197678')).toBe('public');
      expect((await store.getById(contact.id))?.conversationChannels).toEqual([
        expect.objectContaining({
          channel: 'discord',
          channelId: '1313001762793197678',
          privacyLevel: 'public',
        }),
      ]);
    });
  });

  describe('mergeContacts', () => {
    it('remaps identities, activity, and memories while retiring source recent shape', async () => {
      const target = await store.upsert({
        displayName: 'Target',
        discordUserId: 'target-discord-id',
        trustLevel: 'regular',
      });
      const source = await store.upsert({
        displayName: 'Source',
        channelIdentities: [{ channel: 'api', userId: 'source-api-id' }],
        trustLevel: 'trusted',
      });

      pool.l2MemoryContacts.set('memory-1', source.id);
      pool.recentContactShapes.set(source.id, { nickname: 'source' });
      await store.recordChannelActivity(target.id, 'discord', 'guild:shared');
      await store.recordChannelActivity(source.id, 'discord', 'guild:shared');
      await store.recordChannelActivity(source.id, 'api', 'session:9');
      const targetShared = [...pool.contactChannelActivity.values()].find(row => (
        row.contact_id === target.id && row.channel === 'discord' && row.channel_id === 'guild:shared'
      ));
      const sourceShared = [...pool.contactChannelActivity.values()].find(row => (
        row.contact_id === source.id && row.channel === 'discord' && row.channel_id === 'guild:shared'
      ));
      const sourceApi = [...pool.contactChannelActivity.values()].find(row => (
        row.contact_id === source.id && row.channel === 'api' && row.channel_id === 'session:9'
      ));
      if (!targetShared || !sourceShared || !sourceApi) throw new Error('Missing seeded contact activity');
      Object.assign(targetShared, {
        first_seen: '2024-01-01T00:00:00.000Z',
        last_seen: '2024-01-05T00:00:00.000Z',
      });
      Object.assign(sourceShared, {
        first_seen: '2023-12-01T00:00:00.000Z',
        last_seen: '2024-01-10T00:00:00.000Z',
      });
      Object.assign(sourceApi, {
        first_seen: '2024-01-11T00:00:00.000Z',
        last_seen: '2024-01-11T00:00:00.000Z',
      });

      const merged = await store.mergeContacts(source.id, target.id);
      expect(merged).toBe(true);
      // bead psfn-framework-qgqw.6 (adjudication R10.3): the merge folds the
      // source into the target but archives the source row rather than deleting
      // it, recording a `merged` audit entry that names the target.
      const archivedSource = await store.getById(source.id);
      expect(archivedSource).toBeDefined();
      expect(archivedSource?.archivedAt).toBeTruthy();
      const sourceAudit = await store.listMutationAuditEntries({ contactId: source.id });
      const mergeAudit = sourceAudit.find(entry => entry.field === 'merged');
      expect(mergeAudit?.newValue).toBe(target.id);

      const sourceIdentityResolved = await store.getByChannelIdentity('api', 'source-api-id');
      expect(sourceIdentityResolved?.id).toBe(target.id);

      expect(pool.l2MemoryContacts.get('memory-1')).toBe(target.id);
      expect(pool.recentContactShapes.has(source.id)).toBe(false);
      expect(pool.recentContactShapes.has(target.id)).toBe(false);

      const activityRows = [...pool.contactChannelActivity.values()]
        .filter(row => row.contact_id === target.id)
        .sort((left, right) => left.channel.localeCompare(right.channel) || left.channel_id.localeCompare(right.channel_id))
        .map(({ channel, channel_id, first_seen, last_seen }) => ({
          channel,
          channel_id,
          first_seen,
          last_seen,
        }));
      expect(activityRows).toEqual([
        {
          channel: 'api',
          channel_id: 'session:9',
          first_seen: '2024-01-11T00:00:00.000Z',
          last_seen: '2024-01-11T00:00:00.000Z',
        },
        {
          channel: 'discord',
          channel_id: 'guild:shared',
          first_seen: '2023-12-01T00:00:00.000Z',
          last_seen: '2024-01-10T00:00:00.000Z',
        },
      ]);

      expect((await store.getById(target.id))?.trustLevel).toBe('trusted');
    });

    it('prefers human-readable display name when target uses opaque identifier text', async () => {
      const target = await store.upsert({
        displayName: 'YOUR_DISCORD_USER_ID',
        discordUserId: 'YOUR_DISCORD_USER_ID',
      });
      const source = await store.upsert({
        displayName: 'PrimaryUser',
        channelIdentities: [{ channel: 'discord', userId: 'primary-user' }],
      });

      const merged = await store.mergeContacts(source.id, target.id);
      expect(merged).toBe(true);

      const updated = await store.getById(target.id);
      expect(updated?.displayName).toBe('PrimaryUser');
      expect(updated?.discordUserId).toBe('YOUR_DISCORD_USER_ID');
    });
  });

  describe('updateNotes', () => {
    it('updates notes field', async () => {
      const contact = await store.upsert({ displayName: 'Heidi' });
      const result = await store.updateNotes(contact.id, 'New notes');
      expect(result).toBe(true);

      const updated = await store.getById(contact.id);
      expect(updated!.notes).toBe('New notes');
    });

    it('returns false for nonexistent id', async () => {
      expect(await store.updateNotes('nonexistent', 'notes')).toBe(false);
    });

    it('records notes mutations and supports query filters', async () => {
      const contact = await store.upsert({ displayName: 'Note Audit Target' });
      expect(await store.updateNotes(contact.id, 'First note', 'agent:tool:contact_note')).toBe(true);
      expect(await store.updateNotes(contact.id, 'First note', 'agent:tool:contact_note')).toBe(true);

      const byField = await store.listMutationAuditEntries({ field: 'notes' });
      expect(byField).toHaveLength(1);
      expect(byField[0]).toMatchObject({
        contactId: contact.id,
        actor: 'agent:tool:contact_note',
        oldValue: null,
        newValue: 'First note',
      });

      const byActor = await store.listMutationAuditEntries({ actor: 'agent:tool:contact_note', limit: 10 });
      expect(byActor.some(entry => entry.contactId === contact.id && entry.field === 'notes')).toBe(true);
    });
  });

  describe('profile and privacy audit trail', () => {
    it('records display name and nickname mutations with actor metadata', async () => {
      const contact = await store.upsert({ displayName: 'Profile Audit Target' });

      expect(await store.updateIdentityProfile(contact.id, 'Updated Profile Name', 'Poppy', 'admin:api')).toBe(true);

      const entries = await store.listMutationAuditEntries({ contactId: contact.id, limit: 10 });
      expect(entries).toEqual([
        expect.objectContaining({
          contactId: contact.id,
          actor: 'admin:api',
          field: 'nickname',
          oldValue: null,
          newValue: 'Poppy',
        }),
        expect.objectContaining({
          contactId: contact.id,
          actor: 'admin:api',
          field: 'display_name',
          oldValue: 'Profile Audit Target',
          newValue: 'Updated Profile Name',
        }),
      ]);
    });

    it('records relationship mutations', async () => {
      const contact = await store.upsert({ displayName: 'Relationship Audit Target', relationshipType: 'friend' });

      expect(await store.updateRelationshipType(contact.id, 'partner', 'admin:api')).toBe(true);

      const entries = await store.listMutationAuditEntries({ contactId: contact.id, field: 'relationship_type' });
      expect(entries).toEqual([
        expect.objectContaining({
          contactId: contact.id,
          actor: 'admin:api',
          field: 'relationship_type',
          oldValue: 'friend',
          newValue: 'partner',
        }),
      ]);
    });

    it('keeps relationship classification independent from primary trust', async () => {
      const owner = await store.upsert(
        {
          displayName: 'Owner Relationship Target',
          discordUserId: 'primary-user-123',
          trustLevel: 'primary',
        },
        {
          actor: 'operator:test',
          allowPrimaryTrustAssignment: true,
        },
      );
      expect(owner.trustLevel).toBe('primary');
      expect(owner.relationshipType).toBe('stranger');

      expect(await store.updateRelationshipType(
        owner.id,
        'acquaintance',
        'agent:tool:contact_set_relationship',
      )).toBe(true);
      expect((await store.getById(owner.id))?.trustLevel).toBe('primary');
      expect((await store.getById(owner.id))?.relationshipType).toBe('acquaintance');
    });

    it('fails closed on autonomous family and partner writes while allowing operator approval', async () => {
      const contact = await store.upsert({ displayName: 'Gated Relationship Target', relationshipType: 'friend' });

      expect(await store.updateRelationshipType(
        contact.id,
        'family',
        'agent:tool:contact_set_relationship',
      )).toBe(false);
      expect((await store.getById(contact.id))?.relationshipType).toBe('friend');

      expect(await store.updateRelationshipType(contact.id, 'family', 'operator:confirmation-queue')).toBe(true);
      expect(await store.updateRelationshipType(contact.id, 'partner', 'operator:confirmation-queue')).toBe(true);
      expect((await store.getById(contact.id))?.relationshipType).toBe('partner');
      expect(await store.updateRelationshipType(
        contact.id,
        'friend',
        'agent:tool:contact_set_relationship',
      )).toBe(false);
      expect((await store.getById(contact.id))?.relationshipType).toBe('partner');
    });

    it('compare-and-sets approved relationships without overwriting stale state', async () => {
      const contact = await store.upsert({ displayName: 'CAS Relationship Target', relationshipType: 'friend' });

      expect(await store.compareAndSetRelationshipType(
        contact.id,
        'acquaintance',
        'family',
        'operator:confirmation-queue',
      )).toBe(false);
      expect((await store.getById(contact.id))?.relationshipType).toBe('friend');

      expect(await store.compareAndSetRelationshipType(
        contact.id,
        'friend',
        'family',
        'operator:confirmation-queue',
      )).toBe(true);
      expect((await store.getById(contact.id))?.relationshipType).toBe('family');
      expect(await store.listMutationAuditEntries({ contactId: contact.id, field: 'relationship_type' }))
        .toEqual([expect.objectContaining({ oldValue: 'friend', newValue: 'family' })]);
    });

    it('rolls back relationship compare-and-set when its audit insert fails', async () => {
      const contact = await store.upsert({ displayName: 'CAS Audit Rollback', relationshipType: 'friend' });
      pool.failNextMutationAudit = true;

      await expect(store.compareAndSetRelationshipType(
        contact.id,
        'friend',
        'family',
        'operator:confirmation-queue',
      )).rejects.toThrow('forced mutation audit failure');
      expect((await store.getById(contact.id))?.relationshipType).toBe('friend');
      expect(await store.listMutationAuditEntries({ contactId: contact.id, field: 'relationship_type' })).toEqual([]);
    });

    it('records linked identity and conversation channel privacy mutations', async () => {
      const contact = await store.upsert({ displayName: 'Privacy Audit Target' });
      expect(await store.linkChannelIdentity(contact.id, 'discord', 'privacy-user', { privacyLevel: 'invite_only' })).toBe('linked');
      await store.recordChannelActivity(contact.id, 'discord', '1313001762793197678', 'private');

      expect(await store.setChannelPrivacy(contact.id, 'discord', 'privacy-user', 'private', 'admin:api')).toBe(true);
      // E3.3: 'broadcast' is retired from the privacy vocabulary; the
      // provenance-only per-contact field accepts ChannelPrivacy values.
      expect(await store.setConversationChannelPrivacy(
        contact.id,
        'discord',
        '1313001762793197678',
        'public',
        'admin:api',
      )).toBe(true);

      const entries = await store.listMutationAuditEntries({ contactId: contact.id, field: 'channel_privacy', limit: 10 });
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        contactId: contact.id,
        actor: 'admin:api',
        field: 'channel_privacy',
      });
      expect(entries[0].oldValue).toContain('"privacyLevel":"private"');
      expect(entries[0].newValue).toContain('"privacyLevel":"public"');
      expect(entries[0].newValue).toContain('"channelId":"1313001762793197678"');
      expect(entries[1]).toMatchObject({
        contactId: contact.id,
        actor: 'admin:api',
        field: 'channel_privacy',
      });
      expect(entries[1].oldValue).toContain('"privacyLevel":"invite_only"');
      expect(entries[1].newValue).toContain('"privacyLevel":"private"');
      expect(entries[1].newValue).toContain('"userId":"privacy-user"');
    });

    it('sets and audits the channel-bonding opt-in flag on a linked identity', async () => {
      const contact = await store.upsert({ displayName: 'Bonding Target' });
      expect(await store.linkChannelIdentity(contact.id, 'discord', 'bond-user', { privacyLevel: 'private' })).toBe('linked');

      // Default off: a fresh identity link is never bonded.
      expect((await store.getById(contact.id))?.channels?.find(link => link.userId === 'bond-user')?.bonded)
        .not.toBe(true);

      expect(await store.setChannelBonding(contact.id, 'discord', 'bond-user', true, 'admin:api')).toBe(true);
      expect((await store.getById(contact.id))?.channels?.find(link => link.userId === 'bond-user')?.bonded)
        .toBe(true);

      // No identity link -> never created implicitly.
      expect(await store.setChannelBonding(contact.id, 'telegram', 'missing-user', true, 'admin:api')).toBe(false);

      expect(await store.setChannelBonding(contact.id, 'discord', 'bond-user', false, 'admin:api')).toBe(true);
      expect((await store.getById(contact.id))?.channels?.find(link => link.userId === 'bond-user')?.bonded)
        .not.toBe(true);

      const entries = await store.listMutationAuditEntries({ contactId: contact.id, field: 'channel_bond', limit: 10 });
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatchObject({ contactId: contact.id, actor: 'admin:api', field: 'channel_bond' });
      expect(entries[1].oldValue).toContain('"bonded":false');
      expect(entries[1].newValue).toContain('"bonded":true');
    });

    it('records channel unlink mutations', async () => {
      const contact = await store.upsert({ displayName: 'Link Audit Target' });

      expect(await store.linkChannelIdentity(
        contact.id,
        'telegram',
        'link-user',
        { privacyLevel: 'private' },
        'admin:api',
      )).toBe('linked');
      expect(await store.unlinkChannelIdentity(contact.id, 'telegram', 'link-user', 'admin:api')).toBe(true);

      const entries = await store.listMutationAuditEntries({ contactId: contact.id, field: 'channel_link', limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        contactId: contact.id,
        actor: 'admin:api',
        field: 'channel_link',
        newValue: null,
      });
      expect(entries[0].oldValue).toContain('"channel":"telegram"');
      expect(entries[0].oldValue).toContain('"userId":"link-user"');
    });
  });

  describe('listAll', () => {
    it('returns all contacts', async () => {
      await store.upsert({ displayName: 'A', discordUserId: 'a' });
      await store.upsert({ displayName: 'B', discordUserId: 'b' });
      await store.upsert({ displayName: 'C', discordUserId: 'c' });

      const all = await store.listAll();
      expect(all).toHaveLength(3);
    });

    it('returns empty array when no contacts', async () => {
      expect(await store.listAll()).toEqual([]);
    });
  });

  describe('resolveUserId', () => {
    it('creates new contact for unknown user at the public trust floor', async () => {
      const contact = await store.resolveUserId('discord-new');
      expect(contact.discordUserId).toBe('discord-new');
      expect(contact.displayName).toBe('discord-new');  // Placeholder
      // Sprint-10 privacy regression H7: a never-seen, non-primary speaker is
      // minted at the PUBLIC trust floor, never the disclosing 'regular' tier.
      expect(contact.trustLevel).toBe('public');
      expect(contact.relationshipType).toBe('stranger');
    });

    it('returns existing contact for known user', async () => {
      const created = await store.upsert({
        displayName: 'Ivan',
        discordUserId: 'discord-ivan',
        trustLevel: 'trusted',
      });
      const resolved = await store.resolveUserId('discord-ivan');
      expect(resolved.id).toBe(created.id);
      expect(resolved.displayName).toBe('Ivan');
      expect(resolved.trustLevel).toBe('trusted');
    });

    it('preserves trusted contact when a concurrent legacy identity appears between resolver lookups', async () => {
      const created = await store.upsert({
        displayName: 'Legacy Race',
        discordUserId: 'discord-race',
        trustLevel: 'trusted',
      }, { actor: 'operator:test-fixture' });
      const row = pool.contacts.get(created.id);
      if (!row) throw new Error('Missing legacy resolver race fixture');
      const identityKey = 'discord::discord-race';
      const identityRow = pool.contactChannelIds.get(identityKey);
      if (!identityRow) throw new Error('Missing legacy resolver identity fixture');

      row.discord_user_id = null;
      pool.contactChannelIds.delete(identityKey);
      pool.afterNextChannelIdentityLookup = () => {
        row.discord_user_id = 'discord-race';
        pool.contactChannelIds.set(identityKey, identityRow);
      };

      const resolved = await store.resolveUserId('discord-race');

      expect(resolved.id).toBe(created.id);
      expect(resolved.trustLevel).toBe('trusted');
    });

    it('updates lastSeen for existing contact', async () => {
      const created = await store.upsert({
        displayName: 'Judy',
        discordUserId: 'discord-judy',
      });

      // Resolve again — should update lastSeen
      const resolved = await store.resolveUserId('discord-judy');
      // The lastSeen should be updated (may or may not differ within same ms)
      expect(resolved.lastSeen).toBeDefined();
      expect(resolved.id).toBe(created.id);
    });

    it('creates primary user with correct defaults', async () => {
      const contact = await store.resolveUserId(PRIMARY_USER_ID);
      expect(contact.trustLevel).toBe('primary');
      expect(contact.relationshipType).toBe('stranger');
      expect(contact.discordUserId).toBe(PRIMARY_USER_ID);
    });
  });

  describe('resolveChannelIdentity', () => {
    it('creates channel-aware contact mappings for non-discord channels', async () => {
      const contact = await store.resolveChannelIdentity('api', 'api-user-1', 'API User');
      expect(contact.displayName).toBe('API User');
      const persisted = await store.getById(contact.id);
      expect(persisted?.channels).toEqual([
        expect.objectContaining({ channel: 'api', userId: 'api-user-1' }),
      ]);
    });

    it('mints same-cluster fleet companion peers as acquaintance at the public trust floor', async () => {
      const peer = await store.resolveChannelIdentity('companion', 'sibling-companion-1', 'Sibling');
      // bead hr1q: recognized above stranger, but the trust floor stays public.
      expect(peer.relationshipType).toBe('acquaintance');
      expect(peer.trustLevel).toBe('public');
      const persisted = await store.getById(peer.id);
      expect(persisted?.relationshipType).toBe('acquaintance');
      expect(persisted?.trustLevel).toBe('public');
    });

    it('still mints non-fleet strangers as stranger at the public trust floor', async () => {
      const stranger = await store.resolveChannelIdentity('api', 'unknown-api-9', 'Unknown');
      expect(stranger.relationshipType).toBe('stranger');
      expect(stranger.trustLevel).toBe('public');
    });

    it('reuses canonical contact when linked channel identity exists', async () => {
      const contact = await store.upsert({ displayName: 'Morgan', discordUserId: PRIMARY_USER_ID });
      const link = await store.linkChannelIdentity(contact.id, 'api', 'v-api-id');
      expect(link).toBe('linked');

      const resolved = await store.resolveChannelIdentity('api', 'v-api-id', 'Morgan API');
      expect(resolved.id).toBe(contact.id);
      expect(resolved.trustLevel).toBe('primary');
    });

    it('preserves trusted contact when a concurrent channel identity appears between resolver lookups', async () => {
      const created = await store.upsert({
        displayName: 'Channel Race',
        trustLevel: 'trusted',
      }, { actor: 'operator:test-fixture' });
      expect(await store.linkChannelIdentity(created.id, 'api', 'api-race')).toBe('linked');
      const identityKey = 'api::api-race';
      const identityRow = pool.contactChannelIds.get(identityKey);
      if (!identityRow) throw new Error('Missing channel resolver race fixture');

      pool.contactChannelIds.delete(identityKey);
      pool.afterNextChannelIdentityLookup = () => {
        pool.contactChannelIds.set(identityKey, identityRow);
      };

      const resolved = await store.resolveChannelIdentity('api', 'api-race', 'Channel Race');

      expect(resolved.id).toBe(created.id);
      expect(resolved.trustLevel).toBe('trusted');
    });

    it('reconciles duplicate primary contacts into the canonical identity owner', async () => {
      const duplicate = await store.upsert({
        displayName: 'Duplicate Primary',
        discordUserId: 'duplicate-discord-id',
        relationshipType: 'partner',
      }, { actor: 'operator:test' });
      const duplicateRow = pool.contacts.get(duplicate.id);
      if (!duplicateRow) throw new Error('Missing duplicate primary fixture');
      duplicateRow.trust_level = 'primary';
      await store.linkChannelIdentity(duplicate.id, 'api', 'primary-api-alias', { privacyLevel: 'private' });

      const owner = await store.upsert({ displayName: 'Primary Owner' });
      expect(await store.linkChannelIdentity(owner.id, 'discord', PRIMARY_USER_ID)).toBe('linked');
      const resolved = await store.getById(owner.id);
      expect(resolved?.id).toBe(owner.id);
      expect(resolved?.trustLevel).toBe('primary');
      // Duplicate reconciliation preserves the more-established explicit relationship.
      expect(resolved?.relationshipType).toBe('partner');
      // bead psfn-framework-qgqw.6 (adjudication R10.3): the autonomous
      // duplicate-merge fold archives the reconciled-away duplicate rather than
      // hard-deleting it, and its identities resolve live to the canonical owner.
      const archivedDuplicate = await store.getById(duplicate.id);
      expect(archivedDuplicate?.archivedAt).toBeTruthy();
      expect((await store.getByChannelIdentity('api', 'primary-api-alias'))?.id).toBe(owner.id);
    });
  });

  describe('linkChannelIdentity', () => {
    it('returns conflict when identity is already linked to another contact', async () => {
      const first = await store.upsert({
        displayName: 'First',
        channelIdentities: [{ channel: 'api', userId: 'shared-api-id' }],
      });
      const second = await store.upsert({ displayName: 'Second', discordUserId: 'second-discord-id' });

      const result = await store.linkChannelIdentity(second.id, 'api', 'shared-api-id');
      expect(result).toBe('identity_conflict');

      const found = await store.getByChannelIdentity('api', 'shared-api-id');
      expect(found?.id).toBe(first.id);
    });
  });

  describe('identity link verification challenges', () => {
    it('issues a challenge, verifies it, and commits the target link', async () => {
      const contact = await store.upsert({
        displayName: 'PrimaryUser',
        channelIdentities: [{ channel: 'discord', userId: 'user-discord' }],
      });

      const challenge = await store.createIdentityLinkChallenge({
        contactId: contact.id,
        sourceChannel: 'discord',
        sourceUserId: 'user-discord',
        targetChannel: 'api',
        targetUserId: 'user-api',
      });

      expect(challenge.status).toBe('challenge_created');
      if (challenge.status !== 'challenge_created') return;

      const verified = await store.verifyIdentityLinkChallenge({
        contactId: contact.id,
        sourceChannel: 'discord',
        sourceUserId: 'user-discord',
        targetChannel: 'api',
        targetUserId: 'user-api',
        nonce: challenge.verification.nonce,
        expiresAt: challenge.verification.expiresAt,
        signature: challenge.verification.signature,
      });

      expect(verified.status).toBe('linked');
      expect((await store.getByChannelIdentity('api', 'user-api'))?.id).toBe(contact.id);
      expect((await store.listIdentityLinkVerifications(5))[0]?.status).toBe('verified');
    });

    it('rejects replayed verification challenges', async () => {
      const contact = await store.upsert({
        displayName: 'Replay Tester',
        channelIdentities: [{ channel: 'discord', userId: 'replay-discord' }],
      });

      const challenge = await store.createIdentityLinkChallenge({
        contactId: contact.id,
        sourceChannel: 'discord',
        sourceUserId: 'replay-discord',
        targetChannel: 'api',
        targetUserId: 'replay-api',
      });
      expect(challenge.status).toBe('challenge_created');
      if (challenge.status !== 'challenge_created') return;

      const first = await store.verifyIdentityLinkChallenge({
        contactId: contact.id,
        sourceChannel: 'discord',
        sourceUserId: 'replay-discord',
        targetChannel: 'api',
        targetUserId: 'replay-api',
        nonce: challenge.verification.nonce,
        expiresAt: challenge.verification.expiresAt,
        signature: challenge.verification.signature,
      });
      expect(first.status).toBe('linked');

      const second = await store.verifyIdentityLinkChallenge({
        contactId: contact.id,
        sourceChannel: 'discord',
        sourceUserId: 'replay-discord',
        targetChannel: 'api',
        targetUserId: 'replay-api',
        nonce: challenge.verification.nonce,
        expiresAt: challenge.verification.expiresAt,
        signature: challenge.verification.signature,
      });
      expect(second.status).toBe('verification_replayed');
    });
  });

  describe('emotionalBaseline', () => {
    it('round-trips emotional baseline through JSON', async () => {
      const baseline = { warmth: 0.7, formality: 0.3, playfulness: 0.9 };
      const contact = await store.upsert({
        displayName: 'Kim',
        emotionalBaseline: baseline,
      });
      const found = await store.getById(contact.id);
      expect(found!.emotionalBaseline).toEqual(baseline);
    });

    it('defaults to empty object when not provided', async () => {
      const contact = await store.upsert({ displayName: 'Lee' });
      const found = await store.getById(contact.id);
      // Empty JSON object stored, should parse to empty object
      expect(found!.emotionalBaseline).toEqual({});
    });

    it('exposes an empty-to-populated bounded emotional time series per contact', async () => {
      const contact = await store.upsert({ displayName: 'Timeline Learner' });

      expect(await store.getEmotionalTimeSeries(contact.id)).toEqual([]);

      await store.updateEmotionalBaseline(contact.id, {
        valence: 0.25,
        confidence: 0.9,
        observedAtMs: 1_000,
      });
      await store.updateEmotionalBaseline(contact.id, {
        valence: -0.4,
        confidence: 0.6,
        observedAtMs: 2_000,
      });
      await store.updateEmotionalBaseline(contact.id, {
        valence: 0.7,
        confidence: 0.8,
        observedAtMs: 3_000,
      });

      expect(await store.getEmotionalTimeSeries(contact.id)).toEqual([
        { valence: 0.25, confidence: 0.9, observedAtMs: 1_000 },
        { valence: -0.4, confidence: 0.6, observedAtMs: 2_000 },
        { valence: 0.7, confidence: 0.8, observedAtMs: 3_000 },
      ]);
      expect(await store.getEmotionalTimeSeries(contact.id, 2)).toEqual([
        { valence: -0.4, confidence: 0.6, observedAtMs: 2_000 },
        { valence: 0.7, confidence: 0.8, observedAtMs: 3_000 },
      ]);
    });

    it('learns baseline values dynamically from observed emotional signals', async () => {
      const contact = await store.upsert({
        displayName: 'Mood Learner',
        emotionalBaseline: { warmth: 0.7 },
      });

      const updated = await store.updateEmotionalBaseline(contact.id, {
        valence: 0.8,
        confidence: 1,
        observedAtMs: 1_000,
      });

      expect(updated).toBeDefined();
      expect(updated?.emotionalBaseline?.warmth).toBe(0.7);
      expect(updated?.emotionalBaseline?.valenceBaseline).toBeCloseTo(0.32, 4);
      expect(updated?.emotionalBaseline?.moodValence).toBeCloseTo(0.44, 4);
      expect(updated?.emotionalBaseline?.moodDrift).toBeCloseTo(0.12, 4);
      expect(updated?.emotionalBaseline?.moodSamples).toBe(1);

      const snapshot = await store.getEmotionalSnapshot(contact.id);
      expect(snapshot).toEqual(expect.objectContaining({
        baselineValence: 0.32,
        moodValence: 0.44,
        moodDrift: 0.12,
        moodSamples: 1,
        lastMoodUpdateEpochMs: 1_000,
      }));
    });

    it('preserves intra-session mood drift across updates', async () => {
      const contact = await store.upsert({ displayName: 'Session Mood' });
      await store.updateEmotionalBaseline(contact.id, {
        valence: 0.6,
        confidence: 1,
        observedAtMs: 1_000,
      });

      const updated = await store.updateEmotionalBaseline(contact.id, {
        valence: -0.4,
        confidence: 1,
        observedAtMs: 2_000,
      });

      expect(updated).toBeDefined();
      expect(updated?.emotionalBaseline?.moodSamples).toBe(2);
      expect(updated?.emotionalBaseline?.moodValence).toBeLessThan(0);
      expect(updated?.emotionalBaseline?.moodDrift).toBeLessThan(0);

      const snapshot = await store.getEmotionalSnapshot(contact.id);
      expect(snapshot).toEqual(expect.objectContaining({
        moodSamples: 2,
        lastMoodUpdateEpochMs: 2_000,
      }));
    });
  });

  describe('no primaryUserId configured', () => {
    it('treats all users as regular when no primaryUserId set', async () => {
      const { store: storeNoPrimary } = await createTestPostgresContactStore();
      const contact = await storeNoPrimary.upsert({
        displayName: 'Anyone',
        discordUserId: 'discord-anyone',
      });
      expect(contact.trustLevel).toBe('regular');
    });
  });

  describe('deleteContact', () => {
    it('deletes a regular contact and its channel links', async () => {
      const contact = await store.upsert({ displayName: 'Deleteable' });
      await store.linkChannelIdentity(contact.id, 'discord', '999');
      expect(await store.getById(contact.id)).toBeDefined();

      const result = await store.deleteContact(contact.id);
      expect(result).toBe(true);
      expect(await store.getById(contact.id)).toBeUndefined();

      // Channel identity should also be gone
      expect(await store.getByChannelIdentity('discord', '999')).toBeUndefined();
    });

    it('refuses to delete the primary contact', async () => {
      const primary = await store.upsert({
        displayName: 'Primary',
        discordUserId: PRIMARY_USER_ID,
      });
      expect(primary.trustLevel).toBe('primary');

      const result = await store.deleteContact(primary.id);
      expect(result).toBe(false);
      expect(await store.getById(primary.id)).toBeDefined();
    });

    it('returns false for non-existent contact', async () => {
      expect(await store.deleteContact('no-such-id')).toBe(false);
    });
  });

  describe('unlinkChannelIdentity', () => {
    it('removes a specific channel identity link', async () => {
      const contact = await store.upsert({ displayName: 'Multi' });
      await store.linkChannelIdentity(contact.id, 'api', '111');
      await store.linkChannelIdentity(contact.id, 'telegram', '222');

      const result = await store.unlinkChannelIdentity(contact.id, 'api', '111');
      expect(result).toBe(true);

      // API link gone
      expect(await store.getByChannelIdentity('api', '111')).toBeUndefined();
      // Telegram link still present
      expect(await store.getByChannelIdentity('telegram', '222')).toBeDefined();
    });

    it('returns false for non-existent contact', async () => {
      expect(await store.unlinkChannelIdentity('no-such-id', 'discord', '111')).toBe(false);
    });

    it('returns false when channel identity does not exist on contact', async () => {
      const contact = await store.upsert({ displayName: 'Solo' });
      expect(await store.unlinkChannelIdentity(contact.id, 'discord', 'nope')).toBe(false);
    });
  });

  describe('deleteConversationChannel', () => {
    it('removes a specific persisted conversation channel', async () => {
      const contact = await store.upsert({ displayName: 'Conversation User' });
      await store.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:short-check', 'invite_only');
      await store.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:lab:pi5', 'private');

      const result = await store.deleteConversationChannel(contact.id, 'psfn-amica', 'psfn-amica:short-check');
      expect(result).toBe(true);

      expect((await store.getById(contact.id))?.conversationChannels).toEqual([
        expect.objectContaining({
          channel: 'psfn-amica',
          channelId: 'psfn-amica:lab:pi5',
        }),
      ]);

      const entries = await store.listMutationAuditEntries({ contactId: contact.id, field: 'conversation_channel', limit: 10 });
      expect(entries[0]).toMatchObject({
        contactId: contact.id,
        field: 'conversation_channel',
        newValue: null,
      });
      expect(entries[0].oldValue).toContain('"channel":"psfn-amica"');
      expect(entries[0].oldValue).toContain('"channelId":"psfn-amica:short-check"');
    });

    it('returns false when the conversation channel is not linked to the contact', async () => {
      const contact = await store.upsert({ displayName: 'Conversation User' });
      expect(await store.deleteConversationChannel(contact.id, 'psfn-amica', 'psfn-amica:missing')).toBe(false);
    });
  });
});

describe('Postgres contact store machine-intelligence flag', () => {
  let pool: FakePostgresPool;
  let store: ContactStorePort;

  beforeEach(async () => {
    ({ pool, store } = await createTestPostgresContactStore(PRIMARY_USER_ID));
  });

  it('defaults to not-MI, sets and round-trips the flag with audit', async () => {
    const contact = await store.resolveChannelIdentity('discord', 'artemis-001', 'Artemis');
    expect(contact.isMachineIntelligence).toBeUndefined();

    expect(await store.setMachineIntelligence(contact.id, true, 'test')).toBe(true);
    const flagged = await store.getById(contact.id);
    expect(flagged?.isMachineIntelligence).toBe(true);

    // Setting the same value is a no-op success; clearing works too.
    expect(await store.setMachineIntelligence(contact.id, true)).toBe(true);
    expect(await store.setMachineIntelligence(contact.id, false)).toBe(true);
    expect((await store.getById(contact.id))?.isMachineIntelligence).toBeUndefined();

    const audit = await store.listMutationAuditEntries({ contactId: contact.id });
    expect(audit.some(entry => entry.field === 'is_machine_intelligence')).toBe(true);
  });

  it('returns false for unknown contacts', async () => {
    expect(await store.setMachineIntelligence('missing-contact', true)).toBe(false);
  });

  describe('countVerifiedIdentityLinks', () => {
    function insertVerification(contactId: string, id: string, status: string): void {
      pool.contactIdentityLinkVerifications.set(id, {
        id,
        contact_id: contactId,
        source_channel: 'discord',
        source_user_id: 'src-user',
        target_channel: 'telegram',
        target_user_id: 'tgt-user',
        nonce: 'nonce',
        expires_at: '2026-12-31T00:00:00.000Z',
        signature: 'sig',
        status,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        verified_at: status === 'verified' ? '2026-07-01T00:00:00.000Z' : null,
        failure_reason: null,
      });
    }

    it('counts only verified rows for the given contact', async () => {
      const contact = await store.upsert({ displayName: 'Fixture Verified' });
      const other = await store.upsert({ displayName: 'Fixture Other' });
      insertVerification(contact.id, 'v1', 'verified');
      insertVerification(contact.id, 'v2', 'pending');
      insertVerification(other.id, 'v3', 'verified');
      expect(await store.countVerifiedIdentityLinks(contact.id)).toBe(1);
      expect(await store.countVerifiedIdentityLinks(other.id)).toBe(1);
      expect(await store.countVerifiedIdentityLinks('unknown')).toBe(0);
    });
  });

  describe('contact maintenance watermarks', () => {
    it('returns undefined for an unknown processor', async () => {
      expect(await store.getContactMaintenanceWatermark('contacts.trust_drift.review')).toBeUndefined();
    });

    it('round-trips and upserts a watermark', async () => {
      await store.setContactMaintenanceWatermark('contacts.trust_drift.review', '2026-07-07T03:00:00.000Z');
      expect(await store.getContactMaintenanceWatermark('contacts.trust_drift.review'))
        .toBe('2026-07-07T03:00:00.000Z');
      await store.setContactMaintenanceWatermark('contacts.trust_drift.review', '2026-07-08T03:00:00.000Z');
      expect(await store.getContactMaintenanceWatermark('contacts.trust_drift.review'))
        .toBe('2026-07-08T03:00:00.000Z');
    });

    it('rejects an empty processor and an invalid timestamp', async () => {
      await expect(store.setContactMaintenanceWatermark('  ', '2026-07-07T03:00:00.000Z')).rejects.toThrow(/processor/);
      await expect(store.setContactMaintenanceWatermark('contacts.trust_drift.review', 'garbage')).rejects.toThrow(/timestamp/);
    });
  });
});
