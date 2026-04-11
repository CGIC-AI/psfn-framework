import { join } from 'node:path';
import {
  loadOrSeedJson,
  writeJsonAtomic,
} from './load-or-seed.js';
import { isRecord, normalizeStringArray } from '../../shared/utils/types.js';

export const SKILLS_FILE_NAME = 'skills.json';
export const SKILLS_SEED_FILE_NAME = 'skills.seed.json';

export interface SkillsRuntimeConfig {
  enabled: boolean;
  directories: string[];
  extraDirectories: string[];
  maxLoadedSkills: number;
  maxSkillChars: number;
  disabledSkills: string[];
}

interface SkillsRuntimeLoadOptions {
  seedDir?: string;
}

function normalizePositiveInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Invalid skills config: ${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`Invalid skills config: ${field} must be between ${min} and ${max}`);
  }
  return value;
}

function validateSkillsConfig(raw: unknown, sourcePath: string): SkillsRuntimeConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid skills config at ${sourcePath}: expected object`);
  }

  if (typeof raw.enabled !== 'boolean') {
    throw new Error(`Invalid skills config at ${sourcePath}: enabled must be boolean`);
  }

  return {
    enabled: raw.enabled,
    directories: normalizeStringArray(raw.directories, 'directories', { errorPrefix: 'Invalid skills config' }),
    extraDirectories: normalizeStringArray(raw.extraDirectories, 'extraDirectories', { errorPrefix: 'Invalid skills config' }),
    maxLoadedSkills: normalizePositiveInteger(raw.maxLoadedSkills, 'maxLoadedSkills', 1, 512),
    maxSkillChars: normalizePositiveInteger(raw.maxSkillChars, 'maxSkillChars', 256, 1_000_000),
    disabledSkills: normalizeStringArray(raw.disabledSkills, 'disabledSkills', { errorPrefix: 'Invalid skills config' }),
  };
}

export function loadSkillsConfig(
  dataDir: string,
  options: SkillsRuntimeLoadOptions = {},
): SkillsRuntimeConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadOrSeedJson({
    dataPath: join(dataDir, SKILLS_FILE_NAME),
    seedPath: join(seedDir, SKILLS_SEED_FILE_NAME),
    validate: validateSkillsConfig,
  });
}

export function saveSkillsConfig(
  dataDir: string,
  nextConfig: unknown,
): SkillsRuntimeConfig {
  const validated = validateSkillsConfig(nextConfig, SKILLS_FILE_NAME);
  writeJsonAtomic(join(dataDir, SKILLS_FILE_NAME), validated);
  return validated;
}
