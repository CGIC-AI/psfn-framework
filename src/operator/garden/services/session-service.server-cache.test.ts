import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { SessionManager } from '../../../core/session/manager.js';
import type { SessionEntry } from '../../../core/session/types.js';
import { buildSessionHmacKeyring } from '../../../persistence/journals/journal-utils.js';
import { createFilesystemSessionArchivePort } from '../../../persistence/journals/journal/port.js';
import {
  sessionTailRowId,
  type SessionTailCachePort,
  type SessionTailRow,
} from '../../../persistence/sessions/session-tail-cache-port.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { AdminSessionDataService } from './session-service.js';

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
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16_384,
    extractionMaxTokens: 8_192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16_384, contextWindow: 1_000 },
    },
  };
}

class FakeSessionTailCache implements SessionTailCachePort {
  readonly maxEntriesPerChannel = 512;
  readonly calls = { getTail: 0, appendRow: 0 };
  private readonly rows = new Map<string, SessionTailRow[]>();
  private failNextRead = false;
  private blockedAppend: Promise<void> | null = null;
  private releaseBlockedAppend: (() => void) | null = null;

  failNextGetTail(): void {
    this.failNextRead = true;
  }

  blockNextAppend(): () => void {
    this.blockedAppend = new Promise(resolve => {
      this.releaseBlockedAppend = resolve;
    });
    return () => {
      this.releaseBlockedAppend?.();
      this.blockedAppend = null;
      this.releaseBlockedAppend = null;
    };
  }

  corruptMessageRow(
    channelKey: string,
    id: number,
    overrides: Partial<SessionEntry>,
  ): void {
    const rows = this.rows.get(channelKey) ?? [];
    const target = rows.find(
      (row): row is Extract<SessionTailRow, { kind: 'message' }> => (
        row.kind === 'message' && row.entry.id === id
      ),
    );
    if (!target) {
      throw new Error(`Missing message row ${id} for ${channelKey}`);
    }
    const corrupted = rows.map((row): SessionTailRow => (
      row === target
        ? { kind: 'message', entry: { ...target.entry, ...overrides } }
        : row
    ));
    this.rows.set(channelKey, corrupted);
  }

  async getTail(channelKey: string): Promise<SessionTailRow[]> {
    this.calls.getTail += 1;
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('injected Redis read failure');
    }
    return structuredClone(this.rows.get(channelKey) ?? []);
  }

  async getEpoch(): Promise<number> {
    return 0;
  }

  async appendRow(channelKey: string, _epoch: number, row: SessionTailRow): Promise<void> {
    this.calls.appendRow += 1;
    const blocked = this.blockedAppend;
    if (blocked) await blocked;
    const rows = this.rows.get(channelKey) ?? [];
    rows.push(structuredClone(row));
    rows.sort((left, right) => sessionTailRowId(left) - sessionTailRowId(right));
    this.rows.set(channelKey, rows.slice(-this.maxEntriesPerChannel));
  }

  async replaceTail(channelKey: string, _epoch: number, rows: readonly SessionTailRow[]): Promise<void> {
    this.rows.set(channelKey, structuredClone(rows.slice(-this.maxEntriesPerChannel)));
  }

  async invalidateChannel(channelKey: string): Promise<void> {
    this.rows.delete(channelKey);
  }

  async bumpEpoch(channelKey: string): Promise<number> {
    this.rows.delete(channelKey);
    return 1;
  }
}

function appendMessage(store: SessionStore, channelId: string, content: string, timestamp: number): void {
  store.append({
    channelId,
    role: 'user',
    content,
    timestamp,
    authorId: 'contact-1',
    authorName: 'Fixture Contact',
  });
}

function makeService(store: SessionStore, dataDir: string): AdminSessionDataService {
  return new AdminSessionDataService({
    sessionStore: store,
    sessionManager: new SessionManager(store, makeConfig(dataDir)),
    eventBus: new EventBus(),
  });
}

