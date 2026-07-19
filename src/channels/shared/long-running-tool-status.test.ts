import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LongRunningToolStatusTracker } from './long-running-tool-status.js';

describe('LongRunningToolStatusTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts for the analysis workbench and sends the golden status at the polling cadence', async () => {
    const sendStatus = vi.fn(async () => undefined);
    const tracker = new LongRunningToolStatusTracker({
      isProcessing: () => true,
      sendStatus,
      clearStatus: async () => undefined,
    });

    tracker.start('tool-1', 'channel-1', 'analysis_workbench');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendStatus).toHaveBeenCalledTimes(1);
    expect(sendStatus).toHaveBeenCalledWith(
      'channel-1',
      'Still analyzing large-context material (15s elapsed)...',
    );

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendStatus).toHaveBeenNthCalledWith(
      2,
      'channel-1',
      'Still analyzing large-context material (35s elapsed)...',
    );

    tracker.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts only for a supported tool in a channel that is processing', async () => {
    const processingChannels = new Set(['channel-1']);
    const sendStatus = vi.fn(async () => undefined);
    const tracker = new LongRunningToolStatusTracker({
      isProcessing: channelId => processingChannels.has(channelId),
      sendStatus,
      clearStatus: async () => undefined,
    });

    tracker.start('tool-1', 'channel-1', 'shell');
    tracker.start('tool-2', 'channel-2', 'analysis_workbench');
    expect(vi.getTimerCount()).toBe(0);

    tracker.start('tool-3', 'channel-1', 'analysis_workbench');
    expect(vi.getTimerCount()).toBe(1);

    processingChannels.clear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendStatus).not.toHaveBeenCalled();

    tracker.dispose();
  });

  it('stops on completion and clears status after the channel has no active tools', async () => {
    const sendStatus = vi.fn(async () => undefined);
    const clearStatus = vi.fn(async () => undefined);
    const tracker = new LongRunningToolStatusTracker({
      isProcessing: () => true,
      sendStatus,
      clearStatus,
    });

    tracker.start('tool-1', 'channel-1', 'analysis_workbench');
    tracker.start('tool-2', 'channel-1', 'analysis_workbench');
    await vi.advanceTimersByTimeAsync(15_000);

    await tracker.stop('tool-1', 'channel-1', 'analysis_workbench');
    expect(clearStatus).not.toHaveBeenCalled();

    await tracker.stop('tool-2', 'channel-1', 'analysis_workbench');
    expect(clearStatus).toHaveBeenCalledOnce();
    expect(clearStatus).toHaveBeenCalledWith('channel-1');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendStatus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears one channel without leaking intervals or stopping other channels', async () => {
    const sendStatus = vi.fn(async () => undefined);
    const tracker = new LongRunningToolStatusTracker({
      isProcessing: () => true,
      sendStatus,
      clearStatus: async () => undefined,
    });

    tracker.start('tool-1', 'channel-1', 'analysis_workbench');
    tracker.start('tool-2', 'channel-2', 'analysis_workbench');
    expect(vi.getTimerCount()).toBe(2);

    tracker.clearChannel('channel-1');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendStatus).toHaveBeenCalledOnce();
    expect(sendStatus).toHaveBeenCalledWith(
      'channel-2',
      'Still analyzing large-context material (15s elapsed)...',
    );

    tracker.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
