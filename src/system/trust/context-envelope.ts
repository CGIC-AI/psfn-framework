// ── Context Envelope (E3.1 contract layer) ──
// Canonical vocabulary for "who can hear this" — the multi-dimensional
// replacement for the retired single-axis ChannelVisibility model.
//
// Contract doc: docs/context-envelope.md (operator-review surface).
//
// Dimensions:
//   channelPrivacy    — structural access to the room ('private' | 'invite_only' | 'public')
//   audienceScope     — how many can hear ('one' | 'few' | 'many' | 'unbounded')
//   audienceKnowledge — how resolvable the audience is ('all_known' | 'partially_known' | 'anonymous')
//   broadcast         — tweet-like / very-large public surface flag (keeps the
//                       existing approval-token machinery; no longer a privacy level)
//
// Trust (4 tiers) and sensitivity (4 levels) are referenced, NOT redefined —
// the pre-envelope gap was missing dimensions, not missing granularity.
//
// This module is the canonical envelope vocabulary: pure types, guards,
// config validation, and derivation helpers. E3.2 wired the
// channels.json/trust-policy.json owners into classification; E3.3 attached
// the envelope to ConversationScope and re-keyed the policy gates onto
// { channelPrivacy, broadcast }. The transitional single-axis
// ChannelVisibility type is deleted; only the persisted-data read decoder
// (decodeStoredChannelVisibility in ./types.ts) still understands the retired
// stored vocabulary.

// ── channelPrivacy ──

/**
 * Structural privacy of a channel. Replaces ChannelVisibility:
 * 'semi_private' was renamed to 'invite_only' (no alias) and 'broadcast'
 * stops being a privacy level — it becomes the boolean flag below.
 */
export type ChannelPrivacy = 'private' | 'invite_only' | 'public';

export const CHANNEL_PRIVACY_VALUES: readonly ChannelPrivacy[] = ['private', 'invite_only', 'public'];

/** Derived default when no channel-owned label or operator override exists. */
export const DEFAULT_CHANNEL_PRIVACY: ChannelPrivacy = 'invite_only';

export function isChannelPrivacy(value: unknown): value is ChannelPrivacy {
  return typeof value === 'string' && (CHANNEL_PRIVACY_VALUES as readonly string[]).includes(value);
}

export function normalizeChannelPrivacy(value: unknown): ChannelPrivacy | undefined {
  return isChannelPrivacy(value) ? value : undefined;
}

/**
 * Derived-default rule (lowest precedence layer of the privacy contract):
 * direct messages are private; everything else is invite_only.
 */
export function deriveDefaultChannelPrivacy(input: { isDirectMessage?: boolean }): ChannelPrivacy {
  return input.isDirectMessage === true ? 'private' : DEFAULT_CHANNEL_PRIVACY;
}

// ── audienceScope ──

export type AudienceScope = 'one' | 'few' | 'many' | 'unbounded';

export const AUDIENCE_SCOPE_VALUES: readonly AudienceScope[] = ['one', 'few', 'many', 'unbounded'];

export function isAudienceScope(value: unknown): value is AudienceScope {
  return typeof value === 'string' && (AUDIENCE_SCOPE_VALUES as readonly string[]).includes(value);
}

/**
 * Config-owned audience thresholds (trust-policy.json `audienceScopeThresholds`).
 * 'few' covers rosters up to fewMax; 'many' covers rosters up to manyMax;
 * anything larger — or any roster the runtime cannot bound — is 'unbounded'.
 */
export interface AudienceScopeThresholds {
  readonly fewMax: number;
  readonly manyMax: number;
}

export const DEFAULT_AUDIENCE_SCOPE_THRESHOLDS: AudienceScopeThresholds = {
  fewMax: 10,
  manyMax: 100,
};

