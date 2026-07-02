import {
  loadSchedulerConfig,
  type SchedulerRuntimeConfig,
} from './scheduler-config.js';

interface ResolveRuntimeSchedulerConfigOptions {
  dataDir: string;
  seedDir?: string;
}

export function resolveRuntimeSchedulerConfig(
  options: ResolveRuntimeSchedulerConfigOptions,
): SchedulerRuntimeConfig {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for JS callers
  if (!options || typeof options !== 'object') {
    throw new TypeError('resolveRuntimeSchedulerConfig expects an options object argument');
  }
  if (typeof options.dataDir !== 'string' || options.dataDir.trim().length === 0) {
    throw new TypeError('resolveRuntimeSchedulerConfig requires options.dataDir');
  }

  const persisted = loadSchedulerConfig(options.dataDir, {
    seedDir: options.seedDir,
  });

  return {
    tickIntervalMs: persisted.tickIntervalMs,
    heartbeatIntervalMs: persisted.heartbeatIntervalMs,
    salienceDecayIntervalMs: persisted.salienceDecayIntervalMs,
    artifactLifecycle: { ...persisted.artifactLifecycle },
    episodicProcessing: { ...persisted.episodicProcessing },
    sleeptime: {
      direct: { ...persisted.sleeptime.direct },
      group: { ...persisted.sleeptime.group },
    },
    socialGraphBuilder: { ...persisted.socialGraphBuilder },
    temporalWakeup: {
      enabled: persisted.temporalWakeup.enabled,
      morningWake: { ...persisted.temporalWakeup.morningWake },
      idleRefresher: { ...persisted.temporalWakeup.idleRefresher },
    },
  };
}
