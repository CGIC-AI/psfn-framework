import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from './store.js';
import type { SessionEntry } from '../../core/session/types.js';
import {
  sessionTailRowId,
  type SessionTailCachePort,
  type SessionTailRow,
} from './session-tail-cache-port.js';
import { createTurnId } from '../../core/turns/id.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';

// In-memory fake of the tail port (no live Redis in unit tests). Mirrors the
// Redis implementation's epoch fencing: rows live under a per-channel/epoch
// slot, `bumpEpoch` makes every previously written row unreadable, and rows
// are JSON round-tripped to mirror real serialization and trimmed to the
// bound like the ZSET implementation.
class FakeSessionTailCache implements SessionTailCachePort {
  readonly maxEntriesPerChannel: number;
  epochs = new Map<string, number>();
  rowsByEpochSlot = new Map<string, SessionTailRow[]>();
  calls = { getTail: 0, getEpoch: 0, appendRow: 0, replaceTail: 0, invalidateChannel: 0, bumpEpoch: 0 };
  failNextAppend = false;
  failNextBumpEpoch = false;

  constructor(maxEntriesPerChannel = 512) {
    this.maxEntriesPerChannel = maxEntriesPerChannel;
  }

  private clone(row: SessionTailRow): SessionTailRow {
    return JSON.parse(JSON.stringify(row)) as SessionTailRow;
  }

  private slot(channelKey: string, epoch = this.epochs.get(channelKey) ?? 0): string {
    return `${channelKey}@e${epoch}`;
  }

  /** Test accessor: rows written under an EXPLICIT epoch slot. */
  rowsAtEpoch(channelKey: string, epoch: number): SessionTailRow[] {
    return (this.rowsByEpochSlot.get(this.slot(channelKey, epoch)) ?? []).map(row => this.clone(row));
  }

  /** Test accessor: rows visible at the CURRENT epoch. */
  currentRows(channelKey: string): SessionTailRow[] {
    return (this.rowsByEpochSlot.get(this.slot(channelKey)) ?? []).map(row => this.clone(row));
  }

  /** Test accessor: message entries visible at the CURRENT epoch. */
  currentMessages(channelKey: string): SessionEntry[] {
    return this.currentRows(channelKey)
      .filter((row): row is Extract<SessionTailRow, { kind: 'message' }> => row.kind === 'message')
      .map(row => row.entry);
  }

  /** Test helper: overwrite the current-epoch rows directly. */
  setCurrentRows(channelKey: string, rows: SessionTailRow[]): void {
    this.rowsByEpochSlot.set(this.slot(channelKey), rows.map(row => this.clone(row)));
  }

  async getTail(channelKey: string): Promise<SessionTailRow[]> {
    this.calls.getTail += 1;
    return this.currentRows(channelKey);
  }

  async getEpoch(channelKey: string): Promise<number> {
    this.calls.getEpoch += 1;
    return this.epochs.get(channelKey) ?? 0;
  }

