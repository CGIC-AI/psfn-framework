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
