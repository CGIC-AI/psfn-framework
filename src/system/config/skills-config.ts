import { join } from 'node:path';
import {
  loadRequiredJson,
} from './load-or-seed.js';
import { assertPositiveInteger } from './validators.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { OWNER_FILE_MODE_COMPANION_POLICY } from './owner-file-modes.js';
import { isRecord, normalizeStringArray } from '../../shared/utils/types.js';

export const SKILLS_FILE_NAME = 'skills.json';
export const SKILLS_SEED_FILE_NAME = 'skills.seed.json';

/**
 * Quiet reuse-and-revision loop tuning (psfn-framework-lpxg3.3).
 *
 * The loop is opportunity-shaped, never mandatory: these values bound how much
 * background work it may do and how often it may speak, so a companion doing
 * ordinary work is not nagged and no durable artifact is created from one weak
 * observation. The block is optional in the owner file — an existing
 * deployment keeps working and picks up {@link DEFAULT_SKILL_REUSE_CONFIG}
 * until the operator writes explicit values.
 */
export interface SkillReuseConfig {
  /**
   * Most owned skills that may be surfaced as reuse candidates for one task
   * cue. Zero or one strong result is the expected outcome; the cap exists so a
   * broad cue can never turn into a wall of suggestions.
   */
  maxCandidates: number;
  /**
   * Relevance floor (0..1) a candidate must clear before it is surfaced at all.
   * Below it, the honest answer is "no relevant skill", not the least-bad one.
   */
  minRelevanceScore: number;
  /** Tool calls in a turn before it counts as complex enough to learn from. */
  minToolCalls: number;
  /**
   * Only every Nth qualifying turn may raise an opportunity. This is the
   * quietness budget: raising it makes the loop rarer, never louder.
   */
  nudgeEveryNthTurn: number;
}

export const DEFAULT_SKILL_REUSE_CONFIG: SkillReuseConfig = {
  maxCandidates: 3,
  minRelevanceScore: 0.25,
  minToolCalls: 3,
  nudgeEveryNthTurn: 3,
};

export interface SkillsRuntimeConfig {
  enabled: boolean;
  directories: string[];
  extraDirectories: string[];
  maxLoadedSkills: number;
  maxSkillChars: number;
  disabledSkills: string[];
  reuse: SkillReuseConfig;
}

interface SkillsRuntimeLoadOptions {
  seedDir?: string;
}

function normalizeUnitInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid skills config: ${field} must be a number between 0 and 1`);
  }
  return value;
}

function validateSkillReuseConfig(raw: unknown, sourcePath: string): SkillReuseConfig {
  if (raw === undefined) return { ...DEFAULT_SKILL_REUSE_CONFIG };
  if (!isRecord(raw)) {
    throw new Error(`Invalid skills config at ${sourcePath}: reuse must be an object`);
  }
  const unknownKeys = Object.keys(raw).filter(
    key => !Object.hasOwn(DEFAULT_SKILL_REUSE_CONFIG, key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Invalid skills config at ${sourcePath}: reuse has unsupported keys: ${unknownKeys.join(', ')}`,
    );
  }
  return {
    maxCandidates: normalizePositiveInteger(
      raw.maxCandidates ?? DEFAULT_SKILL_REUSE_CONFIG.maxCandidates,
      'reuse.maxCandidates',
      1,
      16,
    ),
    minRelevanceScore: normalizeUnitInterval(
      raw.minRelevanceScore ?? DEFAULT_SKILL_REUSE_CONFIG.minRelevanceScore,
      'reuse.minRelevanceScore',
    ),
    minToolCalls: normalizePositiveInteger(
      raw.minToolCalls ?? DEFAULT_SKILL_REUSE_CONFIG.minToolCalls,
      'reuse.minToolCalls',
      1,
      64,
    ),
    nudgeEveryNthTurn: normalizePositiveInteger(
      raw.nudgeEveryNthTurn ?? DEFAULT_SKILL_REUSE_CONFIG.nudgeEveryNthTurn,
      'reuse.nudgeEveryNthTurn',
      1,
      64,
    ),
  };
}

function normalizePositiveInteger(value: unknown, field: string, min: number, max: number): number {
  return assertPositiveInteger(value, field, {
    min,
    max,
    messages: {
      notInteger: ({ fieldLabel }) => `Invalid skills config: ${fieldLabel} must be an integer`,
      belowMin: ({ fieldLabel }) => `Invalid skills config: ${fieldLabel} must be between ${min} and ${max}`,
      aboveMax: ({ fieldLabel }) => `Invalid skills config: ${fieldLabel} must be between ${min} and ${max}`,
    },
  });
}

export function validateSkillsConfig(raw: unknown, sourcePath: string): SkillsRuntimeConfig {
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
    reuse: validateSkillReuseConfig(raw.reuse, sourcePath),
  };
}

export function loadSkillsConfig(
  dataDir: string,
  options: SkillsRuntimeLoadOptions = {},
): SkillsRuntimeConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath: join(dataDir, SKILLS_FILE_NAME),
    examplePath: join(seedDir, SKILLS_SEED_FILE_NAME),
    validate: validateSkillsConfig,
  });
}

export function saveSkillsConfig(
  dataDir: string,
  nextConfig: unknown,
): SkillsRuntimeConfig {
  const validated = validateSkillsConfig(nextConfig, SKILLS_FILE_NAME);
  writeJsonAtomic(join(dataDir, SKILLS_FILE_NAME), validated, {
    mode: OWNER_FILE_MODE_COMPANION_POLICY,
  });
  return validated;
}
