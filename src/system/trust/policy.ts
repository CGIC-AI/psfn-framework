// ── Trust Policy Engine ──
// Canonical precedence matrix for memory access decisions.
// Consumed by: MemoryRetriever, UserContinuityStore, persona composition, broadcast safety.
//
// Precedence (highest to lowest):
//   1. Operator explicit approval (admin override)
//   2. Disclosure boundary gate (explicit withhold / consent-required)
//   3. Consent flags gate (per-memory denial)
//   4. Trust ceiling gate (hard structural filter by trust level)
//   5. Visibility gate (channel-level restriction)
//   6. Default: allow

import type {
  TrustLevel,
  LowTierTrustLevel,
  TrustMutationSource,
  SensitivityLevel,
  ChannelVisibility,
  ConsentFlags,
} from './types.js';
import {
  isHighTierTrustLevel,
  normalizeChannelVisibility,
  sensitivityOrd,
} from './types.js';
import type { ResponseStyle, ResponseStyleOverrides } from '../../shared/contracts/runtime.js';
import { getRuntimeTrustPolicy } from './runtime-policy.js';

export interface ChannelMeta {
  isDirectMessage?: boolean;
  broadcastApprovalToken?: string;
  disclosureConsentGranted?: boolean;
  privacyLevel?: ChannelVisibility;
}

const RESPONSE_STYLE_BY_VISIBILITY: Record<ChannelVisibility, ResponseStyle> = {
  private: 'expressive',
  invite_only: 'concise',
  public: 'concise',
  broadcast: 'concise',
};

export function buildTrustPromptState(trustLevel: TrustLevel): Record<string, string> {
  // The bare trust tier is the session-stable {{trust_level}} macro; the
  // duplicate {{runtime_trust_level}} spelling was removed (E2.5).
  return {
    runtime_trust_is_primary: String(trustLevel === 'primary'),
    runtime_trust_is_trusted: String(trustLevel === 'trusted'),
    runtime_trust_is_regular: String(trustLevel === 'regular'),
    runtime_trust_is_public: String(trustLevel === 'public'),
  };
}

export function buildResponseStylePromptState(style: ResponseStyle): Record<string, string> {
  return {
    runtime_response_style: style,
    runtime_response_style_name: style === 'concise' ? 'Concise' : 'Expressive',
    runtime_response_style_is_concise: String(style === 'concise'),
    runtime_response_style_is_expressive: String(style === 'expressive'),
  };
}

// ── Policy evaluation ──

export type PolicyDecision = 'allow' | 'deny' | 'sanitize';
export type PolicyReasonTag =
  | 'operator.approval_override'
  | 'boundary.withhold'
  | 'boundary.consent_required'
  | 'consent.allow_recall_denied'
  | 'trust.ceiling_exceeded'
  | 'visibility.channel_restricted'
  | 'default.within_bounds';

export interface DisclosureBoundaryDirective {
  /** Explicit companion-owned withhold gate for this memory. */
  withhold?: boolean;
  /**
   * Requires explicit per-turn consent before disclosure.
   * Fail closed when consent is not explicitly granted.
   */
  consentRequired?: boolean;
  consentGranted?: boolean;
}

export interface PolicyContext {
  trustLevel: TrustLevel;
  channelVisibility: ChannelVisibility;
  memorySensitivity: SensitivityLevel;
  consentFlags?: ConsentFlags;
  disclosureBoundary?: DisclosureBoundaryDirective;
  operatorApproval?: boolean;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  reasonTag: PolicyReasonTag;
  /** Which precedence layer determined the outcome */
  layer: 'operator' | 'boundary' | 'consent' | 'trust' | 'visibility' | 'default';
}

export interface TrustDriftBehaviorSignals {
  positiveInteractionCount: number;
  negativeInteractionCount?: number;
  verifiedIdentityLinks?: number;
  consistentBoundaryRespect?: boolean;
}

export interface LowTierTrustDriftSuggestion {
  fromTrustLevel: LowTierTrustLevel;
  suggestedTrustLevel: LowTierTrustLevel;
  confidence: number;
  rationale: string;
  requiresConfirmation: true;
}

