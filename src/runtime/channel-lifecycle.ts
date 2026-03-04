import type { ChannelAdapter } from '../channels/types.js';

export interface RuntimeChannelLifecycleLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

type SyncChannelRegistry = (channelRegistry: Map<string, ChannelAdapter>) => void;

export function registerChannelAdapter(
  channelRegistry: Map<string, ChannelAdapter>,
  adapter: ChannelAdapter,
  syncChannelRegistry: SyncChannelRegistry,
): void {
  channelRegistry.set(adapter.id, adapter);
  syncChannelRegistry(channelRegistry);
}

export async function startChannelAdapters(
  channelRegistry: Map<string, ChannelAdapter>,
  syncChannelRegistry: SyncChannelRegistry,
  log: RuntimeChannelLifecycleLogger,
): Promise<void> {
  const adapters = [...channelRegistry.values()];
  if (adapters.length === 0) return;

  const results = await Promise.allSettled(
    adapters.map(adapter => adapter.gateway.start()),
  );

  const failedAdapterIds: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') continue;
    const adapterId = adapters[index]?.id ?? `unknown-${index}`;
    failedAdapterIds.push(adapterId);
    log.error('Channel adapter failed to start', {
      adapterId,
      error: String(result.reason),
    });
  }

  if (failedAdapterIds.length === 0) return;

  for (const adapterId of failedAdapterIds) {
    channelRegistry.delete(adapterId);
  }
  syncChannelRegistry(channelRegistry);

  const startedCount = adapters.length - failedAdapterIds.length;
  log.warn('Continuing startup with partially available channel adapters', {
    startedCount,
    failedCount: failedAdapterIds.length,
    failedAdapterIds,
  });

  if (startedCount === 0) {
    throw new Error('No channel adapters started successfully');
  }
}

export async function stopChannelAdapters(
  channelRegistry: Map<string, ChannelAdapter>,
): Promise<void> {
  const adapters = [...channelRegistry.values()].reverse();
  for (const adapter of adapters) {
    await adapter.gateway.stop();
  }
}
