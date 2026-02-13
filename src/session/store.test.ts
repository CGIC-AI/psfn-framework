import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from './store.js';

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
});
