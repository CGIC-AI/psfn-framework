import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from './store.js';
import { createContactTool } from './tools.js';
import { ContactBlockListStore } from '../cogsec/contact-block-list.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('');
}

describe('contact tool blocking (htm9.16 companion agency)', () => {
  let db: Database.Database;
  let store: ContactStore;
  let dir: string;
  let blockList: ContactBlockListStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ContactStore(db, 'primary-user-123');
    dir = mkdtempSync(join(tmpdir(), 'psfn-block-tool-'));
    blockList = new ContactBlockListStore(join(dir, 'contact-block-list.json'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hard-blocks every channel identity of a contact and the gateway then drops that id', async () => {
    const contact = store.upsert({ displayName: 'Mallory', discordUserId: '42', trustLevel: 'regular', relationshipType: 'stranger' });
    store.linkChannelIdentity(contact.id, 'telegram', 'tg-9');
    const tool = createContactTool(store, { blockList });

    const result = await tool.execute('b1', { action: 'block', contactId: contact.id, blockMode: 'hard' });
    expect(resultText(result)).toContain('Blocked Mallory');

    // The block resolves across BOTH known identities.
    expect(blockList.evaluate({ channelType: 'discord', contactId: '42', isDirectMessage: true }).action).toBe('drop');
    expect(blockList.evaluate({ channelType: 'discord', contactId: '42', isDirectMessage: true }).mode).toBe('hard');
    expect(blockList.evaluate({ channelType: 'telegram', contactId: 'tg-9', isDirectMessage: true }).action).toBe('drop');
  });

  it('defaults to a soft block and records an audit entry', async () => {
    const contact = store.upsert({ displayName: 'Eve', discordUserId: '7' });
    const tool = createContactTool(store, { blockList });

    await tool.execute('b2', { action: 'block', contactId: contact.id, reason: 'crossed a boundary' });

    const entry = blockList.get('discord', '7');
    expect(entry?.mode).toBe('soft');
    expect(entry?.reason).toBe('crossed a boundary');
    expect(entry?.canonicalContactId).toBe(contact.id);
    const audit = blockList.listAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('block');
  });

  it('is reversible via action=unblock', async () => {
    const contact = store.upsert({ displayName: 'Trent', discordUserId: '13' });
    const tool = createContactTool(store, { blockList });
    await tool.execute('b3', { action: 'block', contactId: contact.id, blockMode: 'hard' });
    expect(blockList.evaluate({ channelType: 'discord', contactId: '13', isDirectMessage: true }).action).toBe('drop');

    const result = await tool.execute('u1', { action: 'unblock', contactId: contact.id });
    expect(resultText(result)).toContain('Unblocked Trent');
    expect(blockList.evaluate({ channelType: 'discord', contactId: '13', isDirectMessage: true }).action).toBe('allow');
    // Audit retains full history: block + unblock.
    expect(blockList.listAudit().map((e) => e.action)).toEqual(['block', 'unblock']);
  });

  it('supports blocking a raw channel identity without a canonical contact', async () => {
    const tool = createContactTool(store, { blockList });
    const result = await tool.execute('b4', {
      action: 'block', channel: 'discord', channelUserId: '999', blockMode: 'hard', blockScope: 'dm',
    });
    expect(resultText(result)).toContain('Blocked discord:999');
    expect(blockList.evaluate({ channelType: 'discord', contactId: '999', isDirectMessage: true }).action).toBe('drop');
  });

  it('invalidates pending ICP permits before persisting a companion block', async () => {
    const invalidatePendingInitiationPermitsForBlock = vi.fn(async () => {
      if (invalidatePendingInitiationPermitsForBlock.mock.calls.length === 1) {
        expect(blockList.get('companion', 'peer-companion')).toBeNull();
      } else {
        expect(blockList.get('companion', 'peer-companion')).toMatchObject({ mode: 'hard' });
      }
      return { revokedCount: 1 };
    });
    const tool = createContactTool(store, {
      blockList,
      permitInvalidation: { invalidatePendingInitiationPermitsForBlock },
    });

    const result = await tool.execute('b-companion', {
      action: 'block',
      channel: 'companion',
      channelUserId: 'peer-companion',
      blockMode: 'hard',
    });

    expect(result.details?.isError).not.toBe(true);
    expect(invalidatePendingInitiationPermitsForBlock).toHaveBeenCalledTimes(2);
    expect(blockList.get('companion', 'peer-companion')).toMatchObject({ mode: 'hard' });
  });

  it('invalidates on both sides of writing a canonical companion contact', async () => {
    const contact = store.upsert({ displayName: 'Peer', discordUserId: 'peer-discord' });
    store.linkChannelIdentity(contact.id, 'companion', 'peer-companion');
    const invalidatePendingInitiationPermitsForBlock = vi.fn(async () => {
      if (invalidatePendingInitiationPermitsForBlock.mock.calls.length === 1) {
        expect(blockList.get('companion', 'peer-companion')).toBeNull();
        expect(blockList.get('discord', 'peer-discord')).toBeNull();
      } else {
        expect(blockList.get('companion', 'peer-companion')).toMatchObject({ mode: 'hard' });
        expect(blockList.get('discord', 'peer-discord')).toMatchObject({ mode: 'hard' });
      }
      return { revokedCount: 1 };
    });
    const tool = createContactTool(store, {
      blockList,
      permitInvalidation: { invalidatePendingInitiationPermitsForBlock },
    });

    const result = await tool.execute('b-canonical-companion', {
      action: 'block',
      contactId: contact.id,
      blockMode: 'hard',
    });

    expect(result.details?.isError).not.toBe(true);
    expect(invalidatePendingInitiationPermitsForBlock).toHaveBeenCalledTimes(2);
    expect(blockList.get('companion', 'peer-companion')).toMatchObject({ mode: 'hard' });
    expect(blockList.get('discord', 'peer-discord')).toMatchObject({ mode: 'hard' });
  });

  it('does not persist a companion block when permit invalidation fails', async () => {
    const tool = createContactTool(store, {
      blockList,
      permitInvalidation: {
        invalidatePendingInitiationPermitsForBlock: async () => {
          throw new Error('gateway unavailable');
        },
      },
    });

    const result = await tool.execute('b-companion-failure', {
      action: 'block',
      channel: 'companion',
      channelUserId: 'peer-companion',
    });

    expect(result.details?.isError).toBe(true);
    expect(resultText(result)).toContain('gateway unavailable');
    expect(blockList.get('companion', 'peer-companion')).toBeNull();
    expect(blockList.listAudit()).toEqual([]);
  });

  it('fails closed before persisting a companion block when permit invalidation is unwired', async () => {
    const tool = createContactTool(store, { blockList });

    const result = await tool.execute('b-companion-unwired', {
      action: 'block',
      channel: 'companion',
      channelUserId: 'peer-companion',
    });

    expect(result.details?.isError).toBe(true);
    expect(resultText(result)).toContain('permit invalidation is unavailable');
    expect(blockList.get('companion', 'peer-companion')).toBeNull();
  });

  it('fails closed when no block list is wired', async () => {
    const contact = store.upsert({ displayName: 'NoStore', discordUserId: '5' });
    const tool = createContactTool(store); // no blockList

    const result = await tool.execute('b5', { action: 'block', contactId: contact.id });
    expect(result.details?.isError).toBe(true);
    expect(resultText(result)).toContain('Blocking is unavailable');
  });

  it('errors when the contact has no channel identities to enforce a block on', async () => {
    const contact = store.upsert({ displayName: 'Ghost' }); // no discord id, no linked identity
    const tool = createContactTool(store, { blockList });

    const result = await tool.execute('b6', { action: 'block', contactId: contact.id });
    expect(result.details?.isError).toBe(true);
    expect(resultText(result)).toContain('no channel identities');
  });
});
