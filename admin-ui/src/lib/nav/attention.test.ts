import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GardenEventEnvelope } from '$lib/events/envelope';

const apiGet = vi.fn();
vi.mock('$lib/api/client', () => ({ apiGet: (path: string) => apiGet(path) }));

import {
  ATTENTION_SOURCES,
  createAttentionRefreshController,
  emptyInboxTabCounts,
  getInboxTabCounts,
  INBOX_ATTENTION_SOURCES,
  mergeAttentionPollResults,
  notifyInboxAttentionChanged,
  refreshInboxAttentionBreakdown,
  resetInboxTabCounts,
  shouldResetAttentionCounts,
  updateAttentionCountsIfChanged,
  type AttentionRefreshBus,
} from './attention';

describe('attention count reconciliation', () => {
  beforeEach(() => {
    resetInboxTabCounts();
    apiGet.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips the state write and retains the snapshot when counts are unchanged', () => {
    const current = {
      '/inbox': 6,
      '/values': 1,
    };
    const write = vi.fn();

    const reconciled = updateAttentionCountsIfChanged(current, {
      '/inbox': 6,
      '/values': 1,
    }, write);

    expect(reconciled).toBe(current);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes and returns the polled snapshot when any count changes', () => {
    const current = {
      '/inbox': 6,
      '/values': 1,
    };
    const polled = {
      '/inbox': 7,
      '/values': 1,
    };
    const write = vi.fn();

    const reconciled = updateAttentionCountsIfChanged(current, polled, write);

    expect(reconciled).toBe(polled);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(polled);
    expect(reconciled).toEqual({
      '/inbox': 7,
      '/values': 1,
    });
  });

  it('counts only open session_integrity incidents for the Inbox remediation tab (bead g59z)', async () => {
    const source = INBOX_ATTENTION_SOURCES.find((s) => s.tab === 'remediation');
    expect(source).toBeDefined();

    apiGet.mockResolvedValueOnce({
      events: [
        { type: 'session_integrity', status: 'open' },
        { type: 'session_integrity', status: 'applied' },
        { type: 'content_poisoning', status: 'open' },
        { type: 'session_integrity', status: 'open' },
      ],
    });

    const count = await source!.fetchCount();
    expect(apiGet).toHaveBeenCalledWith('/api/admin/session-routes/cogsec/events');
    expect(count).toBe(2);
  });

  it('counts open human escalations inside Inbox attention sources', async () => {
    const source = INBOX_ATTENTION_SOURCES.find((s) => s.tab === 'escalations');
    expect(source).toBeDefined();

    apiGet.mockResolvedValueOnce({
      counts: { open: 3, acknowledged: 1, resolved: 0, dismissed: 0 },
      escalations: [],
    });

    await expect(source!.fetchCount()).resolves.toBe(3);
    expect(apiGet).toHaveBeenCalledWith('/api/admin/escalations?state=open');
  });

  it('surfaces missed or failed journal runs on Identity & Prompts without polling retired Letters', async () => {
    expect(ATTENTION_SOURCES.map(source => source.path)).toEqual(['/inbox', '/identity']);
    const source = ATTENTION_SOURCES.find((item) => item.path === '/identity');
    expect(source).toBeDefined();

    apiGet.mockResolvedValueOnce({ attentionCount: 2 });

    await expect(source!.fetchCount()).resolves.toBe(2);
    expect(apiGet).toHaveBeenCalledWith('/api/admin/values/status');
  });

  it('aggregates all 6 Inbox tabs into one total while preserving last count on partial error', async () => {
    const previous = {
      ...emptyInboxTabCounts(),
      graph: 4,
    };
    const result = await refreshInboxAttentionBreakdown(previous, [
      { tab: 'confirmations', fetchCount: async () => 2 },
      { tab: 'escalations', fetchCount: async () => 1 },
      { tab: 'contacts', fetchCount: async () => 0 },
      { tab: 'graph', fetchCount: async () => { throw new Error('transient'); } },
      { tab: 'cogsec', fetchCount: async () => 3 },
      { tab: 'remediation', fetchCount: async () => 0 },
    ]);

    expect(result.counts).toEqual({
      confirmations: 2,
      escalations: 1,
      contacts: 0,
      graph: 4,
      cogsec: 3,
      remediation: 0,
    });
    expect(result.total).toBe(10);
    expect(getInboxTabCounts()).toEqual(result.counts);
  });

  it('keeps the last count when a background source refresh fails', () => {
    const current = {
      '/inbox': 6,
      '/values': 2,
    };

    const polled = mergeAttentionPollResults(current, [
      { path: '/inbox', count: 3 },
      { path: '/values' },
    ]);

    expect(polled).toEqual({
      '/inbox': 3,
      '/values': 2,
    });
  });

  it('retains verified counts across inner-route navigation for the same companion', () => {
    expect(shouldResetAttentionCounts('companion-a', 'companion-a')).toBe(false);
  });

  it('clears counts only after an established companion or auth scope changes', () => {
    expect(shouldResetAttentionCounts(undefined, 'companion-a')).toBe(false);
    expect(shouldResetAttentionCounts('companion-a', 'companion-b')).toBe(true);
    expect(shouldResetAttentionCounts('companion-a', null)).toBe(true);
    expect(shouldResetAttentionCounts(null, 'companion-a')).toBe(true);
  });

  it('disables background polling while the Garden event bus is connected and refreshes on push events', async () => {
    vi.useFakeTimers();
    let connected = true;
    const eventListeners = new Set<(event: GardenEventEnvelope) => void>();
    const connectionListeners = new Set<(next: boolean) => void>();
    const release = vi.fn();
    const fakeBus: AttentionRefreshBus = {
      retain: () => release,
      isConnected: () => connected,
      subscribeEvents: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      subscribeConnection: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
    };
    const fakeDocument = {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const refresh = vi.fn(async () => {});

    const controller = createAttentionRefreshController({
      refresh,
      fallbackIntervalMs: 30_000,
      documentRef: fakeDocument,
      bus: fakeBus,
    });

    const flush = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };

    controller.start();
    await flush();
    // Initial immediate fetch when started.
    expect(refresh).toHaveBeenCalledTimes(1);

    // No periodic background polling while WebSocket is connected.
    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    // Push event triggers immediate refresh.
    for (const listener of eventListeners) {
      listener({
        type: 'garden.queue.changed',
        timestamp: Date.now(),
        correlation: {},
        data: { queue: 'confirmations' },
      });
    }
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);

    // Local Inbox action triggers immediate refresh.
    notifyInboxAttentionChanged();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(3);

    // Disconnecting WebSocket enables fallback polling (immediate refresh on fallback + interval tick);
    // reconnecting refreshes once and pauses polling again.
    connected = false;
    for (const listener of connectionListeners) listener(false);
    await flush();
    const callsAfterDisconnect = refresh.mock.calls.length;
    expect(callsAfterDisconnect).toBeGreaterThanOrEqual(3);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(callsAfterDisconnect + 1);

    connected = true;
    for (const listener of connectionListeners) listener(true);
    await flush();
    const callsAfterReconnect = refresh.mock.calls.length;
    expect(callsAfterReconnect).toBe(callsAfterDisconnect + 2);
    await vi.advanceTimersByTimeAsync(90_000);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(callsAfterReconnect);

    controller.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
