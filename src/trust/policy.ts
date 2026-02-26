// ── Trust Policy Engine ──
// Canonical precedence matrix for memory access decisions.
// Consumed by: MemoryRetriever, UserContinuityStore, persona composition, broadcast safety.
//
// Precedence (highest to lowest):
//   1. Operator explicit approval (admin override)
//   2. Consent flags gate (per-memory denial trumps all)
//   3. Trust ceiling gate (hard structural filter by trust level)
//   4. Visibility gate (channel-level restriction)
//   5. Default: allow

import type {
  TrustLevel,
  SensitivityLevel,
  ChannelVisibility,
  ConsentFlags,
} from './types.js';
import { getRuntimeTrustPolicy } from './runtime-policy.js';

export interface ChannelMeta {
  isDirectMessage?: boolean;
  broadcastApprovalToken?: string;
}

// ── Policy evaluation ──

export type PolicyDecision = 'allow' | 'deny' | 'sanitize';

export interface PolicyContext {
  trustLevel: TrustLevel;
  channelVisibility: ChannelVisibility;
  memorySensitivity: SensitivityLevel;
  consentFlags?: ConsentFlags;
  operatorApproval?: boolean;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  /** Which precedence layer determined the outcome */
  layer: 'operator' | 'consent' | 'trust' | 'visibility' | 'default';
}

export function evaluateMemoryPolicy(ctx: PolicyContext): PolicyResult {
  const trustPolicy = getRuntimeTrustPolicy();

  // Layer 1: Operator explicit approval overrides all restrictions
  if (ctx.operatorApproval === true) {
    return { decision: 'allow', reason: 'Operator approval override', layer: 'operator' };
  }

  // Layer 2: Consent flags — explicit denial is absolute
  if (ctx.consentFlags?.allowRecall === false) {
    return { decision: 'deny', reason: 'Memory recall denied by consent flags', layer: 'consent' };
  }

  // Layer 3: Trust ceiling — hard structural filter
  const allowed = trustPolicy.trustCeiling[ctx.trustLevel];
  if (!allowed.includes(ctx.memorySensitivity)) {
    return {
      decision: 'deny',
      reason: `Trust level '${ctx.trustLevel}' cannot access '${ctx.memorySensitivity}' memories`,
      layer: 'trust',
    };
  }

  // Layer 4: Visibility gate — channel type imposes additional restrictions
  const allowedByVisibility = trustPolicy.visibilityAllowed[ctx.channelVisibility];
  if (!allowedByVisibility.includes(ctx.memorySensitivity)) {
    return {
      decision: 'deny',
      reason: `${ctx.channelVisibility} channels restrict '${ctx.memorySensitivity}' memory access`,
      layer: 'visibility',
    };
  }

  // Layer 5: Default — within bounds
  return { decision: 'allow', reason: 'Within trust and visibility bounds', layer: 'default' };
}

// ── Channel classification ──

function resolvePrefixVisibilityOverride(
  channelId: string,
  prefixOverrides: Record<string, ChannelVisibility>,
): ChannelVisibility | undefined {
  let bestMatch: { prefix: string; visibility: ChannelVisibility } | undefined;
  for (const [prefix, visibility] of Object.entries(prefixOverrides)) {
    if (!channelId.startsWith(prefix)) continue;
    if (!bestMatch || prefix.length > bestMatch.prefix.length) {
      bestMatch = { prefix, visibility };
    }
  }
  return bestMatch?.visibility;
}

export function classifyChannel(
  channelId: string,
  meta?: ChannelMeta,
): ChannelVisibility {
  const trustPolicy = getRuntimeTrustPolicy();
  const visibilityOverrides = trustPolicy.channelClassification.visibilityOverrides;

  const exactOverride = Object.prototype.hasOwnProperty.call(visibilityOverrides.exact, channelId)
    ? visibilityOverrides.exact[channelId]
    : undefined;
  if (exactOverride !== undefined) {
    return exactOverride;
  }

  const prefixOverride = resolvePrefixVisibilityOverride(channelId, visibilityOverrides.prefix);
  if (prefixOverride !== undefined) {
    return prefixOverride;
  }

  // Discord DMs explicitly flagged by adapter — private (honne)
  if (meta?.isDirectMessage) return 'private';

  if (trustPolicy.channelClassification.privatePrefixes.some(prefix => channelId.startsWith(prefix))) {
    return 'private';
  }

  if (trustPolicy.channelClassification.broadcastPrefixes.some(prefix => channelId.startsWith(prefix))) {
    return 'broadcast';
  }

  return trustPolicy.channelClassification.defaultVisibility;
}

// ── Continuity sharing ──

export function channelsShareContinuity(a: string, b: string): boolean {
  const visA = classifyChannel(a);
  const visB = classifyChannel(b);
  return visibilitiesShareContinuity(visA, visB);
}

export function visibilitiesShareContinuity(a: ChannelVisibility, b: ChannelVisibility): boolean {
  // Only private channels share cross-channel continuity
  return a === 'private' && b === 'private';
}

// ── Allowed sensitivities for a context ──

export function getAllowedSensitivities(
  trustLevel: TrustLevel,
  channelVisibility: ChannelVisibility,
): SensitivityLevel[] {
  const trustPolicy = getRuntimeTrustPolicy();
  const trustAllowed = trustPolicy.trustCeiling[trustLevel];
  const visibilityAllowed = trustPolicy.visibilityAllowed[channelVisibility];

  return trustAllowed.filter(sensitivity => visibilityAllowed.includes(sensitivity)) as SensitivityLevel[];
}
