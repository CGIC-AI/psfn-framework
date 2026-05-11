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
  'analysisWorkbenchExtensionBand',
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

export type ChargePolicyRationaleMap<T extends string> = Partial<Record<T, string>>;

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