export function validateAudienceScopeThresholds(raw: unknown, field: string): AudienceScopeThresholds {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid audience thresholds: ${field} must be an object`);
  }
  const source = raw as Record<string, unknown>;
  const fewMax = source.fewMax;
  const manyMax = source.manyMax;
  if (typeof fewMax !== 'number' || !Number.isInteger(fewMax) || fewMax < 1) {
    throw new Error(`Invalid audience thresholds: ${field}.fewMax must be an integer >= 1`);
  }
  if (typeof manyMax !== 'number' || !Number.isInteger(manyMax) || manyMax <= fewMax) {
    throw new Error(`Invalid audience thresholds: ${field}.manyMax must be an integer > fewMax`);
  }
  const unknownKeys = Object.keys(source).filter(key => key !== 'fewMax' && key !== 'manyMax');
  if (unknownKeys.length > 0) {
    throw new Error(`Invalid audience thresholds: ${field} has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  return { fewMax, manyMax };
}

/**
 * Derivation rule: channel topology + known-roster size → audienceScope.
 * Fail closed: a group whose roster the runtime cannot bound is 'unbounded'.
 */
export function deriveAudienceScope(
  input: {
    topology: 'direct' | 'group';
    /** Bounded roster size when the channel adapter can enumerate members. */
    knownRosterSize?: number;
  },
  thresholds: AudienceScopeThresholds,
): AudienceScope {
  if (input.topology === 'direct') return 'one';
  const size = input.knownRosterSize;
  if (size === undefined) return 'unbounded';
  if (!Number.isInteger(size) || size < 0) {
    throw new Error('deriveAudienceScope: knownRosterSize must be a non-negative integer when present');
  }
  if (size <= thresholds.fewMax) return 'few';
  if (size <= thresholds.manyMax) return 'many';
  return 'unbounded';
}

// ── audienceKnowledge ──

export type AudienceKnowledge = 'all_known' | 'partially_known' | 'anonymous';

export const AUDIENCE_KNOWLEDGE_VALUES: readonly AudienceKnowledge[] = [
  'all_known',
  'partially_known',
  'anonymous',
];

export function isAudienceKnowledge(value: unknown): value is AudienceKnowledge {
  return typeof value === 'string' && (AUDIENCE_KNOWLEDGE_VALUES as readonly string[]).includes(value);
}

/**
 * Derivation rule: fraction of recent speakers resolvable to contacts.
 * Fail closed: an empty speaker window is 'anonymous', never 'all_known'.
 */
export function deriveAudienceKnowledge(input: {
  recentSpeakerCount: number;
  resolvedContactCount: number;
}): AudienceKnowledge {
  const { recentSpeakerCount, resolvedContactCount } = input;
  if (!Number.isInteger(recentSpeakerCount) || recentSpeakerCount < 0) {
    throw new Error('deriveAudienceKnowledge: recentSpeakerCount must be a non-negative integer');
  }
  if (!Number.isInteger(resolvedContactCount) || resolvedContactCount < 0) {
    throw new Error('deriveAudienceKnowledge: resolvedContactCount must be a non-negative integer');
  }
  if (resolvedContactCount > recentSpeakerCount) {
    throw new Error('deriveAudienceKnowledge: resolvedContactCount cannot exceed recentSpeakerCount');
  }
  if (recentSpeakerCount === 0) return 'anonymous';
  if (resolvedContactCount === recentSpeakerCount) return 'all_known';
  if (resolvedContactCount > 0) return 'partially_known';
  return 'anonymous';
}

// ── deliveryStyle ──

/**
 * Channel-owned delivery/length style (charter delivery-guidance rule):
 * length/delivery knobs only — never persona or tone prose. E3.3 decouples
 * response style from privacy: a channels.json label may pin the style, and
 * the retired privacy→style mapping survives only as the derived default
 * applied once at classification (deriveDefaultDeliveryStyle).
 */
export type ChannelDeliveryStyle = 'concise' | 'expressive';

export const CHANNEL_DELIVERY_STYLES: readonly ChannelDeliveryStyle[] = ['concise', 'expressive'];

