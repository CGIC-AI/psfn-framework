import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, sanitizeChannelId, unsanitizeChannelId } from './store.js';
import { buildSessionHmacKeyring, signJournalEntry, verifyJournalEntryIntegrity } from './journal-utils.js';

describe('SessionStore', () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-session-'));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends and retrieves entries', () => {
    store.append({
      channelId: 'ch1',
      role: 'user',
      content: 'Hello',
      authorId: 'u1',
      authorName: 'Alice',
      timestamp: 1000,
    });

    store.append({
      channelId: 'ch1',
      role: 'assistant',
      content: 'Hi there!',
      timestamp: 2000,
    });

    const entries = store.getRecent('ch1', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('Hello');
    expect(entries[1].content).toBe('Hi there!');
  });

  it('limits retrieval', () => {
    for (let i = 0; i < 10; i++) {
      store.append({
        channelId: 'ch1',
        role: 'user',
        content: `Message ${i}`,
        timestamp: i * 1000,
      });
    }

    const entries = store.getRecent('ch1', 3);
    expect(entries).toHaveLength(3);
    expect(entries[0].content).toBe('Message 7');
  });

  it('isolates channels', () => {
    store.append({ channelId: 'ch1', role: 'user', content: 'A', timestamp: 1000 });
    store.append({ channelId: 'ch2', role: 'user', content: 'B', timestamp: 1000 });

    expect(store.getRecent('ch1', 10)).toHaveLength(1);
    expect(store.getRecent('ch2', 10)).toHaveLength(1);
    expect(store.count('ch1')).toBe(1);
    expect(store.count('ch2')).toBe(1);
  });

  it('creates readable filename pattern for new channels and persists mapping', () => {
    store.append({
      channelId: 'api:e2e-internal',
      role: 'user',
      content: 'hello',
      authorId: 'operator',
      authorName: 'V',
      timestamp: 1739443200000,
    });

    const sessionFiles = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('user_'));
    expect(sessionFiles).toHaveLength(1);
    expect(sessionFiles[0]).toMatch(/^\d{8}_[a-z0-9-]+_[a-z0-9-]+_\d{6}\.jsonl$/);
    expect(sessionFiles[0]).not.toContain('%3A');

    expect(existsSync(join(dir, '_channel_index.json'))).toBe(true);
    const index = JSON.parse(readFileSync(join(dir, '_channel_index.json'), 'utf-8')) as {
      channels: Record<string, { filename: string }>;
    };
    expect(index.channels['api:e2e-internal'].filename).toBe(sessionFiles[0]);

    const reloaded = new SessionStore(dir);
    reloaded.append({
      channelId: 'api:e2e-internal',
      role: 'assistant',
      content: 'world',
      timestamp: 1739443201000,
    });

    const entries = reloaded.getRecent('api:e2e-internal', 10);
    expect(entries).toHaveLength(2);

    const filesAfter = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('user_'));
    expect(filesAfter).toHaveLength(1);
    expect(filesAfter[0]).toBe(sessionFiles[0]);
  });

  it('stores and retrieves compaction summaries', () => {
    store.insertCompaction('ch1', 'Previous context summary', 5);

    const summaries = store.getCompactionSummaries('ch1');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toBe('Previous context summary');
    expect(summaries[0].coveredUpTo).toBe(5);
  });

  it('writes graceful shutdown markers for active sessions', () => {
    store.append({
      channelId: 'ch1',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
    });
    store.append({
      channelId: 'ch2',
      role: 'assistant',
      content: 'world',
      timestamp: 2_000,
    });

    const marked = store.markGracefulShutdownForActiveChannels(3_000).sort();
    expect(marked).toEqual(['ch1', 'ch2']);
    expect(store.markGracefulShutdownForActiveChannels(4_000)).toEqual([]);

    const reloaded = new SessionStore(dir);
    expect(reloaded.getUncleanShutdownChannels()).toEqual([]);
  });

  it('detects unclean shutdown and reports un-extracted recovery entries', () => {
    const channelId = 'api:recover-extraction';
    store.append({
      channelId,
      role: 'user',
      content: 'Message 1',
      timestamp: 1_000,
    });
    store.insertExtractionMarker(channelId, 1, 1_500);
    store.append({
      channelId,
      role: 'assistant',
      content: 'Message 2',
      timestamp: 2_000,
    });
    store.append({
      channelId,
      role: 'user',
      content: 'Message 3',
      timestamp: 3_000,
    });

    const reloaded = new SessionStore(dir);
    expect(reloaded.getUncleanShutdownChannels()).toContain(channelId);

    const candidates = reloaded.getCrashRecoveryExtractionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].channelId).toBe(channelId);
    expect(candidates[0].lastExtractionCoveredUpTo).toBe(1);
    expect(candidates[0].unextractedEntries.map(entry => entry.content)).toEqual([
      'Message 2',
      'Message 3',
    ]);

    reloaded.markGracefulShutdownForActiveChannels(3_500);
    const cleanReload = new SessionStore(dir);
    expect(cleanReload.getUncleanShutdownChannels()).toEqual([]);
    expect(cleanReload.getCrashRecoveryExtractionCandidates()).toEqual([]);
  });

  it('persists data across store instances', () => {
    store.append({
      channelId: 'ch1',
      role: 'user',
      content: 'Persistent message',
      timestamp: 1000,
    });
    store.insertCompaction('ch1', 'Summary from before', 1);

    // Create a new store pointing at the same directory
    const store2 = new SessionStore(dir);

    const entries = store2.getRecent('ch1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Persistent message');

    const summaries = store2.getCompactionSummaries('ch1');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toBe('Summary from before');
  });

  it('persists discord message IDs for dedup helpers', () => {
    store.append({
      channelId: '123456789012345678',
      role: 'user',
      content: 'Hello from Discord',
      authorId: 'user-1',
      authorName: 'Alice',
      timestamp: 1000,
      discordMessageId: 'msg-1',
    });
    store.append({
      channelId: '123456789012345678',
      role: 'assistant',
      content: 'Reply',
      timestamp: 2000,
    });
    store.append({
      channelId: '123456789012345678',
      role: 'user',
      content: 'Follow-up',
      authorId: 'user-1',
      authorName: 'Alice',
      timestamp: 3000,
      discordMessageId: 'msg-2',
    });

    const ids = store.getRecentDiscordMessageIds('123456789012345678', 10);
    expect(ids.has('msg-1')).toBe(true);
    expect(ids.has('msg-2')).toBe(true);
    expect(store.getLastEntry('123456789012345678')?.discordMessageId).toBe('msg-2');

    const reloaded = new SessionStore(dir);
    const reloadedIds = reloaded.getRecentDiscordMessageIds('123456789012345678', 10);
    expect(reloadedIds.has('msg-1')).toBe(true);
    expect(reloadedIds.has('msg-2')).toBe(true);
    expect(reloaded.getLastEntry('123456789012345678')?.discordMessageId).toBe('msg-2');
  });

  it('assigns monotonic IDs', () => {
    const id1 = store.append({ channelId: 'ch1', role: 'user', content: 'A', timestamp: 1000 });
    const id2 = store.append({ channelId: 'ch1', role: 'user', content: 'B', timestamp: 2000 });

    expect(id1).toBe(1);
    expect(id2).toBe(2);

    // Reload and continue
    const store2 = new SessionStore(dir);
    const id3 = store2.append({ channelId: 'ch1', role: 'user', content: 'C', timestamp: 3000 });
    expect(id3).toBe(3);
  });

  it('handles channelId with colons (api:session-1)', () => {
    store.append({ channelId: 'api:session-1', role: 'user', content: 'Hello', timestamp: 1000 });
    const entries = store.getRecent('api:session-1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Hello');

    // Reload from disk
    const store2 = new SessionStore(dir);
    const entries2 = store2.getRecent('api:session-1', 10);
    expect(entries2).toHaveLength(1);
  });

  it('handles channelId with shard:uuid format', () => {
    const channelId = 'shard:550e8400-e29b-41d4-a716-446655440000';
    store.append({ channelId, role: 'user', content: 'Shard msg', timestamp: 1000 });
    expect(store.count(channelId)).toBe(1);
  });

  it('handles channelId with slashes (discord/guild/channel)', () => {
    const channelId = 'discord/guild/channel';
    store.append({ channelId, role: 'user', content: 'Slashed', timestamp: 1000 });
    expect(store.count(channelId)).toBe(1);

    const store2 = new SessionStore(dir);
    expect(store2.count(channelId)).toBe(1);
  });

  it('handles channelId with dangerous characters', () => {
    const dangerous = 'ch\x00../../../etc/passwd';
    store.append({ channelId: dangerous, role: 'user', content: 'Sneaky', timestamp: 1000 });
    expect(store.count(dangerous)).toBe(1);

    const store2 = new SessionStore(dir);
    expect(store2.count(dangerous)).toBe(1);
  });

  it('handles channelId with backslash', () => {
    const channelId = 'test\\path\\channel';
    store.append({ channelId, role: 'user', content: 'Backslash', timestamp: 1000 });
    expect(store.count(channelId)).toBe(1);
  });

  it('lists channels with special characters', () => {
    store.append({ channelId: 'api:session-1', role: 'user', content: 'A', timestamp: 1000 });
    store.append({ channelId: 'discord/guild/ch', role: 'user', content: 'B', timestamp: 1000 });

    const channels = store.listChannels();
    const ids = channels.map(c => c.channelId).sort();
    expect(ids).toContain('api:session-1');
    expect(ids).toContain('discord/guild/ch');
  });

  it('backward compat: appends to legacy file (no split-brain)', () => {
    // Simulate old-format file
    const oldFilename = 'api-session-1.jsonl';
    const journalLine = JSON.stringify({
      type: 'message', id: 1, channelId: 'api:session-1',
      role: 'user', content: 'Old msg', timestamp: 1000,
    });
    writeFileSync(join(dir, oldFilename), journalLine + '\n');

    // Load from legacy, then append
    const store1 = new SessionStore(dir);
    store1.append({ channelId: 'api:session-1', role: 'assistant', content: 'New msg', timestamp: 2000 });
    expect(store1.count('api:session-1')).toBe(2);

    // Reload — must get BOTH messages (not just the new one)
    const store2 = new SessionStore(dir);
    const entries = store2.getRecent('api:session-1', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('Old msg');
    expect(entries[1].content).toBe('New msg');
  });

  it('backward compat: listChannels reads old-format files', () => {
    // Simulate an old-format file: colon was replaced with -, slash with _
    const oldFilename = 'api-session-1.jsonl';
    const journalLine = JSON.stringify({
      type: 'message',
      id: 1,
      channelId: 'api:session-1',
      role: 'user',
      content: 'Old format',
      timestamp: 1000,
    });
    writeFileSync(join(dir, oldFilename), journalLine + '\n');

    const freshStore = new SessionStore(dir);
    const channels = freshStore.listChannels();
    const found = channels.find(c => c.channelId === 'api:session-1');
    expect(found).toBeDefined();
    expect(found!.messageCount).toBe(1);
  });

  it('falls back to disk scan when channel index is malformed', () => {
    store.append({
      channelId: 'api:fallback-test',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    });
    writeFileSync(join(dir, '_channel_index.json'), '{not valid json');

    const reloaded = new SessionStore(dir);
    const channels = reloaded.listChannels();
    const found = channels.find(c => c.channelId === 'api:fallback-test');
    expect(found).toBeDefined();
    expect(found!.messageCount).toBe(1);
  });

  it('loads valid entries around malformed lines and writes a quarantine sidecar', () => {
    const channelId = 'api:recover-test';
    const filename = 'api-recover-test.jsonl';
    const filePath = join(dir, filename);

    const raw = [
      JSON.stringify({
        type: 'message',
        id: 1,
        channelId,
        role: 'user',
        content: 'before',
        timestamp: 1000,
      }),
      '{bad',
      JSON.stringify({
        type: 'message',
        id: 3,
        channelId,
        role: 'assistant',
        content: 'after',
        timestamp: 3000,
      }),
      '',
    ].join('\n');

    writeFileSync(filePath, raw, 'utf-8');

    const reloaded = new SessionStore(dir);
    const entries = reloaded.getRecent(channelId, 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('before');
    expect(entries[1].content).toBe('after');

    const sessionFiles = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    expect(sessionFiles).toHaveLength(1);
    const quarantinePath = join(dir, sessionFiles[0] + '.quarantine');
    expect(existsSync(quarantinePath)).toBe(true);
    const quarantine = readFileSync(quarantinePath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { lineNumber: number; raw: string });

    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]).toMatchObject({ lineNumber: 2, raw: '{bad' });
  });

  it('handles malformed journal files without throwing during channel discovery', () => {
    writeFileSync(join(dir, 'broken-session.jsonl'), '{oops\n');

    const reloaded = new SessionStore(dir);
    expect(() => reloaded.listChannels()).not.toThrow();
  });

  it('writes HMAC metadata for each signed journal entry', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:old-key,v2:new-key',
      activeVersion: 'v2',
    });
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    signedStore.append({
      channelId: 'secure:ch',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    });
    signedStore.append({
      channelId: 'secure:ch',
      role: 'assistant',
      content: 'world',
      timestamp: 2000,
    });

    const file = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .find(f => !f.startsWith('user_'));
    expect(file).toBeDefined();

    const lines = readFileSync(join(dir, file!), 'utf-8')
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as { _hmac?: string; _hmacKeyVersion?: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]._hmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(lines[1]._hmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(lines[0]._hmacKeyVersion).toBe('v2');
    expect(lines[1]._hmacKeyVersion).toBe('v2');
  });

  it('wraps tampered entries with <unverified_history> on load', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:integrity-key',
      activeVersion: 'v1',
    });
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    signedStore.append({
      channelId: 'api:session-1',
      role: 'user',
      content: 'original',
      timestamp: 1000,
    });
    signedStore.append({
      channelId: 'api:session-1',
      role: 'assistant',
      content: 'untouched',
      timestamp: 2000,
    });

    const file = readdirSync(dir).find(f => f.endsWith('.jsonl') && !f.startsWith('user_'));
    expect(file).toBeDefined();
    const filePath = join(dir, file!);
    const lines = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    lines[0].content = 'tampered';
    writeFileSync(filePath, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');

    const reloaded = new SessionStore(dir, { integrityKeyring: keyring });
    const entries = reloaded.getRecent('api:session-1', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toContain('<unverified_history>');
    expect(entries[0].content).toContain('tampered');
    expect(entries[1].content).toBe('untouched');
  });

  it('keeps unmodified signed entries verified on reload', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:integrity-key',
      activeVersion: 'v1',
    });
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    signedStore.append({
      channelId: 'api:stable',
      role: 'user',
      content: 'safe',
      timestamp: 1000,
    });

    const reloaded = new SessionStore(dir, { integrityKeyring: keyring });
    const entries = reloaded.getRecent('api:stable', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('safe');
    expect(entries[0].content).not.toContain('<unverified_history>');
  });

  it('supports key rotation while verifying older entries', () => {
    const firstKeyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:old-key',
      activeVersion: 'v1',
    });
    const rotatingStore = new SessionStore(dir, { integrityKeyring: firstKeyring });
    rotatingStore.append({
      channelId: 'api:rotate',
      role: 'user',
      content: 'first',
      timestamp: 1000,
    });

    const rotatedKeyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:old-key,v2:new-key',
      activeVersion: 'v2',
    });
    const rotatedStore = new SessionStore(dir, { integrityKeyring: rotatedKeyring });
    rotatedStore.append({
      channelId: 'api:rotate',
      role: 'assistant',
      content: 'second',
      timestamp: 2000,
    });

    const file = readdirSync(dir).find(f => f.endsWith('.jsonl') && !f.startsWith('user_'));
    expect(file).toBeDefined();
    const lines = readFileSync(join(dir, file!), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { _hmacKeyVersion?: string });
    expect(lines[0]._hmacKeyVersion).toBe('v1');
    expect(lines[1]._hmacKeyVersion).toBe('v2');

    const reloaded = new SessionStore(dir, { integrityKeyring: rotatedKeyring });
    const entries = reloaded.getRecent('api:rotate', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('first');
    expect(entries[1].content).toBe('second');
    expect(entries[0].content).not.toContain('<unverified_history>');
    expect(entries[1].content).not.toContain('<unverified_history>');
  });

  it('supports RPC-style integrity providers without direct keyring injection', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:provider-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();
    const provider = {
      sign: (entry: Parameters<typeof signJournalEntry>[0], previousHmac: string | null) => signJournalEntry(
        entry,
        keyring!,
        previousHmac,
      ),
      verify: (entry: Parameters<typeof verifyJournalEntryIntegrity>[0], previousHmac: string | null) => verifyJournalEntryIntegrity(
        entry,
        keyring!,
        previousHmac,
      ),
    };

    const providerStore = new SessionStore(dir, { integrityProvider: provider });
    providerStore.append({
      channelId: 'api:provider',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    });
    providerStore.append({
      channelId: 'api:provider',
      role: 'assistant',
      content: 'world',
      timestamp: 2000,
    });

    const file = readdirSync(dir).find(f => f.endsWith('.jsonl') && !f.startsWith('user_'));
    expect(file).toBeDefined();
    const lines = readFileSync(join(dir, file!), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { _hmac?: string; _hmacKeyVersion?: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]._hmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(lines[1]._hmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(lines[0]._hmacKeyVersion).toBe('v1');
    expect(lines[1]._hmacKeyVersion).toBe('v1');

    const reloaded = new SessionStore(dir, { integrityProvider: provider });
    const entries = reloaded.getRecent('api:provider', 10);
    expect(entries.map(entry => entry.content)).toEqual(['hello', 'world']);
  });
});

