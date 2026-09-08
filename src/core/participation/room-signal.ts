import type {
  MessageAuthorRoomRole,
  MessageAuthorSourceClass,
} from '../../shared/contracts/message-addressing.js';
import type { RoomSignalSettings } from '../../system/config/participation-config.js';
import type { RoomObservation } from './room-observation.js';
import type {
  ParticipationCandidateTrigger,
  ParticipationSuppressionReason,
} from './types.js';

/**
 * The channel-neutral room signal (jp36.5.6, bible §8.1/§8.4).
 *
 * Stage 1 of the staged hot path. Given one {@link RoomObservation} it derives
 * the connector-independent facts a participation decision needs — ONCE per
 * physical message — and then answers, per eligible companion, a deterministic
 * ignore/nominate question over public and reviewed room-safe metadata only.
 *
 * Three properties are load-bearing and separately tested:
 *
 * 1. **Once per physical message.** {@link RoomMessageFeatureExtractor} memoizes
 *    derived features by `(roomId, messageId)`, so fanning one room line out to
 *    several companion matchers never recomputes them and never re-classifies.
 * 2. **Content-free fan-out.** {@link RoomNomination} — the only thing that
 *    leaves this module toward a companion or a diagnostic — carries ids,
 *    counters, booleans, and bounded reason codes. Room text, aliases,
 *    interests, and biography never appear on it.
 * 3. **Deterministic first, and terminating.** Gates decide without a model. If
 *    they genuinely cannot, the outcome is `ambiguous`, which is resolved by at
 *    most one shared cheap classifier evaluation for the whole physical message
 *    — and, when no claim authority is available, by SUPPRESSION. Ambiguity is
 *    never a route to default participation.
 *
 * A companion-local matcher reads reviewed room-safe roles, interests, and
 * responsibilities ({@link RoomCompanionProfile}). It never loads raw biography
 * or private memories, and nothing here can make the companion speak: an
 * eligible nomination still traverses the bounded appraiser, the reservation
 * phase, CogSec, fatigue, and the egress lease.
 */

const ROOM_SIGNAL_SCHEMA_VERSION = 1 as const;

/** How the reviewed alias vocabulary appears in one room line. */
type RoomAliasCue =
  /** No reviewed alias occurs at all. */
  | 'none'
  /** A reviewed alias occurs somewhere in the line. */
  | 'mention'
  /** The line opens by addressing a reviewed alias. */
  | 'leading_address';

/**
 * Connector-independent facts derived once per physical room message.
 * Content-free: lengths, counters, booleans, and reviewed coarse tags only.
 */
export interface RoomMessageFeatures {
  schemaVersion: typeof ROOM_SIGNAL_SCHEMA_VERSION;
  roomId: string;
  messageId: string;
  timestampMs: number;
  connector: RoomObservation['connector'];
  roomVerified: boolean;
  authorIsMachine: boolean;
  authorIsObserver: boolean;
  authorSourceClass: MessageAuthorSourceClass;
  authorRoomRole: MessageAuthorRoomRole;
  addressedByMention: boolean;
  addressedByReply: boolean;
  contentLength: number;
  /** Reviewed coarse domain/topic tags this line matched. */
  topicTags: readonly string[];
  /** Messages observed in this room inside the trailing velocity window. */
  roomVelocity: number;
}

/**
 * The reviewed, room-safe part of a companion's self-description. Owner-curated
 * tag lists, never prose, never private memory: the matcher can say "this room
 * line is about something I am responsible for" without loading a biography.
 */
export interface RoomCompanionProfile {
  companionId: string;
  /** Reviewed aliases this companion answers to in rooms. */
  aliases: readonly string[];
  /** Reviewed interest/responsibility tags, matched against `topicTags`. */
  interests: readonly string[];
}

/** The bounded, content-free thing that reaches an eligible companion. */
export interface RoomNomination {
  schemaVersion: typeof ROOM_SIGNAL_SCHEMA_VERSION;
  companionId: string;
  roomId: string;
  messageId: string;
  timestampMs: number;
  connector: RoomObservation['connector'];
  trigger: ParticipationCandidateTrigger;
  /** Bounded deterministic reason codes; never text, aliases, or interests. */
  reasonCodes: readonly RoomSignalReasonCode[];
  /** Whether a shared classifier evaluation was consumed for this message. */
  classifierConsulted: boolean;
}

