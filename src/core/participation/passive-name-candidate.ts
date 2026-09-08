import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SessionEntry } from '../session/types.js';
import type { NearTurnMemoryScopeClassifierPort } from '../../faculties/memory/near-turn-memory-lane.js';
import { detectCompanionNameMatch } from '../../faculties/memory/extraction/group-salience.js';
import {
  autonomyLevelPermitsDirected,
  autonomyLevelPermitsPassiveName,
  createDefaultPassiveNameCandidateSettings,
  type ParticipationAutonomyLevel,
  type PassiveNameCandidateSettings,
} from '../../system/config/participation-config.js';
import type {
  ParticipationCandidate,
  ParticipationCandidateTrigger,
  ParticipationContextMessage,
  ParticipationSuppressionReason,
  PassiveNameCandidateDecision,
} from './types.js';
import type { RoomParticipationContinuationOutcome } from './room-participation-lease-coordinator.js';
import {
  normalizeRoomObservation,
  toRoomParticipationObservation,
  type RoomObservation,
} from './room-observation.js';
import {
  evaluateRoomSignalEligibility,
  toRoomNomination,
  type RoomCompanionProfile,
  type RoomMessageFeatureExtractor,
  type RoomMessageFeatures,
  type RoomNomination,
  type RoomSignalReasonCode,
  type SharedRoomClassifier,
} from './room-signal.js';
import type { RoomSignalSettings } from '../../system/config/participation-config.js';
import type { BiographicalAliasResolver } from '../../faculties/memory/biographical/alias-address.js';
import { resolveIdentityChannel } from '../agent/substrate-agent/runtime-context.js';

/**
 * Deterministic passive-name participation candidate gate (free-time social
 * autonomy, bible §8.1). Given an observed room message it either creates one
 * `ParticipationCandidate` or reports a single deterministic suppression reason.
 *
 * Reuse mandate (adjudication S5/R3): this gate does NOT add a second
 * name-detection or group/direct classification path. Companion-name detection
 * reuses `detectCompanionNameMatch` from the group-salience machinery, and
 * group-vs-direct scope reuses the canonical
 * `ObservedGroupMemoryScheduler.classifyChannelMemoryScope` classifier via the
 * `NearTurnMemoryScopeClassifierPort` seam.
 *
 * Name-spam debounce (jp36.3.2.2, bible §8.1 / adjudication S7.3): once a
 * name-triggered candidate is emitted in a channel, further name-triggers in
 * that same channel are suppressed with reason `debounced` until the per-channel
 * window (`debounceWindowMs`, default ~10 minutes) expires. Repeated
 * name-triggering — one sender or several coordinating — therefore collapses to
 * at most one appraisal chain per room per window, deterministically and
 * pre-model. The window is per-channel: spam in one room never silences another.
 *
 * Contextual continuation (jp36.5.5): when the message carries NO name match,
 * and only then, this gate consults the bounded durable room-participation
 * lease. In a room where the companion already holds membership, an ordinary
 * follow-up that never repeats the name may still become a
 * `contextual_continuation` candidate carrying the same bounded transcript. The
 * lease decision is deterministic and pre-model: with no lease the message stays
 * observation/context only and costs nothing but a durable read. Continuations
 * deliberately bypass neither the autonomy ladder, the staleness guard, nor
 * source-message dedup; they DO bypass the name-spam debounce window, which
 * exists to collapse repeated *summoning*, and they never open one.
 *
 * Out of scope here (see sibling beads): the cheap appraiser (jp36.3.3) and the
 * speaking arbiter (jp36.5). This gate only decides whether a candidate exists.
 */

/** Preceding-context source: reuses the session store's `getRecent`. */
export interface ParticipationContextReader {
  getRecent(
    channelId: string,
    limit: number,
  ): SessionEntry[] | Promise<SessionEntry[]>;
}

/**
 * The bounded room-participation lease seam (jp36.5.5). Optional: a runtime
 * without durable leases keeps the pre-continuation behavior exactly.
 */
