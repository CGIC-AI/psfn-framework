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
  ConsentFlags,
} from './types.js';
import {
  isHighTierTrustLevel,
  sensitivityOrd,
} from './types.js';
import type { ResponseStyle, ResponseStyleOverrides } from '../../shared/contracts/runtime.js';
import { getRuntimeTrustPolicy } from './runtime-policy.js';
import type { ChannelClassificationOverride, TrustPolicyConfig } from '../config/trust-policy-config.js';
import {
  DEFAULT_CONTACT_TRACKING_MODE,
  deriveDefaultDeliveryStyle,
  normalizeChannelPrivacy,
  type ChannelDeliveryStyle,
  type ChannelEnvelopeLabel,
  type ChannelPrivacy,
  type ContextEnvelope,
  type ContactTrackingMode,
} from './context-envelope.js';
import { getRuntimeChannelEnvelopeLabels } from './runtime-channel-labels.js';

export interface ChannelMeta {
  isDirectMessage?: boolean;
  broadcastApprovalToken?: string;
  disclosureConsentGranted?: boolean;
  /**
   * Adapter-declared privacy hint (X-Channel-Privacy header, satellite
   * registry, routing metadata). E3.2: a DERIVED-DEFAULT-tier input only —
   * channel-owned labels and operator overrides always win, and per-contact
   * privacy fields must never populate this (docs/context-envelope.md).
   * E3.3: adapters declare ChannelPrivacy only; the broadcast flag is owned
   * by channel labels, operator overrides, and broadcastPrefixes.
   */
  privacyLevel?: ChannelPrivacy;
}

/**
 * The disclosure-gating slice of the Context Envelope: every re-keyed gate
 * (visibilityAllowed lookups, continuity direction, disclosure ceilings)
 * consumes this pair. A full ContextEnvelope satisfies it structurally.
 */
export type ChannelDisclosureContext = Pick<ContextEnvelope, 'channelPrivacy' | 'broadcast'>;

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

/**
 * Bare-value Context Envelope macros (E3.3). Values only — the envelope is
 * deterministic pre-prompt state and NEVER becomes privacy-reasoning prose.
 */
export function buildContextEnvelopePromptState(envelope: ContextEnvelope): Record<string, string> {
  return {
    runtime_channel_privacy: envelope.channelPrivacy,
    runtime_audience_scope: envelope.audienceScope,
    runtime_audience_knowledge: envelope.audienceKnowledge,
    runtime_broadcast: String(envelope.broadcast),
  };
}

// ── Policy evaluation ──