const AUTONOMOUS_TRUST_MUTATION_ACTOR_PREFIXES = ['agent:', 'autonomous:'] as const;
const MANUAL_HIGH_TIER_TRUST_ACTOR_PREFIXES = ['admin:', 'human:', 'operator:'] as const;

function normalizeActor(actor?: string): string {
  return actor?.trim().toLowerCase() ?? '';
}

export function resolveTrustMutationSource(
  actor: string | undefined,
  requestedSource: TrustMutationSource = 'manual',
): TrustMutationSource {
  if (requestedSource !== 'manual') return requestedSource;
  const normalizedActor = normalizeActor(actor);
  if (!normalizedActor) return 'manual';
  if (AUTONOMOUS_TRUST_MUTATION_ACTOR_PREFIXES.some(prefix => normalizedActor.startsWith(prefix))) {
    return 'autonomous';
  }
  return 'manual';
}

export function isManualHighTierTrustMutationAuthorized(
  actor: string | undefined,
  mutationSource: TrustMutationSource = 'manual',
): boolean {
  const resolvedSource = resolveTrustMutationSource(actor, mutationSource);
  if (resolvedSource !== 'manual') return false;

  const normalizedActor = normalizeActor(actor);
  if (!normalizedActor) return true;

  return MANUAL_HIGH_TIER_TRUST_ACTOR_PREFIXES.some(prefix => normalizedActor.startsWith(prefix));
}

function normalizeNonNegativeInteger(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
}

function clampConfidence(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return Math.round(bounded * 100) / 100;
}

export function evaluateLowTierTrustDriftSuggestion(
  currentTrustLevel: TrustLevel,
  signals: TrustDriftBehaviorSignals,
): LowTierTrustDriftSuggestion | null {
  if (isHighTierTrustLevel(currentTrustLevel)) {
    return null;
  }

  const positiveInteractions = normalizeNonNegativeInteger(signals.positiveInteractionCount);
  const negativeInteractions = normalizeNonNegativeInteger(signals.negativeInteractionCount);
  const verifiedIdentityLinks = normalizeNonNegativeInteger(signals.verifiedIdentityLinks);
  const consistentBoundaryRespect = signals.consistentBoundaryRespect !== false;

  if (
    currentTrustLevel === 'public'
    && positiveInteractions >= 3
    && negativeInteractions === 0
    && verifiedIdentityLinks >= 1
    && consistentBoundaryRespect
  ) {
    return {
      fromTrustLevel: 'public',
      suggestedTrustLevel: 'regular',
      confidence: clampConfidence(
        0.6 + Math.min(0.25, positiveInteractions * 0.04) + Math.min(0.1, verifiedIdentityLinks * 0.05),
      ),
      rationale: 'Consistent positive interactions with identity corroboration support a low-tier drift to regular.',
      requiresConfirmation: true,
    };
  }

  if (
    currentTrustLevel === 'regular'
    && (negativeInteractions >= 2 || !consistentBoundaryRespect)
  ) {
    return {
      fromTrustLevel: 'regular',
      suggestedTrustLevel: 'public',
      confidence: clampConfidence(
        0.65 + Math.min(0.25, negativeInteractions * 0.08) + (consistentBoundaryRespect ? 0 : 0.1),
      ),
      rationale: 'Repeated negative or boundary-violating behavior supports a defensive low-tier drift to public.',
      requiresConfirmation: true,
    };
  }

  return null;
}