describe('AdminSessionDataService server-side hot transcript reads', () => {
  let dir: string;
  let tail: FakeSessionTailCache;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'garden-admin-server-cache-'));
    tail = new FakeSessionTailCache();
    store = new SessionStore(dir, { tailCache: tail });
  });

  afterEach(async () => {
    await store.flushSessionTailWrites();
    rmSync(dir, { recursive: true, force: true });
  });

  it('authenticates repeated unchanged first pages without a second canonical journal scan', async () => {
    const channelId = 'api:hot-transcript';
    for (let index = 1; index <= 101; index += 1) {
      appendMessage(store, channelId, `message ${index}`, 1_000 + index);
    }
    await store.flushSessionTailWrites();
    const archivePort = createFilesystemSessionArchivePort();
    const canonicalTailScan = vi.spyOn(archivePort, 'readJournalTailEntries');
    const readerStore = new SessionStore(dir, { tailCache: tail, sessionArchivePort: archivePort });
    canonicalTailScan.mockClear();
    const service = makeService(readerStore, dir);

    const first = await service.getSessionMessagesForAdminRead(channelId, { messagesOnly: true });
    const second = await service.getSessionMessagesForAdminRead(channelId, { messagesOnly: true });

    expect(first.messages).toHaveLength(100);
    expect(first.messages[0]?.content).toBe('message 2');
    expect(first.messages.at(-1)?.content).toBe('message 101');
    expect(second).toEqual(first);
    expect(tail.calls.getTail).toBe(2);
    expect(canonicalTailScan).toHaveBeenCalledOnce();
  });

  it('keeps Redis-disabled behavior on the canonical journal path', async () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'garden-admin-server-cache-disabled-'));
    const plainStore = new SessionStore(plainDir);
    try {
      appendMessage(plainStore, 'api:cache-disabled', 'canonical', 1_000);
      const canonicalRead = vi.spyOn(plainStore, 'getRecent');

      const result = await makeService(plainStore, plainDir)
        .getSessionMessagesForAdminRead('api:cache-disabled', { messagesOnly: true });

      expect(result.messages.map(entry => entry.content)).toEqual(['canonical']);
      expect(canonicalRead).toHaveBeenCalledOnce();
    } finally {
      await plainStore.flushSessionTailWrites();
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('returns authenticated journal truth when Redis corrupts an overlapping message row', async () => {
    const channelId = 'api:authenticated-journal';
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:garden-integrity-regression-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();
    const writerStore = new SessionStore(dir, { tailCache: tail, integrityKeyring: keyring });
    appendMessage(writerStore, channelId, 'authenticated partner transcript', 1_000);
    await writerStore.flushSessionTailWrites();
    tail.corruptMessageRow(channelId, 1, {
      channelId: 'api:attacker-controlled-channel',
      content: 'corrupted Redis transcript',
    });
    // Separate reader forces the canonical row through journal HMAC
    // verification instead of relying on the writer's trusted in-memory row.
    store = new SessionStore(dir, { tailCache: tail, integrityKeyring: keyring });

    const result = await makeService(store, dir)
      .getSessionMessagesForAdminRead(channelId, { messagesOnly: true });

    expect(result.messages).toEqual([
      expect.objectContaining({
        id: 1,
        channelId,
        content: 'authenticated partner transcript',
      }),
    ]);
  });

  it('stays fresh without blocking on a pending cache write-through', async () => {
    const channelId = 'api:write-freshness';
    appendMessage(store, channelId, 'before', 1_000);
    await store.flushSessionTailWrites();
    const service = makeService(store, dir);
    expect((await service.getSessionMessagesForAdminRead(channelId, { messagesOnly: true })).messages)
      .toHaveLength(1);

    const releaseAppend = tail.blockNextAppend();
    appendMessage(store, channelId, 'after', 2_000);
    const pendingRead = service.getSessionMessagesForAdminRead(channelId, { messagesOnly: true });
    let settled = false;
    void pendingRead.then(() => {
      settled = true;
    });
    await new Promise(resolve => setImmediate(resolve));

    const settledBeforeCacheWrite = settled;
    releaseAppend();
    const fresh = await pendingRead;
    expect(settledBeforeCacheWrite).toBe(true);
    expect(fresh.messages.map(entry => entry.content)).toEqual(['before', 'after']);
  });

  it('rejects and repopulates a tail behind a durable append from another store', async () => {
    const channelId = 'api:cross-process-freshness';
    appendMessage(store, channelId, 'reader B prewarm', 1_000);
    await store.flushSessionTailWrites();

    const readerStore = new SessionStore(dir, { tailCache: tail });
    const readerService = makeService(readerStore, dir);
    expect((await readerService.getSessionMessagesForAdminRead(channelId, { messagesOnly: true })).messages)
      .toEqual([expect.objectContaining({ id: 1, content: 'reader B prewarm' })]);

    const releaseWriterAppend = tail.blockNextAppend();
    try {
      appendMessage(store, channelId, 'writer A durable append', 2_000);

      const fresh = await readerService.getSessionMessagesForAdminRead(channelId, { messagesOnly: true });
      await readerStore.flushSessionTailWrites();
      const repopulatedRows = await tail.getTail(channelId);

      expect(fresh.messages.map(entry => entry.content)).toEqual([
        'reader B prewarm',
        'writer A durable append',
      ]);
      expect(repopulatedRows).toContainEqual({
        kind: 'message',
        entry: expect.objectContaining({ id: 2, content: 'writer A durable append' }),
      });
    } finally {
      releaseWriterAppend();
      await store.flushSessionTailWrites();
    }
  });

  it('falls back to the canonical journal when the runtime tail read fails', async () => {
    const channelId = 'api:cache-failure';
    appendMessage(store, channelId, 'still available', 1_000);
    await store.flushSessionTailWrites();
    tail.failNextGetTail();
    const canonicalRead = vi.spyOn(store, 'getRecent');

    const result = await makeService(store, dir)
      .getSessionMessagesForAdminRead(channelId, { messagesOnly: true });

    expect(result.messages.map(entry => entry.content)).toEqual(['still available']);
    // One canonical read serves the response; the existing degraded-cache
    // contract may perform another to repopulate the shared tail in background.
    expect(canonicalRead).toHaveBeenCalled();
  });

  it('keeps older-page pagination on the canonical bounded range reader', async () => {
    const channelId = 'api:older-page';
    appendMessage(store, channelId, 'first', 1_000);
    appendMessage(store, channelId, 'second', 2_000);
    await store.flushSessionTailWrites();
    const service = makeService(store, dir);
    const rangeRead = vi.spyOn(store, 'getEntriesInRange');

    const older = await service.getSessionMessagesForAdminRead(channelId, {
      beforeId: 2,
      messagesOnly: true,
    });

    expect(older.messages.map((entry: SessionEntry) => entry.content)).toEqual(['first']);
    expect(rangeRead).toHaveBeenCalledOnce();
    expect(tail.calls.getTail).toBe(0);
  });
});
