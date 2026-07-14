import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from './store.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SessionTailCachePort } from './session-tail-cache-port.js';
import { createTurnId } from '../../core/turns/id.js';

// In-memory fake of the tail port (no live Redis in unit tests). Entries are
// JSON round-tripped to mirror real serialization, kept sorted by id and
// trimmed to the bound like the ZSET implementation.
class FakeSessionTailCache implements SessionTailCachePort {
  readonly maxEntriesPerChannel: number;
  tails = new Map<string, SessionEntry[]>();
  calls = { getTail: 0, appendEntry: 0, replaceTail: 0, invalidateChannel: 0 };
  failNextAppend = false;

  constructor(maxEntriesPerChannel = 512) {
    this.maxEntriesPerChannel = maxEntriesPerChannel;
  }

  private clone(entry: SessionEntry): SessionEntry {
    return JSON.parse(JSON.stringify(entry)) as SessionEntry;
  }

  async getTail(channelKey: string): Promise<SessionEntry[]> {
    this.calls.getTail += 1;
    return (this.tails.get(channelKey) ?? []).map(entry => this.clone(entry));
  }

  async appendEntry(channelKey: string, entry: SessionEntry): Promise<void> {
    this.calls.appendEntry += 1;
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('fake tail append failure');
    }
    const tail = this.tails.get(channelKey) ?? [];
    tail.push(this.clone(entry));
    tail.sort((left, right) => left.id - right.id);
    this.tails.set(channelKey, tail.slice(-this.maxEntriesPerChannel));
  }

  async replaceTail(channelKey: string, entries: readonly SessionEntry[]): Promise<void> {
    this.calls.replaceTail += 1;
    this.tails.set(
      channelKey,
      entries.slice(-this.maxEntriesPerChannel).map(entry => this.clone(entry)),
    );
  }

  async invalidateChannel(channelKey: string): Promise<void> {
    this.calls.invalidateChannel += 1;
    this.tails.delete(channelKey);
  }
}

function appendMessage(
  store: SessionStore,
  channelId: string,
  role: 'user' | 'assistant',
  content: string,
  timestamp: number,
): number {
  return store.append({
    channelId,
    role,
    content,
    timestamp,
    authorId: role === 'user' ? 'contact-1' : 'companion',
    authorName: role === 'user' ? 'FixtureContact' : 'FixtureCompanion',
  });
}

