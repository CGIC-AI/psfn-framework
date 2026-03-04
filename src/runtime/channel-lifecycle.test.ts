import { describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from '../channels/types.js';
import {
  registerChannelAdapter,
  startChannelAdapters,
  stopChannelAdapters,
} from './channel-lifecycle.js';

function makeAdapter(
  id: string,
  behavior: {
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
  } = {},
): ChannelAdapter {
  return {
    id,
    gateway: {
      start: behavior.start ?? vi.fn().mockResolvedValue(undefined),
      stop: behavior.stop ?? vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ChannelAdapter;
}

function makeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

describe('registerChannelAdapter', () => {
  it('registers the adapter and synchronizes the registry', () => {
    const channelRegistry = new Map<string, ChannelAdapter>();
    const adapter = makeAdapter('discord');
    const syncChannelRegistry = vi.fn();

    registerChannelAdapter(channelRegistry, adapter, syncChannelRegistry);

    expect(channelRegistry.get('discord')).toBe(adapter);
    expect(syncChannelRegistry).toHaveBeenCalledTimes(1);
    expect(syncChannelRegistry).toHaveBeenCalledWith(channelRegistry);
  });
});

describe('startChannelAdapters', () => {
  it('starts all adapters, removes failed adapters, and keeps healthy ones', async () => {
    const startHealthy = vi.fn().mockResolvedValue(undefined);
    const startFailing = vi.fn().mockRejectedValue(new Error('failed to connect'));
    const channelRegistry = new Map<string, ChannelAdapter>([
      ['healthy', makeAdapter('healthy', { start: startHealthy })],
      ['failing', makeAdapter('failing', { start: startFailing })],
    ]);
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();

    await expect(
      startChannelAdapters(channelRegistry, syncChannelRegistry, log),
    ).resolves.toBeUndefined();

    expect(startHealthy).toHaveBeenCalledTimes(1);
    expect(startFailing).toHaveBeenCalledTimes(1);
    expect(channelRegistry.has('healthy')).toBe(true);
    expect(channelRegistry.has('failing')).toBe(false);
    expect(syncChannelRegistry).toHaveBeenCalledTimes(1);
    expect(syncChannelRegistry).toHaveBeenCalledWith(channelRegistry);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('throws when no channel adapters start successfully', async () => {
    const channelRegistry = new Map<string, ChannelAdapter>([
      ['failing-a', makeAdapter('failing-a', { start: vi.fn().mockRejectedValue(new Error('down')) })],
      ['failing-b', makeAdapter('failing-b', { start: vi.fn().mockRejectedValue(new Error('down')) })],
    ]);
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();

    await expect(
      startChannelAdapters(channelRegistry, syncChannelRegistry, log),
    ).rejects.toThrow('No channel adapters started successfully');

    expect(syncChannelRegistry).toHaveBeenCalledTimes(1);
    expect(channelRegistry.size).toBe(0);
  });
});

describe('stopChannelAdapters', () => {
  it('stops channel adapters in reverse registration order', async () => {
    const stoppedOrder: string[] = [];
    const channelRegistry = new Map<string, ChannelAdapter>([
      ['first', makeAdapter('first', { stop: vi.fn(async () => { stoppedOrder.push('first'); }) })],
      ['second', makeAdapter('second', { stop: vi.fn(async () => { stoppedOrder.push('second'); }) })],
      ['third', makeAdapter('third', { stop: vi.fn(async () => { stoppedOrder.push('third'); }) })],
    ]);

    await stopChannelAdapters(channelRegistry);

    expect(stoppedOrder).toEqual(['third', 'second', 'first']);
  });
});
