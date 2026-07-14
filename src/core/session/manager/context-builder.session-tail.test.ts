import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../persistence/sessions/store.js';
import {
  sessionTailRowId,
  type SessionTailCachePort,
  type SessionTailRow,
} from '../../../persistence/sessions/session-tail-cache-port.js';
import type { SessionEntry } from '../types.js';
import { SessionManager } from '../manager.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';

// In-memory fake of the tail port (no live Redis in unit tests). Mirrors the
// Redis implementation's epoch fencing, JSON round-trips rows to mirror real
// serialization, and trims to the bound.
class FakeSessionTailCache implements SessionTailCachePort {
  readonly maxEntriesPerChannel: number;
  epochs = new Map<string, number>();
  rowsByEpochSlot = new Map<string, SessionTailRow[]>();
  calls = { getTail: 0, appendRow: 0, replaceTail: 0, invalidateChannel: 0, bumpEpoch: 0 };

  constructor(maxEntriesPerChannel = 512) {
    this.maxEntriesPerChannel = maxEntriesPerChannel;
  }

  private clone(row: SessionTailRow): SessionTailRow {
    return JSON.parse(JSON.stringify(row)) as SessionTailRow;
  }

  private slot(channelKey: string): string {
    return `${channelKey}@e${this.epochs.get(channelKey) ?? 0}`;
  }

  currentRows(channelKey: string): SessionTailRow[] {
    return (this.rowsByEpochSlot.get(this.slot(channelKey)) ?? []).map(row => this.clone(row));
  }

  currentMessages(channelKey: string): SessionEntry[] {
    return this.currentRows(channelKey)
      .filter((row): row is Extract<SessionTailRow, { kind: 'message' }> => row.kind === 'message')
      .map(row => row.entry);
  }

  setCurrentRows(channelKey: string, rows: SessionTailRow[]): void {
    this.rowsByEpochSlot.set(this.slot(channelKey), rows.map(row => this.clone(row)));
  }

  async getTail(channelKey: string): Promise<SessionTailRow[]> {
    this.calls.getTail += 1;
    return this.currentRows(channelKey);
  }

  async appendRow(channelKey: string, row: SessionTailRow): Promise<void> {
    this.calls.appendRow += 1;
    const rows = this.rowsByEpochSlot.get(this.slot(channelKey)) ?? [];
    rows.push(this.clone(row));
    rows.sort((left, right) => sessionTailRowId(left) - sessionTailRowId(right));
    this.rowsByEpochSlot.set(this.slot(channelKey), rows.slice(-this.maxEntriesPerChannel));
  }

  async replaceTail(channelKey: string, rows: readonly SessionTailRow[]): Promise<void> {
    this.calls.replaceTail += 1;
    this.rowsByEpochSlot.set(
      this.slot(channelKey),
      rows.slice(-this.maxEntriesPerChannel).map(row => this.clone(row)),
    );
  }

  async invalidateChannel(channelKey: string): Promise<void> {
    this.calls.invalidateChannel += 1;
    this.rowsByEpochSlot.delete(this.slot(channelKey));
  }

  async bumpEpoch(channelKey: string): Promise<number> {
    this.calls.bumpEpoch += 1;
    const next = (this.epochs.get(channelKey) ?? 0) + 1;
    this.epochs.set(channelKey, next);
    return next;
  }
}

function makeConfig(dataDir: string): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: '',
    sessionHistoryBudgetPct: 50,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 8000 },
    },
  };
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

