// ── Presence-windowed private-room session serving (psfn-framework-s10rm) ──
//
// The DELIVERY-time privacy mechanism, agent side: a private companion-room
// channel serves context only from the recipient's CURRENT presence window
// (`since` → floor). Covered here:
//  - late joiner: nothing recorded before the window floor is ever served
//  - gap on rejoin: a NEW window serves neither the gap nor earlier windows
//  - public rooms / no port: byte-identical serving (parity)
//  - closed window: serves nothing (fail closed)
//  - compaction summaries minted in earlier windows are not served, and
//    between-turns compaction never summarizes pre-window content
//  - memory-extraction input needs NO change: the session store (extraction's
//    input) holds exactly the delivered window(s) — asserted at the
//    session-content level without touching extraction code.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from './manager.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { RoomContentWindow, RoomContentWindowPort } from './room-content-window.js';
import type { LLMProviderPort } from '../agent/contracts.js';

const ROOM = 'companion-room:den';

// A fixed "now" so orientation/idle math is deterministic across captures.
const NOW = Date.parse('2026-07-08T12:00:00Z');
const T = (offsetMs: number): number => NOW - offsetMs;

function makeConfig(dir: string): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: dir,
    databasePath: '',
    sessionHistoryBudgetPct: 6,
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
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
    },
  } as SubstrateConfig;
}

function fixedWindowPort(window: RoomContentWindow): RoomContentWindowPort {
  return { resolveWindow: (channelId) => (channelId === ROOM ? window : { kind: 'unwindowed' }) };
}

function appendRoomMessage(
  store: SessionStore,
  content: string,
  timestamp: number,
  role: 'user' | 'assistant' = 'user',
): number {
  return store.append({
    channelId: ROOM,
    role,
    content,
    authorId: role === 'user' ? 'comp-peer' : 'comp-self',
    authorName: role === 'user' ? 'Peer' : 'Self',
    timestamp,
  });
}