export interface RoomParticipationContinuationPort {
  admitContinuation(input: {
    channelId: string;
    observation: {
      messageId: string;
      timestampMs: number;
      authorIsMachine: boolean;
      contentLength: number;
    };
  }): Promise<RoomParticipationContinuationOutcome>;
}

export interface PassiveNameCandidateBuilderOptions {
  scopeClassifier: NearTurnMemoryScopeClassifierPort;
  contextReader: ParticipationContextReader;
  companionNames: readonly string[];
  companionAuthorIds: readonly string[];
  settings?: PassiveNameCandidateSettings;
  /** Durable room-participation lease gate; absent runtimes never continue. */
  roomParticipationLease?: RoomParticipationContinuationPort;
  /**
   * Channel-neutral room signal (jp36.5.6). Present only when owner policy
   * enables it; absent runtimes keep the pre-signal behavior exactly.
   */
  roomSignal?: RoomSignalRuntime;
  /**
   * Reviewed relationship-scoped biography aliases (o61vb.17). Optional: a
   * runtime without it behaves exactly as before, and a speaker with no bound
   * aliases is indistinguishable from that. Consulted ONLY after the canonical
   * name detector and the connector's own addressing have both come up empty,
   * so an already-matched or plainly ambient message costs no extra read.
   */
  aliasResolver?: BiographicalAliasResolver;
  nowMs?: () => number;
}

/**
 * The room-signal stage this gate composes: the once-per-physical-message
 * feature extractor, the reviewed room-safe companion profile the local matcher
 * may read, the owner admission policy, and the optional shared classifier that
 * resolves ambiguity at most once per message.
 */
export interface RoomSignalRuntime {
  extractor: RoomMessageFeatureExtractor;
  profile: RoomCompanionProfile;
  settings: RoomSignalSettings;
  classifier?: SharedRoomClassifier;
  /** Content-free sink for the bounded nomination and its reason codes. */
  onNomination?: (nomination: RoomNomination) => void;
}

/**
 * The staged room-signal verdict carried between the deterministic gates and
 * the optional shared classifier. `ambiguous` retains the room text so the ONE
 * bounded classifier call can be made later, after membership is confirmed; it
 * never leaves this module.
 */
type RoomSignalStage =
  | { status: 'absent' }
  | { status: 'suppressed'; reason: ParticipationSuppressionReason }
  | {
    status: 'eligible';
    runtime: RoomSignalRuntime;
    features: RoomMessageFeatures;
    reasonCodes: readonly RoomSignalReasonCode[];
  }
  | {
    status: 'ambiguous';
    runtime: RoomSignalRuntime;
    features: RoomMessageFeatures;
    content: string;
    reasonCodes: readonly RoomSignalReasonCode[];
  };

/** The same-cluster inter-companion lane; ICP owns its own consent moment. */
const ICP_CHANNEL_TYPE = 'companion';

interface ChannelDedupeState {
  order: string[];
  seen: Set<string>;
  /**
   * Exclusive expiry (`nowMs`-scale) of the active name-spam debounce window;
   * `0` when no window is open. A name-trigger observed while `nowMs() <
   * debounceUntilMs` is suppressed as `debounced`.
   */
  debounceUntilMs: number;
}

export class PassiveNameCandidateBuilder {
  private readonly scopeClassifier: NearTurnMemoryScopeClassifierPort;
  private readonly contextReader: ParticipationContextReader;
  private readonly companionNames: readonly string[];
  private readonly companionAuthorIds: readonly string[];
  private readonly settings: PassiveNameCandidateSettings;
  private readonly roomParticipationLease: RoomParticipationContinuationPort | undefined;
  private readonly roomSignal: RoomSignalRuntime | undefined;
  private readonly aliasResolver: BiographicalAliasResolver | undefined;
  private readonly nowMs: () => number;
  private readonly dedupeByChannel = new Map<string, ChannelDedupeState>();

