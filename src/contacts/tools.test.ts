import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from './store.js';
import {
  createContactSetTrustTool,
  createContactNoteTool,
  createContactLookupTool,
  createContactListTool,
} from './tools.js';

/** Extract text from AgentToolResult content array */
function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(c => c.text).join('');
}

describe('contact tools', () => {
  let db: Database.Database;
  let store: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ContactStore(db, 'primary-user-123');
  });

  // ── contact_set_trust ──

  describe('createContactSetTrustTool', () => {
    it('returns a valid AgentTool with correct name and schema', () => {
      const tool = createContactSetTrustTool(store);

      expect(tool.name).toBe('contact_set_trust');
      expect(tool.description).toBeTruthy();
      expect(tool.label).toBe('contact_set_trust');
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    });

    it('sets trust level for an existing contact', async () => {
      const contact = store.upsert({ displayName: 'Alice', discordUserId: 'alice-discord' });
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute('call-1', {
        contactId: contact.id,
        trustLevel: 'trusted',
      });

      expect(resultText(result)).toContain('set to trusted');
      expect(store.getById(contact.id)!.trustLevel).toBe('trusted');
    });

    it('returns error for invalid trust level', async () => {
      const contact = store.upsert({ displayName: 'Bob' });
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute('call-2', {
        contactId: contact.id,
        trustLevel: 'superadmin',
      });

      expect(resultText(result)).toContain('Invalid trust level');
      expect(resultText(result)).toContain('superadmin');
    });

    it('returns error for contact not found', async () => {
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute('call-3', {
        contactId: 'nonexistent-id',
        trustLevel: 'trusted',
      });

      expect(resultText(result)).toContain('not found');
    });

    it('returns error when trying to change primary user trust level', async () => {
      // Create a primary user contact
      store.upsert({ displayName: 'V', discordUserId: 'primary-user-123' });
      const primary = store.getByDiscordUserId('primary-user-123')!;
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute('call-4', {
        contactId: primary.id,
        trustLevel: 'regular',
      });

      // setTrustLevel returns false for primary user
      expect(resultText(result)).toContain('not found or is the primary user');
      // Trust level should remain 'primary'
      expect(store.getById(primary.id)!.trustLevel).toBe('primary');
    });
  });

  // ── contact_note ──

  describe('createContactNoteTool', () => {
    it('returns a valid AgentTool with correct name and schema', () => {
      const tool = createContactNoteTool(store);

      expect(tool.name).toBe('contact_note');
      expect(tool.description).toBeTruthy();
      expect(tool.label).toBe('contact_note');
      expect(tool.parameters).toBeDefined();
    });

    it('updates notes for an existing contact', async () => {
      const contact = store.upsert({ displayName: 'Charlie' });
      const tool = createContactNoteTool(store);

      const result = await tool.execute('call-5', {
        contactId: contact.id,
        notes: 'Likes cats and programming',
      });

      expect(resultText(result)).toContain('Notes updated');
      expect(store.getById(contact.id)!.notes).toBe('Likes cats and programming');
    });

    it('returns error for contact not found', async () => {
      const tool = createContactNoteTool(store);

      const result = await tool.execute('call-6', {
        contactId: 'nonexistent-id',
        notes: 'Some notes',
      });

      expect(resultText(result)).toContain('not found');
    });
  });

  // ── contact_lookup ──

  describe('createContactLookupTool', () => {
    it('returns a valid AgentTool with correct name and schema', () => {
      const tool = createContactLookupTool(store);

      expect(tool.name).toBe('contact_lookup');
      expect(tool.description).toBeTruthy();
      expect(tool.label).toBe('contact_lookup');
      expect(tool.parameters).toBeDefined();
    });

    it('looks up a contact by internal ID', async () => {
      const contact = store.upsert({ displayName: 'Dana', notes: 'Works in design' });
      const tool = createContactLookupTool(store);

      const result = await tool.execute('call-7', { contactId: contact.id });

      expect(resultText(result)).toContain('Contact: Dana');
      expect(resultText(result)).toContain('Trust: regular');
      expect(resultText(result)).toContain('Relationship: stranger');
      expect(resultText(result)).toContain('Notes: Works in design');
    });

    it('looks up a contact by Discord user ID', async () => {
      store.upsert({ displayName: 'Eve', discordUserId: 'eve-discord-456' });
      const tool = createContactLookupTool(store);

      const result = await tool.execute('call-8', { contactId: 'eve-discord-456' });

      expect(resultText(result)).toContain('Contact: Eve');
      expect(resultText(result)).toContain('Trust: regular');
    });

    it('returns not found for unknown ID', async () => {
      const tool = createContactLookupTool(store);

      const result = await tool.execute('call-9', { contactId: 'unknown-id' });

      expect(resultText(result)).toContain('No contact found');
    });

    it('does not include Notes line when notes are empty', async () => {
      store.upsert({ displayName: 'Frank' });
      const frank = store.listAll().find(c => c.displayName === 'Frank')!;
      const tool = createContactLookupTool(store);

      const result = await tool.execute('call-10', { contactId: frank.id });

      expect(resultText(result)).toContain('Contact: Frank');
      expect(resultText(result)).not.toContain('Notes:');
    });
  });

  // ── contact_list ──

  describe('createContactListTool', () => {
    it('returns a valid AgentTool with correct name and schema', () => {
      const tool = createContactListTool(store);

      expect(tool.name).toBe('contact_list');
      expect(tool.description).toBeTruthy();
      expect(tool.label).toBe('contact_list');
      expect(tool.parameters).toBeDefined();
    });

    it('returns empty message when no contacts', async () => {
      const tool = createContactListTool(store);

      const result = await tool.execute('call-11', {});

      expect(resultText(result)).toContain('No contacts in address book');
    });

    it('lists all contacts with trust and relationship info', async () => {
      store.upsert({ displayName: 'Grace', trustLevel: 'trusted', relationshipType: 'friend', notes: 'Met at conf' });
      store.upsert({ displayName: 'Hank', trustLevel: 'regular', relationshipType: 'acquaintance' });
      const tool = createContactListTool(store);

      const result = await tool.execute('call-12', {});

      expect(resultText(result)).toContain('Contacts (2)');
      expect(resultText(result)).toContain('Grace [trusted/friend]');
      expect(resultText(result)).toContain('Met at conf');
      expect(resultText(result)).toContain('Hank [regular/acquaintance]');
    });

    it('omits notes dash when contact has no notes', async () => {
      store.upsert({ displayName: 'Iris' });
      const tool = createContactListTool(store);

      const result = await tool.execute('call-13', {});

      // Should have the contact line but no ' — ' for notes
      const text = resultText(result);
      expect(text).toContain('Iris [regular/stranger]');
      // The line should not end with ' — ' or contain ' — ' since there are no notes
      const irisLine = text.split('\n').find((l: string) => l.includes('Iris'))!;
      expect(irisLine).not.toContain(' — ');
    });
  });
});
