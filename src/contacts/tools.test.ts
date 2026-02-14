import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from './store.js';
import {
  createContactSetTrustTool,
  createContactNoteTool,
  createContactLookupTool,
  createContactListTool,
} from './tools.js';

describe('contact tools', () => {
  let db: Database.Database;
  let store: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ContactStore(db, 'primary-user-123');
  });

  // ── contact_set_trust ──

  describe('createContactSetTrustTool', () => {
    it('returns a valid SubstrateTool with correct name and schema', () => {
      const tool = createContactSetTrustTool(store);

      expect(tool.name).toBe('contact_set_trust');
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toEqual(['contactId', 'trustLevel']);
      expect(typeof tool.execute).toBe('function');

      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.contactId).toBeDefined();
      expect(props.trustLevel).toBeDefined();
      expect(props.trustLevel.enum).toContain('primary');
      expect(props.trustLevel.enum).toContain('trusted');
      expect(props.trustLevel.enum).toContain('regular');
      expect(props.trustLevel.enum).toContain('public');
    });

    it('sets trust level for an existing contact', async () => {
      const contact = store.upsert({ displayName: 'Alice', discordUserId: 'alice-discord' });
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute({
        contactId: contact.id,
        trustLevel: 'trusted',
      });

      expect(result.content).toContain('set to trusted');
      expect(store.getById(contact.id)!.trustLevel).toBe('trusted');
    });

    it('returns error for invalid trust level', async () => {
      const contact = store.upsert({ displayName: 'Bob' });
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute({
        contactId: contact.id,
        trustLevel: 'superadmin',
      });

      expect(result.content).toContain('Invalid trust level');
      expect(result.content).toContain('superadmin');
    });

    it('returns error for contact not found', async () => {
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute({
        contactId: 'nonexistent-id',
        trustLevel: 'trusted',
      });

      expect(result.content).toContain('not found');
    });

    it('returns error when trying to change primary user trust level', async () => {
      // Create a primary user contact
      store.upsert({ displayName: 'V', discordUserId: 'primary-user-123' });
      const primary = store.getByDiscordUserId('primary-user-123')!;
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute({
        contactId: primary.id,
        trustLevel: 'regular',
      });

      // setTrustLevel returns false for primary user
      expect(result.content).toContain('not found or is the primary user');
      // Trust level should remain 'primary'
      expect(store.getById(primary.id)!.trustLevel).toBe('primary');
    });
  });

  // ── contact_note ──

  describe('createContactNoteTool', () => {
    it('returns a valid SubstrateTool with correct name and schema', () => {
      const tool = createContactNoteTool(store);

      expect(tool.name).toBe('contact_note');
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toEqual(['contactId', 'notes']);
    });

    it('updates notes for an existing contact', async () => {
      const contact = store.upsert({ displayName: 'Charlie' });
      const tool = createContactNoteTool(store);

      const result = await tool.execute({
        contactId: contact.id,
        notes: 'Likes cats and programming',
      });

      expect(result.content).toContain('Notes updated');
      expect(store.getById(contact.id)!.notes).toBe('Likes cats and programming');
    });

    it('returns error for contact not found', async () => {
      const tool = createContactNoteTool(store);

      const result = await tool.execute({
        contactId: 'nonexistent-id',
        notes: 'Some notes',
      });

      expect(result.content).toContain('not found');
    });
  });

  // ── contact_lookup ──

  describe('createContactLookupTool', () => {
    it('returns a valid SubstrateTool with correct name and schema', () => {
      const tool = createContactLookupTool(store);

      expect(tool.name).toBe('contact_lookup');
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toEqual(['contactId']);
    });

    it('looks up a contact by internal ID', async () => {
      const contact = store.upsert({ displayName: 'Dana', notes: 'Works in design' });
      const tool = createContactLookupTool(store);

      const result = await tool.execute({ contactId: contact.id });

      expect(result.content).toContain('Contact: Dana');
      expect(result.content).toContain('Trust: regular');
      expect(result.content).toContain('Relationship: stranger');
      expect(result.content).toContain('Notes: Works in design');
    });

    it('looks up a contact by Discord user ID', async () => {
      store.upsert({ displayName: 'Eve', discordUserId: 'eve-discord-456' });
      const tool = createContactLookupTool(store);

      const result = await tool.execute({ contactId: 'eve-discord-456' });

      expect(result.content).toContain('Contact: Eve');
      expect(result.content).toContain('Trust: regular');
    });

    it('returns not found for unknown ID', async () => {
      const tool = createContactLookupTool(store);

      const result = await tool.execute({ contactId: 'unknown-id' });

      expect(result.content).toContain('No contact found');
    });

    it('does not include Notes line when notes are empty', async () => {
      store.upsert({ displayName: 'Frank' });
      const frank = store.listAll().find(c => c.displayName === 'Frank')!;
      const tool = createContactLookupTool(store);

      const result = await tool.execute({ contactId: frank.id });

      expect(result.content).toContain('Contact: Frank');
      expect(result.content).not.toContain('Notes:');
    });
  });

  // ── contact_list ──

  describe('createContactListTool', () => {
    it('returns a valid SubstrateTool with correct name and schema', () => {
      const tool = createContactListTool(store);

      expect(tool.name).toBe('contact_list');
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    });

    it('returns empty message when no contacts', async () => {
      const tool = createContactListTool(store);

      const result = await tool.execute({});

      expect(result.content).toContain('No contacts in address book');
    });

    it('lists all contacts with trust and relationship info', async () => {
      store.upsert({ displayName: 'Grace', trustLevel: 'trusted', relationshipType: 'friend', notes: 'Met at conf' });
      store.upsert({ displayName: 'Hank', trustLevel: 'regular', relationshipType: 'acquaintance' });
      const tool = createContactListTool(store);

      const result = await tool.execute({});

      expect(result.content).toContain('Contacts (2)');
      expect(result.content).toContain('Grace [trusted/friend]');
      expect(result.content).toContain('Met at conf');
      expect(result.content).toContain('Hank [regular/acquaintance]');
    });

    it('omits notes dash when contact has no notes', async () => {
      store.upsert({ displayName: 'Iris' });
      const tool = createContactListTool(store);

      const result = await tool.execute({});

      // Should have the contact line but no ' — ' for notes
      expect(result.content).toContain('Iris [regular/stranger]');
      // The line should not end with ' — ' or contain ' — ' since there are no notes
      const irisLine = result.content.split('\n').find((l: string) => l.includes('Iris'))!;
      expect(irisLine).not.toContain(' — ');
    });
  });
});