/** Bounded content-free reason codes recorded on every staged decision. */
export type RoomSignalReasonCode =
  | 'connector_mention'
  | 'connector_reply'
  | 'alias_leading_address'
  | 'alias_mention'
  | 'topic_match'
  | 'trusted_source_class'
  | 'trusted_room_role'
  | 'classifier_relevant';

export type RoomSignalEligibility =
  | { outcome: 'eligible'; trigger: ParticipationCandidateTrigger; reasonCodes: RoomSignalReasonCode[] }
  | { outcome: 'ineligible'; suppression: ParticipationSuppressionReason }
  /** Deterministic gates admit the author but cannot judge relevance. */
  | { outcome: 'ambiguous'; reasonCodes: RoomSignalReasonCode[] };

/**
 * Per-physical-message feature extraction with a bounded memo. The memo is what
 * makes "normalize and classify one physical message once" true for every
 * companion matcher this process fans out to; the room-velocity ring is the
 * deterministic large/flooding-room gate input.
 */
export class RoomMessageFeatureExtractor {
  private readonly settings: RoomSignalSettings;
  private readonly features = new Map<string, RoomMessageFeatures>();
  private readonly featureOrder: string[] = [];
  private readonly roomActivity = new Map<string, number[]>();

  constructor(options: { settings: RoomSignalSettings }) {
    this.settings = options.settings;
  }

  /**
   * Derive (or replay) the features for one physical message. Repeat calls for
   * the same `(roomId, messageId)` return the identical record without
   * recomputing anything and without advancing the velocity ring, so a redelivery
   * or a second companion matcher costs one map lookup.
   */
  extract(observation: RoomObservation): RoomMessageFeatures {
    const key = featureKey(observation.roomId, observation.messageId);
    const cached = this.features.get(key);
    if (cached) return cached;

    const features: RoomMessageFeatures = {
      schemaVersion: ROOM_SIGNAL_SCHEMA_VERSION,
      roomId: observation.roomId,
      messageId: observation.messageId,
      timestampMs: observation.timestampMs,
      connector: observation.connector,
      roomVerified: observation.roomVerified,
      authorIsMachine: observation.author.isMachine,
      authorIsObserver: observation.author.isObserver,
      authorSourceClass: observation.author.sourceClass,
      authorRoomRole: observation.author.roomRole,
      addressedByMention: observation.addressedByMention,
      addressedByReply: observation.addressedByReply,
      contentLength: observation.content.trim().length,
      topicTags: matchTopicTags(observation.content, this.settings.topicTags),
      roomVelocity: this.recordActivity(observation),
    };
    this.remember(key, features);
    return features;
  }

  /** Whether this physical message has already been derived in this process. */
  has(roomId: string, messageId: string): boolean {
    return this.features.has(featureKey(roomId, messageId));
  }

  private recordActivity(observation: RoomObservation): number {
    const window = this.settings.velocityWindowMs;
    const timestamps = this.roomActivity.get(observation.roomId) ?? [];
    const floor = observation.timestampMs - window;
    const live = timestamps.filter(timestamp => timestamp > floor);
    live.push(observation.timestampMs);
    // The ring is bounded by the same cap the feature memo uses, so a flooding
    // room cannot grow memory without bound.
    while (live.length > this.settings.featureCacheSize) live.shift();
    this.roomActivity.set(observation.roomId, live);
    return live.length;
  }

  private remember(key: string, features: RoomMessageFeatures): void {
    this.features.set(key, features);
    this.featureOrder.push(key);
    while (this.featureOrder.length > this.settings.featureCacheSize) {
      const evicted = this.featureOrder.shift();
      if (evicted !== undefined) this.features.delete(evicted);
    }
  }
}

/**
 * The deterministic per-companion eligibility gate. Pure, model-free, and
 * ordered so the cheapest fail-closed checks run first:
 *
 * verified room → not my own message → direct address (connector-authoritative,
 * then reviewed alias) → owner-approved trust class or room role → room velocity
 * → reviewed topic relevance. Only a message that survives every one of those
 * and still has no relevance evidence is reported `ambiguous`.
 */
