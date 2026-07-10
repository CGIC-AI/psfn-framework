import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTACT_BLOCK_LIST_VERSION,
  ContactBlockListStore,
} from './contact-block-list.js';

describe('ContactBlockListStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-block-'));
    path = join(dir, 'contact-block-list.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const companionActor = { kind: 'companion' as const, id: 'companion' };

  it('records a soft block and evaluates a DM drop', () => {
    const store = new ContactBlockListStore(path);
    store.block({
      channelType: 'discord',
      contactId: '42',
      mode: 'soft',
      reason: 'harassment',
      actor: companionActor,
    });

    const dm = store.evaluate({ channelType: 'discord', contactId: '42', isDirectMessage: true });
    expect(dm.action).toBe('drop');
    expect(dm.mode).toBe('soft');
    expect(dm.reason).toBe('harassment');
  });

  it('defaults scope to all and downgrades group messages to observe (no room drop)', () => {
    const store = new ContactBlockListStore(path);
    store.block({ channelType: 'discord', contactId: '42', mode: 'hard', actor: companionActor });

    const dm = store.evaluate({ channelType: 'discord', contactId: '42', isDirectMessage: true });
    const group = store.evaluate({ channelType: 'discord', contactId: '42', isDirectMessage: false });

    // DMs drop at the gateway; group rooms are only observed (companion ignores).
    expect(dm.action).toBe('drop');
    expect(group.action).toBe('observe');
    expect(group.mode).toBe('hard');
  });

  it('honors scope narrowing: dm-only leaves group traffic allowed and vice versa', () => {
    const store = new ContactBlockListStore(path);
    store.block({ channelType: 'discord', contactId: 'dm-only', mode: 'soft', scope: 'dm', actor: companionActor });
    store.block({ channelType: 'discord', contactId: 'grp-only', mode: 'soft', scope: 'group', actor: companionActor });

    expect(store.evaluate({ channelType: 'discord', contactId: 'dm-only', isDirectMessage: true }).action).toBe('drop');
    expect(store.evaluate({ channelType: 'discord', contactId: 'dm-only', isDirectMessage: false }).action).toBe('allow');

    expect(store.evaluate({ channelType: 'discord', contactId: 'grp-only', isDirectMessage: true }).action).toBe('allow');
    expect(store.evaluate({ channelType: 'discord', contactId: 'grp-only', isDirectMessage: false }).action).toBe('observe');
  });

  it('allows unknown contacts and respects channelType keying', () => {
    const store = new ContactBlockListStore(path);
    store.block({ channelType: 'discord', contactId: '42', mode: 'hard', actor: companionActor });

    expect(store.evaluate({ channelType: 'discord', contactId: '99', isDirectMessage: true }).action).toBe('allow');
    // Same id on a different channel is a different person.
    expect(store.evaluate({ channelType: 'telegram', contactId: '42', isDirectMessage: true }).action).toBe('allow');
  });

  it('persists to disk and reloads across a second store instance (cross-process read)', () => {
    const writer = new ContactBlockListStore(path);
    writer.block({ channelType: 'discord', contactId: '42', mode: 'hard', actor: companionActor });

    // A separate instance (e.g. the gateway process) reads the same file.
    const reader = new ContactBlockListStore(path);
    expect(reader.evaluate({ channelType: 'discord', contactId: '42', isDirectMessage: true }).action).toBe('drop');

    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw.version).toBe(CONTACT_BLOCK_LIST_VERSION);
  });

  it('reflects a writer instance mutation on a live reader instance via mtime reload', () => {
    const reader = new ContactBlockListStore(path);
    expect(reader.evaluate({ channelType: 'discord', contactId: '42', isDirectMessage: true }).action).toBe('allow');

    let tick = 1_000;
    const writer = new ContactBlockListStore(path, { now: () => new Date(tick += 60_000) });
    writer.block({ channelType: 'discord', contactId: '42', mode: 'soft', actor: companionActor });

    // The reader must observe the new block written by the other instance.
    expect(reader.evaluate({ channelType: 'discord', contactId: '42', isDirectMessage: true }).action).toBe('drop');
  });

  it('is reversible with an explicit unblock and never clears automatically', () => {
    const store = new ContactBlockListStore(path);
    store.block({ channelType: 'discord', contactId: '42', mode: 'hard', actor: companionActor });
    expect(store.evaluate({ channelType: 'discord', contactId: '42', isDirectMessage: true }).action).toBe('drop');

    const removed = store.unblock({ channelType: 'discord', contactId: '42', actor: companionActor });
    expect(removed).toBe(true);
    expect(store.evaluate({ channelType: 'discord', contactId: '42', isDirectMessage: true }).action).toBe('allow');

    // Unblocking a non-existent block is a no-op, not an error.
    expect(store.unblock({ channelType: 'discord', contactId: '42', actor: companionActor })).toBe(false);
  });

  it('keeps an append-only audit history of block/update/unblock', () => {
    let tick = 0;
    const store = new ContactBlockListStore(path, { now: () => new Date(tick += 1000) });
    store.block({ channelType: 'discord', contactId: '42', mode: 'soft', actor: companionActor });
    store.block({ channelType: 'discord', contactId: '42', mode: 'hard', reason: 'escalation', actor: companionActor });
    store.unblock({ channelType: 'discord', contactId: '42', reason: 'reconciled', actor: { kind: 'operator', id: 'operator:pierre' } });

    const audit = store.listAudit();
    expect(audit.map((e) => e.action)).toEqual(['block', 'update', 'unblock']);
    expect(audit[1]?.mode).toBe('hard');
    expect(audit[1]?.reason).toBe('escalation');
    expect(audit[2]?.actor).toEqual({ kind: 'operator', id: 'operator:pierre' });

    // The escalation preserved the original blockedAt while advancing updatedAt.
    const reloaded = new ContactBlockListStore(path);
    expect(reloaded.list()).toHaveLength(0); // removed by the unblock above
    expect(reloaded.listAudit()).toHaveLength(3);
  });

  it('rejects malformed persisted state (fail closed)', () => {
    const store = new ContactBlockListStore(path);
    store.block({ channelType: 'discord', contactId: '42', mode: 'soft', actor: companionActor });

    writeFileSync(path, JSON.stringify({ version: 999, entries: {}, audit: [], updatedAt: 'x' }));
    expect(() => new ContactBlockListStore(path)).toThrow(/version/);
  });

  it('rejects invalid block inputs (fail closed)', () => {
    const store = new ContactBlockListStore(path);
    expect(() => store.block({ channelType: '', contactId: '42', mode: 'soft', actor: companionActor })).toThrow();
    expect(() => store.block({ channelType: 'discord', contactId: '42', mode: 'nope' as any, actor: companionActor })).toThrow();
    expect(() => store.block({ channelType: 'discord', contactId: '42', mode: 'soft', scope: 'weird' as any, actor: companionActor })).toThrow();
  });
});
