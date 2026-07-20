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

import type { ChannelPrivacy } from '../../shared/contracts/trust-contracts.js';

// ── channelPrivacy ──

/**
 * Structural privacy of a channel. Replaces ChannelVisibility:
 * 'semi_private' was renamed to 'invite_only' (no alias) and 'broadcast'
 * stops being a privacy level — it becomes the boolean flag below.
 */
export type { ChannelPrivacy } from '../../shared/contracts/trust-contracts.js';

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

/**
 * Minimum edge confidence for a social-relationship edge to be eligible for
 * compact participant-relationship exposure in conversation_state (E4.4). Edges
 * below this bar are never rendered. Config-owned in trust-policy.json; the
 * documented default applies when absent.
 */
export const DEFAULT_PARTICIPANT_RELATIONSHIP_CONFIDENCE_THRESHOLD = 0.7;

export function validateParticipantRelationshipConfidenceThreshold(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new Error(`Invalid trust policy: ${field} must be a number between 0 and 1`);
  }
  return raw;
}

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
 *
 * `classificationSource: 'operator_confirmed'` (jp36.6) records that an
 * operator explicitly confirmed/adjusted this room's {privacy, broadcast}
 * classification — the invite-only → public click-to-accept demotion flow
 * (jp36.6.2). It upgrades the resolved envelope source from the default
 * `channel_label` to `operator_confirmed` (see ChannelClassificationSource in
 * policy.ts) so downstream policy and Garden can distinguish a derived default
 * from an operator DECISION for audit (design bible §9.3). It is a provenance
 * refinement of the tier-1 channel label, never a new precedence tier, and is
 * meaningful only paired with a tier-1 classification (a `privacy` value or
 * `broadcast: true`); a bare confirmation is rejected fail-closed below.
 */
export const CHANNEL_LABEL_CLASSIFICATION_SOURCES = ['operator_confirmed'] as const;
export type ChannelLabelClassificationSource = (typeof CHANNEL_LABEL_CLASSIFICATION_SOURCES)[number];

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
  /**
   * Operator-decision provenance for the label's classification (jp36.6).
   * Only `'operator_confirmed'` is persistable; the other envelope sources
   * (`channel_label`, `operator_override`, `derived_default`) are computed at
   * resolution time and never written to a label.
   */
  readonly classificationSource?: ChannelLabelClassificationSource;
}

