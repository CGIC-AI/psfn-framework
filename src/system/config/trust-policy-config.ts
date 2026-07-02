import { join } from 'node:path';
import type {
  ChannelVisibility,
  SensitivityLevel,
  TrustLevel,
} from '../trust/types.js';
import {
  loadRequiredJson,
} from './load-or-seed.js';
import {
  DEFAULT_AUDIENCE_SCOPE_THRESHOLDS,
  validateAudienceScopeThresholds,
  type AudienceScopeThresholds,
} from '../trust/context-envelope.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import { createComponentLogger } from '../../shared/logger.js';

export const TRUST_POLICY_FILE_NAME = 'trust-policy.json';
export const TRUST_POLICY_SEED_FILE_NAME = 'trust-policy.seed.json';
const log = createComponentLogger('TrustPolicyConfig');

const TRUST_LEVELS: TrustLevel[] = ['primary', 'trusted', 'regular', 'public'];
const SENSITIVITY_LEVELS: SensitivityLevel[] = ['public', 'personal', 'intimate', 'confidential'];
const VISIBILITY_LEVELS: ChannelVisibility[] = ['private', 'invite_only', 'public', 'broadcast'];
const LEGACY_SEMI_PRIVATE = 'semi_private';

export interface TrustPolicyConfig {
  trustCeiling: Record<TrustLevel, readonly SensitivityLevel[]>;
  visibilityAllowed: Record<ChannelVisibility, readonly SensitivityLevel[]>;
  /**
   * Config-owned audienceScope derivation thresholds (Context Envelope
   * contract, docs/context-envelope.md). Optional in the owner file; the
   * documented defaults apply when absent.
   */
  audienceScopeThresholds: AudienceScopeThresholds;
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

/**
 * One-time owner-file vocabulary migration for the E3.1 rename
 * (semi_private → invite_only). Applies BEFORE validation so existing
 * deployments keep starting; anything ambiguous (both spellings present)
 * fails closed. The broadcast → (public + broadcast flag) envelope migration
 * is documented in docs/context-envelope.md and is NOT executed here.
 */
export function migrateLegacyTrustPolicyVocabulary(raw: unknown): {
  raw: unknown;
  migrated: boolean;
} {
  if (!isRecord(raw)) return { raw, migrated: false };
  let migrated = false;
  const next: Record<string, unknown> = { ...raw };

  if (isRecord(raw.visibilityAllowed) && Object.hasOwn(raw.visibilityAllowed, LEGACY_SEMI_PRIVATE)) {
    if (Object.hasOwn(raw.visibilityAllowed, 'invite_only')) {
      throw new Error(
        'Invalid trust policy: visibilityAllowed defines both semi_private and invite_only; '
        + 'remove the retired semi_private key',
      );
    }
    const { [LEGACY_SEMI_PRIVATE]: legacyAllowed, ...rest } = raw.visibilityAllowed;
    next.visibilityAllowed = { ...rest, invite_only: legacyAllowed };
    migrated = true;
  }

  if (isRecord(raw.channelClassification)) {
    const classification: Record<string, unknown> = { ...raw.channelClassification };
    if (classification.defaultVisibility === LEGACY_SEMI_PRIVATE) {
      classification.defaultVisibility = 'invite_only';
      migrated = true;
    }
    if (isRecord(classification.visibilityOverrides)) {
      const overrides: Record<string, unknown> = { ...classification.visibilityOverrides };
      for (const scope of ['exact', 'prefix'] as const) {
        if (!isRecord(overrides[scope])) continue;
        const entries = { ...(overrides[scope] as Record<string, unknown>) };
        let scopeMigrated = false;
        for (const [key, value] of Object.entries(entries)) {
          if (value === LEGACY_SEMI_PRIVATE) {
            entries[key] = 'invite_only';
            scopeMigrated = true;
          }
        }
        if (scopeMigrated) {
          overrides[scope] = entries;
          migrated = true;
        }
      }
      classification.visibilityOverrides = overrides;
    }
    if (migrated) {
      next.channelClassification = classification;
    }
  }

  return { raw: migrated ? next : raw, migrated };
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

  const audienceScopeThresholds = raw.audienceScopeThresholds === undefined
    ? DEFAULT_AUDIENCE_SCOPE_THRESHOLDS
    : validateAudienceScopeThresholds(raw.audienceScopeThresholds, 'audienceScopeThresholds');

  return {
    trustCeiling,
    visibilityAllowed,
    audienceScopeThresholds,
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

function sensitivityListEquals(
  actual: readonly SensitivityLevel[],
  expected: readonly SensitivityLevel[],
): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function stringListEquals(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function visibilityMapEquals(
  actual: Record<string, ChannelVisibility>,
  expected: Record<string, ChannelVisibility>,
): boolean {
  const actualEntries = Object.entries(actual).sort(([a], [b]) => a.localeCompare(b));
  const expectedEntries = Object.entries(expected).sort(([a], [b]) => a.localeCompare(b));
  return actualEntries.length === expectedEntries.length
    && actualEntries.every(([key, value], index) => (
      key === expectedEntries[index]?.[0] && value === expectedEntries[index]?.[1]
    ));
}

function isKnownOldDefaultTrustPolicy(config: TrustPolicyConfig): boolean {
  return sensitivityListEquals(config.trustCeiling.primary, ['public', 'personal', 'intimate', 'confidential'])
    && sensitivityListEquals(config.trustCeiling.trusted, ['public', 'personal'])
    && sensitivityListEquals(config.trustCeiling.regular, ['public'])
    && sensitivityListEquals(config.trustCeiling.public, ['public'])
    && sensitivityListEquals(config.visibilityAllowed.private, ['public', 'personal', 'intimate', 'confidential'])
    && sensitivityListEquals(config.visibilityAllowed.invite_only, ['public', 'personal'])
    && sensitivityListEquals(config.visibilityAllowed.public, ['public'])
    && sensitivityListEquals(config.visibilityAllowed.broadcast, ['public'])
    && stringListEquals(config.channelClassification.privatePrefixes, ['api:', 'sillytavern:', 'openwebui:', 'shard:', 'internal:'])
    && stringListEquals(config.channelClassification.broadcastPrefixes, ['twitter:', 'social:'])
    && config.channelClassification.defaultVisibility === 'invite_only'
    && visibilityMapEquals(config.channelClassification.visibilityOverrides.exact, {})
    && visibilityMapEquals(config.channelClassification.visibilityOverrides.prefix, {});
}

function migrateKnownOldDefaultTrustPolicy(config: TrustPolicyConfig): {
  config: TrustPolicyConfig;
  migrated: boolean;
} {
  if (!isKnownOldDefaultTrustPolicy(config)) {
    return { config, migrated: false };
  }
  return {
    migrated: true,
    config: {
      ...config,
      trustCeiling: {
        ...config.trustCeiling,
        regular: ['public', 'personal'],
      },
    },
  };
}

export function loadTrustPolicyConfig(
  dataDir: string,
  options: TrustPolicyLoadOptions = {},
): TrustPolicyConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  const dataPath = join(dataDir, TRUST_POLICY_FILE_NAME);
  const vocabularyMigration = { migrated: false };
  const loaded = loadRequiredJson({
    dataPath,
    examplePath: join(seedDir, TRUST_POLICY_SEED_FILE_NAME),
    validate: (raw, sourcePath) => {
      const vocabulary = migrateLegacyTrustPolicyVocabulary(raw);
      vocabularyMigration.migrated = vocabulary.migrated;
      return validateTrustPolicy(vocabulary.raw, sourcePath);
    },
  });
  const migrated = migrateKnownOldDefaultTrustPolicy(loaded);
  if (migrated.migrated || vocabularyMigration.migrated) {
    writeJsonAtomic(dataPath, migrated.config);
    if (vocabularyMigration.migrated) {
      log.info('Migrated trust-policy channel vocabulary (semi_private -> invite_only)', {
        dataPath,
      });
    }
    if (migrated.migrated) {
      log.info('Migrated known old trust-policy default regular ceiling', {
        dataPath,
        from: ['public'],
        to: ['public', 'personal'],
      });
    }
  }
  return migrated.config;
}

export function saveTrustPolicyConfig(
  dataDir: string,
  nextConfig: unknown,
): TrustPolicyConfig {
  const validated = validateTrustPolicy(nextConfig, TRUST_POLICY_FILE_NAME);
  writeJsonAtomic(join(dataDir, TRUST_POLICY_FILE_NAME), validated);
  return validated;
}
