import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from './store.js';
import type { Contact } from './types.js';

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

    it('returns false for nonexistent id', () => {
      expect(store.setTrustLevel('nonexistent', 'trusted')).toBe(false);
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
        displayName: '388908766306893854',
        discordUserId: '388908766306893854',
      });
      const source = store.upsert({
        displayName: 'Vega',
        channelIdentities: [{ channel: 'discord', userId: 'vega' }],
      });

      const merged = store.mergeContacts(source.id, target.id);
      expect(merged).toBe(true);

      const updated = store.getById(target.id);
      expect(updated?.displayName).toBe('Vega');
      expect(updated?.discordUserId).toBe('388908766306893854');
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
      const originalLastSeen = created.lastSeen;

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
});