describe('SessionStore session tail integration (psfn-framework-hgw3.5)', () => {
  let dir: string;
  let tail: FakeSessionTailCache;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-session-tail-'));
    tail = new FakeSessionTailCache();
    store = new SessionStore(dir, { tailCache: tail });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes every append through to the shared tail, without integrity fields', async () => {
    appendMessage(store, 'ch-wt', 'user', 'first question', 1_000);
    appendMessage(store, 'ch-wt', 'assistant', 'first answer', 2_000);
    await store.flushSessionTailWrites();

    const cached = tail.tails.get('ch-wt');
    expect(cached).toBeDefined();
    expect(cached).toEqual(store.getRecent('ch-wt', 10));
    for (const entry of cached ?? []) {
      expect(entry).not.toHaveProperty('_hmac');
      expect(entry).not.toHaveProperty('_hmacKeyVersion');
    }
  });

  it('disabled config is zero behavior change: no port calls, identical entries', async () => {
    const untouched = new FakeSessionTailCache();
    const plainDir = mkdtempSync(join(tmpdir(), 'psfn-session-plain-'));
    try {
      const plain = new SessionStore(plainDir);
      appendMessage(plain, 'ch-off', 'user', 'no tail here', 1_000);
      expect(await plain.fetchSessionTailWindow('ch-off')).toBeNull();
      await plain.flushSessionTailWrites();
      expect(untouched.calls).toEqual({
        getTail: 0,
        appendEntry: 0,
        replaceTail: 0,
        invalidateChannel: 0,
      });
      expect(plain.getRecent('ch-off', 10)).toHaveLength(1);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('serves the tail across store instances, covering the recorded staleness scenario', async () => {
    // Recorded hgw3.1 shape: assistant reply appended via a SECOND store
    // instance (another process), then the user turn via the first.
    appendMessage(store, 'ch-stale', 'user', 'previous question', 1_000);
    const secondStore = new SessionStore(dir, { tailCache: tail });
    const assistantId = appendMessage(secondStore, 'ch-stale', 'assistant', 'previous reply', 2_000);
    const currentUserId = appendMessage(store, 'ch-stale', 'user', 'current question', 3_000);
    await store.flushSessionTailWrites();
    await secondStore.flushSessionTailWrites();

    const window = await store.fetchSessionTailWindow('ch-stale', {
      expectedMinEntryId: currentUserId,
    });
    expect(window).not.toBeNull();
    expect(window?.map(entry => entry.id)).toEqual([1, assistantId, currentUserId]);
    expect(window).toEqual(store.getRecent('ch-stale', 10));
  });

  it('treats a tail behind the just-recorded entry as a miss and repopulates from the journal', async () => {
    appendMessage(store, 'ch-behind', 'user', 'covered question', 1_000);
    const currentId = appendMessage(store, 'ch-behind', 'assistant', 'covered answer', 2_000);
    await store.flushSessionTailWrites();

    // Simulate a lost tail write (Redis blip on another process).
    tail.tails.set('ch-behind', (tail.tails.get('ch-behind') ?? []).filter(entry => entry.id !== currentId));

    const missed = await store.fetchSessionTailWindow('ch-behind', { expectedMinEntryId: currentId });
    expect(missed).toBeNull();
    await store.flushSessionTailWrites();
    expect(tail.calls.replaceTail).toBeGreaterThan(0);
    expect(tail.tails.get('ch-behind')).toEqual(store.getRecent('ch-behind', 512));

    const healed = await store.fetchSessionTailWindow('ch-behind', { expectedMinEntryId: currentId });
    expect(healed?.map(entry => entry.id)).toContain(currentId);
  });

  it('an empty tail is a miss that repopulates', async () => {
    appendMessage(store, 'ch-empty', 'user', 'seed', 1_000);
    await store.flushSessionTailWrites();
    tail.tails.delete('ch-empty');

    expect(await store.fetchSessionTailWindow('ch-empty')).toBeNull();
    await store.flushSessionTailWrites();
    expect(tail.tails.get('ch-empty')).toEqual(store.getRecent('ch-empty', 512));
  });

  it('a failed tail write poisons the channel until repopulation (loud degrade, no thrown error)', async () => {
    appendMessage(store, 'ch-fail', 'user', 'before failure', 1_000);
    await store.flushSessionTailWrites();

    tail.failNextAppend = true;
    const failedId = appendMessage(store, 'ch-fail', 'assistant', 'write-through fails', 2_000);
    await store.flushSessionTailWrites();

    // Poisoned: the fetch skips the (possibly gapped) tail and repopulates.
    expect(await store.fetchSessionTailWindow('ch-fail', { expectedMinEntryId: failedId })).toBeNull();
    await store.flushSessionTailWrites();
    expect(tail.tails.get('ch-fail')).toEqual(store.getRecent('ch-fail', 512));

    const recovered = await store.fetchSessionTailWindow('ch-fail', { expectedMinEntryId: failedId });
    expect(recovered?.map(entry => entry.id)).toContain(failedId);
  });

  it('redactTurn invalidates the channel tail instead of patching it', async () => {
    appendMessage(store, 'ch-redact', 'user', 'to be redacted', 1_000);
    await store.flushSessionTailWrites();

    store.redactTurn('ch-redact', createTurnId(), { actor: 'operator' });
    await store.flushSessionTailWrites();

    expect(tail.calls.invalidateChannel).toBeGreaterThan(0);
  });

  it('reloadChannelFromDisk (hgw3.1 heal hook) poisons the tail so the recapture reads the journal', async () => {
    const seedId = appendMessage(store, 'ch-heal', 'user', 'heal seed', 1_000);
    await store.flushSessionTailWrites();

    store.reloadChannelFromDisk('ch-heal');
    // Even though the fake still held a tail, the heal must force the
    // journal-backed path for the immediate recapture.
    expect(await store.fetchSessionTailWindow('ch-heal', { expectedMinEntryId: seedId })).toBeNull();
    await store.flushSessionTailWrites();
    expect(tail.tails.get('ch-heal')).toEqual(store.getRecent('ch-heal', 512));
  });

  it('a corrupt tail (duplicate ids) fails closed to the journal path', async () => {
    const id = appendMessage(store, 'ch-corrupt', 'user', 'original copy', 1_000);
    await store.flushSessionTailWrites();
    const existing = tail.tails.get('ch-corrupt') ?? [];
    tail.tails.set('ch-corrupt', [...existing, { ...existing[0], content: 'stale duplicate' }]);

    expect(await store.fetchSessionTailWindow('ch-corrupt', { expectedMinEntryId: id })).toBeNull();
    await store.flushSessionTailWrites();
    expect(tail.tails.get('ch-corrupt')).toEqual(store.getRecent('ch-corrupt', 512));
  });
});
