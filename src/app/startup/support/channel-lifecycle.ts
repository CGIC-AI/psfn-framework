import type {
  ChannelAdapterFactoryPort,
  ChannelAdapterPort,
} from '../../../channels/backplane/types.js';
import type {
  ChannelAdapterRegistryPort,
  MutableChannelAdapterRegistryPort,
} from '../../../channels/backplane/registry-port.js';
import {
  EligibilityDeniedError,
  type EligibilityGate,
} from '../../../system/capabilities/eligibility.js';
import {
  requirePluginActivationEligibility,
  wrapChannelAdapterWithEligibility,
} from './plugin-eligibility.js';

export interface RuntimeChannelLifecycleLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

type SyncChannelRegistryPort = (channelRegistry: ChannelAdapterRegistryPort) => void;

export function buildChannelAdapterFactoryManifest(
  entries: readonly ChannelAdapterFactoryPort[],
): ChannelAdapterFactoryPort[] {
  const seen = new Set<string>();
  const normalized: ChannelAdapterFactoryPort[] = [];
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
  channelRegistry: MutableChannelAdapterRegistryPort,
  entries: readonly ChannelAdapterFactoryPort[],
  syncChannelRegistry: SyncChannelRegistryPort,
  log: RuntimeChannelLifecycleLogger,
  eligibilityGate?: EligibilityGate,
): Promise<void> {
  for (const entry of entries) {
    const { manifest } = entry;
    if (!manifest.enabled) {
      if (manifest.required) {
        throw new Error(`Required channel adapter "${manifest.id}" is disabled in manifest`);
      }
      log.warn('Skipping disabled channel adapter manifest entry', {
        adapterId: manifest.id,
        required: Boolean(manifest.required),
      });
      continue;
    }

    try {
      requirePluginActivationEligibility(
        eligibilityGate,
        'channel',
        manifest.id,
        manifest.eligibility,
      );
      const adapter = wrapChannelAdapterWithEligibility(
        await entry.create(),
        eligibilityGate,
        manifest.eligibility,
      );
      if (adapter.id !== manifest.id) {
        throw new Error(
          `Manifest id "${manifest.id}" does not match adapter id "${adapter.id}"`,
        );
      }
      registerChannelAdapter(channelRegistry, adapter, syncChannelRegistry);
    } catch (error) {
      if (error instanceof EligibilityDeniedError) {
        if (manifest.required) {
          throw new Error(
            `Required channel adapter "${manifest.id}" denied by eligibility gate: ${error.message}`,
          );
        }
        log.warn('Skipping channel adapter denied by eligibility gate', {
          adapterId: manifest.id,
          reasonCode: error.decision.reasonCode,
          tier: error.decision.tier,
          requiredTokens: error.decision.requiredTokens,
          missingTokens: error.decision.missingTokens,
          minimumTier: error.decision.minimumTier,
        });
        continue;
      }
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
  channelRegistry: MutableChannelAdapterRegistryPort,
  adapter: ChannelAdapterPort,
  syncChannelRegistry: SyncChannelRegistryPort,
): void {
  channelRegistry.register(adapter);
  syncChannelRegistry(channelRegistry);
}

export async function startChannelAdapters(
  channelRegistry: MutableChannelAdapterRegistryPort,
  syncChannelRegistry: SyncChannelRegistryPort,
  log: RuntimeChannelLifecycleLogger,
): Promise<void> {
  const adapters = [...channelRegistry.list()];
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
    channelRegistry.unregister(adapterId);
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
  channelRegistry: ChannelAdapterRegistryPort,
): Promise<void> {
  const adapters = [...channelRegistry.list()].reverse();
  for (const adapter of adapters) {
    await adapter.gateway.stop();
  }
}
