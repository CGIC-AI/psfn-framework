import {
  loadSchedulerConfig,
  type SchedulerRuntimeConfig,
} from './scheduler-config.js';

interface ResolveRuntimeSchedulerConfigOptions {
  dataDir: string;
  seedDir?: string;
  env?: NodeJS.ProcessEnv;
}

function parseEnvInterval(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) return undefined;
  return parsed;
}

export function resolveRuntimeSchedulerConfig(
  options: ResolveRuntimeSchedulerConfigOptions,
): SchedulerRuntimeConfig {
  if (!options || typeof options !== 'object') {
    throw new TypeError('resolveRuntimeSchedulerConfig expects an options object argument');
  }
  if (typeof options.dataDir !== 'string' || options.dataDir.trim().length === 0) {
    throw new TypeError('resolveRuntimeSchedulerConfig requires options.dataDir');
  }

  const env = options.env ?? process.env;
  const persisted = loadSchedulerConfig(options.dataDir, {
    seedDir: options.seedDir,
  });

  return {
    tickIntervalMs: parseEnvInterval(env.SCHEDULER_TICK_INTERVAL_MS) ?? persisted.tickIntervalMs,
    heartbeatIntervalMs: parseEnvInterval(env.SCHEDULER_HEARTBEAT_INTERVAL_MS) ?? persisted.heartbeatIntervalMs,
    salienceDecayIntervalMs: parseEnvInterval(env.MAINTENANCE_INTERVAL_MS) ?? persisted.salienceDecayIntervalMs,
  };
}
