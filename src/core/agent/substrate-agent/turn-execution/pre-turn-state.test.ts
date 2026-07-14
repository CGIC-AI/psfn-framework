import { describe, expect, it, vi } from 'vitest';
import { createTurnId } from '../../../turns/id.js';
import type { TurnSessionContextSnapshot } from '../../../turns/snapshot.js';
import { healStaleCapturedSessionWindow } from './pre-turn-state.js';

function makeSnapshot(overrides: Partial<TurnSessionContextSnapshot> = {}): TurnSessionContextSnapshot {
  return {
    channelId: 'api:main',
    recentEntries: [],
    compactionSummaryTexts: [],
    focusKnowledgeTexts: [],
    continuityEntries: [],
    versionPointer: 'test-snapshot',
    ...overrides,
  };
}

describe('healStaleCapturedSessionWindow (psfn-framework-hgw3.1)', () => {
  const turnId = createTurnId();

  it('returns the snapshot untouched when the raw window already covers the recorded entry', async () => {
    const snapshot = makeSnapshot({ storeWindowMaxEntryId: 5257 });
    const reconcile = vi.fn();
    const recapture = vi.fn();
    const emitTelemetry = vi.fn();

    const result = await healStaleCapturedSessionWindow({
      snapshot,
      currentSessionEntryId: 5257,
      channelId: 'api:main',
      turnId,
      requestId: 'req-1',
      sessionManager: { reconcileSessionChannelFromDisk: reconcile },
      recapture,
      emitTelemetry,
    });

    expect(result).toBe(snapshot);
    expect(reconcile).not.toHaveBeenCalled();
    expect(recapture).not.toHaveBeenCalled();
    expect(emitTelemetry).not.toHaveBeenCalled();
  });

  it('skips entirely when the turn recorded no session entry', async () => {
    const snapshot = makeSnapshot();
    const reconcile = vi.fn();
    const recapture = vi.fn();
    const emitTelemetry = vi.fn();

    const result = await healStaleCapturedSessionWindow({
      snapshot,
      currentSessionEntryId: null,
      channelId: 'internal:reflection:main',
      turnId,
      requestId: 'req-2',
      sessionManager: { reconcileSessionChannelFromDisk: reconcile },
      recapture,
      emitTelemetry,
    });

    expect(result).toBe(snapshot);
    expect(reconcile).not.toHaveBeenCalled();
    expect(recapture).not.toHaveBeenCalled();
  });

  it('reconciles and recaptures once when the raw window is missing the recorded entry', async () => {
    // Live failure shape: user entry 5257 was just recorded, yet the captured
    // window's raw max id froze at 5255 — missing the previous assistant
    // reply on top of the current entry.
    const staleSnapshot = makeSnapshot({ storeWindowMaxEntryId: 5255 });
    const healedSnapshot = makeSnapshot({ storeWindowMaxEntryId: 5257, versionPointer: 'healed' });
    const reconcile = vi.fn().mockReturnValue({ maxEntryId: 5257, lastMessageEntryId: 5257 });
    const recapture = vi.fn().mockResolvedValue(healedSnapshot);
    const emitTelemetry = vi.fn();

    const result = await healStaleCapturedSessionWindow({
      snapshot: staleSnapshot,
      currentSessionEntryId: 5257,
      channelId: 'api:main',
      turnId,
      requestId: 'req-3',
      sessionManager: { reconcileSessionChannelFromDisk: reconcile },
      recapture,
      emitTelemetry,
    });

    expect(result).toBe(healedSnapshot);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith('api:main');
    expect(recapture).toHaveBeenCalledTimes(1);
    expect(emitTelemetry).toHaveBeenCalledTimes(1);
    expect(emitTelemetry).toHaveBeenCalledWith('session.context.stale_window_heal', expect.objectContaining({
      channelId: 'api:main',
      expectedMinEntryId: 5257,
      staleWindowMaxEntryId: 5255,
      reconciledMaxEntryId: 5257,
      recapturedWindowMaxEntryId: 5257,
      healed: true,
    }));
  });

  it('treats an empty raw window after a recorded entry as stale', async () => {
    const staleSnapshot = makeSnapshot();
    const healedSnapshot = makeSnapshot({ storeWindowMaxEntryId: 3 });
    const reconcile = vi.fn().mockReturnValue({ maxEntryId: 3, lastMessageEntryId: 3 });
    const recapture = vi.fn().mockResolvedValue(healedSnapshot);
    const emitTelemetry = vi.fn();

    const result = await healStaleCapturedSessionWindow({
      snapshot: staleSnapshot,
      currentSessionEntryId: 3,
      channelId: 'api:main',
      turnId,
      requestId: 'req-4',
      sessionManager: { reconcileSessionChannelFromDisk: reconcile },
      recapture,
      emitTelemetry,
    });

    expect(result).toBe(healedSnapshot);
    expect(emitTelemetry).toHaveBeenCalledWith('session.context.stale_window_heal', expect.objectContaining({
      staleWindowMaxEntryId: null,
      healed: true,
    }));
  });

  it('never blocks the turn: a failing heal logs, telemeters, and proceeds with the original snapshot', async () => {
    const staleSnapshot = makeSnapshot({ storeWindowMaxEntryId: 5255 });
    const reconcile = vi.fn().mockImplementation(() => {
      throw new Error('reload blew up');
    });
    const recapture = vi.fn();
    const emitTelemetry = vi.fn();

    const result = await healStaleCapturedSessionWindow({
      snapshot: staleSnapshot,
      currentSessionEntryId: 5257,
      channelId: 'api:main',
      turnId,
      requestId: 'req-5',
      sessionManager: { reconcileSessionChannelFromDisk: reconcile },
      recapture,
      emitTelemetry,
    });

    expect(result).toBe(staleSnapshot);
    expect(emitTelemetry).toHaveBeenCalledWith('session.context.stale_window_heal_failed', expect.objectContaining({
      channelId: 'api:main',
      expectedMinEntryId: 5257,
      staleWindowMaxEntryId: 5255,
      error: expect.stringContaining('reload blew up'),
    }));
  });

  it('proceeds with the recaptured snapshot even when the heal did not recover the entry', async () => {
    const staleSnapshot = makeSnapshot({ storeWindowMaxEntryId: 5255 });
    const stillStaleSnapshot = makeSnapshot({ storeWindowMaxEntryId: 5255, versionPointer: 'still-stale' });
    const reconcile = vi.fn().mockReturnValue({ maxEntryId: 5255, lastMessageEntryId: 5255 });
    const recapture = vi.fn().mockResolvedValue(stillStaleSnapshot);
    const emitTelemetry = vi.fn();

    const result = await healStaleCapturedSessionWindow({
      snapshot: staleSnapshot,
      currentSessionEntryId: 5257,
      channelId: 'api:main',
      turnId,
      requestId: 'req-6',
      sessionManager: { reconcileSessionChannelFromDisk: reconcile },
      recapture,
      emitTelemetry,
    });

    // One heal attempt only, then proceed with what we have.
    expect(result).toBe(stillStaleSnapshot);
    expect(recapture).toHaveBeenCalledTimes(1);
    expect(emitTelemetry).toHaveBeenCalledWith('session.context.stale_window_heal', expect.objectContaining({
      healed: false,
    }));
  });
});