export function evaluateRoomSignalEligibility(input: {
  features: RoomMessageFeatures;
  /** Normalized room text, used ONLY for the local reviewed-alias match. */
  normalizedContent: string;
  profile: RoomCompanionProfile;
  settings: RoomSignalSettings;
}): RoomSignalEligibility {
  const { features, profile, settings } = input;
  if (!settings.enabled) {
    return { outcome: 'ineligible', suppression: 'disabled' };
  }
  if (!features.roomVerified) {
    // An unverified room is never a participation surface (fail closed).
    return { outcome: 'ineligible', suppression: 'room_unverified' };
  }
  if (features.authorIsObserver) {
    return { outcome: 'ineligible', suppression: 'own_message' };
  }

  const reasonCodes: RoomSignalReasonCode[] = [];
  if (features.addressedByMention) reasonCodes.push('connector_mention');
  if (features.addressedByReply) reasonCodes.push('connector_reply');
  const aliasCue = matchAliasCue(input.normalizedContent, profile.aliases);
  if (aliasCue === 'leading_address') reasonCodes.push('alias_leading_address');
  else if (aliasCue === 'mention') reasonCodes.push('alias_mention');

  const directlyAddressed = features.addressedByMention
    || features.addressedByReply
    || aliasCue === 'leading_address';
  if (directlyAddressed) {
    // A direct address is admitted regardless of trust class, room size, or
    // velocity: being spoken to is not ambient chatter. Owner autonomy policy
    // and every downstream gate still apply.
    return { outcome: 'eligible', trigger: 'direct_mention', reasonCodes };
  }

  // Everything below is contextual participation in someone else's
  // conversation, so it must clear the owner-approved admission bar first.
  const trustedClass = settings.contextualEligibleSourceClasses
    .includes(features.authorSourceClass);
  const trustedRole = settings.contextualEligibleRoomRoles.includes(features.authorRoomRole);
  if (!trustedClass && !trustedRole) {
    // Unknown or untrusted room members stay direct-address-only.
    return { outcome: 'ineligible', suppression: 'untrusted_room_member' };
  }
  reasonCodes.push(trustedClass ? 'trusted_source_class' : 'trusted_room_role');

  if (features.roomVelocity > settings.maxRoomVelocity) {
    // A flooding room does not get contextual participation on top of it.
    return { outcome: 'ineligible', suppression: 'room_velocity' };
  }

  if (aliasCue === 'mention') {
    return { outcome: 'eligible', trigger: 'passive_name', reasonCodes };
  }
  if (sharesTag(features.topicTags, profile.interests)) {
    reasonCodes.push('topic_match');
    return { outcome: 'eligible', trigger: 'contextual_continuation', reasonCodes };
  }
  if (features.topicTags.length === 0 && profile.interests.length > 0) {
    // The reviewed tag vocabulary produced nothing to compare, so the
    // deterministic gates genuinely cannot decide relevance.
    return { outcome: 'ambiguous', reasonCodes };
  }
  return { outcome: 'ineligible', suppression: 'topic_mismatch' };
}

/** Build the bounded, content-free nomination handed to one companion. */
export function toRoomNomination(input: {
  features: RoomMessageFeatures;
  companionId: string;
  trigger: ParticipationCandidateTrigger;
  reasonCodes: readonly RoomSignalReasonCode[];
  classifierConsulted: boolean;
}): RoomNomination {
  return {
    schemaVersion: ROOM_SIGNAL_SCHEMA_VERSION,
    companionId: input.companionId,
    roomId: input.features.roomId,
    messageId: input.features.messageId,
    timestampMs: input.features.timestampMs,
    connector: input.features.connector,
    trigger: input.trigger,
    reasonCodes: [...input.reasonCodes],
    classifierConsulted: input.classifierConsulted,
  };
}

/**
 * The cheap bounded ambiguity classifier. It sees only what a content-minimal
 * relevance question needs and answers one boolean; it is never a
 * response-capable model call and never speaks.
 */
export interface RoomAmbiguityClassifierPort {
  classify(input: {
    roomId: string;
    messageId: string;
    /** Bounded, truncated room text — the only content this stage may see. */
    excerpt: string;
    /** Reviewed room-safe tags to judge relevance against. */
    interests: readonly string[];
  }): Promise<{ relevant: boolean }>;
}

/**
 * Claim authority for "this physical message's classification is mine to run".
 * A single-companion runtime can satisfy this in process; a fleet needs a
 * durable claim so two companion processes cannot both classify one room line.
 */