describe('sanitizeChannelId / unsanitizeChannelId', () => {
  it('keeps safe characters as-is', () => {
    expect(sanitizeChannelId('hello-world_123.test')).toBe('hello-world_123.test');
  });

  it('encodes colons', () => {
    expect(sanitizeChannelId('api:session-1')).toBe('api%3Asession-1');
  });

  it('encodes slashes', () => {
    expect(sanitizeChannelId('discord/guild/ch')).toBe('discord%2Fguild%2Fch');
  });

  it('encodes null bytes', () => {
    expect(sanitizeChannelId('ch\x00id')).toBe('ch%00id');
  });

  it('encodes backslashes', () => {
    expect(sanitizeChannelId('a\\b')).toBe('a%5Cb');
  });

  it('encodes spaces', () => {
    expect(sanitizeChannelId('hello world')).toBe('hello%20world');
  });

  it('round-trips: sanitize then unsanitize returns original', () => {
    const cases = [
      'api:session-1',
      'shard:550e8400-e29b-41d4-a716-446655440000',
      'discord/guild/channel',
      'test\\path',
      'ch\x00../../../etc/passwd',
      'simple',
      'hello world',
      'with!special@chars#$',
    ];
    for (const original of cases) {
      expect(unsanitizeChannelId(sanitizeChannelId(original))).toBe(original);
    }
  });

  it('round-trips unicode characters (non-ASCII)', () => {
    const cases = [
      'channel-\u20AC',      // Euro sign (U+20AC, 4 hex digits)
      'test-\u00E9',         // é (U+00E9, 2 hex digits)
      'caf\u00E9-chat',      // café-chat
    ];
    for (const original of cases) {
      const sanitized = sanitizeChannelId(original);
      const restored = unsanitizeChannelId(sanitized);
      expect(restored).toBe(original);
    }
  });

  it('unsanitize decodes hex sequences', () => {
    expect(unsanitizeChannelId('api%3Asession-1')).toBe('api:session-1');
    expect(unsanitizeChannelId('discord%2Fguild%2Fch')).toBe('discord/guild/ch');
  });
});
