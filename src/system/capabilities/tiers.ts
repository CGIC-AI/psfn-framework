import type { CapabilityTier } from './tier-types.js';
import type { CapabilityToken } from './tokens.js';

export const CAPABILITY_TIER_VALUES: readonly CapabilityTier[] = [
  'nursery',
  'apprentice',
  'autonomous',
  'custom',
] as const;

const NURSERY_TOKENS: readonly CapabilityToken[] = [
  'identity.read',
  'identity.write.runtime',
  'memory.write',
  'git.read',
  'issue.read',
  'repl.execute',
];

const APPRENTICE_TOKENS: readonly CapabilityToken[] = [
  'identity.read',
  'internal.read',
  'identity.write.runtime',
  'memory.write',
  'external.discord',
  'external.email',
  'external.web',
  'git.read',
  'issue.read',
  'issue.write',
  'repl.execute',
  'shard.spawn',
];

const AUTONOMOUS_TOKENS: readonly CapabilityToken[] = [
  'identity.read',
  'internal.read',
  'identity.write.runtime',
  'identity.write.base',
  'identity.write.operator',
  'memory.write',
  'memory.delete',
  'external.discord',
  'external.email',
  'external.web',
  'git.read',
  'git.write',
  'issue.read',
  'issue.write',
  'issue.close',
  'lifecycle.restart',
  'lifecycle.rebuild',
  'repl.execute',
  'shard.spawn',
];

export const CAPABILITY_TIER_DEFAULTS: Readonly<Record<Exclude<CapabilityTier, 'custom'>, readonly CapabilityToken[]>> = {
  nursery: NURSERY_TOKENS,
  apprentice: APPRENTICE_TOKENS,
  autonomous: AUTONOMOUS_TOKENS,
};

export function isCapabilityTier(value: unknown): value is CapabilityTier {
  return typeof value === 'string' && CAPABILITY_TIER_VALUES.includes(value as CapabilityTier);
}

export function normalizeCapabilityTier(
  value: unknown,
  fallback: CapabilityTier = 'nursery',
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
