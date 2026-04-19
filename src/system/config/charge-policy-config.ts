import { join } from 'node:path';
import {
  loadOrSeedJson,
  loadSeedJson,
  writeJsonAtomic,
} from './load-or-seed.js';
import { isRecord } from '../../shared/utils/types.js';

export const CHARGE_POLICY_FILE_NAME = 'charge-policy.json';
export const CHARGE_POLICY_SEED_FILE_NAME = 'charge-policy.seed.json';

export const CHARGE_POLICY_RUNTIME_LANE_VALUES = [
  'interactive',
  'background',
  'maintenance',
  'subagent',
  'shard',
] as const;

export const CHARGE_POLICY_SURFACE_VALUES = [
  'ownerFileInspection',
  'localFilesystem',
  'memoryRead',
  'memoryWrite',
  'localEmbedding',
  'externalEmbedding',
  'localImageGeneration',
  'paidImageGeneration',
  'thinkExtensionBand',
  'subagentLaunch',
  'shardLaunch',
  'externalModelConsult',
  'moaRoundBase',
] as const;

export const CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES = [
  'local',
  'subscription',
  'cheap_cloud',
  'premium_cloud',
] as const;

export type ChargePolicyRuntimeLane = (typeof CHARGE_POLICY_RUNTIME_LANE_VALUES)[number];
export type ChargePolicySurface = (typeof CHARGE_POLICY_SURFACE_VALUES)[number];
export type ChargePolicyReferenceModelClass = (typeof CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES)[number];

type ChargePolicyRationaleMap<T extends string> = Partial<Record<T, string>>;

export interface ChargePolicyConfig {
  schemaVersion: 1;
  runChargeQuotaByLane: Record<ChargePolicyRuntimeLane, number>;
  surfaceCosts: Record<ChargePolicySurface, number>;
  surfaceRationales?: ChargePolicyRationaleMap<ChargePolicySurface>;
  moa: {
    perRoundMultiplierByReferenceModelClass: Record<ChargePolicyReferenceModelClass, number>;
  };
  referenceModelClassPricing: Record<ChargePolicyReferenceModelClass, number>;
  referenceModelClassPricingRationales?: ChargePolicyRationaleMap<ChargePolicyReferenceModelClass>;
}

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
  const missing = Object.entries(values)
    .filter(([, amount]) => amount > 0)
    .map(([key]) => key as T)
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
  };
}

export function loadChargePolicyConfig(
  dataDir: string,
  options: ChargePolicyLoadOptions = {},
): ChargePolicyConfig {
  const seedDir = resolveSeedDir(options.seedDir);
  return loadOrSeedJson({
    dataPath: join(dataDir, CHARGE_POLICY_FILE_NAME),
    seedPath: join(seedDir, CHARGE_POLICY_SEED_FILE_NAME),
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
