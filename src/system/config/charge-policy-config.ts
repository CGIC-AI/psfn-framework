import { join } from 'node:path';
import {
  loadRequiredJson,
  loadSeedJson,
} from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  CHARGE_POLICY_FILE_NAME,
  CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SEED_FILE_NAME,
  CHARGE_POLICY_SURFACE_VALUES,
  FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
  FATIGUE_POLICY_INTENT_VALUES,
  FATIGUE_POLICY_RELATIONSHIP_VALUES,
  type ChargePolicyConfig,
  type ChargePolicyRationaleMap,
  type FatiguePolicyActivityThresholds,
  type FatiguePolicyChannelSettingLimit,
  type FatiguePolicyConfig,
  type FatiguePolicyIntentMultiplier,
  type FatiguePolicyOverchargeConfig,
  type FatiguePolicyResponseBudget,
  type FatiguePolicyStateThresholds,
} from '../../shared/contracts/charge-policy.js';

export {
  CHARGE_POLICY_FILE_NAME,
  CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SEED_FILE_NAME,
  CHARGE_POLICY_SURFACE_VALUES,
  FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
  FATIGUE_POLICY_INTENT_VALUES,
  FATIGUE_POLICY_RELATIONSHIP_VALUES,
  type ChargePolicyConfig,
  type ChargePolicyRationaleMap,
  type ChargePolicyReferenceModelClass,
  type ChargePolicyRuntimeLane,
  type ChargePolicySurface,
  type FatiguePolicyChannelSetting,
  type FatiguePolicyConfig,
  type FatiguePolicyIntent,
  type FatiguePolicyRelationshipClass,
  type FatiguePolicyState,
} from '../../shared/contracts/charge-policy.js';

interface ChargePolicyLoadOptions {
  seedDir?: string;
}

function resolveSeedDir(seedDir?: string): string {
  const resolved = (seedDir ?? process.env.CONFIG_DIR ?? './config').trim();
  if (!resolved) {
    throw new Error('Charge policy seed directory is required');
  }
  return resolved;
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  fieldPath: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(`Invalid charge policy: ${fieldPath} contains unknown keys: ${unknown.join(', ')}`);
  }
}

function parseNonNegativeNumber(
  value: unknown,
  fieldPath: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be a finite number >= 0`);
  }
  return value;
}

function parseNonNegativeInteger(
  value: unknown,
  fieldPath: string,
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 0
  ) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be a finite integer >= 0`);
  }
  return value;
}

function parsePositiveInteger(
  value: unknown,
  fieldPath: string,
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value <= 0
  ) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be a finite integer > 0`);
  }
  return value;
}

function parseBoolean(
  value: unknown,
  fieldPath: string,
): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid charge policy: ${fieldPath} must be a boolean`);
  }
  return value;
}

function parseFixedNumericMap<T extends string>(
  raw: unknown,
  fieldPath: string,
  allowedKeys: readonly T[],
): Record<T, number> {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }

  assertNoUnknownKeys(raw, allowedKeys, fieldPath);

  const parsed = {} as Record<T, number>;
  for (const key of allowedKeys) {
    parsed[key] = parseNonNegativeNumber(raw[key], `${fieldPath}.${key}`);
  }
  return parsed;
}

function parseFixedObjectMap<T extends string, V>(
  raw: unknown,
  fieldPath: string,
  allowedKeys: readonly T[],
  parseEntry: (value: unknown, fieldPath: string) => V,
): Record<T, V> {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }

  assertNoUnknownKeys(raw, allowedKeys, fieldPath);

  const parsed = {} as Record<T, V>;
  for (const key of allowedKeys) {
    parsed[key] = parseEntry(raw[key], `${fieldPath}.${key}`);
  }
  return parsed;
}