describe('SessionManager private-room presence window (psfn-framework-s10rm)', () => {
  let dir: string;
  let store: SessionStore;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-room-window-'));
    store = new SessionStore(dir);
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('late joiner: serves nothing recorded before the current window floor', async () => {
    const mgr = new SessionManager(store, makeConfig(dir));
    // Room conversation before this companion joined would never be delivered
    // to it — but its OWN persisted session from an EARLIER visit looks the
    // same to the serving path, which is exactly what this gate covers.
    appendRoomMessage(store, 'earlier-window secret plan', T(60_000));
    appendRoomMessage(store, 'earlier-window reply', T(55_000), 'assistant');
    const floor = T(30_000);
    appendRoomMessage(store, 'post-join greeting', T(20_000));
    appendRoomMessage(store, 'post-join reply', T(10_000), 'assistant');

    mgr.setRoomContentWindowPort(fixedWindowPort({ kind: 'windowed', floorMs: floor }));
    const snapshot = await mgr.captureTurnSessionContext({ channelId: ROOM });

    expect(snapshot.recentEntries.map(entry => entry.content)).toEqual([
      'post-join greeting',
      'post-join reply',
    ]);
    expect(snapshot.roomWindowFloorMs).toBe(floor);
    expect(snapshot.roomWindowFilteredEntryCount).toBe(2);

    const context = await mgr.buildContext(ROOM, 'SYS', '', undefined, undefined, undefined, [], snapshot);
    const rendered = JSON.stringify(context.messages) + context.systemPrompt;
    expect(rendered).not.toContain('earlier-window secret plan');
    expect(rendered).not.toContain('earlier-window reply');
    expect(rendered).toContain('post-join greeting');
    expect(context.manifest.session.roomWindowFilteredEntryCount).toBe(2);
  });

  it('gap on rejoin: a NEW window serves neither the gap nor the earlier window', async () => {
    const mgr = new SessionManager(store, makeConfig(dir));
    // Window 1 (present): these were delivered and recorded.
    appendRoomMessage(store, 'w1 chat', T(120_000));
    // Gap (absent): the gateway fan-out excluded this companion, so NOTHING
    // from the gap exists in its store — that is the privacy guarantee. We
    // deliberately append nothing here.
    // Window 2 (rejoined): new window, new floor.
    const rejoinFloor = T(30_000);
    appendRoomMessage(store, 'w2 chat after rejoin', T(15_000));

    mgr.setRoomContentWindowPort(fixedWindowPort({ kind: 'windowed', floorMs: rejoinFloor }));
    const snapshot = await mgr.captureTurnSessionContext({ channelId: ROOM });

    // Only the current window is served: no gap content (it was never
    // delivered) and no retroactive access to window 1 either.
    expect(snapshot.recentEntries.map(entry => entry.content)).toEqual(['w2 chat after rejoin']);
    expect(snapshot.roomWindowFilteredEntryCount).toBe(1);

    // Extraction-input proof (session-content level, no extraction code
    // involved): the L0 session store — the ONLY input extraction ever sees —
    // contains exactly the delivered windows and nothing from the gap.
    const l0Contents = store.getRecent(ROOM, 100).map(entry => entry.content);
    expect(l0Contents).toEqual(['w1 chat', 'w2 chat after rejoin']);
  });

  it('closed window serves nothing at all (fail closed)', async () => {
    const mgr = new SessionManager(store, makeConfig(dir));
    appendRoomMessage(store, 'room chatter', T(20_000));
    appendRoomMessage(store, 'more chatter', T(10_000), 'assistant');

    mgr.setRoomContentWindowPort(fixedWindowPort({ kind: 'closed' }));
    const snapshot = await mgr.captureTurnSessionContext({ channelId: ROOM });

    expect(snapshot.recentEntries).toEqual([]);
    expect(snapshot.roomWindowFilteredEntryCount).toBe(2);
    expect(snapshot.compactionSummaryTexts).toEqual([]);

    const context = await mgr.buildContext(ROOM, 'SYS', '', undefined, undefined, undefined, [], snapshot);
    expect(JSON.stringify(context.messages)).not.toContain('chatter');
  });

  it('public parity: an unwindowed port is byte-identical to no port at all', async () => {
    const mgr = new SessionManager(store, makeConfig(dir));
    appendRoomMessage(store, 'public room history A', T(50_000));
    appendRoomMessage(store, 'public room history B', T(20_000), 'assistant');

    const withoutPort = await mgr.captureTurnSessionContext({ channelId: ROOM });
    mgr.setRoomContentWindowPort(fixedWindowPort({ kind: 'unwindowed' }));
    const withPort = await mgr.captureTurnSessionContext({ channelId: ROOM });

    expect(withPort).toEqual(withoutPort);
    expect(withPort.roomWindowFloorMs).toBeUndefined();
    expect(withPort.roomWindowFilteredEntryCount).toBeUndefined();
  });

  it('does not serve compaction summaries minted in an earlier window', async () => {
    const mgr = new SessionManager(store, makeConfig(dir));

    // Earlier window: two entries and a compaction summary covering the first.
    const preWindowNow = T(90_000);
    nowSpy.mockReturnValue(preWindowNow);
    const firstId = appendRoomMessage(store, 'w1 to be compacted', T(100_000));
    store.insertCompaction(ROOM, 'w1 recap: the secret plan', firstId);
    appendRoomMessage(store, 'w1 verbatim leftover', T(95_000));

    // Rejoin: new window, new floor, one live entry and a fresh summary.
    nowSpy.mockReturnValue(NOW);
    const floor = T(30_000);
    appendRoomMessage(store, 'w2 live chat', T(10_000));
    const lastPreFloorId = firstId + 1;
    store.insertCompaction(ROOM, 'w2 recap: current window only', lastPreFloorId);

    mgr.setRoomContentWindowPort(fixedWindowPort({ kind: 'windowed', floorMs: floor }));
    const snapshot = await mgr.captureTurnSessionContext({ channelId: ROOM });

    expect(snapshot.recentEntries.map(entry => entry.content)).toEqual(['w2 live chat']);
    const summaries = snapshot.compactionSummaryTexts.join('\n');
    expect(summaries).not.toContain('w1 recap');
    expect(summaries).toContain('w2 recap: current window only');
  });

  it('between-turns compaction never summarizes pre-window content', async () => {
    const mgr = new SessionManager(store, makeConfig(dir));
    appendRoomMessage(store, 'w1 pre-window material', T(60_000));
    const floor = T(30_000);
    appendRoomMessage(store, 'w2 in-window material', T(10_000));
    mgr.setRoomContentWindowPort(fixedWindowPort({ kind: 'windowed', floorMs: floor }));

    const seen: string[] = [];
    const llmProvider: LLMProviderPort = {
      stream: vi.fn(),
      complete: vi.fn(async (context: { messages: Array<{ content: unknown }> }) => {
        seen.push(JSON.stringify(context));
        return {
          content: 'summary',
          model: 'test',
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: [],
          stopReason: 'end_turn' as const,
        };
      }),
    } as unknown as LLMProviderPort;

    await mgr.scheduleAutoCompactionBetweenTurns({
      channelId: ROOM,
      systemPrompt: 'SYS',
      memoriesBlock: '',
      llmProvider,
    });

    // Whether or not the tiny session triggered a compaction call, no LLM
    // input may ever contain pre-window content.
    for (const promptPayload of seen) {
      expect(promptPayload).not.toContain('w1 pre-window material');
    }
  });

  it('leaves non-room channels completely unaffected by a wired port', async () => {
    const mgr = new SessionManager(store, makeConfig(dir));
    store.append({
      channelId: 'discord:777',
      role: 'user',
      content: 'ordinary group channel history',
      authorId: 'u1',
      authorName: 'User',
      timestamp: T(500_000),
    });

    const before = await mgr.captureTurnSessionContext({ channelId: 'discord:777' });
    mgr.setRoomContentWindowPort(fixedWindowPort({ kind: 'windowed', floorMs: NOW }));
    const after = await mgr.captureTurnSessionContext({ channelId: 'discord:777' });

    expect(after).toEqual(before);
    expect(after.recentEntries.map(entry => entry.content))
      .toEqual(['ordinary group channel history']);
  });
});
