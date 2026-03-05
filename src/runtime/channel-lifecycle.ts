import type {
  ChannelAdapter,
  ChannelAdapterFactoryEntry,
} from '../channels/types.js';

export interface RuntimeChannelLifecycleLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

type SyncChannelRegistry = (channelRegistry: Map<string, ChannelAdapter>) => void;

export function buildChannelAdapterFactoryManifest(
  entries: readonly ChannelAdapterFactoryEntry[],
): ChannelAdapterFactoryEntry[] {
  const seen = new Set<string>();
  const normalized: ChannelAdapterFactoryEntry[] = [];
  for (const entry of entries) {
    const id = entry.manifest.id.trim();
    if (!id) {
      throw new Error('Channel adapter manifest entry id must be non-empty');
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate channel adapter manifest entry "${id}"`);
    }
    seen.add(id);
    normalized.push({
      ...entry,
      manifest: {
        ...entry.manifest,
        id,
      },
    });
  }
  return normalized;
}

export async function loadChannelAdaptersFromManifest(
  channelRegistry: Map<string, ChannelAdapter>,
  entries: readonly ChannelAdapterFactoryEntry[],
  syncChannelRegistry: SyncChannelRegistry,
  log: RuntimeChannelLifecycleLogger,
): Promise<void> {
  for (const entry of entries) {
    const { manifest } = entry;
    if (!manifest.enabled) {
      log.warn('Skipping disabled channel adapter manifest entry', {
        adapterId: manifest.id,
        required: manifest.required === true,
      });
      continue;
    }

    try {
      const adapter = await entry.create();
      if (adapter.id !== manifest.id) {
        throw new Error(
          `Manifest id "${manifest.id}" does not match adapter id "${adapter.id}"`,
        );
      }
      registerChannelAdapter(channelRegistry, adapter, syncChannelRegistry);
    } catch (error) {
      if (manifest.required) {
        throw new Error(
          `Required channel adapter "${manifest.id}" failed to initialize: ${String(error)}`,
        );
      }
      log.warn('Optional channel adapter failed to initialize', {
        adapterId: manifest.id,
        error: String(error),
      });
    }
  }

  if (channelRegistry.size === 0) {
    throw new Error('No channel adapters loaded from manifest');
  }
}

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
