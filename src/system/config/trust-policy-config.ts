import { join } from 'node:path';
import type {
  SensitivityLevel,
  TrustLevel,
} from '../trust/types.js';
import {
  loadRequiredJson,
} from './load-or-seed.js';
import {
  CHANNEL_PRIVACY_VALUES,
  DEFAULT_AUDIENCE_SCOPE_THRESHOLDS,
  DEFAULT_PARTICIPANT_RELATIONSHIP_CONFIDENCE_THRESHOLD,
  isChannelPrivacy,
  validateAudienceScopeThresholds,
  validateParticipantRelationshipConfidenceThreshold,
  type AudienceScopeThresholds,
  type ChannelPrivacy,
} from '../trust/context-envelope.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import { createComponentLogger } from '../../shared/logger.js';

export const TRUST_POLICY_FILE_NAME = 'trust-policy.json';
export const TRUST_POLICY_SEED_FILE_NAME = 'trust-policy.seed.json';
const log = createComponentLogger('TrustPolicyConfig');

const TRUST_LEVELS: TrustLevel[] = ['primary', 'trusted', 'regular', 'public'];
const SENSITIVITY_LEVELS: SensitivityLevel[] = ['public', 'personal', 'intimate', 'confidential'];
const LEGACY_SEMI_PRIVATE = 'semi_private';
const LEGACY_BROADCAST = 'broadcast';

/**
 * Operator classification override value: the envelope {privacy, broadcast}
 * pair. The owner file accepts either a bare ChannelPrivacy string
 * (broadcast: false) or the explicit pair object; legacy 'broadcast' string
 * values are migrated once at load to { privacy: 'public', broadcast: true }.
 */
export interface ChannelClassificationOverride {
  privacy: ChannelPrivacy;
  broadcast: boolean;
}

