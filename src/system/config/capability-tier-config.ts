import { join } from 'node:path';
import type { CapabilityTier } from './runtime-config-contracts.js';
import { isCapabilityTier } from '../capabilities/tiers.js';
import type { CapabilityToken } from '../capabilities/tokens.js';
import { normalizeCapabilityTokens } from '../capabilities/tokens.js';
import {
  loadOrSeedJson,
  loadSeedJson,
} from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

export const CAPABILITY_TIER_FILE_NAME = 'capability-tier.json';
export const CAPABILITY_TIER_SEED_FILE_NAME = 'capability-tier.seed.json';

export interface CapabilityTierConfig {
  tier: CapabilityTier;
  customTokens: CapabilityToken[];
}

interface CapabilityTierLoadOptions {
  seedDir?: string;
}

function validateCapabilityTierConfig(raw: unknown, sourcePath: string): CapabilityTierConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid capability config at ${sourcePath}: expected object`);
  }

  const tier = raw.tier;
  if (!isCapabilityTier(tier)) {
    throw new Error(`Invalid capability config at ${sourcePath}: tier is not supported`);
  }

  const customTokens = normalizeCapabilityTokens(
    raw.customTokens ?? [],
    'customTokens',
  );

  return {
    tier,
    customTokens,
  };
}

export function loadCapabilityTierConfig(
  dataDir: string,
  options: CapabilityTierLoadOptions = {},
): CapabilityTierConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadOrSeedJson({
    dataPath: join(dataDir, CAPABILITY_TIER_FILE_NAME),
    seedPath: join(seedDir, CAPABILITY_TIER_SEED_FILE_NAME),
    validate: validateCapabilityTierConfig,
  });
}

export function loadCapabilityTierSeedDefaults(
  options: CapabilityTierLoadOptions = {},
): CapabilityTierConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadSeedJson({
    seedPath: join(seedDir, CAPABILITY_TIER_SEED_FILE_NAME),
    validate: validateCapabilityTierConfig,
  });
}

export function saveCapabilityTierConfig(
  dataDir: string,
  nextConfig: unknown,
): CapabilityTierConfig {
  const validated = validateCapabilityTierConfig(nextConfig, CAPABILITY_TIER_FILE_NAME);
  writeJsonAtomic(join(dataDir, CAPABILITY_TIER_FILE_NAME), validated);
  return validated;
}
