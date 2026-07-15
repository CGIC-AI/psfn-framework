import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVisibilityAwarePoller,
  type VisibilityDocument,
} from './visibility-aware-poller';

class FakeVisibilityDocument implements VisibilityDocument {
  hidden: boolean;
  private readonly listeners = new Set<() => void>();

  constructor(hidden: boolean) {
    this.hidden = hidden;
  }

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

async function flushRefresh(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createVisibilityAwarePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends no hidden-tab traffic and resumes with one immediate refresh and one timer', async () => {
    const documentRef = new FakeVisibilityDocument(true);
    const refresh = vi.fn();
    const poller = createVisibilityAwarePoller({
      documentRef,
      intervalMs: 15_000,
      refresh,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();

    documentRef.setHidden(false);
    documentRef.setHidden(false);
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('clears network polling while hidden and does not duplicate timers after repeated transitions', async () => {
    const documentRef = new FakeVisibilityDocument(false);
    const refresh = vi.fn();
    const poller = createVisibilityAwarePoller({
      documentRef,
      intervalMs: 30_000,
      refresh,
    });

    poller.start();
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);

    documentRef.setHidden(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    documentRef.setHidden(false);
    await flushRefresh();
    documentRef.setHidden(true);
    documentRef.setHidden(false);
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('coalesces change-signal bursts and defers hidden signals until the tab is visible', async () => {
    const documentRef = new FakeVisibilityDocument(false);
    const refresh = vi.fn();
    const poller = createVisibilityAwarePoller({
      documentRef,
      intervalMs: 15_000,
      refresh,
    });

    poller.start();
    poller.requestRefresh();
    poller.requestRefresh();
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);

    documentRef.setHidden(true);
    poller.requestRefresh();
    poller.requestRefresh();
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);

    documentRef.setHidden(false);
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('uses polling only as a socket fallback and remains teardown safe', async () => {
    const documentRef = new FakeVisibilityDocument(false);
    const refresh = vi.fn();
    const poller = createVisibilityAwarePoller({
      documentRef,
      intervalMs: 15_000,
      pollingEnabled: false,
      refresh,
    });

    poller.start();
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    poller.setPollingEnabled(true);
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(3);

    poller.stop();
    documentRef.setHidden(true);
    documentRef.setHidden(false);
    poller.requestRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
