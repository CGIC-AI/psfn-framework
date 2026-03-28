import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { wireContactRuntime, type ContactRuntimeTarget } from './runtime-wiring.js';

class FakeTarget implements ContactRuntimeTarget {
  contactStore = null;
  tools: AgentTool<any>[] = [];

  registerTool(tool: AgentTool<any>): void {
    this.tools.push(tool);
  }
}

describe('wireContactRuntime', () => {
  it('injects ContactStore and registers all contact tools', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    const contactStore = wireContactRuntime(target, db, 'primary-user-123');

    expect(target.contactStore).toBe(contactStore);
    expect(target.tools.map(t => t.name).sort()).toEqual([
      'contact_link_identity',
      'contact_list',
      'contact_lookup',
      'contact_note',
      'contact_set_channel_privacy',
      'contact_set_trust',
    ]);
  });

  it('threads primary user id into ContactStore behavior', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    wireContactRuntime(target, db, 'primary-user-123');
    const contact = target.contactStore!.resolveUserId('primary-user-123');
    expect(contact.trustLevel).toBe('primary');
  });

  it('links bootstrap identities onto the primary contact', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    wireContactRuntime(target, db, 'primary-user-123', {
      bootstrapPrimaryIdentityLinks: [{
        channel: 'telegram',
        userId: '5635268079',
        privacyLevel: 'private',
      }],
    });

    const primary = target.contactStore!.resolveUserId('primary-user-123');
    const linked = target.contactStore!.getByChannelIdentity('telegram', '5635268079');
    expect(linked?.id).toBe(primary.id);
  });
});
