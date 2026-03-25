import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ContactStore } from '../../../contacts/store.js';
import type { MemoryStore } from '../../../memory/store.js';
import type { SessionStore } from '../../../session/store.js';
import { AdminContactsDataService } from './contacts-service.js';

function createServiceHarness() {
  const db = new Database(':memory:');
  const contactStore = new ContactStore(db);
  const sessionStore = {
    listChannels: () => [],
    getLastEntry: () => undefined,
  } as unknown as SessionStore;
  const memoryStore = {} as MemoryStore;
  const service = new AdminContactsDataService({
    contactStore,
    memoryStore,
    sessionStore,
  });
  return { db, contactStore, service };
}

describe('AdminContactsDataService', () => {
  it('deletes a persisted conversation channel from a contact', () => {
    const { db, contactStore, service } = createServiceHarness();
    try {
      const contact = contactStore.upsert({ displayName: 'Operator' });
      contactStore.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:short-check', 'semi_private');
      contactStore.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:lab:pi5', 'private');

      const result = service.deleteConversationChannel(
        contact.id,
        JSON.stringify({
          channel: 'psfn-amica',
          channelId: 'psfn-amica:short-check',
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.contact?.conversationChannels).toEqual([
        expect.objectContaining({
          channel: 'psfn-amica',
          channelId: 'psfn-amica:lab:pi5',
        }),
      ]);
      expect(result.relatedChannels).toEqual([
        expect.objectContaining({
          channel: 'psfn-amica',
          channelId: 'psfn-amica:lab:pi5',
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('fails closed when the conversation channel is not on the contact', () => {
    const { db, contactStore, service } = createServiceHarness();
    try {
      const contact = contactStore.upsert({ displayName: 'Operator' });

      const result = service.deleteConversationChannel(
        contact.id,
        JSON.stringify({
          channel: 'psfn-amica',
          channelId: 'psfn-amica:missing',
        }),
      );

      expect(result).toEqual({
        ok: false,
        message: 'Conversation channel not found on contact',
      });
    } finally {
      db.close();
    }
  });
});
