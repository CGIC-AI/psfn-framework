import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, sanitizeChannelId, unsanitizeChannelId } from './store.js';

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

  it('handles malformed journal files without throwing during channel discovery', () => {
    writeFileSync(join(dir, 'broken-session.jsonl'), '{oops\n');

    const reloaded = new SessionStore(dir);
    expect(() => reloaded.listChannels()).not.toThrow();
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