export function evaluateMemoryPolicy(ctx: PolicyContext): PolicyResult {
  const trustPolicy = getRuntimeTrustPolicy();

  // Layer 1: Operator explicit approval overrides all restrictions
  if (ctx.operatorApproval === true) {
    return {
      decision: 'allow',
      reason: 'Operator approval override',
      reasonTag: 'operator.approval_override',
      layer: 'operator',
    };
  }

  // Layer 2: Explicit disclosure boundaries — withhold / consent-required
  if (ctx.disclosureBoundary?.withhold === true) {
    return {
      decision: 'deny',
      reason: 'Memory withheld by explicit disclosure boundary',
      reasonTag: 'boundary.withhold',
      layer: 'boundary',
    };
  }
  if (ctx.disclosureBoundary?.consentRequired === true && ctx.disclosureBoundary.consentGranted !== true) {
    return {
      decision: 'deny',
      reason: 'Memory disclosure requires explicit consent',
      reasonTag: 'boundary.consent_required',
      layer: 'boundary',
    };
  }

  // Layer 3: Consent flags — explicit denial is absolute
  if (ctx.consentFlags?.allowRecall === false) {
    return {
      decision: 'deny',
      reason: 'Memory recall denied by consent flags',
      reasonTag: 'consent.allow_recall_denied',
      layer: 'consent',
    };
  }

  // Layer 4: Trust ceiling — hard structural filter
  const allowed = trustPolicy.trustCeiling[ctx.trustLevel];
  if (!allowed.includes(ctx.memorySensitivity)) {
    return {
      decision: 'deny',
      reason: `Trust level '${ctx.trustLevel}' cannot access '${ctx.memorySensitivity}' memories`,
      reasonTag: 'trust.ceiling_exceeded',
      layer: 'trust',
    };
  }

  // Layer 5: Visibility gate — channel type imposes additional restrictions
  const allowedByVisibility = trustPolicy.visibilityAllowed[ctx.channelVisibility];
  if (!allowedByVisibility.includes(ctx.memorySensitivity)) {
    return {
      decision: 'deny',
      reason: `${ctx.channelVisibility} channels restrict '${ctx.memorySensitivity}' memory access`,
      reasonTag: 'visibility.channel_restricted',
      layer: 'visibility',
    };
  }

  // Layer 6: Default — within bounds
  return {
    decision: 'allow',
    reason: 'Within trust and visibility bounds',
    reasonTag: 'default.within_bounds',
    layer: 'default',
  };
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

  if (trustPolicy.channelClassification.broadcastPrefixes.some(prefix => channelId.startsWith(prefix))) {
    return 'broadcast';
  }

  const explicitPrivacyLevel = normalizeChannelVisibility(meta?.privacyLevel);
  if (explicitPrivacyLevel !== undefined) {
    return explicitPrivacyLevel;
  }

  // Discord DMs explicitly flagged by adapter — private (honne)
  if (meta?.isDirectMessage) return 'private';

  if (trustPolicy.channelClassification.privatePrefixes.some(prefix => channelId.startsWith(prefix))) {
    return 'private';
  }

  return trustPolicy.channelClassification.defaultVisibility;
}

function resolvePrefixStyleOverride(
  channelId: string,
  prefixOverrides: Record<string, ResponseStyle>,
): ResponseStyle | undefined {
  let bestMatch: { prefix: string; style: ResponseStyle } | undefined;
  for (const [prefix, style] of Object.entries(prefixOverrides)) {
    if (!channelId.startsWith(prefix)) continue;
    if (!bestMatch || prefix.length > bestMatch.prefix.length) {
      bestMatch = { prefix, style };
    }
  }
  return bestMatch?.style;
}

function resolveChannelTypeStyleOverride(
  channelType: string,
  channelTypeOverrides: Record<string, ResponseStyle>,
): ResponseStyle | undefined {
  if (Object.prototype.hasOwnProperty.call(channelTypeOverrides, channelType)) {
    return channelTypeOverrides[channelType];
  }

  const normalized = channelType.trim().toLowerCase();
  if (!normalized) return undefined;
  for (const [key, style] of Object.entries(channelTypeOverrides)) {
    if (key.trim().toLowerCase() === normalized) return style;
  }
  return undefined;
}