export function isChannelDeliveryStyle(value: unknown): value is ChannelDeliveryStyle {
  return typeof value === 'string' && (CHANNEL_DELIVERY_STYLES as readonly string[]).includes(value);
}

/**
 * Derived-default delivery style for a classified channel. This is the ONLY
 * place the retired privacy→style coupling survives, applied once at
 * classification so unlabeled channels keep their pre-E3.3 behavior
 * (private → expressive; everything else, including broadcast surfaces,
 * → concise). Channel-owned labels and operator response-style overrides
 * always win over this default.
 */
export function deriveDefaultDeliveryStyle(pair: {
  channelPrivacy: ChannelPrivacy;
  broadcast: boolean;
}): ChannelDeliveryStyle {
  return pair.channelPrivacy === 'private' && !pair.broadcast ? 'expressive' : 'concise';
}

// ── contactTracking ──

/**
 * Per-channel contact-tracking mode (channels.json).
 * 'role_gated' is reserved vocabulary: it validates as config, but any code
 * path asked to OPERATE in role_gated mode must fail closed until the
 * large-audience epic implements it.
 */
export type ContactTrackingMode = 'auto' | 'approval' | 'role_gated';

export const CONTACT_TRACKING_MODES: readonly ContactTrackingMode[] = ['auto', 'approval', 'role_gated'];

export const DEFAULT_CONTACT_TRACKING_MODE: ContactTrackingMode = 'auto';

export function isContactTrackingMode(value: unknown): value is ContactTrackingMode {
  return typeof value === 'string' && (CONTACT_TRACKING_MODES as readonly string[]).includes(value);
}

/**
 * Fail-closed use gate for reserved modes. Config validation accepts
 * 'role_gated'; runtime activation must call this and let it throw.
 */
export function assertContactTrackingModeImplemented(mode: ContactTrackingMode): void {
  if (mode === 'role_gated') {
    throw new Error(
      "contactTracking mode 'role_gated' is reserved and not implemented; "
      + "configure 'auto' or 'approval' until role gating ships",
    );
  }
}

// ── The envelope ──

/**
 * The Context Envelope: the full pre-prompt, deterministic description of the
 * disclosure surface for one conversational context. Policy decisions consume
 * the envelope PLUS the unchanged TrustLevel / SensitivityLevel references —
 * no privacy prose ever enters prompts.
 */
export interface ContextEnvelope {
  readonly channelPrivacy: ChannelPrivacy;
  readonly audienceScope: AudienceScope;
  readonly audienceKnowledge: AudienceKnowledge;
  readonly broadcast: boolean;
}

export function isContextEnvelope(value: unknown): value is ContextEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return isChannelPrivacy(source.channelPrivacy)
    && isAudienceScope(source.audienceScope)
    && isAudienceKnowledge(source.audienceKnowledge)
    && typeof source.broadcast === 'boolean';
}

/**
 * ConversationScope attachment seam (executed in E3.3).
 *
 * ConversationScope (src/core/session/conversation-scope.ts) carries
 * `readonly envelope: ContextEnvelope`, resolved once per turn at
 * session-manager ingress alongside the scope itself.
 */
export interface ContextEnvelopeCarrier {
  readonly envelope: ContextEnvelope;
}

/**
 * Full envelope derivation at scope-resolution time (E3.3).
 *
 * Inputs are the interim derivation sources the contract names
 * (docs/context-envelope.md): channel classification ({channelPrivacy,
 * broadcast} from classifyChannelEnvelope), conversation topology
 * (dm → audienceScope 'one'), the recent-speaker window, and contact
 * resolvability of that window.
 *
 * Fail-closed rules:
 * - group audienceKnowledge with an unknown/empty resolvability input is
 *   'anonymous', never 'all_known';
 * - dm audienceKnowledge is 'all_known' only when the DM partner is a
 *   genuinely resolved contact (dmContactResolved), else derived from the
 *   window (empty window → 'anonymous').
 */
