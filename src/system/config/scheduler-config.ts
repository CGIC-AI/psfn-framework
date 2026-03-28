import { join } from 'node:path';
import {
  loadOrSeedJson,
  writeJsonAtomic,
} from './load-or-seed.js';
import { isRecord } from '../../shared/utils/types.js';

export const SCHEDULER_FILE_NAME = 'scheduler.json';
export const SCHEDULER_SEED_FILE_NAME = 'scheduler.seed.json';

export interface SchedulerRuntimeConfig {
  tickIntervalMs: number;
  heartbeatIntervalMs: number;
  salienceDecayIntervalMs: number;
}

interface SchedulerRuntimeLoadOptions {
  seedDir?: string;
}

function toInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1_000) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer >= 1000`);
  }
  return value;
}

function validateSchedulerConfig(raw: unknown, sourcePath: string): SchedulerRuntimeConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: expected object`);
  }

  return {
    tickIntervalMs: toInterval(raw.tickIntervalMs, 'tickIntervalMs'),
    heartbeatIntervalMs: toInterval(raw.heartbeatIntervalMs, 'heartbeatIntervalMs'),
    salienceDecayIntervalMs: toInterval(raw.salienceDecayIntervalMs, 'salienceDecayIntervalMs'),
  };
}

export function loadSchedulerConfig(
  dataDir: string,
  options: SchedulerRuntimeLoadOptions = {},
): SchedulerRuntimeConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadOrSeedJson({
    dataPath: join(dataDir, SCHEDULER_FILE_NAME),
    seedPath: join(seedDir, SCHEDULER_SEED_FILE_NAME),
    validate: validateSchedulerConfig,
  });
}

export function saveSchedulerConfig(
  dataDir: string,
  nextConfig: unknown,
): SchedulerRuntimeConfig {
  const validated = validateSchedulerConfig(nextConfig, SCHEDULER_FILE_NAME);
  writeJsonAtomic(join(dataDir, SCHEDULER_FILE_NAME), validated);
  return validated;
}