export interface TrustPolicyConfig {
  trustCeiling: Record<TrustLevel, readonly SensitivityLevel[]>;
  /**
   * E3.3: keyed by the three ChannelPrivacy values. The former 'broadcast'
   * row is gone — broadcast is a flag whose disclosure ceiling IS the public
   * row (plus the approval-token machinery in broadcast-safety.ts).
   */
  visibilityAllowed: Record<ChannelPrivacy, readonly SensitivityLevel[]>;
  /**
   * Config-owned audienceScope derivation thresholds (Context Envelope
   * contract, docs/context-envelope.md). Optional in the owner file; the
   * documented defaults apply when absent.
   */
  audienceScopeThresholds: AudienceScopeThresholds;
  /**
   * E4.4: minimum edge confidence for compact participant-relationship exposure
   * in conversation_state. Optional in the owner file; the documented default
   * (0.7) applies when absent.
   */
  participantRelationshipConfidenceThreshold: number;
  channelClassification: {
    privatePrefixes: string[];
    broadcastPrefixes: string[];
    defaultVisibility: ChannelPrivacy;
    visibilityOverrides: {
      exact: Record<string, ChannelClassificationOverride>;
      prefix: Record<string, ChannelClassificationOverride>;
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

function parseClassificationOverrideValue(
  value: unknown,
  field: string,
): ChannelClassificationOverride {
  if (typeof value === 'string') {
    if (!isChannelPrivacy(value)) {
      throw new Error(`Invalid trust policy: ${field} has unsupported visibility`);
    }
    return { privacy: value, broadcast: false };
  }
  if (isRecord(value)) {
    const unknownKeys = Object.keys(value).filter(key => key !== 'privacy' && key !== 'broadcast');
    if (unknownKeys.length > 0) {
      throw new Error(`Invalid trust policy: ${field} has unsupported keys: ${unknownKeys.join(', ')}`);
    }
    if (!isChannelPrivacy(value.privacy)) {
      throw new Error(`Invalid trust policy: ${field}.privacy must be one of: ${CHANNEL_PRIVACY_VALUES.join(', ')}`);
    }
    const broadcast = value.broadcast ?? false;
    if (typeof broadcast !== 'boolean') {
      throw new Error(`Invalid trust policy: ${field}.broadcast must be a boolean`);
    }
    if (broadcast && value.privacy !== 'public') {
      throw new Error(
        `Invalid trust policy: ${field} sets broadcast=true with privacy '${value.privacy}'; `
        + "a broadcast surface is always 'public'",
      );
    }
    return { privacy: value.privacy, broadcast };
  }
  throw new Error(`Invalid trust policy: ${field} must be a channel privacy string or {privacy, broadcast} object`);
}

function visibilityOverrideMap(value: unknown, field: string): Record<string, ChannelClassificationOverride> {
  if (!isRecord(value)) {
    throw new Error(`Invalid trust policy: ${field} must be an object`);
  }

  const out: Record<string, ChannelClassificationOverride> = {};
  for (const [rawKey, rawOverride] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) continue;
    out[key] = parseClassificationOverrideValue(rawOverride, `${field}.${rawKey}`);
  }

  return out;
}

function sensitivitySetEquals(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === setB.size && [...setA].every(value => setB.has(value));
}

/**
 * One-time owner-file vocabulary migration. Applies BEFORE validation so
 * existing deployments keep starting; anything ambiguous fails closed.
 *
 * Legs (docs/context-envelope.md migration map):
 * - E3.1: 'semi_private' → 'invite_only' (visibilityAllowed key,
 *   defaultVisibility, override values).
 * - E3.3: the visibilityAllowed 'broadcast' row is dropped — broadcast is a
 *   flag whose disclosure ceiling IS the public row. A legacy broadcast row
 *   that differs from the public row fails closed (dropping it would silently
 *   change gating). Override VALUES of 'broadcast' migrate to the explicit
 *   { privacy: 'public', broadcast: true } pair.
 *
 * saveTrustPolicyConfig (Garden writes) rejects the retired vocabulary
 * outright; this decode applies only to files loaded from disk.
 */
export function migrateLegacyTrustPolicyVocabulary(raw: unknown): {
  raw: unknown;
  migrated: boolean;
} {
  if (!isRecord(raw)) return { raw, migrated: false };
  let migrated = false;
  const next: Record<string, unknown> = { ...raw };

  if (isRecord(raw.visibilityAllowed)) {
    let visibilityAllowed: Record<string, unknown> = raw.visibilityAllowed;
    if (Object.hasOwn(visibilityAllowed, LEGACY_SEMI_PRIVATE)) {
      if (Object.hasOwn(visibilityAllowed, 'invite_only')) {
        throw new Error(
          'Invalid trust policy: visibilityAllowed defines both semi_private and invite_only; '
          + 'remove the retired semi_private key',
        );
      }
      const { [LEGACY_SEMI_PRIVATE]: legacyAllowed, ...rest } = visibilityAllowed;
      visibilityAllowed = { ...rest, invite_only: legacyAllowed };
      migrated = true;
    }
    if (Object.hasOwn(visibilityAllowed, LEGACY_BROADCAST)) {
      const { [LEGACY_BROADCAST]: legacyBroadcastRow, ...rest } = visibilityAllowed;
      if (!sensitivitySetEquals(legacyBroadcastRow, rest.public)) {
        throw new Error(
          'Invalid trust policy: visibilityAllowed.broadcast differs from visibilityAllowed.public; '
          + 'the broadcast row is retired (broadcast is a flag whose ceiling is the public row) — '
          + 'reconcile the two rows, then remove the broadcast key',
        );
      }
      visibilityAllowed = rest;
      migrated = true;
    }
    if (migrated) {
      next.visibilityAllowed = visibilityAllowed;
    }
  }

  if (isRecord(raw.channelClassification)) {
    const classification: Record<string, unknown> = { ...raw.channelClassification };
    let classificationMigrated = false;
    if (classification.defaultVisibility === LEGACY_SEMI_PRIVATE) {
      classification.defaultVisibility = 'invite_only';
      classificationMigrated = true;
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
          } else if (value === LEGACY_BROADCAST) {
            entries[key] = { privacy: 'public', broadcast: true };
            scopeMigrated = true;
          }
        }
        if (scopeMigrated) {
          overrides[scope] = entries;
          classificationMigrated = true;
        }
      }
      classification.visibilityOverrides = overrides;
    }
    if (classificationMigrated) {
      next.channelClassification = classification;
      migrated = true;
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

  const retiredVisibilityKeys = Object.keys(raw.visibilityAllowed)
    .filter(key => !isChannelPrivacy(key));
  if (retiredVisibilityKeys.length > 0) {
    throw new Error(
      `Invalid trust policy: visibilityAllowed has unsupported keys: ${retiredVisibilityKeys.join(', ')} `
      + `(supported: ${CHANNEL_PRIVACY_VALUES.join(', ')}; broadcast is a channel-envelope flag, not a privacy row)`,
    );
  }
  const visibilityAllowed = {} as Record<ChannelPrivacy, readonly SensitivityLevel[]>;
  for (const privacy of CHANNEL_PRIVACY_VALUES) {
    visibilityAllowed[privacy] = uniqueSensitivityList(raw.visibilityAllowed[privacy], `visibilityAllowed.${privacy}`);
  }

  const defaultVisibilityRaw = raw.channelClassification.defaultVisibility;
  if (!isChannelPrivacy(defaultVisibilityRaw)) {
    throw new Error(
      'Invalid trust policy: channelClassification.defaultVisibility must be one of: '
      + `${CHANNEL_PRIVACY_VALUES.join(', ')}`,
    );
  }

  const visibilityOverridesRaw = raw.channelClassification.visibilityOverrides;
  if (visibilityOverridesRaw !== undefined && !isRecord(visibilityOverridesRaw)) {
    throw new Error('Invalid trust policy: channelClassification.visibilityOverrides must be an object');
  }
  const visibilityOverrides = visibilityOverridesRaw as Record<string, unknown> | undefined;

  const audienceScopeThresholds = raw.audienceScopeThresholds === undefined
    ? DEFAULT_AUDIENCE_SCOPE_THRESHOLDS
    : validateAudienceScopeThresholds(raw.audienceScopeThresholds, 'audienceScopeThresholds');

  const participantRelationshipConfidenceThreshold = raw.participantRelationshipConfidenceThreshold === undefined
    ? DEFAULT_PARTICIPANT_RELATIONSHIP_CONFIDENCE_THRESHOLD
    : validateParticipantRelationshipConfidenceThreshold(
      raw.participantRelationshipConfidenceThreshold,
      'participantRelationshipConfidenceThreshold',
    );

  return {
    trustCeiling,
    visibilityAllowed,
    audienceScopeThresholds,
    participantRelationshipConfidenceThreshold,
    channelClassification: {
      privatePrefixes: uniqueStringList(raw.channelClassification.privatePrefixes, 'channelClassification.privatePrefixes'),
      broadcastPrefixes: uniqueStringList(raw.channelClassification.broadcastPrefixes, 'channelClassification.broadcastPrefixes'),
      defaultVisibility: defaultVisibilityRaw,
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
  actual: Record<string, ChannelClassificationOverride>,
  expected: Record<string, ChannelClassificationOverride>,
): boolean {
  const actualEntries = Object.entries(actual).sort(([a], [b]) => a.localeCompare(b));
  const expectedEntries = Object.entries(expected).sort(([a], [b]) => a.localeCompare(b));
  return actualEntries.length === expectedEntries.length
    && actualEntries.every(([key, value], index) => (
      key === expectedEntries[index]?.[0]
      && value.privacy === expectedEntries[index]?.[1]?.privacy
      && value.broadcast === expectedEntries[index]?.[1]?.broadcast
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
      log.info('Migrated trust-policy channel vocabulary (semi_private rename / broadcast row and override split)', {
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