export function deriveScopeContextEnvelope(input: {
  classification: { channelPrivacy: ChannelPrivacy; broadcast: boolean };
  kind: 'dm' | 'group';
  /** True when the DM partner resolved to a genuine canonical contact. */
  dmContactResolved?: boolean;
  recentSpeakerCount: number;
  /** Recent speakers resolvable to contacts; absent fails closed to 0. */
  resolvedSpeakerContactCount?: number;
  /** Bounded roster hint when the channel adapter can enumerate members. */
  memberCountHint?: number;
  thresholds: AudienceScopeThresholds;
}): ContextEnvelope {
  const { classification, thresholds } = input;
  if (input.kind === 'dm') {
    return {
      channelPrivacy: classification.channelPrivacy,
      broadcast: classification.broadcast,
      audienceScope: 'one',
      audienceKnowledge: input.dmContactResolved === true
        ? 'all_known'
        : deriveAudienceKnowledge({
          recentSpeakerCount: input.recentSpeakerCount,
          resolvedContactCount: Math.min(
            input.resolvedSpeakerContactCount ?? 0,
            input.recentSpeakerCount,
          ),
        }),
    };
  }
  // Interim roster bound: memberCountHint when the adapter supplied one, else
  // the distinct recent-speaker count. E4.1 seam: the ContactChannelActivity
  // room-roster query slots in here as the knownRosterSize source.
  const knownRosterSize = input.memberCountHint ?? input.recentSpeakerCount;
  return {
    channelPrivacy: classification.channelPrivacy,
    broadcast: classification.broadcast,
    audienceScope: deriveAudienceScope({ topology: 'group', knownRosterSize }, thresholds),
    audienceKnowledge: deriveAudienceKnowledge({
      recentSpeakerCount: input.recentSpeakerCount,
      resolvedContactCount: Math.min(
        input.resolvedSpeakerContactCount ?? 0,
        input.recentSpeakerCount,
      ),
    }),
  };
}

// ── Per-channel owner-file labels (channels.json `contextEnvelope.channels`) ──

/**
 * Channel-owned envelope label. Highest-precedence source for channelPrivacy:
 *   channel-owned label > operator trust-policy override > derived default.
 * All fields optional; omitted fields fall through to the next precedence layer.
 *
 * `needsReview` (E3.2) marks a label seeded by the one-time channel-envelope
 * migration for a channel whose classification could not be derived
 * unambiguously: it received the fail-closed default (invite_only) and the
 * flag keeps it visible (Garden warning badge + migration report line) until
 * the operator confirms or corrects it. The flag never changes gating.
 */
export interface ChannelEnvelopeLabel {
  readonly privacy?: ChannelPrivacy;
  readonly broadcast?: boolean;
  readonly contactTracking?: ContactTrackingMode;
  /**
   * Channel-owned delivery/length style (E3.3). Absent means the derived
   * default applies (deriveDefaultDeliveryStyle). Delivery only — persona and
   * tone prose remain forbidden substrate content (charter rule).
   */
  readonly deliveryStyle?: ChannelDeliveryStyle;
  readonly needsReview?: boolean;
}