  constructor(options: PassiveNameCandidateBuilderOptions) {
    this.scopeClassifier = options.scopeClassifier;
    this.contextReader = options.contextReader;
    this.companionNames = options.companionNames;
    this.companionAuthorIds = options.companionAuthorIds;
    this.settings = options.settings ?? createDefaultPassiveNameCandidateSettings();
    this.roomParticipationLease = options.roomParticipationLease;
    this.roomSignal = options.roomSignal;
    this.aliasResolver = options.aliasResolver;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async build(message: SubstrateMessage): Promise<PassiveNameCandidateDecision> {
    if (!this.settings.enabled) {
      return this.suppress(message, 'disabled');
    }

    // 0. Channel-neutral normalization (jp36.5.6). Every gate below reads this
    // instead of transport-specific fields, so one policy covers every
    // connector. Pure and model-free: an ambient line that never becomes a
    // candidate costs exactly this.
    const normalized = normalizeRoomObservation(message);
    const observation = normalized.status === 'observed' ? normalized.observation : null;

    // 1. Never react to the companion's own messages. The connector's own
    // observer identity answers this on every transport; the configured author
    // ids stay as the fallback for connectors with no addressing envelope.
    if (
      this.companionAuthorIds.includes(message.authorId)
      || observation?.author.isObserver === true
    ) {
      return this.suppress(message, 'own_message');
    }

    // 2. ICP inter-companion lane already has its own consent moment (§7 R6.1).
    if (message.channelType === ICP_CHANNEL_TYPE) {
      return this.suppress(message, 'icp_lane');
    }

    // 3. Direct/private messages are never group rooms.
    if (message.isDirectMessage === true) {
      return this.suppress(message, 'direct_message');
    }

    // 4. Group rooms only — reuse the canonical direct-vs-group classifier.
    const scope = await this.scopeClassifier.classifyChannelMemoryScope({
      channelId: message.channelId,
      channelType: message.channelType,
    });
    if (scope !== 'group') {
      return this.suppress(message, 'not_group');
    }

    // 5. Companion-name detection — reuse the group-salience name detector for
    // the textual cue, and the connector's own validated addressee resolution
    // for the authoritative one. A platform mention or a reply to this
    // companion is a direct address on EVERY connector, even when the body
    // never names it; prose alone can no longer be the only way in.
    let match = detectCompanionNameMatch(message.content, {
      companionNames: this.companionNames,
      companionAuthorIds: this.companionAuthorIds,
    });
    const connectorAddressed = observation !== null
      && (observation.addressedByMention || observation.addressedByReply);
    // 5b. Relationship-scoped biography aliases (o61vb.17). A reviewed nickname
    // the speaker actually uses is a cheap deterministic address cue, so it
    // reruns the SAME canonical detector with that speaker's alias list rather
    // than adding a second matcher. Resolution happens only when nothing has
    // matched yet, and an unrelated speaker resolves to nothing — so a private
    // term of address is never revealed by the fact that it failed to match.
    if (
      !match.mentioned && !match.directAddress && !connectorAddressed
      && this.aliasResolver !== undefined && observation !== null
    ) {
      const aliases = await this.aliasResolver.resolve({
        // The same canonical identity-channel resolution every other
        // contact lookup uses; a raw channelType would miss the satellite,
        // voice and terminal mappings and silently resolve nobody.
        source: resolveIdentityChannel(message),
        transportParticipantId: observation.author.authorId,
      });
      const admitted = aliases.filter(
        alias => alias.trim().length >= this.settings.aliasMinLength,
      );
      if (admitted.length > 0) {
        match = detectCompanionNameMatch(message.content, {
          companionNames: this.companionNames,
          companionAuthorIds: this.companionAuthorIds,
          speakerAliases: admitted,
        });
      }
    }
    const matchedName = match.mentioned || connectorAddressed;
    const matchedDirectAddress = match.directAddress || connectorAddressed;
    const nameMatched = matchedName || matchedDirectAddress;
    if (!nameMatched && !this.roomParticipationLease) {
      return this.suppress(message, 'no_name_match');
    }
    const trigger: ParticipationCandidateTrigger = matchedDirectAddress
      ? 'direct_mention'
      : matchedName
        ? 'passive_name'
        : 'contextual_continuation';

    // 6. Autonomy ladder gate (§8.4). A contextual continuation is contextual
    // participation, so it needs exactly what a passive-name summons needs.
    const level = this.resolveAutonomyLevel(message.channelId);
    const permitted = trigger === 'direct_mention'
      ? autonomyLevelPermitsDirected(level)
      : autonomyLevelPermitsPassiveName(level);
    if (!permitted) {
      return nameMatched
        ? this.suppress(message, 'autonomy_disabled', trigger)
        : this.suppress(message, 'no_name_match');
    }

    // 7. Staleness guard — never resurrect long-delayed observed mentions.
    const triggerTimestampMs = message.timestamp.getTime();
    if (
      Number.isFinite(triggerTimestampMs)
      && this.nowMs() - triggerTimestampMs > this.settings.stalenessMs
    ) {
      return this.suppress(message, 'stale', trigger);
    }

    // 8. One candidate per source message (dedup across redeliveries).
    if (this.hasSeen(message.channelId, message.id)) {
      return this.suppress(message, 'duplicate', trigger);
    }

    // 9. Name-spam debounce window (§8.1 / adjudication S7.3). A candidate
    // emitted earlier in this channel opens a per-channel ignore window; every
    // distinct name-trigger landing inside it collapses to `debounced`, so
    // repeated summoning — one sender or several coordinating — yields at most
    // one appraisal chain per room per window. Deterministic and pre-model.
    const now = this.nowMs();
    if (nameMatched && this.isDebounced(message.channelId, now)) {
      return this.suppress(message, 'debounced', trigger);
    }

    // 10. Contextual continuation (jp36.5.5). Only a name-free message reaches
    // this branch, and only the deterministic lease gate may admit it. `absent`
    // — no membership in this room — is reported as the ordinary `no_name_match`
    // suppression this gate has always produced, so a room the companion is not
    // taking part in is telemetry-identical to the pre-lease behavior and costs
    // no model call. The gate's own durable claim is what makes the message
    // considered, so it can never be considered twice.
    //
    // The room signal's deterministic gates (jp36.5.6) run FIRST and can only
    // refuse: an unverified room, an untrusted member, a flooding room, or an
    // irrelevant topic all stop here without any durable read and without any
    // model call. Membership itself remains the lease's question, so one
    // physical message can still be considered only once.
    const signal = this.evaluateRoomSignal(observation);
    if (signal.status === 'suppressed') {
      return this.suppress(message, signal.reason, trigger);
    }
    if (!nameMatched) {
      const admission = await this.admitContinuation(message, observation);
      if (admission.outcome === 'absent') {
        return this.suppress(message, 'no_name_match');
      }
      if (admission.outcome === 'suppressed') {
        return this.suppress(message, admission.suppression, trigger);
      }
    }
    // Only a message that survived every deterministic gate AND holds
    // membership may spend the shared ambiguity classifier, so a room this
    // companion is not taking part in never costs one.
    const resolved = await this.resolveRoomSignalAmbiguity(signal, trigger);
    if (resolved.status === 'suppressed') {
      return this.suppress(message, resolved.reason, trigger);
    }

    this.markSeen(message.channelId, message.id);
    // The debounce window collapses repeated *summoning*; a continuation neither
    // opens one nor is silenced by one.
    if (nameMatched) {
      this.openDebounceWindow(message.channelId, now);
    }

    const precedingContext = await this.loadPrecedingContext(message, triggerTimestampMs);
    const candidate: ParticipationCandidate = {
      schemaVersion: 1,
      channelId: message.channelId,
      channelType: message.channelType,
      sourceMessageId: message.id,
      trigger,
      triggerAuthorId: message.authorId,
      triggerAuthorIsMachine: message.routing?.authorIsMachineIntelligence === true,
      triggerAuthorName: message.authorName,
      triggerContent: message.content,
      triggerTimestampMs,
      matchedName,
      matchedDirectAddress,
      precedingContext,
      createdAtMs: now,
    };
    return { status: 'created', candidate };
  }

  /**
   * Consult the durable room-participation lease for one name-free room message.
   * Content-free by construction: the gate sees ids, a timestamp, whether the
   * author is a machine (the bot-loop fence), and the message LENGTH — never the
   * message itself.
   */
  private async admitContinuation(
    message: SubstrateMessage,
    observation: RoomObservation | null,
  ): Promise<RoomParticipationContinuationOutcome> {
    const lease = this.roomParticipationLease;
    if (!lease) {
      return { outcome: 'absent' };
    }
    return await lease.admitContinuation({
      channelId: message.channelId,
      // jp36.5.6 closes the jp36.5.5 seam: the lease gate now consumes the
      // channel-neutral observation's own projection rather than reaching into
      // Discord-shaped routing fields.
      observation: observation
        ? toRoomParticipationObservation(observation)
        : {
          messageId: message.id,
          timestampMs: message.timestamp.getTime(),
          authorIsMachine: message.routing?.authorIsMachineIntelligence === true,
          contentLength: message.content.trim().length,
        },
    });
  }

  /**
   * Deterministic room-signal admission (jp36.5.6). Absent runtime, absent
   * observation, or a directly-addressed line all pass straight through; the
   * gate can only ever refuse or record a bounded content-free nomination.
   */
  private evaluateRoomSignal(observation: RoomObservation | null): RoomSignalStage {
    const runtime = this.roomSignal;
    if (!runtime || !observation) return { status: 'absent' };
    const features = runtime.extractor.extract(observation);
    const eligibility = evaluateRoomSignalEligibility({
      features,
      // vprcm: the canonical detector owns normalization and the authoritative
      // `<@id>` cue, so the raw line and this companion's own connector ids go
      // in exactly as they do for the group-salience match above.
      content: observation.content,
      companionAuthorIds: this.companionAuthorIds,
      profile: runtime.profile,
      settings: runtime.settings,
    });
    if (eligibility.outcome === 'ineligible') {
      return { status: 'suppressed', reason: eligibility.suppression };
    }
    if (eligibility.outcome === 'ambiguous') {
      return {
        status: 'ambiguous',
        runtime,
        features,
        content: observation.content,
        reasonCodes: eligibility.reasonCodes,
      };
    }
    return {
      status: 'eligible',
      runtime,
      features,
      reasonCodes: eligibility.reasonCodes,
    };
  }

  /**
   * Resolve a deterministic stalemate with at most ONE cheap bounded evaluation
   * for this physical message, shared across every companion that reached this
   * point. No classifier, or no claim authority, means no evaluation and no
   * participation: ambiguity is never a route to default speech.
   */
  private async resolveRoomSignalAmbiguity(
    signal: RoomSignalStage,
    trigger: ParticipationCandidateTrigger,
  ): Promise<
    { status: 'admitted' }
    | { status: 'suppressed'; reason: ParticipationSuppressionReason }
  > {
    if (signal.status === 'absent') return { status: 'admitted' };
    if (signal.status === 'suppressed') return signal;
    if (signal.status === 'eligible') {
      this.recordNomination(signal.runtime, signal.features, trigger, signal.reasonCodes, false);
      return { status: 'admitted' };
    }
    const verdict = await signal.runtime.classifier?.resolve({
      features: signal.features,
      content: signal.content,
      interests: signal.runtime.profile.interests,
    });
    if (!verdict || verdict.outcome !== 'relevant') {
      return { status: 'suppressed', reason: 'room_signal_ambiguous' };
    }
    this.recordNomination(
      signal.runtime,
      signal.features,
      trigger,
      [...signal.reasonCodes, 'classifier_relevant'],
      true,
    );
    return { status: 'admitted' };
  }

  private recordNomination(
    runtime: RoomSignalRuntime,
    features: RoomMessageFeatures,
    trigger: ParticipationCandidateTrigger,
    reasonCodes: readonly RoomSignalReasonCode[],
    classifierConsulted: boolean,
  ): void {
    runtime.onNomination?.(toRoomNomination({
      features,
      companionId: runtime.profile.companionId,
      trigger,
      reasonCodes,
      classifierConsulted,
    }));
  }

  private suppress(
    message: Pick<SubstrateMessage, 'channelId' | 'id'>,
    reason: Extract<PassiveNameCandidateDecision, { status: 'suppressed' }>['reason'],
    trigger?: ParticipationCandidateTrigger,
  ): PassiveNameCandidateDecision {
    return {
      status: 'suppressed',
      reason,
      channelId: message.channelId,
      sourceMessageId: message.id,
      ...(trigger ? { trigger } : {}),
    };
  }

  private resolveAutonomyLevel(channelId: string): ParticipationAutonomyLevel {
    return this.settings.channelAutonomyLevels[channelId]
      ?? this.settings.defaultAutonomyLevel;
  }

  private getOrCreateState(channelId: string): ChannelDedupeState {
    let state = this.dedupeByChannel.get(channelId);
    if (!state) {
      state = { order: [], seen: new Set(), debounceUntilMs: 0 };
      this.dedupeByChannel.set(channelId, state);
    }
    return state;
  }

  private hasSeen(channelId: string, sourceMessageId: string): boolean {
    return this.dedupeByChannel.get(channelId)?.seen.has(sourceMessageId) ?? false;
  }

  /**
   * Whether an open name-spam debounce window is currently suppressing this
   * channel. Per-channel (isolated across rooms); `nowMs` is passed in so a
   * single build pass evaluates the window and stamps the candidate against one
   * clock reading.
   */
  private isDebounced(channelId: string, nowMs: number): boolean {
    const until = this.dedupeByChannel.get(channelId)?.debounceUntilMs ?? 0;
    return until > 0 && nowMs < until;
  }

  /**
   * Open (or refresh) the per-channel debounce window on candidate emission. A
   * non-positive `debounceWindowMs` disables debounce: no window is opened, so
   * every non-duplicate name-trigger keeps creating candidates.
   */
  private openDebounceWindow(channelId: string, nowMs: number): void {
    const windowMs = this.settings.debounceWindowMs;
    if (windowMs <= 0) {
      return;
    }
    this.getOrCreateState(channelId).debounceUntilMs = nowMs + windowMs;
  }

  private markSeen(channelId: string, sourceMessageId: string): void {
    const state = this.getOrCreateState(channelId);
    if (state.seen.has(sourceMessageId)) {
      return;
    }
    state.seen.add(sourceMessageId);
    state.order.push(sourceMessageId);
    const cap = this.settings.dedupeHistoryPerChannel;
    while (state.order.length > cap) {
      const evicted = state.order.shift();
      if (evicted !== undefined) {
        state.seen.delete(evicted);
      }
    }
  }

  private async loadPrecedingContext(
    message: SubstrateMessage,
    triggerTimestampMs: number,
  ): Promise<ParticipationContextMessage[]> {
    const want = this.settings.precedingContextMessages;
    if (want <= 0) {
      return [];
    }
    // Over-read a small buffer so filtering out the source message (if it is
    // already persisted) and any out-of-window entries still leaves `want`.
    const entries = await this.contextReader.getRecent(message.channelId, want + 4);
    const hasTriggerTs = Number.isFinite(triggerTimestampMs);
    const preceding = entries
      .filter((entry) => entry.discordMessageId !== message.id)
      .filter((entry) => !hasTriggerTs || entry.timestamp <= triggerTimestampMs)
      .filter((entry) => entry.content.length > 0)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-want);
    return preceding.map((entry) => ({
      messageId: entry.discordMessageId ?? String(entry.id),
      authorId: entry.authorId ?? '',
      authorName: entry.authorName ?? entry.role,
      content: entry.content,
      timestampMs: entry.timestamp,
    }));
  }
}
