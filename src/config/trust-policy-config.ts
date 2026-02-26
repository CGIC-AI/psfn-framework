import { join } from 'node:path';
import type {
  ChannelVisibility,
  SensitivityLevel,
  TrustLevel,
} from '../trust/types.js';
import {
  loadOrSeedJson,
  writeJsonAtomic,
} from './load-or-seed.js';
import { isRecord } from '../utils/types.js';

export const TRUST_POLICY_FILE_NAME = 'trust-policy.json';
export const TRUST_POLICY_SEED_FILE_NAME = 'trust-policy.seed.json';

const TRUST_LEVELS: TrustLevel[] = ['primary', 'trusted', 'regular', 'public'];
const SENSITIVITY_LEVELS: SensitivityLevel[] = ['public', 'personal', 'intimate', 'confidential'];
const VISIBILITY_LEVELS: ChannelVisibility[] = ['private', 'semi_private', 'public', 'broadcast'];

export interface TrustPolicyConfig {
  trustCeiling: Record<TrustLevel, readonly SensitivityLevel[]>;
  visibilityAllowed: Record<ChannelVisibility, readonly SensitivityLevel[]>;
  channelClassification: {
    privatePrefixes: string[];
    broadcastPrefixes: string[];
    defaultVisibility: ChannelVisibility;
    visibilityOverrides: {
      exact: Record<string, ChannelVisibility>;
      prefix: Record<string, ChannelVisibility>;
    };
  };
}

interface TrustPolicyLoadOptions {
  seedDir?: string;
}

function uniqueSensitivityList(value: unknown, field: string): SensitivityLevel[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid trust policy: ${field} must be an array`);
  }

  const set = new Set<SensitivityLevel>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !SENSITIVITY_LEVELS.includes(entry as SensitivityLevel)) {
      throw new Error(`Invalid trust policy: ${field} contains unsupported sensitivity`);
    }
    set.add(entry as SensitivityLevel);
  }

  if (set.size === 0) {
    throw new Error(`Invalid trust policy: ${field} must contain at least one sensitivity`);
  }

  return [...set];
}

function uniqueStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid trust policy: ${field} must be an array`);
  }

  const set = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(`Invalid trust policy: ${field} items must be strings`);
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    set.add(trimmed);
  }

  return [...set];
}

function visibilityOverrideMap(value: unknown, field: string): Record<string, ChannelVisibility> {
  if (!isRecord(value)) {
    throw new Error(`Invalid trust policy: ${field} must be an object`);
  }

  const out: Record<string, ChannelVisibility> = {};
  for (const [rawKey, rawVisibility] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawVisibility !== 'string' || !VISIBILITY_LEVELS.includes(rawVisibility as ChannelVisibility)) {
      throw new Error(`Invalid trust policy: ${field}.${rawKey} has unsupported visibility`);
    }
    out[key] = rawVisibility as ChannelVisibility;
  }

  return out;
}

function validateTrustPolicy(raw: unknown, sourcePath: string): TrustPolicyConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid trust policy at ${sourcePath}: expected object`);
  }

  if (!isRecord(raw.trustCeiling)) {
    throw new Error(`Invalid trust policy at ${sourcePath}: trustCeiling must be an object`);
  }

  if (!isRecord(raw.visibilityAllowed)) {
    throw new Error(`Invalid trust policy at ${sourcePath}: visibilityAllowed must be an object`);
  }

  if (!isRecord(raw.channelClassification)) {
    throw new Error(`Invalid trust policy at ${sourcePath}: channelClassification must be an object`);
  }

  const trustCeiling = {} as Record<TrustLevel, readonly SensitivityLevel[]>;
  for (const level of TRUST_LEVELS) {
    trustCeiling[level] = uniqueSensitivityList(raw.trustCeiling[level], `trustCeiling.${level}`);
  }

  const visibilityAllowed = {} as Record<ChannelVisibility, readonly SensitivityLevel[]>;
  for (const visibility of VISIBILITY_LEVELS) {
    visibilityAllowed[visibility] = uniqueSensitivityList(raw.visibilityAllowed[visibility], `visibilityAllowed.${visibility}`);
  }

  const defaultVisibilityRaw = raw.channelClassification.defaultVisibility;
  if (typeof defaultVisibilityRaw !== 'string' || !VISIBILITY_LEVELS.includes(defaultVisibilityRaw as ChannelVisibility)) {
    throw new Error('Invalid trust policy: channelClassification.defaultVisibility is not supported');
  }

  const visibilityOverridesRaw = raw.channelClassification.visibilityOverrides;
  if (visibilityOverridesRaw !== undefined && !isRecord(visibilityOverridesRaw)) {
    throw new Error('Invalid trust policy: channelClassification.visibilityOverrides must be an object');
  }
  const visibilityOverrides = visibilityOverridesRaw as Record<string, unknown> | undefined;

  return {
    trustCeiling,
    visibilityAllowed,
    channelClassification: {
      privatePrefixes: uniqueStringList(raw.channelClassification.privatePrefixes, 'channelClassification.privatePrefixes'),
      broadcastPrefixes: uniqueStringList(raw.channelClassification.broadcastPrefixes, 'channelClassification.broadcastPrefixes'),
      defaultVisibility: defaultVisibilityRaw as ChannelVisibility,
      visibilityOverrides: {
        exact: visibilityOverrideMap(
          visibilityOverrides?.exact ?? {},
          'channelClassification.visibilityOverrides.exact',
        ),
        prefix: visibilityOverrideMap(
          visibilityOverrides?.prefix ?? {},
          'channelClassification.visibilityOverrides.prefix',
        ),
      },
    },
  };
}

export function loadTrustPolicyConfig(
  dataDir: string,
  options: TrustPolicyLoadOptions = {},
): TrustPolicyConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadOrSeedJson({
    dataPath: join(dataDir, TRUST_POLICY_FILE_NAME),
    seedPath: join(seedDir, TRUST_POLICY_SEED_FILE_NAME),
    validate: validateTrustPolicy,
  });
}

export function saveTrustPolicyConfig(
  dataDir: string,
  nextConfig: unknown,
): TrustPolicyConfig {
  const validated = validateTrustPolicy(nextConfig, TRUST_POLICY_FILE_NAME);
  writeJsonAtomic(join(dataDir, TRUST_POLICY_FILE_NAME), validated);
  return validated;
}
