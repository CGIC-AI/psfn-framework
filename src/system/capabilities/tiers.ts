import type { CapabilityTier } from './tier-types.js';
import { CAPABILITY_TOKENS, type CapabilityToken } from './tokens.js';

export const CAPABILITY_TIER_VALUES: readonly CapabilityTier[] = [
  'nursery',
  'apprentice',
  'autonomous',
  'custom',
] as const;

/**
 * Full baseline capability grant shared by all non-custom tiers.
 *
 * Legacy progression tiers (`nursery`, `apprentice`) are retained in the
 * schema union strictly for backward compatibility with existing on-disk
 * `capability-tier.json` files; every standard companion receives full
 * baseline capability from day one, while per-companion tool exclusions live
 * in `disabledTools` and explicit narrow token sets continue to use `custom`.
 */
const FULL_CAPABILITY_TOKENS: readonly CapabilityToken[] = CAPABILITY_TOKENS;

export const CAPABILITY_TIER_DEFAULTS: Readonly<Record<Exclude<CapabilityTier, 'custom'>, readonly CapabilityToken[]>> = {
  nursery: FULL_CAPABILITY_TOKENS,
  apprentice: FULL_CAPABILITY_TOKENS,
  autonomous: FULL_CAPABILITY_TOKENS,
};

export function isCapabilityTier(value: unknown): value is CapabilityTier {
  return typeof value === 'string' && CAPABILITY_TIER_VALUES.includes(value as CapabilityTier);
}

export function normalizeCapabilityTier(
  value: unknown,
  fallback: CapabilityTier = 'autonomous',
): CapabilityTier {
  return isCapabilityTier(value) ? value : fallback;
}

export function resolveTierCapabilityTokens(
  tier: CapabilityTier,
  customTokens: readonly CapabilityToken[] = [],
): CapabilityToken[] {
  if (tier === 'custom') return [...new Set(customTokens)];
  return [...new Set(CAPABILITY_TIER_DEFAULTS[tier])];
}