export function resolveChannelResponseStyle(
  channelId: string,
  options: {
    channelType?: string;
    meta?: ChannelMeta;
    overrides?: ResponseStyleOverrides;
  } = {},
): ResponseStyle {
  const overrides = options.overrides;
  const exactOverride = overrides?.exact && Object.prototype.hasOwnProperty.call(overrides.exact, channelId)
    ? overrides.exact[channelId]
    : undefined;
  if (exactOverride) return exactOverride;

  const prefixOverride = overrides?.prefix
    ? resolvePrefixStyleOverride(channelId, overrides.prefix)
    : undefined;
  if (prefixOverride) return prefixOverride;

  const channelType = options.channelType?.trim();
  if (channelType && overrides?.channelType) {
    const byChannelType = resolveChannelTypeStyleOverride(channelType, overrides.channelType);
    if (byChannelType) return byChannelType;
  }

  const normalizedChannelType = channelType?.toLowerCase();
  const normalizedChannelId = channelId.toLowerCase();
  if (
    normalizedChannelId.startsWith('discord-voice:')
    || normalizedChannelType === 'discord_voice'
    || normalizedChannelType === 'api_voice'
    || normalizedChannelId.startsWith('api-voice:')
  ) {
    return 'concise';
  }
  if (
    normalizedChannelType === 'telegram'
    || normalizedChannelType === 'telegram_group'
    || normalizedChannelType === 'telegram_dm'
    || normalizedChannelId.startsWith('telegram:')
  ) {
    return 'concise';
  }
  if (normalizedChannelType === 'internal' || normalizedChannelId.startsWith('internal:')) {
    return 'concise';
  }

  const explicitPrivacyLevel = normalizeChannelVisibility(options.meta?.privacyLevel);
  if (explicitPrivacyLevel) {
    const visibility = classifyChannel(channelId, options.meta);
    return overrides?.defaultStyle ?? RESPONSE_STYLE_BY_VISIBILITY[visibility];
  }

  if (options.meta?.isDirectMessage) return 'expressive';

  if (normalizedChannelType === 'api' || normalizedChannelId.startsWith('api:')) {
    return 'expressive';
  }
  if (normalizedChannelType === 'discord' || normalizedChannelType === 'discord_text') {
    return 'concise';
  }
  if (
    normalizedChannelType?.includes('webui')
    || channelId.startsWith('openwebui:')
    || channelId.startsWith('webui:')
  ) {
    return 'expressive';
  }

  const visibility = classifyChannel(channelId, options.meta);
  return overrides?.defaultStyle ?? RESPONSE_STYLE_BY_VISIBILITY[visibility];
}

export function getResponseStylePromptGuidance(style: ResponseStyle): string {
  if (style === 'concise') {
    return 'Prefer concise responses: answer directly, keep wording tight, and expand only when the user asks for more detail.';
  }
  return 'Prefer expressive responses: keep your voice warm and vivid, and add personality-rich detail when it helps clarity.';
}

// ── Continuity sharing ──

export function channelsShareContinuity(sourceChannelId: string, targetChannelId: string): boolean {
  const sourceVisibility = classifyChannel(sourceChannelId);
  const targetVisibility = classifyChannel(targetChannelId);
  return visibilitiesShareContinuity(sourceVisibility, targetVisibility);
}

export function getVisibilityDisclosureCeiling(
  channelVisibility: ChannelVisibility,
): SensitivityLevel {
  const allowed = getRuntimeTrustPolicy().visibilityAllowed[channelVisibility];
  return allowed.reduce<SensitivityLevel>((ceiling, candidate) => (
    sensitivityOrd(candidate) > sensitivityOrd(ceiling) ? candidate : ceiling
  ), allowed[0] ?? 'public');
}

export function visibilitiesShareContinuity(
  sourceVisibility: ChannelVisibility,
  targetVisibility: ChannelVisibility,
): boolean {
  const trustPolicy = getRuntimeTrustPolicy();
  const sourceAllowed = trustPolicy.visibilityAllowed[sourceVisibility];
  const targetAllowed = trustPolicy.visibilityAllowed[targetVisibility];

  // Directional: source continuity can flow into target only if the target
  // allows every sensitivity the source channel may disclose.
  return sourceAllowed.every(sensitivity => targetAllowed.includes(sensitivity));
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
