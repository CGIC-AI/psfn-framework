import type { SessionTailCachePort, SessionTailRow } from './session-tail-cache-port.js';
import { rewriteJournalChainTransaction } from '../journals/journal/chain-transaction.js';
import { writeJournalFile } from '../journals/journal-utils.js';
import { migrateJournalAddressingEntry } from './message-addressing-journal-policy.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateJournalMessageAddressing } from './message-addressing-journal-migration.js';
import { createKeyringIntegrityProvider } from './store-primitives.js';
import { SessionStore } from './store.js';
import { buildSessionHmacKeyring, verifyJournalEntryIntegrity } from '../journals/journal-utils.js';
import { classifySessionEntryCompanionRelevance } from '../../faculties/memory/extraction/message-address-mode.js';
import { createInMemoryTranscriptProjection } from '../../test-support/in-memory-transcript-projection.js';

const roots: string[] = [];
const observer = { authorId: 'bot-invented', authorName: 'Companion' };
const channelId = 'discord:room:invented';
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tailFixture(): SessionTailCachePort {
  let epoch = 0;
  const rows = new Map<number, SessionTailRow[]>();
  return {
    maxEntriesPerChannel: 10,
    getEpoch: async () => epoch,
    getTail: async () => rows.get(epoch) ?? [],
    appendRow: async (_id, captured, row) => { rows.set(captured, [...rows.get(captured) ?? [], row]); },
    replaceTail: async (_id, captured, entries) => { rows.set(captured, [...entries]); },
    invalidateChannel: async (_id, captured) => { rows.delete(captured); },
    bumpEpoch: async () => ++epoch,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'addressing-migration-')); roots.push(root);
  const sessionsDir = join(root, 'sessions');
  const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:invented-test-key', activeVersion: 'v1' })!;
  const projection = createInMemoryTranscriptProjection();
  const store = new SessionStore(sessionsDir, { integrityKeyring: keyring, transcriptProjection: projection });
  store.append({ channelId, role: 'user', authorId: 'human-invented', authorName: 'Morgan',
    content: 'Companion, remember this shared conversation.', timestamp: 1_000, channelVisibility: 'invite_only',
    metadata: JSON.stringify({ preserved: 'original metadata', messageAddressing: { schemaVersion: 1, mentionedTargets: [observer] } }),
  });
  store.append({ channelId, role: 'assistant', content: 'I remember.', timestamp: 2_000 });
  const file = readdirSync(sessionsDir).find(name => name.endsWith('.jsonl'))!;
  const journal = join(sessionsDir, file);
  mkdirSync(join(root, 'backup'));
  const options = { channelId, observer, journalPath: journal, integrityProvider: createKeyringIntegrityProvider(keyring), transcriptProjection: projection, tailCache: tailFixture(), writersStopped: true, maxJournalBytes: 1_000_000, maxJournalFiles: 8 };
  return { root, sessionsDir, keyring, projection, store, journal, options };
}

