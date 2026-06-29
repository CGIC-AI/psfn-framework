import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContactStore } from './store.js';

const PRIMARY_USER_ID = 'discord-primary-123';

describe('ContactStore', () => {
  let db: Database.Database;
  let store: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ContactStore(db, PRIMARY_USER_ID);
  });

  describe('createTables', () => {
    it('initializes without error', () => {
      // Constructor already called createTables — verify table exists
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'",
      ).all();
      expect(tables).toHaveLength(1);
    });

    it('is idempotent — second construction does not throw', () => {
      expect(() => new ContactStore(db, PRIMARY_USER_ID)).not.toThrow();
    });

    it('migrates legacy contacts schema to include nickname', () => {
      const legacyDb = new Database(':memory:');
      legacyDb.exec(`
        CREATE TABLE contacts (
          id TEXT PRIMARY KEY,
          discord_user_id TEXT UNIQUE,
          display_name TEXT NOT NULL,
          trust_level TEXT NOT NULL DEFAULT 'regular',
          relationship_type TEXT NOT NULL DEFAULT 'stranger',
          emotional_baseline TEXT DEFAULT '{}',
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          notes TEXT
        );

        CREATE TABLE contact_channel_ids (
          contact_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          channel_user_id TEXT NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (channel, channel_user_id)
        );
      `);

      const now = new Date().toISOString();
      legacyDb.prepare(`
        INSERT INTO contacts (
          id, discord_user_id, display_name, trust_level, relationship_type,
          emotional_baseline, first_seen, last_seen, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('legacy-contact', 'legacy-discord-id', 'Legacy', 'trusted', 'friend', '{}', now, now, null);

      const migratedStore = new ContactStore(legacyDb, PRIMARY_USER_ID);
      const columns = legacyDb.prepare('PRAGMA table_info(contacts)')
        .all() as Array<{ name: string }>;
      expect(columns.some(column => column.name === 'nickname')).toBe(true);
      expect(columns.some(column => column.name === 'timezone')).toBe(true);
      expect(migratedStore.updateIdentityProfile('legacy-contact', 'Legacy Updated', 'Leg')).toBe(true);
      expect(migratedStore.getById('legacy-contact')?.nickname).toBe('Leg');
    });

    it('migrates legacy discord_user_id rows into channel identity table', () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO contacts (
          id, discord_user_id, display_name, trust_level, relationship_type,
          emotional_baseline, first_seen, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('legacy-contact', 'legacy-discord-id', 'Legacy', 'trusted', 'friend', '{}', now, now);

      const migratedStore = new ContactStore(db, PRIMARY_USER_ID);
      const byChannelIdentity = migratedStore.getByChannelIdentity('discord', 'legacy-discord-id');
      expect(byChannelIdentity?.id).toBe('legacy-contact');
    });

    it('creates contact_channel_activity table', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_channel_activity'",
      ).all();
      expect(tables).toHaveLength(1);
    });

    it('creates contact_identity_link_verifications table', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_identity_link_verifications'",
      ).all();
      expect(tables).toHaveLength(1);
    });

    it('creates contact_mutation_audit table', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_mutation_audit'",
      ).all();
      expect(tables).toHaveLength(1);
    });
  });

  describe('upsert', () => {
    it('creates new contact with generated UUID', () => {
      const contact = store.upsert({ displayName: 'Alice' });
      expect(contact.id).toBeDefined();
      expect(contact.id.length).toBeGreaterThan(0);
      expect(contact.displayName).toBe('Alice');
      expect(contact.trustLevel).toBe('regular');
      expect(contact.relationshipType).toBe('stranger');
      expect(contact.firstSeen).toBeDefined();
      expect(contact.lastSeen).toBeDefined();
    });

    it('updates existing contact by discordUserId', () => {
      const c1 = store.upsert({
        displayName: 'Bob',
        discordUserId: 'discord-bob',
        trustLevel: 'regular',
      });
      const c2 = store.upsert({
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

    it('forces primary trust for primaryUserId', () => {
      const contact = store.upsert({
        displayName: 'V',
        discordUserId: PRIMARY_USER_ID,
        trustLevel: 'regular',  // Should be overridden
      });
      expect(contact.trustLevel).toBe('primary');
      expect(contact.relationshipType).toBe('partner');
    });

    it('forces primary trust when updating existing primary user', () => {
      store.upsert({ displayName: 'V', discordUserId: PRIMARY_USER_ID });
      const updated = store.upsert({
        displayName: 'V Updated',
        discordUserId: PRIMARY_USER_ID,
        trustLevel: 'public',  // Should be overridden
      });
      expect(updated.trustLevel).toBe('primary');
    });

    it('rejects unauthorized primary trust assignment via upsert and audits denial', () => {
      const contact = store.upsert({
        displayName: 'Mallory',
        discordUserId: 'discord-mallory',
        trustLevel: 'trusted',
      });

      expect(() => store.upsert({
        id: contact.id,
        displayName: 'Mallory',
        trustLevel: 'primary',
      })).toThrow(/Primary trust assignment denied/);

      const unchanged = store.getById(contact.id);
      expect(unchanged?.trustLevel).toBe('trusted');

      const entries = store.listMutationAuditEntries({
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

    it('audits allowed owner-mapped upsert primary assignment', () => {
      const contact = store.upsert({
        displayName: 'V',
        discordUserId: PRIMARY_USER_ID,
        trustLevel: 'regular',
      });
      expect(contact.trustLevel).toBe('primary');

      const entries = store.listMutationAuditEntries({
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

    it('preserves existing fields when partial update', () => {
      store.upsert({
        displayName: 'Carol',
        discordUserId: 'discord-carol',
        notes: 'Old notes',
        emotionalBaseline: { warmth: 0.5 },
      });
      const updated = store.upsert({
        displayName: 'Carol Updated',
        discordUserId: 'discord-carol',
      });
      expect(updated.notes).toBe('Old notes');
      expect(updated.emotionalBaseline).toEqual({ warmth: 0.5 });
    });

    it('persists, hydrates, preserves, updates, and clears optional timezone', () => {
      const created = store.upsert({
        displayName: 'Timezone Contact',
        discordUserId: 'timezone-contact',
        timezone: '  America/Los_Angeles  ',
      });
      expect(created.timezone).toBe('America/Los_Angeles');
      expect(store.getById(created.id)?.timezone).toBe('America/Los_Angeles');

      const unrelatedUpdate = store.upsert({
        displayName: 'Timezone Contact Renamed',
        discordUserId: 'timezone-contact',
      });
      expect(unrelatedUpdate.timezone).toBe('America/Los_Angeles');

      const changed = store.upsert({
        displayName: 'Timezone Contact Renamed',
        discordUserId: 'timezone-contact',
        timezone: 'Europe/London',
      }, { actor: 'admin:api' });
      expect(changed.timezone).toBe('Europe/London');

      const cleared = store.upsert({
        displayName: 'Timezone Contact Renamed',
        discordUserId: 'timezone-contact',
        timezone: undefined,
      }, { actor: 'admin:api' });
      expect(cleared.timezone).toBeUndefined();

      const entries = store.listMutationAuditEntries({
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

    it('exports contact snapshots to configured contacts directory', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'psfn-contacts-export-'));
      const exportDir = join(tempDir, 'contacts');
      const exportStore = new ContactStore(db, PRIMARY_USER_ID, { exportDir });

      const created = exportStore.upsert({
        displayName: 'Exported',
        discordUserId: 'discord-export',
        notes: 'first note',
      });
      exportStore.updateNotes(created.id, 'updated note');

      const index = JSON.parse(readFileSync(join(exportDir, 'index.json'), 'utf-8')) as {
        count: number;
        contacts: Array<{ id: string; displayName: string }>;
      };
      expect(index.count).toBeGreaterThanOrEqual(1);
      expect(index.contacts.some(contact => contact.id === created.id)).toBe(true);

      const contactFile = JSON.parse(
        readFileSync(join(exportDir, `contact-${created.id}.json`), 'utf-8'),
      ) as { id: string; notes?: string };
      expect(contactFile.id).toBe(created.id);
      expect(contactFile.notes).toBe('updated note');

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('getById', () => {
    it('returns contact when found', () => {
      const created = store.upsert({ displayName: 'Dave' });
      const found = store.getById(created.id);
      expect(found).toBeDefined();
      expect(found!.displayName).toBe('Dave');
    });

    it('returns undefined when not found', () => {
      expect(store.getById('nonexistent')).toBeUndefined();
    });
  });

  describe('getByDiscordUserId', () => {
    it('returns contact when found', () => {
      store.upsert({ displayName: 'Eve', discordUserId: 'discord-eve' });
      const found = store.getByDiscordUserId('discord-eve');
      expect(found).toBeDefined();
      expect(found!.displayName).toBe('Eve');
    });

    it('returns undefined when not found', () => {
      expect(store.getByDiscordUserId('nonexistent')).toBeUndefined();
    });
  });

  describe('getByChannelIdentity', () => {
    it('returns contact when identity mapping exists', () => {
      const contact = store.upsert({
        displayName: 'Cross',
        channelIdentities: [{ channel: 'api', userId: 'cross-api-1' }],
      });

      const found = store.getByChannelIdentity('api', 'cross-api-1');
      expect(found?.id).toBe(contact.id);
      expect(found?.displayName).toBe('Cross');
    });

    it('falls back to legacy discord_user_id rows', () => {
      const contact = store.upsert({ displayName: 'Legacy', discordUserId: 'legacy-discord' });

      const found = store.getByChannelIdentity('discord', 'legacy-discord');
      expect(found?.id).toBe(contact.id);
      expect(found?.discordUserId).toBe('legacy-discord');
    });
  });

  describe('getByTrustLevel', () => {
    it('filters contacts correctly', () => {
      store.upsert({ displayName: 'Trusted1', trustLevel: 'trusted', discordUserId: 't1' });
      store.upsert({ displayName: 'Trusted2', trustLevel: 'trusted', discordUserId: 't2' });
      store.upsert({ displayName: 'Regular1', trustLevel: 'regular', discordUserId: 'r1' });

      const trusted = store.getByTrustLevel('trusted');
      expect(trusted).toHaveLength(2);
      expect(trusted.map(c => c.displayName).sort()).toEqual(['Trusted1', 'Trusted2']);

      const regular = store.getByTrustLevel('regular');
      expect(regular).toHaveLength(1);
      expect(regular[0].displayName).toBe('Regular1');
    });

    it('returns empty array when no contacts at level', () => {
      expect(store.getByTrustLevel('public')).toEqual([]);
    });
  });

  describe('setTrustLevel', () => {
    it('updates trust level', () => {
      const contact = store.upsert({ displayName: 'Frank', discordUserId: 'discord-frank' });
      const result = store.setTrustLevel(contact.id, 'trusted');
      expect(result).toBe(true);

      const updated = store.getById(contact.id);
      expect(updated!.trustLevel).toBe('trusted');
    });

    it('cannot change primary user trust', () => {
      const primary = store.upsert({ displayName: 'V', discordUserId: PRIMARY_USER_ID });
      const result = store.setTrustLevel(primary.id, 'public');
      expect(result).toBe(false);

      const unchanged = store.getById(primary.id);
      expect(unchanged!.trustLevel).toBe('primary');
    });

    it('denies unauthorized promotion to primary via setTrustLevel and audits denial', () => {
      const contact = store.upsert({ displayName: 'Frank', discordUserId: 'discord-frank' });
      expect(store.setTrustLevel(contact.id, 'primary', 'admin:gui')).toBe(false);

      const unchanged = store.getById(contact.id);
      expect(unchanged?.trustLevel).toBe('regular');

      const entries = store.listMutationAuditEntries({
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

    it('allows owner-mapped promotion to primary via setTrustLevel and audits allowance', () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO contacts (
          id, discord_user_id, display_name, trust_level, relationship_type,
          emotional_baseline, first_seen, last_seen, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('owner-legacy', PRIMARY_USER_ID, 'Owner Legacy', 'regular', 'friend', '{}', now, now, null);
      db.prepare(`
        INSERT INTO contact_channel_ids (
          contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run('owner-legacy', 'discord', PRIMARY_USER_ID, 'semi_private', now, now);

      expect(store.setTrustLevel('owner-legacy', 'primary', 'admin:api')).toBe(true);
      expect(store.getById('owner-legacy')?.trustLevel).toBe('primary');

      const entries = store.listMutationAuditEntries({
        contactId: 'owner-legacy',
        field: 'trust_level',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        contactId: 'owner-legacy',
        field: 'trust_level',
        actor: 'admin:api:primary_allowed',
        oldValue: 'regular',
        newValue: 'primary',
      });
    });

    it('returns false for nonexistent id', () => {
      expect(store.setTrustLevel('nonexistent', 'trusted')).toBe(false);
    });

    it('records trust mutations with actor and old/new values', () => {
      const contact = store.upsert({ displayName: 'Audit Trust Target', trustLevel: 'regular' });
      expect(store.setTrustLevel(contact.id, 'trusted', 'admin:gui')).toBe(true);

      const entries = store.listMutationAuditEntries({
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
    it('updates timestamp', () => {
      // Insert with an old timestamp so updateLastSeen will definitely produce a newer one
      const oldTime = '2020-01-01T00:00:00.000Z';
      const contact = store.upsert({
        displayName: 'Grace',
        firstSeen: oldTime,
        lastSeen: oldTime,
      });
      expect(contact.lastSeen).toBe(oldTime);

      store.updateLastSeen(contact.id);

      const updated = store.getById(contact.id);
      expect(updated!.lastSeen).not.toBe(oldTime);
      // Updated timestamp should be more recent
      expect(new Date(updated!.lastSeen).getTime()).toBeGreaterThan(new Date(oldTime).getTime());
    });
  });

  describe('recordChannelActivity', () => {
    it('records channel activity and hydrates conversationChannels', () => {
      const contact = store.upsert({ displayName: 'Activity User', discordUserId: 'activity-user-1' });
      store.recordChannelActivity(contact.id, 'Discord', 'guild:123');

      const hydrated = store.getById(contact.id);
      expect(hydrated?.conversationChannels).toEqual([
        expect.objectContaining({
          channel: 'discord',
          channelId: 'guild:123',
        }),
      ]);
      expect(hydrated?.conversationChannels?.[0].firstSeen).toBeDefined();
      expect(hydrated?.conversationChannels?.[0].lastSeen).toBeDefined();
    });

    it('records explicit conversation-channel privacy and persists direct channel edits', () => {
      const contact = store.upsert({ displayName: 'DM User', discordUserId: 'dm-user-1' });
      store.recordChannelActivity(contact.id, 'Discord', '1313001762793197678', 'private');

      expect(store.getById(contact.id)?.conversationChannels).toEqual([
        expect.objectContaining({
          channel: 'discord',
          channelId: '1313001762793197678',
          privacyLevel: 'private',
        }),
      ]);

      expect(store.setConversationChannelPrivacy(contact.id, 'discord', '1313001762793197678', 'public')).toBe(true);
      expect(store.getConversationChannelPrivacy(contact.id, 'discord', '1313001762793197678')).toBe('public');
      expect(store.getById(contact.id)?.conversationChannels).toEqual([
        expect.objectContaining({
          channel: 'discord',
          channelId: '1313001762793197678',
          privacyLevel: 'public',
        }),
      ]);
    });
  });

  describe('mergeContacts', () => {
    it('remaps identities, activity, memories, and profiles to target', () => {
      db.exec(`
        CREATE TABLE l2_memories (
          id TEXT PRIMARY KEY,
          contact_id TEXT,
          content TEXT
        );

        CREATE TABLE contact_profiles (
          contact_id TEXT PRIMARY KEY,
          profile_json TEXT
        );
      `);

      const target = store.upsert({
        displayName: 'Target',
        discordUserId: 'target-discord-id',
        trustLevel: 'regular',
      });
      const source = store.upsert({
        displayName: 'Source',
        channelIdentities: [{ channel: 'api', userId: 'source-api-id' }],
        trustLevel: 'trusted',
      });

      db.prepare('INSERT INTO l2_memories (id, contact_id, content) VALUES (?, ?, ?)')
        .run('memory-1', source.id, 'source memory');
      db.prepare('INSERT INTO contact_profiles (contact_id, profile_json) VALUES (?, ?)')
        .run(source.id, '{"nickname":"source"}');

      db.prepare(`
        INSERT INTO contact_channel_activity (contact_id, channel, channel_id, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?)
      `).run(target.id, 'discord', 'guild:shared', '2024-01-01T00:00:00.000Z', '2024-01-05T00:00:00.000Z');
      db.prepare(`
        INSERT INTO contact_channel_activity (contact_id, channel, channel_id, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?)
      `).run(source.id, 'discord', 'guild:shared', '2023-12-01T00:00:00.000Z', '2024-01-10T00:00:00.000Z');
      db.prepare(`
        INSERT INTO contact_channel_activity (contact_id, channel, channel_id, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?)
      `).run(source.id, 'api', 'session:9', '2024-01-11T00:00:00.000Z', '2024-01-11T00:00:00.000Z');

      const merged = store.mergeContacts(source.id, target.id);
      expect(merged).toBe(true);
      expect(store.getById(source.id)).toBeUndefined();

      const sourceIdentityResolved = store.getByChannelIdentity('api', 'source-api-id');
      expect(sourceIdentityResolved?.id).toBe(target.id);

      const memoryContact = db.prepare('SELECT contact_id FROM l2_memories WHERE id = ?')
        .get('memory-1') as { contact_id: string };
      expect(memoryContact.contact_id).toBe(target.id);

      const profileContact = db.prepare('SELECT contact_id FROM contact_profiles')
        .get() as { contact_id: string };
      expect(profileContact.contact_id).toBe(target.id);

      const activityRows = db.prepare(`
        SELECT channel, channel_id, first_seen, last_seen
        FROM contact_channel_activity
        WHERE contact_id = ?
        ORDER BY channel ASC, channel_id ASC
      `).all(target.id) as Array<{
        channel: string;
        channel_id: string;
        first_seen: string;
        last_seen: string;
      }>;
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

      expect(store.getById(target.id)?.trustLevel).toBe('trusted');
    });

    it('prefers human-readable display name when target uses opaque identifier text', () => {
      const target = store.upsert({
        displayName: 'YOUR_DISCORD_USER_ID',
        discordUserId: 'YOUR_DISCORD_USER_ID',
      });
      const source = store.upsert({
        displayName: 'PrimaryUser',
        channelIdentities: [{ channel: 'discord', userId: 'primary-user' }],
      });

      const merged = store.mergeContacts(source.id, target.id);
      expect(merged).toBe(true);

      const updated = store.getById(target.id);
      expect(updated?.displayName).toBe('PrimaryUser');
      expect(updated?.discordUserId).toBe('YOUR_DISCORD_USER_ID');
    });
  });

  describe('updateNotes', () => {
    it('updates notes field', () => {
      const contact = store.upsert({ displayName: 'Heidi' });
      const result = store.updateNotes(contact.id, 'New notes');
      expect(result).toBe(true);

      const updated = store.getById(contact.id);
      expect(updated!.notes).toBe('New notes');
    });

    it('returns false for nonexistent id', () => {
      expect(store.updateNotes('nonexistent', 'notes')).toBe(false);
    });

    it('records notes mutations and supports query filters', () => {
      const contact = store.upsert({ displayName: 'Note Audit Target' });
      expect(store.updateNotes(contact.id, 'First note', 'agent:tool:contact_note')).toBe(true);
      expect(store.updateNotes(contact.id, 'First note', 'agent:tool:contact_note')).toBe(true);

      const byField = store.listMutationAuditEntries({ field: 'notes' });
      expect(byField).toHaveLength(1);
      expect(byField[0]).toMatchObject({
        contactId: contact.id,
        actor: 'agent:tool:contact_note',
        oldValue: null,
        newValue: 'First note',
      });

      const byActor = store.listMutationAuditEntries({ actor: 'agent:tool:contact_note', limit: 10 });
      expect(byActor.some(entry => entry.contactId === contact.id && entry.field === 'notes')).toBe(true);
    });
  });

  describe('profile and privacy audit trail', () => {
    it('records display name and nickname mutations with actor metadata', () => {
      const contact = store.upsert({ displayName: 'Profile Audit Target' });

      expect(store.updateIdentityProfile(contact.id, 'Updated Profile Name', 'Poppy', 'admin:api')).toBe(true);

      const entries = store.listMutationAuditEntries({ contactId: contact.id, limit: 10 });
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

    it('records relationship mutations', () => {
      const contact = store.upsert({ displayName: 'Relationship Audit Target', relationshipType: 'friend' });

      expect(store.updateRelationshipType(contact.id, 'partner', 'admin:api')).toBe(true);

      const entries = store.listMutationAuditEntries({ contactId: contact.id, field: 'relationship_type' });
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

    it('records linked identity and conversation channel privacy mutations', () => {
      const contact = store.upsert({ displayName: 'Privacy Audit Target' });
      expect(store.linkChannelIdentity(contact.id, 'discord', 'privacy-user', { privacyLevel: 'semi_private' })).toBe('linked');
      store.recordChannelActivity(contact.id, 'discord', '1313001762793197678', 'private');

      expect(store.setChannelPrivacy(contact.id, 'discord', 'privacy-user', 'private', 'admin:api')).toBe(true);
      expect(store.setConversationChannelPrivacy(
        contact.id,
        'discord',
        '1313001762793197678',
        'broadcast',
        'admin:api',
      )).toBe(true);

      const entries = store.listMutationAuditEntries({ contactId: contact.id, field: 'channel_privacy', limit: 10 });
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        contactId: contact.id,
        actor: 'admin:api',
        field: 'channel_privacy',
      });
      expect(entries[0].oldValue).toContain('"privacyLevel":"private"');
      expect(entries[0].newValue).toContain('"privacyLevel":"broadcast"');
      expect(entries[0].newValue).toContain('"channelId":"1313001762793197678"');
      expect(entries[1]).toMatchObject({
        contactId: contact.id,
        actor: 'admin:api',
        field: 'channel_privacy',
      });
      expect(entries[1].oldValue).toContain('"privacyLevel":"semi_private"');
      expect(entries[1].newValue).toContain('"privacyLevel":"private"');
      expect(entries[1].newValue).toContain('"userId":"privacy-user"');
    });

    it('records channel link and unlink mutations', () => {
      const contact = store.upsert({ displayName: 'Link Audit Target' });

      expect(store.linkChannelIdentity(
        contact.id,
        'telegram',
        'link-user',
        { privacyLevel: 'private' },
        'admin:api',
      )).toBe('linked');
      expect(store.unlinkChannelIdentity(contact.id, 'telegram', 'link-user', 'admin:api')).toBe(true);

      const entries = store.listMutationAuditEntries({ contactId: contact.id, field: 'channel_link', limit: 10 });
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        contactId: contact.id,
        actor: 'admin:api',
        field: 'channel_link',
        newValue: null,
      });
      expect(entries[0].oldValue).toContain('"channel":"telegram"');
      expect(entries[0].oldValue).toContain('"userId":"link-user"');
      expect(entries[1]).toMatchObject({
        contactId: contact.id,
        actor: 'admin:api',
        field: 'channel_link',
        oldValue: null,
      });
      expect(entries[1].newValue).toContain('"privacyLevel":"private"');
    });
  });

  describe('listAll', () => {
    it('returns all contacts', () => {
      store.upsert({ displayName: 'A', discordUserId: 'a' });
      store.upsert({ displayName: 'B', discordUserId: 'b' });
      store.upsert({ displayName: 'C', discordUserId: 'c' });

      const all = store.listAll();
      expect(all).toHaveLength(3);
    });

    it('returns empty array when no contacts', () => {
      expect(store.listAll()).toEqual([]);
    });
  });

  describe('resolveUserId', () => {
    it('creates new contact for unknown user', () => {
      const contact = store.resolveUserId('discord-new');
      expect(contact.discordUserId).toBe('discord-new');
      expect(contact.displayName).toBe('discord-new');  // Placeholder
      expect(contact.trustLevel).toBe('regular');
      expect(contact.relationshipType).toBe('stranger');
    });

    it('returns existing contact for known user', () => {
      const created = store.upsert({
        displayName: 'Ivan',
        discordUserId: 'discord-ivan',
        trustLevel: 'trusted',
      });
      const resolved = store.resolveUserId('discord-ivan');
      expect(resolved.id).toBe(created.id);
      expect(resolved.displayName).toBe('Ivan');
      expect(resolved.trustLevel).toBe('trusted');
    });

    it('updates lastSeen for existing contact', () => {
      const created = store.upsert({
        displayName: 'Judy',
        discordUserId: 'discord-judy',
      });

      // Resolve again — should update lastSeen
      const resolved = store.resolveUserId('discord-judy');
      // The lastSeen should be updated (may or may not differ within same ms)
      expect(resolved.lastSeen).toBeDefined();
      expect(resolved.id).toBe(created.id);
    });

    it('creates primary user with correct defaults', () => {
      const contact = store.resolveUserId(PRIMARY_USER_ID);
      expect(contact.trustLevel).toBe('primary');
      expect(contact.relationshipType).toBe('partner');
      expect(contact.discordUserId).toBe(PRIMARY_USER_ID);
    });
  });

  describe('resolveChannelIdentity', () => {
    it('creates channel-aware contact mappings for non-discord channels', () => {
      const contact = store.resolveChannelIdentity('api', 'api-user-1', 'API User');
      expect(contact.displayName).toBe('API User');
      expect(contact.channelIdentities).toEqual([
        { channel: 'api', userId: 'api-user-1' },
      ]);
    });

    it('reuses canonical contact when linked channel identity exists', () => {
      const contact = store.upsert({ displayName: 'V', discordUserId: PRIMARY_USER_ID });
      const link = store.linkChannelIdentity(contact.id, 'api', 'v-api-id');
      expect(link).toBe('linked');

      const resolved = store.resolveChannelIdentity('api', 'v-api-id', 'V API');
      expect(resolved.id).toBe(contact.id);
      expect(resolved.trustLevel).toBe('primary');
    });

    it('reconciles duplicate primary contacts into canonical identity owner', () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO contacts (
          id, discord_user_id, display_name, trust_level, relationship_type,
          emotional_baseline, first_seen, last_seen, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('primary-owner', PRIMARY_USER_ID, 'Primary Owner', 'regular', 'stranger', '{}', now, now, null);
      db.prepare(`
        INSERT INTO contact_channel_ids (
          contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run('primary-owner', 'discord', PRIMARY_USER_ID, 'semi_private', now, now);

      db.prepare(`
        INSERT INTO contacts (
          id, discord_user_id, display_name, trust_level, relationship_type,
          emotional_baseline, first_seen, last_seen, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('duplicate-primary', 'duplicate-discord-id', 'Duplicate Primary', 'primary', 'partner', '{}', now, now, null);
      db.prepare(`
        INSERT INTO contact_channel_ids (
          contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run('duplicate-primary', 'api', 'primary-api-alias', 'private', now, now);

      const resolved = store.resolveChannelIdentity('discord', PRIMARY_USER_ID, 'V');
      expect(resolved.id).toBe('primary-owner');
      expect(resolved.trustLevel).toBe('primary');
      expect(resolved.relationshipType).toBe('partner');
      expect(store.getById('duplicate-primary')).toBeUndefined();
      expect(store.getByChannelIdentity('api', 'primary-api-alias')?.id).toBe('primary-owner');
    });
  });

  describe('linkChannelIdentity', () => {
    it('returns conflict when identity is already linked to another contact', () => {
      const first = store.upsert({
        displayName: 'First',
        channelIdentities: [{ channel: 'api', userId: 'shared-api-id' }],
      });
      const second = store.upsert({ displayName: 'Second', discordUserId: 'second-discord-id' });

      const result = store.linkChannelIdentity(second.id, 'api', 'shared-api-id');
      expect(result).toBe('identity_conflict');

      const found = store.getByChannelIdentity('api', 'shared-api-id');
      expect(found?.id).toBe(first.id);
    });
  });

  describe('identity link verification challenges', () => {
    it('issues a challenge, verifies it, and commits the target link', () => {
      const contact = store.upsert({
        displayName: 'PrimaryUser',
        channelIdentities: [{ channel: 'discord', userId: 'user-discord' }],
      });

      const challenge = store.createIdentityLinkChallenge({
        contactId: contact.id,
        sourceChannel: 'discord',
        sourceUserId: 'user-discord',
        targetChannel: 'api',
        targetUserId: 'user-api',
      });

      expect(challenge.status).toBe('challenge_created');
      if (challenge.status !== 'challenge_created') return;

      const verified = store.verifyIdentityLinkChallenge({
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
      expect(store.getByChannelIdentity('api', 'user-api')?.id).toBe(contact.id);
      expect(store.listIdentityLinkVerifications(5)[0]?.status).toBe('verified');
    });

    it('rejects replayed verification challenges', () => {
      const contact = store.upsert({
        displayName: 'Replay Tester',
        channelIdentities: [{ channel: 'discord', userId: 'replay-discord' }],
      });

      const challenge = store.createIdentityLinkChallenge({
        contactId: contact.id,
        sourceChannel: 'discord',
        sourceUserId: 'replay-discord',
        targetChannel: 'api',
        targetUserId: 'replay-api',
      });
      expect(challenge.status).toBe('challenge_created');
      if (challenge.status !== 'challenge_created') return;

      const first = store.verifyIdentityLinkChallenge({
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

      const second = store.verifyIdentityLinkChallenge({
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
    it('round-trips emotional baseline through JSON', () => {
      const baseline = { warmth: 0.7, formality: 0.3, playfulness: 0.9 };
      const contact = store.upsert({
        displayName: 'Kim',
        emotionalBaseline: baseline,
      });
      const found = store.getById(contact.id);
      expect(found!.emotionalBaseline).toEqual(baseline);
    });

    it('defaults to empty object when not provided', () => {
      const contact = store.upsert({ displayName: 'Lee' });
      const found = store.getById(contact.id);
      // Empty JSON object stored, should parse to empty object
      expect(found!.emotionalBaseline).toEqual({});
    });

    it('exposes an empty-to-populated bounded emotional time series per contact', () => {
      const contact = store.upsert({ displayName: 'Timeline Learner' });

      expect(store.getEmotionalTimeSeries(contact.id)).toEqual([]);

      store.updateEmotionalBaseline(contact.id, {
        valence: 0.25,
        confidence: 0.9,
        observedAtMs: 1_000,
      });
      store.updateEmotionalBaseline(contact.id, {
        valence: -0.4,
        confidence: 0.6,
        observedAtMs: 2_000,
      });
      store.updateEmotionalBaseline(contact.id, {
        valence: 0.7,
        confidence: 0.8,
        observedAtMs: 3_000,
      });

      expect(store.getEmotionalTimeSeries(contact.id)).toEqual([
        { valence: 0.25, confidence: 0.9, observedAtMs: 1_000 },
        { valence: -0.4, confidence: 0.6, observedAtMs: 2_000 },
        { valence: 0.7, confidence: 0.8, observedAtMs: 3_000 },
      ]);
      expect(store.getEmotionalTimeSeries(contact.id, 2)).toEqual([
        { valence: -0.4, confidence: 0.6, observedAtMs: 2_000 },
        { valence: 0.7, confidence: 0.8, observedAtMs: 3_000 },
      ]);
    });

    it('learns baseline values dynamically from observed emotional signals', () => {
      const contact = store.upsert({
        displayName: 'Mood Learner',
        emotionalBaseline: { warmth: 0.7 },
      });

      const updated = store.updateEmotionalBaseline(contact.id, {
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

      const snapshot = store.getEmotionalSnapshot(contact.id);
      expect(snapshot).toEqual(expect.objectContaining({
        baselineValence: 0.32,
        moodValence: 0.44,
        moodDrift: 0.12,
        moodSamples: 1,
        lastMoodUpdateEpochMs: 1_000,
      }));
    });

    it('preserves intra-session mood drift across updates', () => {
      const contact = store.upsert({ displayName: 'Session Mood' });
      store.updateEmotionalBaseline(contact.id, {
        valence: 0.6,
        confidence: 1,
        observedAtMs: 1_000,
      });

      const updated = store.updateEmotionalBaseline(contact.id, {
        valence: -0.4,
        confidence: 1,
        observedAtMs: 2_000,
      });

      expect(updated).toBeDefined();
      expect(updated?.emotionalBaseline?.moodSamples).toBe(2);
      expect(updated?.emotionalBaseline?.moodValence).toBeLessThan(0);
      expect(updated?.emotionalBaseline?.moodDrift).toBeLessThan(0);

      const snapshot = store.getEmotionalSnapshot(contact.id);
      expect(snapshot).toEqual(expect.objectContaining({
        moodSamples: 2,
        lastMoodUpdateEpochMs: 2_000,
      }));
    });
  });

  describe('no primaryUserId configured', () => {
    it('treats all users as regular when no primaryUserId set', () => {
      const storeNoPrimary = new ContactStore(db);
      // Re-create tables on same db is fine (IF NOT EXISTS)
      const contact = storeNoPrimary.upsert({
        displayName: 'Anyone',
        discordUserId: 'discord-anyone',
      });
      expect(contact.trustLevel).toBe('regular');
    });
  });

  describe('deleteContact', () => {
    it('deletes a regular contact and its channel links', () => {
      const contact = store.upsert({ displayName: 'Deleteable' });
      store.linkChannelIdentity(contact.id, 'discord', '999');
      expect(store.getById(contact.id)).toBeDefined();

      const result = store.deleteContact(contact.id);
      expect(result).toBe(true);
      expect(store.getById(contact.id)).toBeUndefined();

      // Channel identity should also be gone
      expect(store.getByChannelIdentity('discord', '999')).toBeUndefined();
    });

    it('refuses to delete the primary contact', () => {
      const primary = store.upsert({
        displayName: 'Primary',
        discordUserId: PRIMARY_USER_ID,
      });
      expect(primary.trustLevel).toBe('primary');

      const result = store.deleteContact(primary.id);
      expect(result).toBe(false);
      expect(store.getById(primary.id)).toBeDefined();
    });

    it('returns false for non-existent contact', () => {
      expect(store.deleteContact('no-such-id')).toBe(false);
    });
  });

  describe('unlinkChannelIdentity', () => {
    it('removes a specific channel identity link', () => {
      const contact = store.upsert({ displayName: 'Multi' });
      store.linkChannelIdentity(contact.id, 'api', '111');
      store.linkChannelIdentity(contact.id, 'telegram', '222');

      const result = store.unlinkChannelIdentity(contact.id, 'api', '111');
      expect(result).toBe(true);

      // API link gone
      expect(store.getByChannelIdentity('api', '111')).toBeUndefined();
      // Telegram link still present
      expect(store.getByChannelIdentity('telegram', '222')).toBeDefined();
    });

    it('returns false for non-existent contact', () => {
      expect(store.unlinkChannelIdentity('no-such-id', 'discord', '111')).toBe(false);
    });

    it('returns false when channel identity does not exist on contact', () => {
      const contact = store.upsert({ displayName: 'Solo' });
      expect(store.unlinkChannelIdentity(contact.id, 'discord', 'nope')).toBe(false);
    });
  });

  describe('deleteConversationChannel', () => {
    it('removes a specific persisted conversation channel', () => {
      const contact = store.upsert({ displayName: 'Conversation User' });
      store.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:short-check', 'semi_private');
      store.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:lab:pi5', 'private');

      const result = store.deleteConversationChannel(contact.id, 'psfn-amica', 'psfn-amica:short-check');
      expect(result).toBe(true);

      expect(store.getById(contact.id)?.conversationChannels).toEqual([
        expect.objectContaining({
          channel: 'psfn-amica',
          channelId: 'psfn-amica:lab:pi5',
        }),
      ]);

      const entries = store.listMutationAuditEntries({ contactId: contact.id, field: 'conversation_channel', limit: 10 });
      expect(entries[0]).toMatchObject({
        contactId: contact.id,
        field: 'conversation_channel',
        newValue: null,
      });
      expect(entries[0].oldValue).toContain('"channel":"psfn-amica"');
      expect(entries[0].oldValue).toContain('"channelId":"psfn-amica:short-check"');
    });

    it('returns false when the conversation channel is not linked to the contact', () => {
      const contact = store.upsert({ displayName: 'Conversation User' });
      expect(store.deleteConversationChannel(contact.id, 'psfn-amica', 'psfn-amica:missing')).toBe(false);
    });
  });
});

describe('ContactStore machine-intelligence flag', () => {
  let db: Database.Database;
  let store: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ContactStore(db, PRIMARY_USER_ID);
  });

  it('defaults to not-MI, sets and round-trips the flag with audit', () => {
    const contact = store.resolveChannelIdentity('discord', 'artemis-001', 'Artemis');
    expect(contact.isMachineIntelligence).toBeUndefined();

    expect(store.setMachineIntelligence(contact.id, true, 'test')).toBe(true);
    const flagged = store.getById(contact.id);
    expect(flagged?.isMachineIntelligence).toBe(true);

    // Setting the same value is a no-op success; clearing works too.
    expect(store.setMachineIntelligence(contact.id, true)).toBe(true);
    expect(store.setMachineIntelligence(contact.id, false)).toBe(true);
    expect(store.getById(contact.id)?.isMachineIntelligence).toBeUndefined();

    const audit = store.listMutationAuditEntries({ contactId: contact.id });
    expect(audit.some(entry => entry.field === 'is_machine_intelligence')).toBe(true);
  });

  it('returns false for unknown contacts', () => {
    expect(store.setMachineIntelligence('missing-contact', true)).toBe(false);
  });

  it('survives schema migration on a pre-flag database', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        discord_user_id TEXT UNIQUE,
        display_name TEXT NOT NULL,
        nickname TEXT,
        trust_level TEXT NOT NULL DEFAULT 'regular',
        relationship_type TEXT NOT NULL DEFAULT 'stranger',
        emotional_baseline TEXT DEFAULT '{}',
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        notes TEXT
      );
    `);
    legacy.prepare(`
      INSERT INTO contacts (id, display_name, first_seen, last_seen)
      VALUES ('legacy-1', 'Legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
    const migrated = new ContactStore(legacy, PRIMARY_USER_ID);
    expect(migrated.getById('legacy-1')?.isMachineIntelligence).toBeUndefined();
    expect(migrated.setMachineIntelligence('legacy-1', true)).toBe(true);
    expect(migrated.getById('legacy-1')?.isMachineIntelligence).toBe(true);
    legacy.close();
  });
});
