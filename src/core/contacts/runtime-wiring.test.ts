import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import type { AgentTool } from '../../boundary/pi-agent/index.js';
import type Database from 'better-sqlite3';
import {
  registerContactRuntime,
  type ContactRuntimeOptions,
  type ContactRuntimeTarget,
} from './runtime-wiring.js';
import { createSQLiteContactStore } from './sqlite-adapter.js';
import type { ContactStorePort } from './contact-store-port.js';

// Legacy SQLite convenience wiring, kept test-local until psfn-framework-3c2.5
// deletes the SQLite contact store and this test file with it.
async function wireContactRuntime(
  target: ContactRuntimeTarget,
  db: Database.Database,
  primaryUserId?: string,
  options: ContactRuntimeOptions = {},
): Promise<ContactStorePort> {
  const contactStore = createSQLiteContactStore(db, primaryUserId, {
    exportDir: options.exportDir,
  });
  return await registerContactRuntime(target, contactStore, primaryUserId, options);
}

class FakeTarget implements ContactRuntimeTarget {
  contactStore = null;
  tools: AgentTool<any>[] = [];

  registerTool(tool: AgentTool<any>): void {
    this.tools.push(tool);
  }
}

describe('wireContactRuntime', () => {
  it('injects ContactStore and registers only the unified contact surface', async () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    const contactStore = await wireContactRuntime(target, db, 'primary-user-123');

    expect(target.contactStore).toBe(contactStore);
    expect(target.tools.map(t => t.name)).toEqual(['contact']);
  });

  it('threads primary user id into ContactStore behavior', async () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    await wireContactRuntime(target, db, 'primary-user-123');
    const contact = await target.contactStore!.resolveUserId('primary-user-123');
    expect(contact.trustLevel).toBe('primary');
  });

  it('links bootstrap identities onto the primary contact', async () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    await wireContactRuntime(target, db, 'primary-user-123', {
      bootstrapPrimaryIdentityLinks: [{
        channel: 'telegram',
        userId: '5635268079',
        privacyLevel: 'private',
      }],
    });

    const primary = await target.contactStore!.resolveUserId('primary-user-123');
    const linked = await target.contactStore!.getByChannelIdentity('telegram', '5635268079');
    expect(linked?.id).toBe(primary.id);
  });
});