describe('canonical message-addressing migration', () => {
  it('repairs native relevance parsing, preserves signed originals and updates projection', async () => {
    const f = fixture();
    const original = readFileSync(f.journal);
    expect(() => classifySessionEntryCompanionRelevance(f.store.getRecent(channelId, 2)[0]!, {})).toThrow('schemaVersion 2');
    const before = f.store.getRecent(channelId, 2);
    await f.options.tailCache.replaceTail(channelId, 0, before.map(entry => ({ kind: 'message', entry })));
    expect(await f.options.tailCache.getTail(channelId)).toHaveLength(2);
    const plan = await migrateJournalMessageAddressing({ ...f.options, mode: 'dry-run' });
    expect(plan.migratedEntries).toBe(1);
    expect(readFileSync(f.journal)).toEqual(original);
    const replace = vi.spyOn(f.projection, 'replaceChannelEntries');
    const result = await migrateJournalMessageAddressing({ ...f.options, mode: 'apply', expectedPlanDigest: plan.planDigest, backupDir: join(f.root, 'backup') });
    expect(result.migratedEntries).toBe(1);
    expect(await f.options.tailCache.getTail(channelId)).toEqual([]);
    expect(await f.options.tailCache.getEpoch(channelId)).toBe(2);
    expect(readFileSync(join(result.backupPath!, '0.jsonl'))).toEqual(original);
    let previousHmac: string | null = null;
    for (const line of readFileSync(f.journal, 'utf8').trim().split('\n')) {
      const row = JSON.parse(line);
      expect(verifyJournalEntryIntegrity(row, f.keyring, previousHmac).verified).toBe(true);
      previousHmac = row._hmac;
    }
    const after = new SessionStore(f.sessionsDir, { integrityKeyring: f.keyring }).getRecent(channelId, 2);
    expect(after.map(row => [row.id, row.content, row.timestamp])).toEqual(before.map(row => [row.id, row.content, row.timestamp]));
    expect(JSON.parse(after[0]!.metadata!).preserved).toBe('original metadata');
    expect(classifySessionEntryCompanionRelevance(after[0]!, {})).toBe('direct_to_companion');
    expect(replace).toHaveBeenLastCalledWith(channelId, expect.arrayContaining([expect.objectContaining({ id: after[0]!.id, metadata: after[0]!.metadata })]), { redaction: true });
    expect((await migrateJournalMessageAddressing({ ...f.options, mode: 'dry-run' })).migratedEntries).toBe(0);
  });

  it('rejects a stale digest and changed observer before rewriting', async () => {
    const f = fixture(); const original = readFileSync(f.journal);
    const plan = await migrateJournalMessageAddressing({ ...f.options, mode: 'dry-run' });
    await expect(migrateJournalMessageAddressing({ ...f.options, mode: 'apply', expectedPlanDigest: '0'.repeat(64), backupDir: join(f.root, 'backup') })).rejects.toThrow('plan digest');
    await expect(migrateJournalMessageAddressing({ ...f.options, observer: { ...observer, authorId: 'other' }, mode: 'apply', expectedPlanDigest: plan.planDigest, backupDir: join(f.root, 'backup') })).rejects.toThrow('plan digest');
    expect(readFileSync(f.journal)).toEqual(original);
  });

  it('preflights every record and refuses ambiguous evidence without partial migration', async () => {
    const f = fixture();
    f.store.append({ channelId, role: 'user', content: 'A private room is not proven to be a DM.', authorId: 'another', authorName: 'Taylor', timestamp: 3_000, channelVisibility: 'private', metadata: JSON.stringify({ messageAddressing: { schemaVersion: 1, mentionedTargets: [observer] } }) });
    const original = readFileSync(f.journal);
    await expect(migrateJournalMessageAddressing({ ...f.options, mode: 'dry-run' })).rejects.toThrow('legacy_v1_ambiguous_channel_scope');
    expect(readFileSync(f.journal)).toEqual(original);
  });

  it('refuses signed input without its verifier and enforces explicit read bounds', async () => {
    const f = fixture(); const original = readFileSync(f.journal);
    await expect(migrateJournalMessageAddressing({ ...f.options, integrityProvider: null, mode: 'dry-run' })).rejects.toThrow('integrity');
    await expect(migrateJournalMessageAddressing({ ...f.options, maxJournalBytes: 1, mode: 'dry-run' })).rejects.toThrow('byte bound');
    expect(readFileSync(f.journal)).toEqual(original);
  });

  it('rejects tampered signatures before backup or projection mutation', async () => {
    const f = fixture();
    writeFileSync(f.journal, readFileSync(f.journal, 'utf8').replace('shared conversation', 'forged conversation'));
    const original = readFileSync(f.journal);
    const mark = vi.spyOn(f.projection, 'markProjectionDrift');
    await expect(migrateJournalMessageAddressing({ ...f.options, mode: 'dry-run' })).rejects.toThrow('integrity');
    expect(mark).not.toHaveBeenCalled();
    expect(readFileSync(f.journal)).toEqual(original);
  });

  it('keeps original bytes when the durable projection fence cannot be proven', async () => {
    const f = fixture(); const original = readFileSync(f.journal);
    const plan = await migrateJournalMessageAddressing({ ...f.options, mode: 'dry-run' });
    vi.spyOn(f.projection, 'assertRedactionDriftDurable').mockRejectedValue(new Error('database unavailable'));
    await expect(migrateJournalMessageAddressing({ ...f.options, mode: 'apply', expectedPlanDigest: plan.planDigest, backupDir: join(f.root, 'backup') })).rejects.toThrow('database unavailable');
    expect(readFileSync(f.journal)).toEqual(original);
    expect(readdirSync(join(f.root, 'backup'))).toEqual([]);
  });

  it('fences tails on partial completion and refuses a successful no-op while projection remains failed', async () => {
    const f = fixture();
    const plan = await migrateJournalMessageAddressing({ ...f.options, mode: 'dry-run' });
    vi.spyOn(f.projection, 'replaceChannelEntries').mockImplementation(() => { throw new Error('projection unavailable'); });
    await expect(migrateJournalMessageAddressing({ ...f.options, mode: 'apply', expectedPlanDigest: plan.planDigest, backupDir: join(f.root, 'backup') })).rejects.toThrow('projection unavailable');
    expect(await f.options.tailCache.getEpoch(channelId)).toBe(2);
    const current = await migrateJournalMessageAddressing({ ...f.options, mode: 'dry-run' });
    expect(current.migratedEntries).toBe(0);
    await expect(migrateJournalMessageAddressing({ ...f.options, mode: 'apply', expectedPlanDigest: current.planDigest, backupDir: join(f.root, 'backup') })).rejects.toThrow('requires native repair');
  });

  it('enforces the exact transform at the native chain boundary', () => {
    const f = fixture(); const original = readFileSync(f.journal);
    const rows = original.toString().trim().split('\n').map(line => JSON.parse(line));
    const addressingMigration = { kind: 'message-addressing-v1-to-v2' as const, observer };
    const migrated = rows.map(row => migrateJournalAddressingEntry(row, addressingMigration));
    for (const patch of [{ content: 'forged' }, { authorId: 'forged' }, { metadata: JSON.stringify({ unrelated: true }) }]) {
      const replacements = [{ ...migrated[0], ...patch }, ...migrated.slice(1)];
      expect(() => rewriteJournalChainTransaction({ targetPaths: [f.journal], entriesByTarget: [replacements], writeEntries: writeJournalFile, addressingMigration })).toThrow('may only replace');
    }
    expect(readFileSync(f.journal)).toEqual(original);
  });


  it('rejects a dot-prefixed backup directory inside canonical sessions', async () => {
    const f = fixture(); const original = readFileSync(f.journal);
    const backupDir = join(f.sessionsDir, '..backup'); mkdirSync(backupDir);
    const plan = await migrateJournalMessageAddressing({ ...f.options, mode: 'dry-run' });
    await expect(migrateJournalMessageAddressing({ ...f.options, mode: 'apply', expectedPlanDigest: plan.planDigest, backupDir })).rejects.toThrow('outside the sessions');
    expect(readFileSync(f.journal)).toEqual(original);
  });

});