export type PolicyDecision = 'allow' | 'deny' | 'sanitize';
// Reason-tag mapping through the E3.3 envelope re-key:
// - 'visibility.channel_restricted' is KEPT for the channelPrivacy-keyed
//   restriction (identical semantics: the channel's structural class denies
//   the sensitivity; the reason string now cites the channelPrivacy value).
// - 'visibility.broadcast_restricted' is NEW: the old broadcast-visibility
//   denial (retired 'broadcast' ChannelVisibility row) now cites the
//   broadcast envelope dimension explicitly.
// - All other tags are unchanged.
export type PolicyReasonTag =
  | 'operator.approval_override'
  | 'boundary.withhold'
  | 'boundary.consent_required'
  | 'consent.allow_recall_denied'
  | 'trust.ceiling_exceeded'
  | 'visibility.channel_restricted'
  | 'visibility.broadcast_restricted'
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
  /** Context Envelope disclosure pair for the channel (E3.3 re-key). */
  channelPrivacy: ChannelPrivacy;
  broadcast: boolean;
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

  // Layer 5: Envelope gate — the channel's {channelPrivacy, broadcast} pair
  // imposes additional restrictions. Broadcast surfaces are always 'public'
  // by construction, so the effective row is the privacy row; the broadcast
  // flag is cited in the denial so withheld reasons name the envelope
  // dimension that gated (approval-token elevation arrives as
  // operatorApproval at layer 1 via broadcast-safety.ts).
  const allowedByEnvelope = trustPolicy.visibilityAllowed[ctx.channelPrivacy];
  if (!allowedByEnvelope.includes(ctx.memorySensitivity)) {
    if (ctx.broadcast) {
      return {
        decision: 'deny',
        reason: `broadcast (channelPrivacy '${ctx.channelPrivacy}') channels restrict '${ctx.memorySensitivity}' memory access`,
        reasonTag: 'visibility.broadcast_restricted',
        layer: 'visibility',
      };
    }
    return {
      decision: 'deny',
      reason: `channelPrivacy '${ctx.channelPrivacy}' channels restrict '${ctx.memorySensitivity}' memory access`,
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

// ── Channel classification (envelope-keyed) ──
//
// classifyChannelEnvelope resolves the {channelPrivacy, broadcast} pair per
// the Context Envelope contract precedence (docs/context-envelope.md):
//   1. channel-owned label   — channels.json contextEnvelope.channels.<id>
//   2. operator override     — trust-policy.json channelClassification
//                              visibilityOverrides (exact, then longest prefix)
//   3. derived default       — adapter-declared runtime metadata and DEMOTED
//                              prefix heuristics; isDirectMessage → private,
//                              else invite_only
// E3.3 deleted the transitional 4-value ChannelVisibility projection: the
// pair IS the classification.

export type ChannelClassificationSource = 'channel_label' | 'operator_override' | 'derived_default';

export interface ChannelEnvelopeClassification {
  privacy: ChannelPrivacy;
  broadcast: boolean;
  contactTracking: ContactTrackingMode;
  /**
   * Delivery/length style for the channel (E3.3): the channel-owned label
   * when present, else the derived default applied ONCE here
   * (deriveDefaultDeliveryStyle) so response style has no live privacy
   * coupling downstream. Delivery only — never persona/tone prose.
   */
  deliveryStyle: ChannelDeliveryStyle;
  deliveryStyleSource: 'channel_label' | 'derived_default';
  /** Which precedence tier resolved the {privacy, broadcast} pair. */
  source: ChannelClassificationSource;
  /** Migration-seeded fail-closed label awaiting operator review (never gates). */
  needsReview: boolean;
}

function resolvePrefixVisibilityOverride(
  channelId: string,
  prefixOverrides: Record<string, ChannelClassificationOverride>,
): ChannelClassificationOverride | undefined {
  let bestMatch: { prefix: string; override: ChannelClassificationOverride } | undefined;
  for (const [prefix, override] of Object.entries(prefixOverrides)) {
    if (!channelId.startsWith(prefix)) continue;
    if (!bestMatch || prefix.length > bestMatch.prefix.length) {
      bestMatch = { prefix, override };
    }
  }
  return bestMatch?.override;
}

/**
 * Pure envelope classification over explicit inputs. classifyChannelEnvelope
 * wraps this with the runtime label/policy accessors; Garden and maintenance
 * surfaces call it directly against freshly loaded owner files.
 */
export function resolveChannelEnvelopeClassification(
  channelId: string,
  meta: ChannelMeta | undefined,
  inputs: {
    label?: ChannelEnvelopeLabel;
    trustPolicy: TrustPolicyConfig;
  },
): ChannelEnvelopeClassification {
  const { label, trustPolicy } = inputs;
  const contactTracking = label?.contactTracking ?? DEFAULT_CONTACT_TRACKING_MODE;
  const needsReview = label?.needsReview === true;

  const finalize = (
    pair: { privacy: ChannelPrivacy; broadcast: boolean },
    source: ChannelClassificationSource,
  ): ChannelEnvelopeClassification => ({
    ...pair,
    contactTracking,
    // Delivery style is resolved ONCE at classification: channel-owned label
    // wins; otherwise the derived default of the FINAL pair applies. This is
    // the only remaining privacy→style linkage (a derived default), per the
    // delivery-guidance rule in docs/context-envelope.md.
    deliveryStyle: label?.deliveryStyle
      ?? deriveDefaultDeliveryStyle({ channelPrivacy: pair.privacy, broadcast: pair.broadcast }),
    deliveryStyleSource: label?.deliveryStyle ? 'channel_label' : 'derived_default',
    source,
    needsReview,
  });

  // ── Tier 1: channel-owned label (channels.json contextEnvelope) ──
  if (label?.broadcast === true) {
    // Contract: a broadcast surface is always channelPrivacy 'public'.
    // (Labels pairing broadcast=true with a non-public privacy are rejected
    // fail-closed at validation.)
    return finalize({ privacy: 'public', broadcast: true }, 'channel_label');
  }
  if (label?.privacy !== undefined) {
    return finalize({ privacy: label.privacy, broadcast: false }, 'channel_label');
  }
  // A label carrying broadcast=false (without privacy) pins the flag while the
  // privacy value falls through to the next tiers — channel ownership of the
  // broadcast flag stays highest-precedence.
  const broadcastPinnedFalse = label?.broadcast === false;
  const applyPin = (pair: { privacy: ChannelPrivacy; broadcast: boolean }): {
    privacy: ChannelPrivacy;
    broadcast: boolean;
  } => ({
    privacy: broadcastPinnedFalse && pair.broadcast ? 'public' : pair.privacy,
    broadcast: broadcastPinnedFalse ? false : pair.broadcast,
  });

  // ── Tier 2: operator trust-policy overrides (exact, then longest prefix) ──
  const visibilityOverrides = trustPolicy.channelClassification.visibilityOverrides;
  const exactOverride = Object.prototype.hasOwnProperty.call(visibilityOverrides.exact, channelId)
    ? visibilityOverrides.exact[channelId]
    : undefined;
  if (exactOverride !== undefined) {
    return finalize(applyPin(exactOverride), 'operator_override');
  }
  const prefixOverride = resolvePrefixVisibilityOverride(channelId, visibilityOverrides.prefix);
  if (prefixOverride !== undefined) {
    return finalize(applyPin(prefixOverride), 'operator_override');
  }

  // ── Tier 3: derived default ──
  // broadcastPrefixes / privatePrefixes are DEMOTED heuristics (E3.2): they
  // are seed data for channel-owned records (npm run migrate:channel-envelope)
  // and survive here only as derived-default inputs for channels that have no
  // owned label yet. Adapter-declared metadata (X-Channel-Privacy, satellite
  // registry, routing channelPrivacy → ChannelMeta.privacyLevel) and the DM
  // flag are runtime observations, not operator policy, so they also live in
  // this tier. Relative order is preserved from the pre-envelope hierarchy so
  // unlabeled channels classify byte-identically.
  const derived = (pair: { privacy: ChannelPrivacy; broadcast: boolean }): ChannelEnvelopeClassification =>
    finalize(applyPin(pair), 'derived_default');

  if (trustPolicy.channelClassification.broadcastPrefixes.some(prefix => channelId.startsWith(prefix))) {
    return derived({ privacy: 'public', broadcast: true });
  }

  const explicitPrivacyLevel = normalizeChannelPrivacy(meta?.privacyLevel);
  if (explicitPrivacyLevel !== undefined) {
    return derived({ privacy: explicitPrivacyLevel, broadcast: false });
  }

  // Direct messages explicitly flagged by adapter — private (honne)
  if (meta?.isDirectMessage) {
    return derived({ privacy: 'private', broadcast: false });
  }

  if (trustPolicy.channelClassification.privatePrefixes.some(prefix => channelId.startsWith(prefix))) {
    return derived({ privacy: 'private', broadcast: false });
  }

  return derived({ privacy: trustPolicy.channelClassification.defaultVisibility, broadcast: false });
}

export function classifyChannelEnvelope(
  channelId: string,
  meta?: ChannelMeta,
): ChannelEnvelopeClassification {
  return resolveChannelEnvelopeClassification(channelId, meta, {
    label: getRuntimeChannelEnvelopeLabels()[channelId],
    trustPolicy: getRuntimeTrustPolicy(),
  });
}

/** The disclosure pair for a channel, as consumed by the re-keyed gates. */
export function classifyChannelDisclosure(
  channelId: string,
  meta?: ChannelMeta,
): ChannelDisclosureContext {
  const classification = classifyChannelEnvelope(channelId, meta);
  return { channelPrivacy: classification.privacy, broadcast: classification.broadcast };
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

/**
 * Response style resolution (E3.3: decoupled from privacy).
 *
 * Precedence:
 *   1. Operator response-style overrides (exact, prefix, channelType).
 *   2. Channel-owned deliveryStyle label (channels.json contextEnvelope).
 *   3. Channel-type heuristics (voice/telegram/internal/api/discord/webui),
 *      unchanged from the pre-envelope behavior.
 *   4. overrides.defaultStyle, else the classification's derived-default
 *      deliveryStyle (deriveDefaultDeliveryStyle, applied once at
 *      classification — the retired RESPONSE_STYLE_BY_VISIBILITY mapping
 *      survives only as that derived default).
 *
 * Style is delivery/length guidance only; persona and tone prose remain
 * forbidden substrate content (charter rule).
 */
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

  const classification = classifyChannelEnvelope(channelId, options.meta);
  if (classification.deliveryStyleSource === 'channel_label') {
    return classification.deliveryStyle;
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

  if (normalizeChannelPrivacy(options.meta?.privacyLevel)) {
    return overrides?.defaultStyle ?? classification.deliveryStyle;
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

  return overrides?.defaultStyle ?? classification.deliveryStyle;
}

export function getResponseStylePromptGuidance(style: ResponseStyle): string {
  if (style === 'concise') {
    return 'Prefer concise responses: answer directly, keep wording tight, and expand only when the user asks for more detail.';
  }
  return 'Prefer expressive responses: keep your voice warm and vivid, and add personality-rich detail when it helps clarity.';
}

// ── Continuity sharing ──
// The re-keyed gates consume the envelope {channelPrivacy, broadcast} pair.
// A broadcast surface is always 'public', so its allowed-sensitivity row IS
// the public row (docs/context-envelope.md) — the flag adds the published-
// artifact property (approval tokens, broadcast-safety), never a wider row.

function envelopeAllowedSensitivities(
  context: ChannelDisclosureContext,
): readonly SensitivityLevel[] {
  return getRuntimeTrustPolicy().visibilityAllowed[context.channelPrivacy];
}

export function channelsShareContinuity(sourceChannelId: string, targetChannelId: string): boolean {
  return visibilitiesShareContinuity(
    classifyChannelDisclosure(sourceChannelId),
    classifyChannelDisclosure(targetChannelId),
  );
}

export function getVisibilityDisclosureCeiling(
  context: ChannelDisclosureContext,
): SensitivityLevel {
  const allowed = envelopeAllowedSensitivities(context);
  return allowed.reduce<SensitivityLevel>((ceiling, candidate) => (
    sensitivityOrd(candidate) > sensitivityOrd(ceiling) ? candidate : ceiling
  ), allowed[0] ?? 'public');
}

export function visibilitiesShareContinuity(
  source: ChannelDisclosureContext,
  target: ChannelDisclosureContext,
): boolean {
  const sourceAllowed = envelopeAllowedSensitivities(source);
  const targetAllowed = envelopeAllowedSensitivities(target);

  // Directional: source continuity can flow into target only if the target
  // allows every sensitivity the source channel may disclose.
  return sourceAllowed.every(sensitivity => targetAllowed.includes(sensitivity));
}

// ── Allowed sensitivities for a context ──

export function getAllowedSensitivities(
  trustLevel: TrustLevel,
  context: ChannelDisclosureContext,
): SensitivityLevel[] {
  const trustPolicy = getRuntimeTrustPolicy();
  const trustAllowed = trustPolicy.trustCeiling[trustLevel];
  const envelopeAllowed = envelopeAllowedSensitivities(context);

  return trustAllowed.filter(sensitivity => envelopeAllowed.includes(sensitivity)) as SensitivityLevel[];
}