export interface RoomClassificationClaimPort {
  /** Returns true for exactly one caller per `(roomId, messageId)`. */
  claim(input: { roomId: string; messageId: string }): Promise<boolean>;
}

/**
 * At-most-one classifier evaluation per physical message.
 *
 * Every ambiguous evaluation for one `(roomId, messageId)` shares a single
 * in-flight promise, and the underlying classifier runs only for the caller that
 * won the claim. Without a claim authority the classifier never runs at all and
 * ambiguity resolves to suppression — the fail-closed posture a fleet runtime
 * keeps until the durable claim lands.
 */
export class SharedRoomClassifier {
  private readonly classifier: RoomAmbiguityClassifierPort;
  private readonly claims: RoomClassificationClaimPort;
  private readonly settings: RoomSignalSettings;
  private readonly inFlight = new Map<string, Promise<RoomClassificationOutcome>>();
  private readonly order: string[] = [];

  constructor(options: {
    classifier: RoomAmbiguityClassifierPort;
    claims: RoomClassificationClaimPort;
    settings: RoomSignalSettings;
  }) {
    this.classifier = options.classifier;
    this.claims = options.claims;
    this.settings = options.settings;
  }

  async resolve(input: {
    features: RoomMessageFeatures;
    /** Room text; truncated to the owner-owned excerpt cap before any call. */
    content: string;
    interests: readonly string[];
  }): Promise<RoomClassificationOutcome> {
    if (!this.settings.classifier.enabled) {
      return { outcome: 'unavailable' };
    }
    const key = featureKey(input.features.roomId, input.features.messageId);
    const existing = this.inFlight.get(key);
    if (existing) return await existing;

    const pending = this.evaluate(key, input);
    this.inFlight.set(key, pending);
    this.order.push(key);
    while (this.order.length > this.settings.featureCacheSize) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.inFlight.delete(evicted);
    }
    return await pending;
  }

  private async evaluate(
    key: string,
    input: {
      features: RoomMessageFeatures;
      content: string;
      interests: readonly string[];
    },
  ): Promise<RoomClassificationOutcome> {
    const claimed = await this.claims.claim({
      roomId: input.features.roomId,
      messageId: input.features.messageId,
    });
    if (!claimed) {
      // Another observer owns this message's classification. Losing the claim
      // is a suppression, never a silent admission.
      this.inFlight.delete(key);
      return { outcome: 'unavailable' };
    }
    const verdict = await this.classifier.classify({
      roomId: input.features.roomId,
      messageId: input.features.messageId,
      excerpt: input.content.slice(0, this.settings.classifier.excerptChars),
      interests: input.interests,
    });
    return verdict.relevant ? { outcome: 'relevant' } : { outcome: 'not_relevant' };
  }
}

export type RoomClassificationOutcome =
  | { outcome: 'relevant' }
  | { outcome: 'not_relevant' }
  /** Disabled, unclaimable, or otherwise not runnable — resolves to suppression. */
  | { outcome: 'unavailable' };

/** Normalize room text once, for reviewed-alias matching only. */
export function normalizeRoomContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim();
}

function featureKey(roomId: string, messageId: string): string {
  return `${roomId}\0${messageId}`;
}

function matchAliasCue(
  normalizedContent: string,
  aliases: readonly string[],
): RoomAliasCue {
  let cue: RoomAliasCue = 'none';
  for (const alias of aliases) {
    const normalized = normalizeRoomContent(alias);
    if (!normalized) continue;
    if (normalizedContent === normalized || normalizedContent.startsWith(`${normalized} `)) {
      return 'leading_address';
    }
    if (cue === 'none' && hasWholeWord(normalizedContent, normalized)) cue = 'mention';
  }
  return cue;
}

function matchTopicTags(
  content: string,
  topicTags: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  const normalized = normalizeRoomContent(content);
  const matched: string[] = [];
  for (const [tag, keywords] of Object.entries(topicTags)) {
    if (keywords.some(keyword => hasWholeWord(normalized, normalizeRoomContent(keyword)))) {
      matched.push(tag);
    }
  }
  return matched;
}

function sharesTag(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some(tag => rightSet.has(tag));
}

function hasWholeWord(normalizedContent: string, word: string): boolean {
  if (!word) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(word)}([^\\p{L}\\p{N}]|$)`, 'u')
    .test(normalizedContent);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
