import { isCapabilityTier } from './tiers.js';
import { inferSessionChannelType } from '../../core/session/session-id.js';
import { isRecord } from '../../shared/utils/types.js';
import { CHANNEL_TYPES, COMPOSITIONAL_PURPOSES, type ChannelType, type CompositionalPurpose } from '../../shared/contracts/runtime.js';
import { createDefaultCompositionalPolicyConfig, type CapabilityTier, type CompositionalPolicyConfig } from '../config/runtime-config-contracts.js';

export { createDefaultCompositionalPolicyConfig } from '../config/runtime-config-contracts.js';

const CHANNEL_TYPE_SET = new Set<ChannelType>(CHANNEL_TYPES);
const COMPOSITIONAL_PURPOSE_SET = new Set<CompositionalPurpose>(COMPOSITIONAL_PURPOSES);
const NON_COMPOSITIONAL_CHANNEL_TYPES = new Set<ChannelType>(['internal', 'subagent', 'shard']);

function uniqueValues<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === 'string' && CHANNEL_TYPE_SET.has(value as ChannelType);
}

export function resolveCompositionalChannelType(channelId: string): ChannelType | undefined {
  const inferred = inferSessionChannelType(channelId);
  if (!inferred || !isChannelType(inferred)) {
    return undefined;
  }
  return NON_COMPOSITIONAL_CHANNEL_TYPES.has(inferred) ? undefined : inferred;
}

export function isCompositionalPurpose(value: unknown): value is CompositionalPurpose {
  return typeof value === 'string' && COMPOSITIONAL_PURPOSE_SET.has(value as CompositionalPurpose);
}

function normalizeTierList(value: unknown): CapabilityTier[] {
  if (!Array.isArray(value)) return [];
  return uniqueValues(
    value.filter((entry): entry is CapabilityTier => isCapabilityTier(entry)),
  );
}

function normalizeChannelTypeList(value: unknown): ChannelType[] {
  if (!Array.isArray(value)) return [];
  return uniqueValues(
    value.filter((entry): entry is ChannelType => isChannelType(entry)),
  );
}

function normalizePurposeList(value: unknown): CompositionalPurpose[] {
  if (!Array.isArray(value)) return [];
  return uniqueValues(
    value.filter((entry): entry is CompositionalPurpose => isCompositionalPurpose(entry)),
  );
}

export function normalizeCompositionalPolicyConfig(value: unknown): CompositionalPolicyConfig {
  if (!isRecord(value)) {
    return createDefaultCompositionalPolicyConfig();
  }

  return {
    enabled: value.enabled === true,
    allowedTiers: normalizeTierList(value.allowedTiers),
    allowedChannelTypes: normalizeChannelTypeList(value.allowedChannelTypes),
    allowedPurposes: normalizePurposeList(value.allowedPurposes),
  };
}

export function cloneCompositionalPolicyConfig(
  value: CompositionalPolicyConfig | undefined,
): CompositionalPolicyConfig {
  return normalizeCompositionalPolicyConfig(value);
}

export function validateCompositionalPolicyConfig(
  value: unknown,
  field = 'compositionalPolicy',
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    errors.push(`${field} must be an object`);
    return errors;
  }

  if ('enabled' in value && typeof value.enabled !== 'boolean') {
    errors.push(`${field}.enabled must be true or false`);
  }

  const allowlists = [
    {
      field: `${field}.allowedTiers`,
      value: value.allowedTiers,
      isValid: (entry: unknown): entry is CapabilityTier => isCapabilityTier(entry),
      description: 'capability tiers',
    },
    {
      field: `${field}.allowedChannelTypes`,
      value: value.allowedChannelTypes,
      isValid: (entry: unknown): entry is ChannelType => isChannelType(entry),
      description: 'channel types',
    },
    {
      field: `${field}.allowedPurposes`,
      value: value.allowedPurposes,
      isValid: (entry: unknown): entry is CompositionalPurpose => isCompositionalPurpose(entry),
      description: 'compositional purposes',
    },
  ] as const;

  for (const allowlist of allowlists) {
    if (allowlist.value === undefined) continue;
    const isValidArray = Array.isArray(allowlist.value)
      && allowlist.value.every((entry) => allowlist.isValid(entry));
    if (!isValidArray) {
      errors.push(`${allowlist.field} must be an array of supported ${allowlist.description}`);
    }
  }

  if (value.enabled === true) {
    const requiredLists = [
      [`${field}.allowedTiers`, value.allowedTiers],
      [`${field}.allowedChannelTypes`, value.allowedChannelTypes],
      [`${field}.allowedPurposes`, value.allowedPurposes],
    ];
    for (const [path, entry] of requiredLists) {
      if (!Array.isArray(entry) || entry.length === 0) {
        errors.push(`${path} must list at least one value when ${field}.enabled=true`);
      }
    }
  }

  return errors;
}

export type CompositionalPolicyDecisionReason =
  | 'allowed'
  | 'disabled'
  | 'tier_not_allowed'
  | 'channel_type_not_allowed'
  | 'purpose_not_allowed';

export interface CompositionalPolicyDecision {
  allowed: boolean;
  reason: CompositionalPolicyDecisionReason;
}

export function evaluateCompositionalPolicy(options: {
  policy?: CompositionalPolicyConfig;
  capabilityTier?: CapabilityTier;
  channelType: ChannelType;
  purpose: CompositionalPurpose;
}): CompositionalPolicyDecision {
  const policy = normalizeCompositionalPolicyConfig(options.policy);

  if (!policy.enabled) {
    return { allowed: false, reason: 'disabled' };
  }

  if (!options.capabilityTier || !policy.allowedTiers.includes(options.capabilityTier)) {
    return { allowed: false, reason: 'tier_not_allowed' };
  }

  if (!policy.allowedChannelTypes.includes(options.channelType)) {
    return { allowed: false, reason: 'channel_type_not_allowed' };
  }

  if (!policy.allowedPurposes.includes(options.purpose)) {
    return { allowed: false, reason: 'purpose_not_allowed' };
  }

  return { allowed: true, reason: 'allowed' };
}

export function evaluateCompositionalPolicyForChannelId(options: {
  policy?: CompositionalPolicyConfig;
  capabilityTier?: CapabilityTier;
  channelId: string;
  purpose: CompositionalPurpose;
}): CompositionalPolicyDecision {
  const channelType = resolveCompositionalChannelType(options.channelId);
  if (!channelType) {
    return { allowed: false, reason: 'channel_type_not_allowed' };
  }

  return evaluateCompositionalPolicy({
    policy: options.policy,
    capabilityTier: options.capabilityTier,
    channelType,
    purpose: options.purpose,
  });
}