function parseOptionalTextMap<T extends string>(
  raw: unknown,
  fieldPath: string,
  allowedKeys: readonly T[],
): ChargePolicyRationaleMap<T> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }

  assertNoUnknownKeys(raw, allowedKeys, fieldPath);

  const parsed = {} as ChargePolicyRationaleMap<T>;
  for (const key of allowedKeys) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Invalid charge policy: ${fieldPath}.${key} must be a non-empty string`);
    }
    parsed[key] = value.trim();
  }

  return Object.keys(parsed).length > 0 ? parsed : {};
}

function assertNonZeroEntriesHaveRationales<T extends string>(
  values: Record<T, number>,
  rationales: ChargePolicyRationaleMap<T> | undefined,
  fieldPath: string,
  rationaleFieldPath: string,
): void {
  const missing = (Object.entries(values) as Array<[T, number]>)
    .filter(([, amount]) => amount > 0)
    .map(([key]) => key)
    .filter((key) => {
      if (!rationales) {
        return true;
      }
      const rationale = rationales[key];
      return !rationale || rationale.trim().length === 0;
    });

  if (missing.length > 0) {
    throw new Error(
      `Invalid charge policy: ${rationaleFieldPath} must include non-empty entries for nonzero ${fieldPath}: ${missing.join(', ')}`,
    );
  }
}

function parseFatigueResponseBudget(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyResponseBudget {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, ['softTarget', 'hardCap'], fieldPath);
  const softTarget = parseNonNegativeInteger(raw.softTarget, `${fieldPath}.softTarget`);
  const hardCap = parseNonNegativeInteger(raw.hardCap, `${fieldPath}.hardCap`);
  if (hardCap < softTarget) {
    throw new Error(`Invalid charge policy: ${fieldPath}.hardCap must be >= ${fieldPath}.softTarget`);
  }
  return { softTarget, hardCap };
}

function parseFatigueChannelSettingLimit(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyChannelSettingLimit {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, ['maxSoftTarget', 'maxHardCap'], fieldPath);
  const maxSoftTarget = parseNonNegativeInteger(raw.maxSoftTarget, `${fieldPath}.maxSoftTarget`);
  const maxHardCap = parseNonNegativeInteger(raw.maxHardCap, `${fieldPath}.maxHardCap`);
  if (maxHardCap < maxSoftTarget) {
    throw new Error(`Invalid charge policy: ${fieldPath}.maxHardCap must be >= ${fieldPath}.maxSoftTarget`);
  }
  return { maxSoftTarget, maxHardCap };
}

function parseFatigueIntentMultiplier(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyIntentMultiplier {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, ['softTargetMultiplier', 'hardCapMultiplier'], fieldPath);
  const softTargetMultiplier = parseNonNegativeNumber(
    raw.softTargetMultiplier,
    `${fieldPath}.softTargetMultiplier`,
  );
  const hardCapMultiplier = parseNonNegativeNumber(
    raw.hardCapMultiplier,
    `${fieldPath}.hardCapMultiplier`,
  );
  if (hardCapMultiplier < softTargetMultiplier) {
    throw new Error(`Invalid charge policy: ${fieldPath}.hardCapMultiplier must be >= ${fieldPath}.softTargetMultiplier`);
  }
  return { softTargetMultiplier, hardCapMultiplier };
}

function parseFatigueActivityThresholds(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyActivityThresholds {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    ['busyRecentMessageCount', 'busyHumanParticipantCount', 'quietRecentMessageCount'],
    fieldPath,
  );
  return {
    busyRecentMessageCount: parsePositiveInteger(
      raw.busyRecentMessageCount,
      `${fieldPath}.busyRecentMessageCount`,
    ),
    busyHumanParticipantCount: parsePositiveInteger(
      raw.busyHumanParticipantCount,
      `${fieldPath}.busyHumanParticipantCount`,
    ),
    quietRecentMessageCount: parsePositiveInteger(
      raw.quietRecentMessageCount,
      `${fieldPath}.quietRecentMessageCount`,
    ),
  };
}

function parseFatigueStateThresholds(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyStateThresholds {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, ['nearingLimitRemainingResponses', 'wrapUpRemainingResponses'], fieldPath);
  return {
    nearingLimitRemainingResponses: parseNonNegativeInteger(
      raw.nearingLimitRemainingResponses,
      `${fieldPath}.nearingLimitRemainingResponses`,
    ),
    wrapUpRemainingResponses: parseNonNegativeInteger(
      raw.wrapUpRemainingResponses,
      `${fieldPath}.wrapUpRemainingResponses`,
    ),
  };
}

function parseFatigueOverchargeConfig(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyOverchargeConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    ['enabled', 'recentHumanParticipationWindowMs', 'minRecentHumanMessages', 'minRecentHumanParticipants'],
    fieldPath,
  );
  return {
    enabled: parseBoolean(raw.enabled, `${fieldPath}.enabled`),
    recentHumanParticipationWindowMs: parsePositiveInteger(
      raw.recentHumanParticipationWindowMs,
      `${fieldPath}.recentHumanParticipationWindowMs`,
    ),
    minRecentHumanMessages: parsePositiveInteger(
      raw.minRecentHumanMessages,
      `${fieldPath}.minRecentHumanMessages`,
    ),
    minRecentHumanParticipants: parsePositiveInteger(
      raw.minRecentHumanParticipants,
      `${fieldPath}.minRecentHumanParticipants`,
    ),
  };
}

function parseFatiguePolicyConfig(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    [
      'relationshipBudgets',
      'channelSettingLimits',
      'intentMultipliers',
      'activityThresholds',
      'stateThresholds',
      'overcharge',
    ],
    fieldPath,
  );

  return {
    relationshipBudgets: parseFixedObjectMap(
      raw.relationshipBudgets,
      `${fieldPath}.relationshipBudgets`,
      FATIGUE_POLICY_RELATIONSHIP_VALUES,
      parseFatigueResponseBudget,
    ),
    channelSettingLimits: parseFixedObjectMap(
      raw.channelSettingLimits,
      `${fieldPath}.channelSettingLimits`,
      FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
      parseFatigueChannelSettingLimit,
    ),
    intentMultipliers: parseFixedObjectMap(
      raw.intentMultipliers,
      `${fieldPath}.intentMultipliers`,
      FATIGUE_POLICY_INTENT_VALUES,
      parseFatigueIntentMultiplier,
    ),
    activityThresholds: parseFatigueActivityThresholds(
      raw.activityThresholds,
      `${fieldPath}.activityThresholds`,
    ),
    stateThresholds: parseFatigueStateThresholds(
      raw.stateThresholds,
      `${fieldPath}.stateThresholds`,
    ),
    overcharge: parseFatigueOverchargeConfig(
      raw.overcharge,
      `${fieldPath}.overcharge`,
    ),
  };
}

function validateChargePolicyConfig(
  raw: unknown,
  sourcePath: string,
): ChargePolicyConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy at ${sourcePath}: expected object`);
  }

  assertNoUnknownKeys(
    raw,
    [
      'schemaVersion',
      'runChargeQuotaByLane',
      'surfaceCosts',
      'surfaceRationales',
      'moa',
      'referenceModelClassPricing',
      'referenceModelClassPricingRationales',
      'fatigue',
    ],
    sourcePath,
  );

  if (raw.schemaVersion !== 1) {
    throw new Error(`Invalid charge policy at ${sourcePath}: schemaVersion must equal 1`);
  }

  if (!isRecord(raw.moa)) {
    throw new Error(`Invalid charge policy at ${sourcePath}: moa must be an object`);
  }
  assertNoUnknownKeys(raw.moa, ['perRoundMultiplierByReferenceModelClass'], `${sourcePath}.moa`);

  const runChargeQuotaByLane = parseFixedNumericMap(
    raw.runChargeQuotaByLane,
    `${sourcePath}.runChargeQuotaByLane`,
    CHARGE_POLICY_RUNTIME_LANE_VALUES,
  );
  const surfaceCosts = parseFixedNumericMap(
    raw.surfaceCosts,
    `${sourcePath}.surfaceCosts`,
    CHARGE_POLICY_SURFACE_VALUES,
  );
  const surfaceRationales = parseOptionalTextMap(
    raw.surfaceRationales,
    `${sourcePath}.surfaceRationales`,
    CHARGE_POLICY_SURFACE_VALUES,
  );
  const referenceModelClassPricing = parseFixedNumericMap(
    raw.referenceModelClassPricing,
    `${sourcePath}.referenceModelClassPricing`,
    CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
  );
  const referenceModelClassPricingRationales = parseOptionalTextMap(
    raw.referenceModelClassPricingRationales,
    `${sourcePath}.referenceModelClassPricingRationales`,
    CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
  );

  assertNonZeroEntriesHaveRationales(
    surfaceCosts,
    surfaceRationales,
    `${sourcePath}.surfaceCosts`,
    `${sourcePath}.surfaceRationales`,
  );
  assertNonZeroEntriesHaveRationales(
    referenceModelClassPricing,
    referenceModelClassPricingRationales,
    `${sourcePath}.referenceModelClassPricing`,
    `${sourcePath}.referenceModelClassPricingRationales`,
  );

  return {
    schemaVersion: 1,
    runChargeQuotaByLane,
    surfaceCosts,
    ...(surfaceRationales !== undefined ? { surfaceRationales } : {}),
    moa: {
      perRoundMultiplierByReferenceModelClass: parseFixedNumericMap(
        raw.moa.perRoundMultiplierByReferenceModelClass,
        `${sourcePath}.moa.perRoundMultiplierByReferenceModelClass`,
        CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
      ),
    },
    referenceModelClassPricing,
    ...(referenceModelClassPricingRationales !== undefined
      ? { referenceModelClassPricingRationales }
      : {}),
    fatigue: parseFatiguePolicyConfig(raw.fatigue, `${sourcePath}.fatigue`),
  };
}

export function loadChargePolicyConfig(
  dataDir: string,
  options: ChargePolicyLoadOptions = {},
): ChargePolicyConfig {
  const seedDir = resolveSeedDir(options.seedDir);
  return loadRequiredJson({
    dataPath: join(dataDir, CHARGE_POLICY_FILE_NAME),
    examplePath: join(seedDir, CHARGE_POLICY_SEED_FILE_NAME),
    validate: validateChargePolicyConfig,
  });
}

export function loadChargePolicySeedDefaults(
  options: ChargePolicyLoadOptions = {},
): ChargePolicyConfig {
  const seedDir = resolveSeedDir(options.seedDir);
  return loadSeedJson({
    seedPath: join(seedDir, CHARGE_POLICY_SEED_FILE_NAME),
    validate: validateChargePolicyConfig,
  });
}

export function saveChargePolicyConfig(
  dataDir: string,
  nextConfig: unknown,
): ChargePolicyConfig {
  const validated = validateChargePolicyConfig(nextConfig, CHARGE_POLICY_FILE_NAME);
  writeJsonAtomic(join(dataDir, CHARGE_POLICY_FILE_NAME), validated);
  return validated;
}