export function validateChannelEnvelopeLabel(raw: unknown, field: string): ChannelEnvelopeLabel {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid channel envelope label: ${field} must be an object`);
  }
  const source = raw as Record<string, unknown>;
  const supportedKeys = ['privacy', 'broadcast', 'contactTracking', 'deliveryStyle', 'needsReview'];
  const unknownKeys = Object.keys(source).filter(key => !supportedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Invalid channel envelope label: ${field} has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (Object.keys(source).length === 0) {
    throw new Error(`Invalid channel envelope label: ${field} must define at least one field`);
  }

  const label: {
    privacy?: ChannelPrivacy;
    broadcast?: boolean;
    contactTracking?: ContactTrackingMode;
    deliveryStyle?: ChannelDeliveryStyle;
    needsReview?: boolean;
  } = {};

  if (source.privacy !== undefined) {
    if (!isChannelPrivacy(source.privacy)) {
      throw new Error(
        `Invalid channel envelope label: ${field}.privacy must be one of: ${CHANNEL_PRIVACY_VALUES.join(', ')}`,
      );
    }
    label.privacy = source.privacy;
  }
  if (source.broadcast !== undefined) {
    if (typeof source.broadcast !== 'boolean') {
      throw new Error(`Invalid channel envelope label: ${field}.broadcast must be a boolean`);
    }
    label.broadcast = source.broadcast;
  }
  if (source.contactTracking !== undefined) {
    if (!isContactTrackingMode(source.contactTracking)) {
      throw new Error(
        `Invalid channel envelope label: ${field}.contactTracking must be one of: ${CONTACT_TRACKING_MODES.join(', ')}`,
      );
    }
    label.contactTracking = source.contactTracking;
  }
  if (source.deliveryStyle !== undefined) {
    if (!isChannelDeliveryStyle(source.deliveryStyle)) {
      throw new Error(
        `Invalid channel envelope label: ${field}.deliveryStyle must be one of: ${CHANNEL_DELIVERY_STYLES.join(', ')}`,
      );
    }
    label.deliveryStyle = source.deliveryStyle;
  }
  if (source.needsReview !== undefined) {
    if (typeof source.needsReview !== 'boolean') {
      throw new Error(`Invalid channel envelope label: ${field}.needsReview must be a boolean`);
    }
    label.needsReview = source.needsReview;
  }
  // Contract rule (docs/context-envelope.md): a broadcast surface is always
  // channelPrivacy 'public'. Reject contradictory labels fail-closed.
  if (label.broadcast === true && label.privacy !== undefined && label.privacy !== 'public') {
    throw new Error(
      `Invalid channel envelope label: ${field} sets broadcast=true with privacy '${label.privacy}'; `
      + "a broadcast surface is always 'public'",
    );
  }
  return label;
}

// ── Migration map: retired ChannelVisibility vocabulary → envelope pair ──

/**
 * Retired single-axis visibility vocabulary as it may still appear in
 * PERSISTED data and pre-E3.3 owner files. This union exists ONLY for the
 * read/migration boundary (decodeStoredChannelVisibility, the trust-policy
 * load migration, and the one-time channel-envelope migration command).
 * Runtime code never produces these values; 'broadcast' is a flag and
 * 'semi_private' was renamed to 'invite_only'.
 */
export type LegacyChannelVisibility = 'private' | 'invite_only' | 'public' | 'broadcast';

/**
 * Documented migration map from the retired single-axis visibility model to
 * the envelope's {channelPrivacy, broadcast} pair. The semi_private →
 * invite_only leg was executed in E3.1 as a pure vocabulary rename; the
 * broadcast → (public + broadcast flag) leg was executed at classification
 * inputs in E3.2 and completed at the gates in E3.3 (the ChannelVisibility
 * type itself is deleted).
 *
 *   private      → { channelPrivacy: 'private',     broadcast: false }
 *   invite_only  → { channelPrivacy: 'invite_only', broadcast: false }  (was semi_private)
 *   public       → { channelPrivacy: 'public',      broadcast: false }
 *   broadcast    → { channelPrivacy: 'public',      broadcast: true  }
 */
export const CHANNEL_VISIBILITY_ENVELOPE_MIGRATION: Record<
  LegacyChannelVisibility,
  { channelPrivacy: ChannelPrivacy; broadcast: boolean }
> = {
  private: { channelPrivacy: 'private', broadcast: false },
  invite_only: { channelPrivacy: 'invite_only', broadcast: false },
  public: { channelPrivacy: 'public', broadcast: false },
  broadcast: { channelPrivacy: 'public', broadcast: true },
};
