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
import { TRUST_CEILING } from './types.js';

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
  // Layer 1: Operator explicit approval overrides all restrictions
  if (ctx.operatorApproval === true) {
    return { decision: 'allow', reason: 'Operator approval override', layer: 'operator' };
  }

  // Layer 2: Consent flags — explicit denial is absolute
  if (ctx.consentFlags?.allowRecall === false) {
    return { decision: 'deny', reason: 'Memory recall denied by consent flags', layer: 'consent' };
  }

  // Layer 3: Trust ceiling — hard structural filter
  const allowed = TRUST_CEILING[ctx.trustLevel];
  if (!allowed.includes(ctx.memorySensitivity)) {
    return {
      decision: 'deny',
      reason: `Trust level '${ctx.trustLevel}' cannot access '${ctx.memorySensitivity}' memories`,
      layer: 'trust',
    };
  }

  // Layer 4: Visibility gate — channel type imposes additional restrictions
  if (ctx.channelVisibility === 'broadcast') {
    if (ctx.memorySensitivity !== 'public') {
      return {
        decision: 'deny',
        reason: 'Broadcast channels restricted to public memories only',
        layer: 'visibility',
      };
    }
  }

  if (ctx.channelVisibility === 'public') {
    if (ctx.memorySensitivity !== 'public') {
      return {
        decision: 'deny',
        reason: 'Public channels restricted to public memories only',
        layer: 'visibility',
      };
    }
  }

  if (ctx.channelVisibility === 'semi_private') {
    if (ctx.memorySensitivity === 'intimate' || ctx.memorySensitivity === 'confidential') {
      return {
        decision: 'deny',
        reason: 'Semi-private channels cannot access intimate/confidential memories',
        layer: 'visibility',
      };
    }
  }

  // Layer 5: Default — within bounds
  return { decision: 'allow', reason: 'Within trust and visibility bounds', layer: 'default' };
}

// ── Channel classification ──

export function classifyChannel(channelId: string): ChannelVisibility {
  // Primary user interfaces — 1:1 private channels (honne)
  if (channelId.startsWith('api:')) return 'private';
  if (channelId.startsWith('sillytavern:')) return 'private';
  if (channelId.startsWith('openwebui:')) return 'private';

  // Shard and internal channels are private
  if (channelId.startsWith('shard:')) return 'private';
  if (channelId.startsWith('internal:')) return 'private';

  // Broadcast / social media
  if (channelId.startsWith('twitter:')) return 'broadcast';
  if (channelId.startsWith('social:')) return 'broadcast';

  // Discord DMs are private (channelId is numeric, resolved via Discord API)
  // Guild channels are semi_private (group setting)
  // This is a default — Discord adapter should resolve DM vs guild explicitly
  return 'semi_private';
}

// ── Continuity sharing ──

export function channelsShareContinuity(a: string, b: string): boolean {
  const visA = classifyChannel(a);
  const visB = classifyChannel(b);
  // Only private channels share cross-channel continuity
  return visA === 'private' && visB === 'private';
}

// ── Allowed sensitivities for a context ──

export function getAllowedSensitivities(
  trustLevel: TrustLevel,
  channelVisibility: ChannelVisibility,
): SensitivityLevel[] {
  const trustAllowed = TRUST_CEILING[trustLevel];

  if (channelVisibility === 'broadcast' || channelVisibility === 'public') {
    return ['public'];
  }

  if (channelVisibility === 'semi_private') {
    return trustAllowed.filter(s => s === 'public' || s === 'personal') as SensitivityLevel[];
  }

  // Private — full trust ceiling applies
  return [...trustAllowed];
}
