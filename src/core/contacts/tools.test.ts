import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from './store.js';
import {
  createContactTool,
  createContactLinkIdentityTool,
  createContactListTool,
  createContactLookupTool,
  createContactNoteTool,
  createContactSetChannelPrivacyTool,
  createContactSetTrustTool,
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

  describe('createContactTool', () => {
    it('returns a unified contact tool with canonical metadata', () => {
      const tool = createContactTool(store);

      expect(tool.name).toBe('contact');
      expect(tool.label).toBe('contact');
      expect(tool.description).toContain('Unified contact surface');
      expect(tool.description).toContain('action=search with query');
      expect(tool.description).toContain('action=lookup with exact contactId');
      expect((tool.parameters as any).properties.action.anyOf.map((entry: { const: string }) => entry.const)).toContain('search');
      expect((tool.parameters as any).properties.query.description).toContain('Required for action=search');
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    });

    it('defaults to list when called without params', async () => {
      store.upsert({ displayName: 'Grace', trustLevel: 'trusted', relationshipType: 'friend' });
      const tool = createContactTool(store);

      const result = await tool.execute('contact-list-default', {});

      expect(resultText(result)).toContain('Contacts (1)');
      expect(resultText(result)).toContain('Grace [trusted/friend]');
    });

    it('defaults to lookup when only contactId is provided', async () => {
      const contact = store.upsert({ displayName: 'Dana', notes: 'Works in design' });
      const tool = createContactTool(store);

      const result = await tool.execute('contact-lookup-default', { contactId: contact.id });

      expect(resultText(result)).toContain(`Canonical ID: ${contact.id}`);
      expect(resultText(result)).toContain('Notes: Works in design');
    });

    it('updates trust through action=set_trust while preserving guardrails', async () => {
      const contact = store.upsert({ displayName: 'Alice', discordUserId: 'alice-discord' });
      const tool = createContactTool(store);

      const result = await tool.execute('contact-set-trust', {
        action: 'set_trust',
        contactId: contact.id,
        trustLevel: 'public',
      });

      expect(resultText(result)).toContain('set to public');
      expect(store.getById(contact.id)!.trustLevel).toBe('public');
    });

    it('declares action-aware capability requirements for reads and mutations', () => {
      const tool = createContactTool(store) as ReturnType<typeof createContactTool> & {
        requiredCapability?: (params: Record<string, unknown>) => unknown;
      };

      expect(tool.requiredCapability?.({ action: 'list' })).toBe('identity.read');
      expect(tool.requiredCapability?.({ action: 'search', query: 'grace' })).toBe('identity.read');
      expect(tool.requiredCapability?.({ action: 'lookup', contactId: 'contact-1' })).toBe('identity.read');
      expect(tool.requiredCapability?.({ action: 'note', contactId: 'contact-1', notes: 'x' })).toBe('identity.write.runtime');
      expect(tool.requiredCapability?.({ action: 'set_trust', contactId: 'contact-1', trustLevel: 'public' })).toBe('identity.write.runtime');
      expect(tool.requiredCapability?.({ action: 'link_identity', contactId: 'contact-1' })).toBe('identity.write.runtime');
      expect(tool.requiredCapability?.({ action: 'set_channel_privacy', contactId: 'contact-1' })).toBe('identity.write.runtime');
    });

    it('rejects retired lookup action aliases inside the unified tool', async () => {
      const contact = store.upsert({ displayName: 'Alias User', notes: 'Alias works' });
      const tool = createContactTool(store);

      const result = await tool.execute('contact-legacy-alias', {
        action: 'contact_lookup',
        contactId: contact.id,
      });

      expect(resultText(result)).toContain('action must be one of');
      expect(result.details?.isError).toBe(true);
    });

    it('rejects retired list action aliases inside the unified tool', async () => {
      store.upsert({ displayName: 'Grace', trustLevel: 'trusted', relationshipType: 'friend' });
      const tool = createContactTool(store);

      const result = await tool.execute('contact-legacy-list-alias', {
        action: 'contact_list',
      });

      expect(resultText(result)).toContain('action must be one of');
      expect(result.details?.isError).toBe(true);
    });

    it('fails closed when mutation-shaped params are supplied without an action', async () => {
      const contact = store.upsert({ displayName: 'Needs Action' });
      const tool = createContactTool(store);

      const result = await tool.execute('contact-missing-action', {
        contactId: contact.id,
        notes: 'should fail',
      });

      expect(resultText(result)).toContain('action is required');
      expect(result.details?.isError).toBe(true);
    });

    it('searches contacts separately from list and lookup and returns exact contactIds', async () => {
      const grace = store.upsert({
        displayName: 'Grace Hopper',
        nickname: 'Amazing Grace',
        notes: 'Compiler history and navy stories',
        channelIdentities: [{ channel: 'discord', userId: 'grace-discord' }],
      });
      store.upsert({ displayName: 'Ada Lovelace', notes: 'Analytical engine notes' });
      const tool = createContactTool(store);

      const result = await tool.execute('contact-search', {
        action: 'search',
        query: 'compiler discord',
      });
      const text = resultText(result);

      expect(text).toContain('Contact search results for "compiler discord" (1)');
      expect(text).toContain(`${grace.id}: Amazing Grace [regular/stranger]`);
      expect(text).toContain('discord:grace-discord');
      expect(text).toContain('Pass an exact contactId from these results to action=lookup');
    });

    it('names missing search query and gives a minimal valid example', async () => {
      const tool = createContactTool(store);

      const result = await tool.execute('contact-search-missing-query', {
        action: 'search',
      });
      const text = resultText(result);

      expect(text).toContain('Missing required field "query" for action=search');
      expect(text).toContain('Minimal valid JSON: {"action":"search","query":"name, handle, channel, or note text"}');
      expect(text).toContain('do not retry action=search without a non-empty query');
      expect(result.details?.isError).toBe(true);
    });
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

    it('sets low-tier trust level for an existing contact', async () => {
      const contact = store.upsert({ displayName: 'Alice', discordUserId: 'alice-discord' });
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute('call-1', {
        contactId: contact.id,
        trustLevel: 'public',
      });

      expect(resultText(result)).toContain('set to public');
      expect(store.getById(contact.id)!.trustLevel).toBe('public');
    });

    it('denies autonomous high-tier trust updates', async () => {
      const contact = store.upsert({ displayName: 'High Tier Target', discordUserId: 'trusted-target' });
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute('call-1b', {
        contactId: contact.id,
        trustLevel: 'trusted',
      });

      expect(resultText(result)).toContain('manual admin approval');
      expect(store.getById(contact.id)!.trustLevel).toBe('regular');
      expect(result.details?.isError).toBe(true);
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
      expect(result.details?.isError).toBe(true);
    });

    it('returns error for contact not found', async () => {
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute('call-3', {
        contactId: 'nonexistent-id',
        trustLevel: 'trusted',
      });

      expect(resultText(result)).toContain('not found');
      expect(result.details?.isError).toBe(true);
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
      expect(result.details?.isError).toBe(true);
    });

    it('returns canonical error when setTrustLevel throws', async () => {
      const contact = store.upsert({ displayName: 'Throwy' });
      vi.spyOn(store, 'setTrustLevel').mockImplementation(() => {
        throw new Error('store unavailable');
      });
      const tool = createContactSetTrustTool(store);

      const result = await tool.execute('call-4b', {
        contactId: contact.id,
        trustLevel: 'trusted',
      });

      expect(resultText(result)).toContain('contact_set_trust failed');
      expect(resultText(result)).toContain('store unavailable');
      expect(result.details?.isError).toBe(true);
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
      expect(result.details?.isError).toBe(true);
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

      expect(resultText(result)).toContain(`Canonical ID: ${contact.id}`);
      expect(resultText(result)).toContain('Contact: Dana');
      expect(resultText(result)).toContain('Trust: regular');
      expect(resultText(result)).toContain('Relationship: stranger');
      expect(resultText(result)).toContain('Notes: Works in design');
    });

    it('prefers nickname over display name in lookup output', async () => {
      const contact = store.upsert({ displayName: 'Alex Example', nickname: 'A' });
      const tool = createContactLookupTool(store);

      const result = await tool.execute('call-7b', { contactId: contact.id });

      expect(resultText(result)).toContain('Contact: A');
      expect(resultText(result)).not.toContain('Contact: Alex Example');
    });

    it('looks up a contact by Discord user ID', async () => {
      store.upsert({ displayName: 'Eve', discordUserId: 'eve-discord-456' });
      const tool = createContactLookupTool(store);

      const result = await tool.execute('call-8', { contactId: 'eve-discord-456' });

      expect(resultText(result)).toContain('Contact: Eve');
      expect(resultText(result)).toContain('Trust: regular');
    });

    it('looks up a contact by channel identity syntax', async () => {
      const contact = store.upsert({
        displayName: 'Sky',
        channelIdentities: [{ channel: 'api', userId: 'sky-api-1' }],
      });
      const tool = createContactLookupTool(store);

      const result = await tool.execute('call-8b', { contactId: 'api:sky-api-1' });

      expect(resultText(result)).toContain(`Canonical ID: ${contact.id}`);
      expect(resultText(result)).toContain('Contact: Sky');
      expect(resultText(result)).toContain('Identities: api:sky-api-1');
    });

    it('returns not found for unknown ID', async () => {
      const tool = createContactLookupTool(store);

      const result = await tool.execute('call-9', { contactId: 'unknown-id' });

      expect(resultText(result)).toContain('No contact found');
      expect(result.details?.isError).toBe(true);
    });

    it('gives a contactId recovery path when lookup guesses a display name', async () => {
      const contact = store.upsert({
        displayName: 'Grace',
        channelIdentities: [{ channel: 'discord', userId: 'grace-discord' }],
      });
      const listTool = createContactListTool(store);
      const lookupTool = createContactLookupTool(store);

      const list = await listTool.execute('contact-list-recovery', {});
      const miss = await lookupTool.execute('contact-lookup-display-name-miss', { contactId: 'Grace' });
      const text = resultText(miss);

      expect(resultText(list)).toContain(`${contact.id}: Grace`);
      expect(text).toContain('No contact found for contactId "Grace"');
      expect(text).toContain(`Valid contactIds: ${contact.id}`);
      expect(text).toContain(`Minimal valid JSON: {"action":"lookup","contactId":"${contact.id}"}`);
      expect(text).toContain('do not guess contactId from display names');
      expect(miss.details?.isError).toBe(true);
    });

    it('names missing contactId and points to list recovery', async () => {
      const contact = store.upsert({ displayName: 'Lookup Target' });
      const tool = createContactLookupTool(store);

      const result = await tool.execute('contact-lookup-missing-id', {} as any);
      const text = resultText(result);

      expect(text).toContain('Missing required field "contactId" for action=lookup');
      expect(text).toContain(`Valid contactIds: ${contact.id}`);
      expect(text).toContain(`Minimal valid JSON: {"action":"lookup","contactId":"${contact.id}"}`);
      expect(result.details?.isError).toBe(true);
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

    it('lists all contacts with contactId, channels, trust, and relationship info', async () => {
      const grace = store.upsert({
        displayName: 'Grace',
        trustLevel: 'trusted',
        relationshipType: 'friend',
        notes: 'Met at conf',
        channelIdentities: [
          { channel: 'discord', userId: 'grace-discord' },
          { channel: 'api', userId: 'grace-api' },
        ],
      });
      store.upsert({ displayName: 'Hank', trustLevel: 'regular', relationshipType: 'acquaintance' });
      const tool = createContactListTool(store);

      const result = await tool.execute('call-12', {});
      const text = resultText(result);

      expect(text).toContain('Contacts (2)');
      expect(text).toContain(`${grace.id}: Grace [trusted/friend]`);
      expect(text).toContain('channels=api:grace-api[private]');
      expect(text).toContain('discord:grace-discord[semi_private]');
      expect(text).toContain('Met at conf');
      expect(text).toContain('Hank [regular/acquaintance]');
      expect(text).toContain('Pass contactId from this list to action=lookup, action=set_trust, or action=note');
    });

    it('prefers nickname over display name in list output', async () => {
      store.upsert({ displayName: 'Alex Example', nickname: 'A' });
      const tool = createContactListTool(store);

      const result = await tool.execute('call-12b', {});

      expect(resultText(result)).toContain('A [regular/stranger]');
      expect(resultText(result)).not.toContain('Alex Example [regular/stranger]');
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

  describe('createContactLinkIdentityTool', () => {
    it('links a new channel identity to an existing contact', async () => {
      const contact = store.upsert({ displayName: 'Nova', discordUserId: 'nova-discord' });
      const tool = createContactLinkIdentityTool(store);

      const result = await tool.execute('call-14', {
        contactId: contact.id,
        channel: 'api',
        channelUserId: 'nova-api',
      });

      expect(resultText(result)).toContain('Linked api:nova-api');
      const resolved = store.getByChannelIdentity('api', 'nova-api');
      expect(resolved?.id).toBe(contact.id);
    });

    it('returns conflict when identity belongs to another contact', async () => {
      const first = store.upsert({ displayName: 'First', channelIdentities: [{ channel: 'api', userId: 'shared-api' }] });
      const second = store.upsert({ displayName: 'Second', discordUserId: 'second-discord' });
      expect(first.id).not.toBe(second.id);
      const tool = createContactLinkIdentityTool(store);

      const result = await tool.execute('call-15', {
        contactId: second.id,
        channel: 'api',
        channelUserId: 'shared-api',
      });

      expect(resultText(result)).toContain('already linked to a different contact');
      expect(result.details?.isError).toBe(true);
    });

    it('treats already-linked identity as idempotent success', async () => {
      const contact = store.upsert({
        displayName: 'Idempotent',
        channelIdentities: [{ channel: 'api', userId: 'existing-api' }],
      });
      const tool = createContactLinkIdentityTool(store);

      const result = await tool.execute('call-16', {
        contactId: contact.id,
        channel: 'api',
        channelUserId: 'existing-api',
      });

      expect(resultText(result)).toContain('already linked');
      expect(result.details?.isError).toBeUndefined();
    });
  });

  describe('createContactSetChannelPrivacyTool', () => {
    it('updates channel privacy for an existing linked identity', async () => {
      const contact = store.upsert({ displayName: 'Privacy User' });
      store.linkChannelIdentity(contact.id, 'api', 'privacy-api');
      const tool = createContactSetChannelPrivacyTool(store);

      const result = await tool.execute('call-17', {
        contactId: contact.id,
        channel: 'api',
        channelUserId: 'privacy-api',
        privacyLevel: 'public',
      });

      expect(resultText(result)).toContain('privacy to public');
      expect(store.getByChannelIdentity('api', 'privacy-api')?.channels?.[0]?.privacyLevel).toBe('public');
    });

    it('rejects invalid privacy levels', async () => {
      const contact = store.upsert({ displayName: 'Privacy User' });
      store.linkChannelIdentity(contact.id, 'api', 'privacy-api');
      const tool = createContactSetChannelPrivacyTool(store);

      const result = await tool.execute('call-18', {
        contactId: contact.id,
        channel: 'api',
        channelUserId: 'privacy-api',
        privacyLevel: 'super-private' as any,
      });

      expect(resultText(result)).toContain('Invalid channel privacy level');
      expect(result.details?.isError).toBe(true);
    });
  });
});
