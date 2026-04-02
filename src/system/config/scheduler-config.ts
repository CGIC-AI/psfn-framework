import { join } from 'node:path';
import {
  loadOrSeedJson,
  loadSeedJson,
  writeJsonAtomic,
} from './load-or-seed.js';
import { isRecord } from '../../shared/utils/types.js';

export const SCHEDULER_FILE_NAME = 'scheduler.json';
export const SCHEDULER_SEED_FILE_NAME = 'scheduler.seed.json';

export interface ArtifactLifecyclePolicyConfig {
  scratchpadRetentionDays: number;
  generatedMediaRetentionDays: number;
  workspaceTempRetentionDays: number;
  cleanupBatchSize: number;
}

export interface SchedulerRuntimeConfig {
  tickIntervalMs: number;
  heartbeatIntervalMs: number;
  salienceDecayIntervalMs: number;
  artifactLifecycle: ArtifactLifecyclePolicyConfig;
}

interface SchedulerRuntimeLoadOptions {
  seedDir?: string;
}

function resolveSeedDir(seedDir?: string): string {
  const resolved = (seedDir ?? process.env.CONFIG_DIR ?? './config').trim();
  if (!resolved) {
    throw new Error('Scheduler seed directory is required');
  }
  return resolved;
}

function toInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1_000) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer >= 1000`);
  }
  return value;
}

function toPositiveInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer >= ${minimum}`);
  }
  return value;
}

function validateArtifactLifecycleConfig(
  raw: unknown,
  sourcePath: string,
): ArtifactLifecyclePolicyConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: artifactLifecycle must be an object`);
  }

  return {
    scratchpadRetentionDays: toPositiveInteger(raw.scratchpadRetentionDays, 'artifactLifecycle.scratchpadRetentionDays', 1),
    generatedMediaRetentionDays: toPositiveInteger(raw.generatedMediaRetentionDays, 'artifactLifecycle.generatedMediaRetentionDays', 1),
    workspaceTempRetentionDays: toPositiveInteger(raw.workspaceTempRetentionDays, 'artifactLifecycle.workspaceTempRetentionDays', 1),
    cleanupBatchSize: toPositiveInteger(raw.cleanupBatchSize, 'artifactLifecycle.cleanupBatchSize', 1),
  };
}

function validateSchedulerConfig(raw: unknown, sourcePath: string): SchedulerRuntimeConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: expected object`);
  }

  return {
    tickIntervalMs: toInterval(raw.tickIntervalMs, 'tickIntervalMs'),
    heartbeatIntervalMs: toInterval(raw.heartbeatIntervalMs, 'heartbeatIntervalMs'),
    salienceDecayIntervalMs: toInterval(raw.salienceDecayIntervalMs, 'salienceDecayIntervalMs'),
    artifactLifecycle: validateArtifactLifecycleConfig(raw.artifactLifecycle, sourcePath),
  };
}

export function loadSchedulerConfig(
  dataDir: string,
  options: SchedulerRuntimeLoadOptions = {},
): SchedulerRuntimeConfig {
  const seedDir = resolveSeedDir(options.seedDir);
  return loadOrSeedJson({
    dataPath: join(dataDir, SCHEDULER_FILE_NAME),
    seedPath: join(seedDir, SCHEDULER_SEED_FILE_NAME),
    validate: validateSchedulerConfig,
  });
}

export function loadSchedulerSeedDefaults(
  options: SchedulerRuntimeLoadOptions = {},
): SchedulerRuntimeConfig {
  const seedDir = resolveSeedDir(options.seedDir);
  return loadSeedJson({
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