  async appendRow(channelKey: string, epoch: number, row: SessionTailRow): Promise<void> {
    this.calls.appendRow += 1;
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('fake tail append failure');
    }
    const slot = this.slot(channelKey, epoch);
    const rows = this.rowsByEpochSlot.get(slot) ?? [];
    rows.push(this.clone(row));
    rows.sort((left, right) => sessionTailRowId(left) - sessionTailRowId(right));
    this.rowsByEpochSlot.set(slot, rows.slice(-this.maxEntriesPerChannel));
  }

  async replaceTail(channelKey: string, epoch: number, rows: readonly SessionTailRow[]): Promise<void> {
    this.calls.replaceTail += 1;
    this.rowsByEpochSlot.set(
      this.slot(channelKey, epoch),
      rows.slice(-this.maxEntriesPerChannel).map(row => this.clone(row)),
    );
  }

  async invalidateChannel(channelKey: string, epoch: number): Promise<void> {
    this.calls.invalidateChannel += 1;
    this.rowsByEpochSlot.delete(this.slot(channelKey, epoch));
  }

  async bumpEpoch(channelKey: string): Promise<number> {
    this.calls.bumpEpoch += 1;
    if (this.failNextBumpEpoch) {
      this.failNextBumpEpoch = false;
      throw new Error('fake epoch INCR failure');
    }
    const next = (this.epochs.get(channelKey) ?? 0) + 1;
    this.epochs.set(channelKey, next);
    this.rowsByEpochSlot.delete(this.slot(channelKey));
    return next;
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

    const cached = tail.currentMessages('ch-wt');
    expect(cached).toEqual(store.getRecent('ch-wt', 10));
    for (const entry of cached) {
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
        getEpoch: 0,
        appendRow: 0,
        replaceTail: 0,
        invalidateChannel: 0,
        bumpEpoch: 0,
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

    // Simulate a lost TRAILING tail write (Redis blip on another process).
    tail.setCurrentRows(
      'ch-behind',
      tail.currentRows('ch-behind').filter(row => sessionTailRowId(row) !== currentId),
    );

    const missed = await store.fetchSessionTailWindow('ch-behind', { expectedMinEntryId: currentId });
    expect(missed).toBeNull();
    await store.flushSessionTailWrites();
    expect(tail.calls.replaceTail).toBeGreaterThan(0);
    expect(tail.currentMessages('ch-behind')).toEqual(store.getRecent('ch-behind', 512));

    const healed = await store.fetchSessionTailWindow('ch-behind', { expectedMinEntryId: currentId });
    expect(healed?.map(entry => entry.id)).toContain(currentId);
  });

  it('an INTERIOR id gap is a miss even when the max-id freshness check passes', async () => {
    // Review finding: process A's tail append of id N fails (poisons only A),
    // process B appends N+1; [.., N-1, N+1] passes the max-id check but the
    // window silently lost an entry. Contiguity must reject it.
    appendMessage(store, 'ch-gap', 'user', 'first', 1_000);
    const droppedId = appendMessage(store, 'ch-gap', 'assistant', 'lost from tail', 2_000);
    const currentId = appendMessage(store, 'ch-gap', 'user', 'latest', 3_000);
    await store.flushSessionTailWrites();

    tail.setCurrentRows(
      'ch-gap',
      tail.currentRows('ch-gap').filter(row => sessionTailRowId(row) !== droppedId),
    );

    const missed = await store.fetchSessionTailWindow('ch-gap', { expectedMinEntryId: currentId });
    expect(missed).toBeNull();

    // Journal fallback + repopulation heals the gap.
    await store.flushSessionTailWrites();
    expect(tail.currentMessages('ch-gap')).toEqual(store.getRecent('ch-gap', 512));
    const healed = await store.fetchSessionTailWindow('ch-gap', { expectedMinEntryId: currentId });
    expect(healed?.map(entry => entry.id)).toEqual([1, droppedId, currentId]);
  });

  it('non-message journal entries write id-gap placeholders so contiguity keeps holding', async () => {
    appendMessage(store, 'ch-marker', 'user', 'before compaction', 1_000);
    const coveredId = appendMessage(store, 'ch-marker', 'assistant', 'covered reply', 2_000);
    store.insertCompaction('ch-marker', 'fixture summary', coveredId);
    const currentId = appendMessage(store, 'ch-marker', 'user', 'after compaction', 3_000);
    await store.flushSessionTailWrites();

    // The compaction consumed an entry id between the messages; the explicit
    // placeholder keeps the window contiguous and the tail keeps serving.
    const window = await store.fetchSessionTailWindow('ch-marker', { expectedMinEntryId: currentId });
    expect(window).not.toBeNull();
    expect(window?.map(entry => entry.id)).toEqual([1, coveredId, currentId]);
    expect(tail.currentRows('ch-marker').some(row => row.kind === 'id_gap')).toBe(true);
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
    expect(tail.currentMessages('ch-fail')).toEqual(store.getRecent('ch-fail', 512));

    const recovered = await store.fetchSessionTailWindow('ch-fail', { expectedMinEntryId: failedId });
    expect(recovered?.map(entry => entry.id)).toContain(failedId);
  });

  it('redactTurn bumps the shared epoch so every process drops the pre-rewrite tail', async () => {
    const seedId = appendMessage(store, 'ch-redact', 'user', 'to be redacted', 1_000);
    await store.flushSessionTailWrites();

    // A SECOND process (fresh store over the same tail) can serve the window.
    const otherProcess = new SessionStore(dir, { tailCache: tail });
    expect(await otherProcess.fetchSessionTailWindow('ch-redact', { expectedMinEntryId: seedId }))
      .not.toBeNull();

    await store.redactTurn('ch-redact', createTurnId(), { actor: 'operator' });
    await store.flushSessionTailWrites();

    expect(tail.calls.bumpEpoch).toBeGreaterThan(0);
    // The other process holds NO local poison flag, yet its next read misses:
    // the epoch fence is cross-process. Pre-rewrite rows are unreachable.
    expect(await otherProcess.fetchSessionTailWindow('ch-redact', { expectedMinEntryId: seedId }))
      .toBeNull();
  });

  it('a failed epoch INCR fails the rewrite loudly while the journal is untouched', async () => {
    appendMessage(store, 'ch-incr-fail', 'user', 'must stay redactable', 1_000);
    await store.flushSessionTailWrites();
    const before = store.getRecent('ch-incr-fail', 10);

    tail.failNextBumpEpoch = true;
    await expect(store.redactTurn('ch-incr-fail', createTurnId(), { actor: 'operator' }))
      .rejects.toThrow(/epoch bump failed/);

    // Fail-closed: the tombstone did NOT land (no partial redaction with a
    // live pre-rewrite tail in other processes).
    expect(store.getRecent('ch-incr-fail', 10)).toEqual(before);
  });

  it('redactTurn succeeds without a tail cache configured (feature disabled)', async () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'psfn-session-notail-'));
    try {
      const plain = new SessionStore(plainDir);
      appendMessage(plain, 'ch-plain-redact', 'user', 'redact without redis', 1_000);
      await expect(plain.redactTurn('ch-plain-redact', createTurnId(), { actor: 'operator' }))
        .resolves.toBeUndefined();
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('reloadChannelFromDisk (hgw3.1 heal hook) fences the tail so the recapture reads the journal', async () => {
    const seedId = appendMessage(store, 'ch-heal', 'user', 'heal seed', 1_000);
    await store.flushSessionTailWrites();

    await store.reloadChannelFromDisk('ch-heal');
    // Even though the fake still held pre-reload rows (under the old epoch),
    // the heal must force the journal-backed path for the immediate
    // recapture.
    expect(await store.fetchSessionTailWindow('ch-heal', { expectedMinEntryId: seedId })).toBeNull();
    await store.flushSessionTailWrites();
    expect(tail.currentMessages('ch-heal')).toEqual(store.getRecent('ch-heal', 512));
  });

  it('reloadChannelFromDisk fails loudly when the epoch bump fails (post-repair fencing)', async () => {
    appendMessage(store, 'ch-heal-fail', 'user', 'seed', 1_000);
    await store.flushSessionTailWrites();

    tail.failNextBumpEpoch = true;
    await expect(store.reloadChannelFromDisk('ch-heal-fail')).rejects.toThrow(/epoch bump failed/);
  });

  it('a queued tail write binds to the epoch captured at enqueue, never the epoch at execution', async () => {
    // The append enqueues a tail write that captures epoch 0 with the row
    // data. Before the queued write executes, a rewrite fence lands
    // (another process's redaction bumping the shared epoch). The row MUST
    // go to the superseded epoch-0 slot — resolving the epoch at execution
    // time would resurrect pre-rewrite content under the new epoch.
    const id = appendMessage(store, 'ch-enqueue-bind', 'user', 'pre-rewrite content', 1_000);
    tail.epochs.set('ch-enqueue-bind', 1);
    await store.flushSessionTailWrites();

    expect(tail.currentRows('ch-enqueue-bind')).toEqual([]);
    expect(tail.rowsAtEpoch('ch-enqueue-bind', 0).map(row => sessionTailRowId(row))).toEqual([id]);
  });

  it('the second fence still lands when a step AFTER the journal rewrite throws (exception-safe post bump)', async () => {
    const caseId = 'cogsec_20260701T000000Z_postfence';
    const dirtyId = appendMessage(store, 'ch-postfence', 'user', 'payload to tombstone', 1_000);
    await store.flushSessionTailWrites();

    const eventStore = new CogSecEventStore(join(dir, 'cogsec-events.json'));
    eventStore.createEvent({
      caseId,
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: 'ch-postfence',
      safeAgentSummary: 'Unsafe instruction-like content was sealed and removed from active cognition.',
    });

    const bumpsBefore = tail.calls.bumpEpoch;
    // Event bookkeeping runs AFTER the journal rewrite landed; its failure
    // must NOT leave the stale-epoch repopulation race open.
    await expect(store.applyCogSecTombstones({
      channelId: 'ch-postfence',
      caseId,
      eventStore: {
        getEvent: id => eventStore.getEvent(id),
        updateEvent: () => {
          throw new Error('event bookkeeping failed after the rewrite');
        },
      },
      forensicArchive: {
        sealArtifact: () => ({
          ref: `${caseId}/fixture-artifact`,
          artifactId: 'fixture-artifact',
          caseId,
          kind: 'l0_rows',
          sha256: 'sha256:fixture',
          byteLength: 1,
          createdAt: '2026-07-01T00:00:00.000Z',
        }),
      },
      messageIds: [dirtyId],
    })).rejects.toThrow(/event bookkeeping failed/);

    // The rewrite itself was durable (tombstone landed in the journal)...
    expect(store.getRecent('ch-postfence', 10).map(entry => entry.content))
      .toEqual([`[CogSec redaction: ${caseId}]`]);
    // ...so BOTH fences must have run: pre-rewrite and (exception-safe)
    // post-rewrite. Without the post fence a sibling's stale repopulation
    // could resurrect the pre-rewrite tail under the bumped epoch.
    expect(tail.calls.bumpEpoch - bumpsBefore).toBe(2);
    expect(tail.epochs.get('ch-postfence')).toBe(2);
  });

  it('a corrupt tail (duplicate ids) fails closed to the journal path', async () => {
    const id = appendMessage(store, 'ch-corrupt', 'user', 'original copy', 1_000);
    await store.flushSessionTailWrites();
    const existing = tail.currentRows('ch-corrupt');
    const duplicate = JSON.parse(JSON.stringify(existing[0])) as SessionTailRow;
    if (duplicate.kind === 'message') {
      duplicate.entry.content = 'stale duplicate';
    }
    tail.setCurrentRows('ch-corrupt', [...existing, duplicate]);

    expect(await store.fetchSessionTailWindow('ch-corrupt', { expectedMinEntryId: id })).toBeNull();
    await store.flushSessionTailWrites();
    expect(tail.currentMessages('ch-corrupt')).toEqual(store.getRecent('ch-corrupt', 512));
  });
});