// Acceptance (psfn-framework-hgw3.5): with the tail enabled,
// captureTurnSessionContext returns entries identical to the file-only path,
// including the recorded staleness scenario (assistant appended via a SECOND
// store instance, then the user turn via the first, then capture).
describe('captureTurnSessionContext with the session tail cache', () => {
  let dir: string;
  let sessionsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-capture-tail-'));
    sessionsDir = join(dir, 'sessions');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function captureBothPaths(params: {
    tail: FakeSessionTailCache;
    channelId: string;
    excludeSessionEntryId: number;
  }) {
    const tailStore = new SessionStore(sessionsDir, { tailCache: params.tail });
    const tailManager = new SessionManager(tailStore, makeConfig(dir));
    const fileStore = new SessionStore(sessionsDir);
    const fileManager = new SessionManager(fileStore, makeConfig(dir));

    const tailSnapshot = await tailManager.captureTurnSessionContext({
      channelId: params.channelId,
      excludeSessionEntryId: params.excludeSessionEntryId,
    });
    const fileSnapshot = await fileManager.captureTurnSessionContext({
      channelId: params.channelId,
      excludeSessionEntryId: params.excludeSessionEntryId,
    });
    return { tailSnapshot, fileSnapshot };
  }

  it('parity: tail-served capture equals the file-only capture across the staleness scenario', async () => {
    const tail = new FakeSessionTailCache();
    const writerA = new SessionStore(sessionsDir, { tailCache: tail });

    appendMessage(writerA, 'ch-parity', 'user', 'opening question', Date.now() - 50_000);
    appendMessage(writerA, 'ch-parity', 'assistant', 'opening reply', Date.now() - 40_000);
    appendMessage(writerA, 'ch-parity', 'user', 'previous turn question', Date.now() - 30_000);
    // Recorded staleness shape: the assistant reply lands via a SECOND store
    // instance (another process), then the current user turn via the first.
    const writerB = new SessionStore(sessionsDir, { tailCache: tail });
    appendMessage(writerB, 'ch-parity', 'assistant', 'previous turn reply', Date.now() - 20_000);
    const currentUserId = appendMessage(writerA, 'ch-parity', 'user', 'current turn question', Date.now());
    await writerA.flushSessionTailWrites();
    await writerB.flushSessionTailWrites();

    const { tailSnapshot, fileSnapshot } = await captureBothPaths({
      tail,
      channelId: 'ch-parity',
      excludeSessionEntryId: currentUserId,
    });

    expect(tail.calls.getTail).toBeGreaterThan(0);
    expect(tailSnapshot.recentEntries).toEqual(fileSnapshot.recentEntries);
    expect(tailSnapshot.storeWindowMaxEntryId).toBe(fileSnapshot.storeWindowMaxEntryId);
    expect(tailSnapshot.storeWindowMaxEntryId).toBe(currentUserId);
    expect(tailSnapshot.recentEntries.map(entry => entry.content))
      .toContain('previous turn reply');
    expect(tailSnapshot.compactionSummaryTexts).toEqual(fileSnapshot.compactionSummaryTexts);
    expect(tailSnapshot.sourceEntryCount).toBe(fileSnapshot.sourceEntryCount);
  });

  it('bound merge: a window larger than maxEntriesPerChannel merges journal + tail with no duplicates', async () => {
    const tail = new FakeSessionTailCache(4);
    const writer = new SessionStore(sessionsDir, { tailCache: tail });
    let currentUserId = 0;
    for (let index = 0; index < 12; index += 1) {
      currentUserId = appendMessage(
        writer,
        'ch-bound',
        index % 2 === 0 ? 'user' : 'assistant',
        `bounded message ${index + 1}`,
        Date.now() - (12 - index) * 1_000,
      );
    }
    await writer.flushSessionTailWrites();
    expect(tail.currentRows('ch-bound')).toHaveLength(4);

    const { tailSnapshot, fileSnapshot } = await captureBothPaths({
      tail,
      channelId: 'ch-bound',
      excludeSessionEntryId: currentUserId,
    });

    const ids = tailSnapshot.recentEntries.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((left, right) => left - right)).toEqual(ids);
    expect(tailSnapshot.recentEntries).toEqual(fileSnapshot.recentEntries);
  });

  it('behind-tail detection: a tail missing the just-recorded entry falls back and repopulates', async () => {
    const tail = new FakeSessionTailCache();
    const writer = new SessionStore(sessionsDir, { tailCache: tail });
    appendMessage(writer, 'ch-behind', 'user', 'previous question', Date.now() - 20_000);
    appendMessage(writer, 'ch-behind', 'assistant', 'previous reply', Date.now() - 10_000);
    const currentUserId = appendMessage(writer, 'ch-behind', 'user', 'current question', Date.now());
    await writer.flushSessionTailWrites();
    // Simulate a lost write-through: wipe the just-recorded entry from the tail.
    tail.setCurrentRows(
      'ch-behind',
      tail.currentRows('ch-behind').filter(row => sessionTailRowId(row) !== currentUserId),
    );

    const tailStore = new SessionStore(sessionsDir, { tailCache: tail });
    const tailManager = new SessionManager(tailStore, makeConfig(dir));
    const snapshot = await tailManager.captureTurnSessionContext({
      channelId: 'ch-behind',
      excludeSessionEntryId: currentUserId,
    });

    // Journal fallback still serves the full window (never a stale reply loop)...
    expect(snapshot.storeWindowMaxEntryId).toBe(currentUserId);
    expect(snapshot.recentEntries.map(entry => entry.content)).toContain('previous reply');
    // ...and the tail repopulates for the fleet.
    await tailStore.flushSessionTailWrites();
    expect(tail.calls.replaceTail).toBeGreaterThan(0);
    expect(tail.currentMessages('ch-behind').map(entry => entry.id)).toContain(currentUserId);
  });

  it('parity holds on a compacted channel (boundary-store read path)', async () => {
    const tail = new FakeSessionTailCache();
    const writerA = new SessionStore(sessionsDir, { tailCache: tail });
    appendMessage(writerA, 'ch-compacted', 'user', 'opening message', Date.now() - 60_000);
    const openingReplyId = appendMessage(writerA, 'ch-compacted', 'assistant', 'opening reply', Date.now() - 50_000);
    writerA.insertCompaction('ch-compacted', 'summary of the opening exchange', openingReplyId);
    appendMessage(writerA, 'ch-compacted', 'user', 'previous turn question', Date.now() - 30_000);
    const writerB = new SessionStore(sessionsDir, { tailCache: tail });
    appendMessage(writerB, 'ch-compacted', 'assistant', 'previous turn reply', Date.now() - 20_000);
    const currentUserId = appendMessage(writerA, 'ch-compacted', 'user', 'current turn question', Date.now());
    await writerA.flushSessionTailWrites();
    await writerB.flushSessionTailWrites();

    const { tailSnapshot, fileSnapshot } = await captureBothPaths({
      tail,
      channelId: 'ch-compacted',
      excludeSessionEntryId: currentUserId,
    });

    expect(tailSnapshot.recentEntries).toEqual(fileSnapshot.recentEntries);
    // Entries covered by the compaction stay out of the served window even
    // though the tail still holds them.
    expect(tailSnapshot.recentEntries.map(entry => entry.content))
      .not.toContain('opening message');
    expect(tailSnapshot.recentEntries.map(entry => entry.content))
      .toContain('previous turn reply');
    expect(tailSnapshot.compactionSummaryTexts).toEqual(fileSnapshot.compactionSummaryTexts);
    expect(tailSnapshot.compactionSummaryTexts).toHaveLength(1);
  });
});
