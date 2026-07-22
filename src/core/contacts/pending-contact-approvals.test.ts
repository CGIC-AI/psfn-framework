import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFilePendingContactApprovalStore,
  truncateContactApprovalPreview,
} from './pending-contact-approvals.js';

describe('createFilePendingContactApprovalStore', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'psfn-pending-contacts-'));
    filePath = join(tempDir, 'contacts', 'pending-approvals.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeSighting(overrides: Record<string, string> = {}) {
    return {
      channel: 'discord',
      channelUserId: 'user-42',
      displayName: 'New Speaker',
      channelId: 'discord:big-room',
      messageId: 'msg-1',
      messagePreview: 'first message',
      ...overrides,
    };
  }

  it('creates a pending entry on first sighting and updates it afterwards', async () => {
    const store = createFilePendingContactApprovalStore(filePath);

    const first = await store.recordSighting(makeSighting());
    expect(first.created).toBe(true);
    expect(first.entry.status).toBe('pending');
    expect(first.entry.messagePreviews).toHaveLength(1);

    const second = await store.recordSighting(makeSighting({ messageId: 'msg-2', messagePreview: 'second' }));
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.messagePreviews).toHaveLength(2);
    expect(await store.list()).toHaveLength(1);
  });

  it('dedupes previews by message id and caps the sample size', async () => {
    const store = createFilePendingContactApprovalStore(filePath, { maxPreviews: 2 });

    await store.recordSighting(makeSighting());
    // Same message reported twice (multiple resolution passes per turn).
    await store.recordSighting(makeSighting());
    await store.recordSighting(makeSighting({ messageId: 'msg-2', messagePreview: 'second' }));
    await store.recordSighting(makeSighting({ messageId: 'msg-3', messagePreview: 'third (over cap)' }));

    const entry = await store.getByIdentity('discord', 'user-42');
    expect(entry?.messagePreviews.map(preview => preview.messageId)).toEqual(['msg-1', 'msg-2']);
  });

  it('truncates long previews', () => {
    expect(truncateContactApprovalPreview('a'.repeat(200), 160)).toHaveLength(161);
    expect(truncateContactApprovalPreview('  spaced\n\nout  ', 160)).toBe('spaced out');
  });

  it('persists denial decisions across store re-instantiation', async () => {
    const store = createFilePendingContactApprovalStore(filePath);
    const { entry } = await store.recordSighting(makeSighting());
    await store.markDenied(entry.id);

    const reopened = createFilePendingContactApprovalStore(filePath);
    const persisted = await reopened.getByIdentity('discord', 'user-42');
    expect(persisted?.status).toBe('denied');
    expect(persisted?.decidedAt).toBeDefined();

    // Denied entries stay immutable to new sightings.
    const sighting = await reopened.recordSighting(makeSighting({ messageId: 'msg-9' }));
    expect(sighting.created).toBe(false);
    expect(sighting.entry.status).toBe('denied');
    expect(sighting.entry.messagePreviews).toHaveLength(1);
  });

  it('remove clears the record so the next sighting re-proposes (operator reset semantics)', async () => {
    const store = createFilePendingContactApprovalStore(filePath);
    const { entry } = await store.recordSighting(makeSighting());
    await store.markDenied(entry.id);
    await store.remove(entry.id);

    const reproposed = await store.recordSighting(makeSighting({ messageId: 'msg-10' }));
    expect(reproposed.created).toBe(true);
    expect(reproposed.entry.status).toBe('pending');
    expect(reproposed.entry.id).not.toBe(entry.id);
  });

  it('returns undefined for unknown ids on markDenied/remove', async () => {
    const store = createFilePendingContactApprovalStore(filePath);
    expect(await store.markDenied('missing')).toBeUndefined();
    expect(await store.remove('missing')).toBeUndefined();
  });

  it('does not persist a lastSeenAt-only refresh (idle purity)', async () => {
    const times = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z'];
    let call = 0;
    const now = () => new Date(times[Math.min(call++, times.length - 1)]);
    const store = createFilePendingContactApprovalStore(filePath, { now });

    await store.recordSighting(makeSighting()); // t0: create -> persists
    const afterCreate = readFileSync(filePath, 'utf8');

    // Same messageId again: dedupes to no new preview, same displayName -> only
    // lastSeenAt would move. This must NOT rewrite the durable store.
    await store.recordSighting(makeSighting()); // t1: bare refresh -> no write
    const afterRefresh = readFileSync(filePath, 'utf8');
    expect(afterRefresh).toBe(afterCreate); // byte-identical: zero persist

    // The refresh is live in memory but was intentionally not flushed to disk.
    const inMemory = await store.getByIdentity('discord', 'user-42');
    expect(inMemory?.lastSeenAt).toBe(times[1]);
    const reopened = createFilePendingContactApprovalStore(filePath);
    const persisted = await reopened.getByIdentity('discord', 'user-42');
    expect(persisted?.lastSeenAt).toBe(times[0]);
  });

  it('persists a material change (new preview)', async () => {
    const store = createFilePendingContactApprovalStore(filePath);
    await store.recordSighting(makeSighting());
    const afterCreate = readFileSync(filePath, 'utf8');

    await store.recordSighting(makeSighting({ messageId: 'msg-2', messagePreview: 'second' }));
    const afterMaterial = readFileSync(filePath, 'utf8');
    expect(afterMaterial).not.toBe(afterCreate);

    const reopened = createFilePendingContactApprovalStore(filePath);
    const persisted = await reopened.getByIdentity('discord', 'user-42');
    expect(persisted?.messagePreviews).toHaveLength(2);
  });

  it('persists a display-name change even without a new preview', async () => {
    const store = createFilePendingContactApprovalStore(filePath);
    await store.recordSighting(makeSighting());
    const afterCreate = readFileSync(filePath, 'utf8');

    // Same messageId (no new preview) but a changed display name is material.
    await store.recordSighting(makeSighting({ displayName: 'Renamed Speaker' }));
    const afterRename = readFileSync(filePath, 'utf8');
    expect(afterRename).not.toBe(afterCreate);

    const reopened = createFilePendingContactApprovalStore(filePath);
    const persisted = await reopened.getByIdentity('discord', 'user-42');
    expect(persisted?.displayName).toBe('Renamed Speaker');
  });

  it('flushes the refreshed lastSeenAt durably on the next material write', async () => {
    const times = [
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:05:00.000Z',
      '2026-01-01T00:10:00.000Z',
    ];
    let call = 0;
    const now = () => new Date(times[Math.min(call++, times.length - 1)]);
    const store = createFilePendingContactApprovalStore(filePath, { now });

    await store.recordSighting(makeSighting()); // t0: create
    await store.recordSighting(makeSighting()); // t1: bare refresh, not written
    // t2: new preview is material -> flushes the whole entry, carrying the
    // current (t2) lastSeenAt with it. No timestamp data loss across writes.
    await store.recordSighting(makeSighting({ messageId: 'msg-2', messagePreview: 'second' }));

    const reopened = createFilePendingContactApprovalStore(filePath);
    const persisted = await reopened.getByIdentity('discord', 'user-42');
    expect(persisted?.lastSeenAt).toBe(times[2]);
    expect(persisted?.messagePreviews).toHaveLength(2);
  });

  it('fails closed on a corrupt state file instead of silently dropping decisions', async () => {
    const store = createFilePendingContactApprovalStore(filePath);
    await store.recordSighting(makeSighting());
    writeFileSync(filePath, '{"version":99}', 'utf8');

    const reopened = createFilePendingContactApprovalStore(filePath);
    await expect(reopened.list()).rejects.toThrow(/Unsupported pending contact approvals file shape/);
  });
});