export function validateChannelEnvelopeLabel(raw: unknown, field: string): ChannelEnvelopeLabel {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid channel envelope label: ${field} must be an object`);
  }
  const source = raw as Record<string, unknown>;
  const supportedKeys = [
    'privacy',
    'broadcast',
    'contactTracking',
    'deliveryStyle',
    'needsReview',
    'classificationSource',
  ];
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
    classificationSource?: ChannelLabelClassificationSource;
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
  if (source.classificationSource !== undefined) {
    if (
      typeof source.classificationSource !== 'string'
      || !(CHANNEL_LABEL_CLASSIFICATION_SOURCES as readonly string[]).includes(source.classificationSource)
    ) {
      throw new Error(
        `Invalid channel envelope label: ${field}.classificationSource must be one of: `
        + CHANNEL_LABEL_CLASSIFICATION_SOURCES.join(', '),
      );
    }
    label.classificationSource = source.classificationSource as ChannelLabelClassificationSource;
  }
  // Contract rule (docs/context-envelope.md): a broadcast surface is always
  // channelPrivacy 'public'. Reject contradictory labels fail-closed.
  if (label.broadcast === true && label.privacy !== undefined && label.privacy !== 'public') {
    throw new Error(
      `Invalid channel envelope label: ${field} sets broadcast=true with privacy '${label.privacy}'; `
      + "a broadcast surface is always 'public'",
    );
  }
  // Room-classification epochs (jp36.6): `operator_confirmed` records a
  // confirmed {privacy, broadcast} classification. It only resolves at tier 1,
  // so it is meaningless — and rejected fail-closed — unless the label also
  // pins that classification (a `privacy` value or `broadcast: true`). Without
  // one, the pair would fall through to an operator override or a derived
  // default, where the confirmation marker would be silently dropped.
  if (
    label.classificationSource === 'operator_confirmed'
    && label.privacy === undefined
    && label.broadcast !== true
  ) {
    throw new Error(
      `Invalid channel envelope label: ${field} sets classificationSource 'operator_confirmed' `
      + "without a tier-1 classification; pair it with a 'privacy' value or 'broadcast: true'",
    );
  }
  return label;
}

// ── Room classification epochs (jp36.6): invite-only → public demotion ──

/**
 * Version of the click-to-accept demotion notice the operator must acknowledge.
 * Bump when the notice copy changes so an epoch record proves WHICH notice text
 * the operator accepted. The demotion flow (jp36.6.2) rejects an acceptance
 * whose acknowledged version does not match this constant (fail closed).
 */
export const DEMOTION_EPOCH_NOTICE_VERSION = '2026-07-19.1';

/**
 * Click-to-accept notice for the invite-only → public classification demotion
 * (design bible §9.3 / §18 / settled decision #37). The bible specifies the
 * REQUIRED CONTENT, not literal copy; this is the ratified wording drafted from
 * that spec. All four statements are load-bearing:
 *  1. prior derived/shared-eligible room material can no longer be auto-shared
 *     at the new (public) level because trust/privacy gates now apply;
 *  2. accepting starts a FRESH disclosure epoch for this channel;
 *  3. prior material remains reachable ONLY through human-in-the-loop egress
 *     review — it is not retroactively declassified;
 *  4. only content generated AFTER acceptance is public-eligible.
 */
export const DEMOTION_EPOCH_NOTICE = [
  'Demoting this room from invite-only to public starts a fresh disclosure epoch.',
  'Derived and shared-eligible material generated in this room under the invite-only '
    + 'ceiling can no longer be auto-shared with the room at the public level, because '
    + 'trust and privacy gates now apply at that level.',
  'Everything generated under the old ceiling keeps that ceiling: prior material remains '
    + 'reachable only through human-in-the-loop egress review and is not retroactively '
    + 'declassified.',
  'Only content generated after you accept is public-eligible.',
].join(' ');

/**
 * An operator-signed classification-epoch boundary. Written ONLY by the Garden
 * click-to-accept demotion flow (jp36.6.2) atomically with the confirmed label,
 * and it is the operator-signed record that authorizes a label's
 * `classificationSource: 'operator_confirmed'` (parseContextEnvelopeSection
 * fail-closes any confirmed label lacking a matching epoch). Downstream epoch
 * enforcement (jp36.6.3) reads `at` as the disclosure-epoch boundary: material
 * generated before `at` keeps the old (invite-only) ceiling; only content after
 * `at` is public-eligible.
 */
export interface ChannelClassificationEpoch {
  readonly channelId: string;
  /** Classification before the demotion. Only invite_only → public is valid. */
  readonly from: 'invite_only';
  readonly to: 'public';
  /** ISO-8601 timestamp of the epoch boundary (acceptance instant). */
  readonly at: string;
  /** Operator actor that accepted the notice (audit attribution). */
  readonly acceptedBy: string;
  /** Notice version the operator acknowledged (must be a known version). */
  readonly noticeVersion: string;
}

const CHANNEL_CLASSIFICATION_EPOCH_KEYS = [
  'channelId',
  'from',
  'to',
  'at',
  'acceptedBy',
  'noticeVersion',
] as const;

/** Notice versions accepted on load. Add historical versions here, never remove. */
export const KNOWN_DEMOTION_EPOCH_NOTICE_VERSIONS = [DEMOTION_EPOCH_NOTICE_VERSION] as const;

/**
 * Fail-closed validator for one persisted classification-epoch record. Only the
 * invite_only → public demotion is a legal epoch boundary (widening a public
 * room does not exist and narrowing tightens forward only without an epoch).
 */
export function validateChannelClassificationEpoch(raw: unknown, field: string): ChannelClassificationEpoch {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid classification epoch: ${field} must be an object`);
  }
  const source = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(source).filter(
    key => !(CHANNEL_CLASSIFICATION_EPOCH_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`Invalid classification epoch: ${field} has unsupported keys: ${unknownKeys.join(', ')}`);
  }

  const channelId = typeof source.channelId === 'string' ? source.channelId.trim() : '';
  if (!channelId) {
    throw new Error(`Invalid classification epoch: ${field}.channelId must be a non-empty string`);
  }
  if (source.from !== 'invite_only') {
    throw new Error(`Invalid classification epoch: ${field}.from must be 'invite_only' (only invite-only → public epochs exist)`);
  }
  if (source.to !== 'public') {
    throw new Error(`Invalid classification epoch: ${field}.to must be 'public' (only invite-only → public epochs exist)`);
  }
  if (typeof source.at !== 'string' || Number.isNaN(Date.parse(source.at))) {
    throw new Error(`Invalid classification epoch: ${field}.at must be an ISO-8601 timestamp`);
  }
  if (typeof source.acceptedBy !== 'string' || source.acceptedBy.trim() === '') {
    throw new Error(`Invalid classification epoch: ${field}.acceptedBy must be a non-empty string`);
  }
  if (
    typeof source.noticeVersion !== 'string'
    || !(KNOWN_DEMOTION_EPOCH_NOTICE_VERSIONS as readonly string[]).includes(source.noticeVersion)
  ) {
    throw new Error(
      `Invalid classification epoch: ${field}.noticeVersion must be one of: `
      + KNOWN_DEMOTION_EPOCH_NOTICE_VERSIONS.join(', '),
    );
  }
  return {
    channelId,
    from: 'invite_only',
    to: 'public',
    at: source.at,
    acceptedBy: source.acceptedBy,
    noticeVersion: source.noticeVersion,
  };
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
