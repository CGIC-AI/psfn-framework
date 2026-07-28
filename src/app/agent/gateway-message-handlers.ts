import type { AgentResponse, Attachment, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { MessageHandlerOptions } from '../../channels/backplane/types.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ShardExecutionPort } from '../../faculties/shards/port.js';
import type { SatelliteRoutingPort } from '../../core/agent/satellite-adapter-port.js';
import type { ObservedGroupMemoryScheduleDecision } from '../../faculties/memory/extraction/group-observed-scheduler.js';
import type {
  ParticipationAppraisalResult,
  ParticipationCandidate,
  PassiveNameCandidateDecision,
} from '../../core/participation/types.js';
import type {
  ReservationDecision,
  ReservationSignalContext,
} from '../../core/agent/arbiter/reservation-phase.js';
import type {
  EgressLeaseDecision,
  EgressReplyTrigger,
} from '../../core/agent/arbiter/egress-lease-phase.js';
import type { SpeakingReservationSnapshot } from '../../core/agent/arbiter/speaking-arbiter-store-port.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { resolveCompanionIdFromConfig } from '../../core/identity/companion-runtime.js';
import type { OutboundReplyGuardPort } from '../../system/lifecycle/outbound-reply-dedupe.js';
import type {
  CompanionDeliveryFailureReason,
  CompanionMessageDeliveryFailureNotification,
  CompanionMessageFailureReportParams,
} from '../../boundary/gateway/protocol.js';
import {
  createDiscordDeliveryCheckpoint,
  deliverDiscordReply,
  DiscordFailedDeliveryCache,
  type DiscordDeliveryCheckpoint,
} from './discord-reply-delivery.js';
import {
  createIcpTargetChannelInitiator,
  type IcpDeliveryObservation,
  type IcpTargetChannelInitiator,
  type RecordedIcpInitiationTurn,
} from './icp-target-channel-initiation.js';
import {
  parseIcpConversationCorrelation,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import {
  createCompanionReplyDeliveryLifecycle,
} from './companion-reply-delivery-recovery.js';
import {
  finalizeCompanionDelivery,
  finalizeDiscordDelivery,
  handleCompanionTurnFailure,
  handleDiscordTurnFailure,
} from './delivery-pump-outcomes.js';
import {
  assertIcpRecoveryStatusBinding,
  parseIcpRecoveryResponse,
  type RecordedCompanionSourceMessage,
} from '../../core/session/icp-delivery-recovery.js';
import { assertCompanionRecoveryLineage } from './icp-recovery-lineage.js';
import {
  emitTurnPerformance,
  monotonicEpochNowMs,
} from '../../shared/telemetry/turn-performance.js';

const DUPLICATE_MESSAGE_WINDOW_MS = 2 * 60_000;
const AGENT_BUSY_PATTERN = /already processing a prompt/i;
const CANONICAL_COMPANION_ROUTING_KEYS = new Set([
  'source',
  'authorIsMachineIntelligence',
  'icpCorrelation',
  'channelPrivacy',
  'room',
]);

interface QueuedDiscordMessage {
  message: SubstrateMessage;
  dedupeKey: string | null;
  enqueuedMonotonicAtMs: number;
  retryDelivery?: DiscordDeliveryCheckpoint;
}

interface RecentHandleMessageResult {
  completedAt: number;
  response: AgentResponse;
}

function buildMessageDedupKey(route: 'handle' | 'discord' | 'companion', message: SubstrateMessage): string | null {
  const messageId = message.id.trim();
  if (!messageId) return null;
  return `${route}:${message.channelId}:${messageId}`;
}

function normalizeTransportTimestamp(message: SubstrateMessage): void {
  const timestamp = message.timestamp instanceof Date
    ? new Date(message.timestamp.getTime())
    : new Date(String(message.timestamp));
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('Companion transport timestamp is invalid');
  }
  message.timestamp = timestamp;
}

function bindRecordedCompanionSourceEnvelope(
  message: SubstrateMessage,
  recorded: RecordedCompanionSourceMessage,
): void {
  const incomingCorrelation = parseIcpConversationCorrelation(message.routing?.icpCorrelation);
  const expectedIsDirectMessage = incomingCorrelation.surface === 'companion_dm';
  const channelPrivacy = message.routing?.channelPrivacy;
  const room = message.routing?.room;
  const routingKeys = Object.keys(message.routing ?? {});
  if (!recorded.correlation
    || JSON.stringify(incomingCorrelation) !== JSON.stringify(recorded.correlation)
    || recorded.channelId !== message.channelId
    || recorded.sourceMessageId !== message.id
    || recorded.content !== message.content
    || recorded.authorId !== message.authorId
    || recorded.authorName !== message.authorName
    || message.channelType !== 'companion'
    || message.isDirectMessage !== expectedIsDirectMessage
    || message.routing?.source !== 'companion'
    || message.routing.authorIsMachineIntelligence !== true
    || routingKeys.some(key => !CANONICAL_COMPANION_ROUTING_KEYS.has(key))) {
    throw new Error('Companion replay envelope does not match its durable source entry');
  }
  const timestamp = new Date(recorded.timestampMs);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('Recorded companion source timestamp is invalid');
  }
  message.content = recorded.content;
  message.authorId = recorded.authorId;
  message.authorName = recorded.authorName;
  message.timestamp = timestamp;
  delete message.attachments;
  message.channelType = 'companion';
  message.isDirectMessage = expectedIsDirectMessage;
  message.routing = {
    source: 'companion',
    authorIsMachineIntelligence: true,
    icpCorrelation: recorded.correlation,
    ...(channelPrivacy ? { channelPrivacy } : {}),
    ...(room ? { room } : {}),
  };
}

function bindCompanionRecoveryCorrelation(
  message: SubstrateMessage,
  correlation: IcpConversationCorrelation,
): void {
  message.routing = {
    source: 'companion',
    authorIsMachineIntelligence: true,
    icpCorrelation: correlation,
  };
}

export interface GatewayMessageGateway {
  onHandleMessage(handler: (message: SubstrateMessage) => Promise<AgentResponse>): void;
  onDiscordMessage(handler: (message: SubstrateMessage) => void | Promise<void>): void;
  discordSend(channelId: string, content: string): Promise<void>;
  discordSendMedia(channelId: string, media: Attachment): Promise<void>;
  /** Inter-companion lane (sprint 10, W6): inbound peer messages + outbound replies. */
  onCompanionMessage(handler: (message: SubstrateMessage) => void | Promise<void>): void;
  companionSend(
    channelId: string,
    content: string,
    authorName?: string,
    correlationOrReplyToMessageId?: IcpConversationCorrelation | string,
  ): Promise<{
    channelId: string;
    messageId: string;
    deliveredTo: string[];
    skippedOffline: string[];
  }>;
  companionSendInitiation(input: {
    channelId: string;
    content: string;
    authorName?: string;
    permitId: string;
    conversationId: string;
    recipientCompanionId: string;
    correlation: IcpConversationCorrelation;
  }): Promise<{
    channelId: string;
    messageId: string;
    deliveredTo: string[];
    skippedOffline: string[];
    permitOutcome: 'consumed' | 'replayed';
  }>;
  companionConsumeInitiationPermit(input: {
    permitId: string;
    conversationId: string;
    recipientCompanionId: string;
    channelId: string;
    rootInitiationId: string;
    peerContactId: string;
  }): Promise<{ outcome: string }>;
  companionReportFailure(params: CompanionMessageFailureReportParams): Promise<unknown>;
  onCompanionDeliveryFailure(
    handler: (notification: CompanionMessageDeliveryFailureNotification) => void | Promise<void>,
  ): void;
}

export interface GatewayMessageAgentLoop {
  handleMessage(
    message: SubstrateMessage,
    deliveryLifecycle?: {
      recoveredResponse?: AgentResponse;
      sourceAlreadyPersisted?: true;
      finalizeDelivery(response: AgentResponse): Promise<void>;
    },
    turnControl?: MessageHandlerOptions,
  ): Promise<AgentResponse>;
  observeMessage(message: SubstrateMessage): Promise<void>;
  /** Resolves when the agent has finished all in-flight work (prompt + steering + follow-ups). */
  waitForIdle(): Promise<void>;
  findRecordedIcpInitiation(
    channelId: string,
    sourceMessageId: string,
  ): Promise<RecordedIcpInitiationTurn | null> | RecordedIcpInitiationTurn | null;
  findIcpDeliveryObservation(
    channelId: string,
    sourceMessageId: string,
  ): Promise<IcpDeliveryObservation | null>
    | IcpDeliveryObservation
    | null;
  findRecordedCompanionSourceMessage(
    channelId: string,
    sourceMessageId: string,
  ): Promise<RecordedCompanionSourceMessage | null> | RecordedCompanionSourceMessage | null;
  recordIcpDeliveryObservation(observation: IcpDeliveryObservation): Promise<void> | void;
}

export type GatewayMessageShardManager = Pick<ShardExecutionPort, 'delegateSatelliteSession'>;

export interface GatewayMessageAuditTrail {
  append(event: string, details?: Record<string, unknown>): unknown;
}

export interface ObservedGroupMemorySchedulerPort {
  observeMessage(message: SubstrateMessage): Promise<ObservedGroupMemoryScheduleDecision>;
}

export interface PassiveNameCandidatePort {
  build(message: SubstrateMessage): Promise<PassiveNameCandidateDecision>;
}

export interface ParticipationAppraiserPort {
  appraise(candidate: ParticipationCandidate): Promise<ParticipationAppraisalResult>;
}

/**
 * Deterministic speaking-arbiter reservation phase (bible §8.5/§12.2, §6.10;
 * jp36.5.1.2). Runs BEFORE the appraiser's model call: a gated candidate never
 * reaches appraisal, and a reserved candidate's reservation is released on an
 * `ignore` outcome.
 */
export interface ReservationPhasePort {
  reserve(ctx: ReservationSignalContext): Promise<ReservationDecision>;
  settleAfterAppraisal(
    reservation: SpeakingReservationSnapshot,
    action: ParticipationAppraisalResult['appraisal']['action'],
    nowMs: number,
  ): Promise<'released' | 'retained'>;
  releaseIgnored(reservation: SpeakingReservationSnapshot, nowMs: number): Promise<void>;
}

/**
 * Speaking-arbiter egress-lease phase (bible §8.5/§12.2, §18, §20.1;
 * jp36.5.1.3). Phase 2: the exclusive send-once binding at delivery. When
 * present, a RETAINED `reply` reservation is handed to {@link grantReply} (the
 * Law-36 single-probe breaker gate, lease-threshold-bias confidence bar,
 * speak-least fairness, the real pot draw, then acquire → send → complete); a
 * RETAINED `react` reservation is handed to {@link releaseReact} for its
 * explicit non-lease release. Optional and off by default — promoting an
 * observed candidate to a real autonomous send is opt-in and fail-closed.
 */
export interface EgressLeasePhasePort {
  grantReply(
    reservation: SpeakingReservationSnapshot,
    appraisal: Extract<ParticipationAppraisalResult['appraisal'], { action: 'reply' }>,
    trigger: EgressReplyTrigger,
    nowMs: number,
  ): Promise<EgressLeaseDecision>;
  releaseReact(
    reservation: SpeakingReservationSnapshot,
    nowMs: number,
  ): Promise<EgressLeaseDecision>;
}

export interface GatewayMessageLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface GatewayMessageHandlersDeps {
  eventBus: EventBus;
  gateway: GatewayMessageGateway;
  agentLoop: GatewayMessageAgentLoop;
  shardManager: GatewayMessageShardManager;
  safeguardAuditTrail: GatewayMessageAuditTrail;
  satelliteRouting: SatelliteRoutingPort;
  config: SubstrateConfig;
  log: GatewayMessageLogger;
  trackSessionActivity: (message: SubstrateMessage) => void;
  observedGroupMemoryScheduler?: ObservedGroupMemorySchedulerPort;
  /**
   * Deterministic passive-name participation candidate gate (bible §8.1). Runs
   * on observed group-room traffic alongside group-memory scheduling; records
   * created/suppressed candidates on the safeguard audit trail. Optional so
   * runtimes without room participation keep working unchanged.
   */
  passiveNameCandidateBuilder?: PassiveNameCandidatePort;
  /**
   * Cheap tool-less participation appraiser (bible §8.2). When present, each
   * candidate the passive-name gate creates is appraised on this real observe
   * path into a ternary (ignore/react/reply); the outcome is recorded on the
   * safeguard audit trail and the typed event bus. Fails closed to `ignore` on
   * any error/timeout/malformed output — it never speaks itself, and a `reply`
   * decision is only routed through the full response path downstream (jp36.5).
   * Optional so runtimes without room participation keep working unchanged.
   */
  participationAppraiser?: ParticipationAppraiserPort;
  /**
   * Speaking-arbiter reservation phase (bible §8.5/§12.2, jp36.5.1.2). When
   * present, each created candidate is deterministically gated and reserved
   * before appraisal ("peek before the model runs"): a gated candidate never
   * reaches the appraiser, and a reserved candidate's reservation is released on
   * an `ignore` outcome. Optional so single-companion runtimes (no gateway
   * arbiter store) keep the appraiser's existing direct path unchanged.
   */
  reservationPhase?: ReservationPhasePort;
  /**
   * Speaking-arbiter egress-lease phase (bible §8.5, jp36.5.1.3). When present
   * (and enabled), a RETAINED `reply`/`react` reservation from the reservation
   * phase is handed onward here: `reply` binds the exclusive fenced egress lease
   * and delivers (the real pot draw + Law-36 single-probe breaker gate bind
   * here), `react` gets its explicit non-lease release. Optional so runtimes
   * without the arbiter — or with autonomous send disabled — keep the
   * observe/appraise path unchanged (nothing is sent).
   */
  egressLeasePhase?: EgressLeasePhasePort;
  /**
   * Records primary replies delivered to Discord so replay-prone senders (the
   * internal continuation) can detect and suppress a duplicate of
   * an already-delivered reply. See `outbound-reply-dedupe.ts`.
   */
  outboundReplyGuard?: OutboundReplyGuardPort;
  /**
   * Display name stamped on companion-lane replies (the character card name).
   * Identity is always the gateway-verified companionId; this is cosmetic.
   */
  companionAuthorName?: string;
  /** Deterministic clock seam for queue-wait contract tests. */
  nowMonotonicMs?: () => number;
}

export interface RegisteredGatewayMessageHandlers {
  icpTargetChannelInitiator: IcpTargetChannelInitiator;
}

export function registerGatewayMessageHandlers(
  deps: GatewayMessageHandlersDeps,
): RegisteredGatewayMessageHandlers {
  const {
    gateway,
    agentLoop,
    shardManager,
    safeguardAuditTrail,
    satelliteRouting,
    config,
    log,
    trackSessionActivity,
    observedGroupMemoryScheduler,
    passiveNameCandidateBuilder,
    participationAppraiser,
    reservationPhase,
    egressLeasePhase,
    outboundReplyGuard,
    companionAuthorName,
    eventBus,
  } = deps;
  const nowMonotonicMs = deps.nowMonotonicMs ?? monotonicEpochNowMs;
  const companionId = resolveCompanionIdFromConfig(config);

  const inFlightHandleMessages = new Map<string, Promise<AgentResponse>>();
  const recentHandleResponses = new Map<string, RecentHandleMessageResult>();
  const inFlightDiscordMessages = new Set<string>();
  const recentDiscordMessages = new Map<string, number>();
  const failedDiscordDeliveries = new DiscordFailedDeliveryCache();
  const inFlightCompanionMessages = new Set<string>();
  const recentCompanionMessages = new Map<string, number>();

  /**
   * Appraise one created participation candidate into a ternary (bible §8.2) and
   * record it. Fully fail-closed: it never throws into the observe path and the
   * appraiser itself fails closed to `ignore` on any error/timeout/malformed
   * output, so a failure can only ever suppress participation, never invent it.
   * The decision is recorded on the audit trail and the typed event bus; a
   * `reply` here is only a request that the downstream arbiter (jp36.5) may
   * route through the full response path — nothing is sent from here.
   */
  const appraiseParticipationCandidate = async (
    candidate: ParticipationCandidate,
  ): Promise<ParticipationAppraisalResult | undefined> => {
    if (!participationAppraiser) {
      return undefined;
    }
    try {
      const result = await participationAppraiser.appraise(candidate);
      const { appraisal } = result;
      safeguardAuditTrail.append('participation.appraisal.completed', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        action: appraisal.action,
        reasonCode: appraisal.reasonCode,
        confidence: appraisal.confidence,
        failClosed: result.failClosed,
        ...(result.failClosedReason ? { failClosedReason: result.failClosedReason } : {}),
      });
      await eventBus.emit('participation.appraisal', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        action: appraisal.action,
        reasonCode: appraisal.reasonCode,
        confidence: appraisal.confidence,
        failClosed: result.failClosed,
        timestamp: nowMonotonicMs(),
      });
      return result;
    } catch (appraiserError) {
      // The appraiser is designed to fail closed internally; this is a
      // belt-and-braces guard so nothing here can break message observation.
      const errorText = toErrorMessage(appraiserError);
      log.warn('Participation appraiser failed', {
        channelId: candidate.channelId,
        messageId: candidate.sourceMessageId,
        error: errorText,
      });
      safeguardAuditTrail.append('participation.appraisal.error', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        error: errorText,
      });
      return undefined;
    }
  };

  /**
   * Gate and reserve one created candidate before appraisal (bible §8.5/§12.2,
   * jp36.5.1.2), then appraise a reserved candidate and settle its reservation.
   * A gated candidate never reaches the appraiser (no model spend). A reserved
   * candidate's reservation is released on an `ignore` outcome (silence is a
   * valid release, never retried into speech); a `react`/`reply` reservation is
   * handed to the egress-lease phase (jp36.5.1.3). Fully fail-closed: it never
   * throws into the observe path.
   */
  const reserveAndAppraiseCandidate = async (
    candidate: ParticipationCandidate,
    phase: ReservationPhasePort,
  ): Promise<void> => {
    const decision = await phase.reserve({
      channelId: candidate.channelId,
      triggerEventId: candidate.sourceMessageId,
      companionId,
      nowMs: nowMonotonicMs(),
    });
    if (decision.outcome === 'gated') {
      safeguardAuditTrail.append('participation.reservation.gated', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        blockedBy: decision.blockedBy,
        ...(decision.availabilityState ? { availabilityState: decision.availabilityState } : {}),
        ...(decision.errorStage ? { errorStage: decision.errorStage } : {}),
      });
      await eventBus.emit('participation.reservation', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        outcome: 'gated',
        blockedBy: decision.blockedBy,
        ...(decision.availabilityState ? { availabilityState: decision.availabilityState } : {}),
        ...(decision.errorStage ? { errorStage: decision.errorStage } : {}),
        timestamp: nowMonotonicMs(),
      });
      // Gated: the candidate never reaches the appraiser's model call.
      return;
    }
    safeguardAuditTrail.append('participation.reservation.reserved', {
      channelId: candidate.channelId,
      sourceMessageId: candidate.sourceMessageId,
      trigger: candidate.trigger,
      reservationId: decision.reservation.reservationId,
      episodeId: decision.reservation.episodeId,
      replayed: decision.replayed,
    });
    await eventBus.emit('participation.reservation', {
      channelId: candidate.channelId,
      sourceMessageId: candidate.sourceMessageId,
      trigger: candidate.trigger,
      outcome: 'reserved',
      reservationId: decision.reservation.reservationId,
      episodeId: decision.reservation.episodeId,
      replayed: decision.replayed,
      timestamp: nowMonotonicMs(),
    });

    const result = participationAppraiser
      ? await appraiseParticipationCandidate(candidate)
      : undefined;
    // No appraiser, or the appraiser's belt-and-braces guard tripped: the
    // candidate can never become a reply, so release the reservation.
    const action = result?.appraisal.action ?? 'ignore';
    let settlement: 'released' | 'retained' = 'released';
    try {
      settlement = await phase.settleAfterAppraisal(
        decision.reservation,
        action,
        nowMonotonicMs(),
      );
      safeguardAuditTrail.append('participation.reservation.settled', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        reservationId: decision.reservation.reservationId,
        action,
        settlement,
      });
      await eventBus.emit('participation.reservation', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        outcome: 'settled',
        reservationId: decision.reservation.reservationId,
        action,
        settlement,
        timestamp: nowMonotonicMs(),
      });
    } catch (releaseError) {
      // A failed release never wedges the room — the reservation is TTL-swept.
      const errorText = toErrorMessage(releaseError);
      log.warn('Participation reservation settle failed', {
        channelId: candidate.channelId,
        messageId: candidate.sourceMessageId,
        error: errorText,
      });
      safeguardAuditTrail.append('participation.reservation.error', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        reservationId: decision.reservation.reservationId,
        error: errorText,
      });
      // Content-free bus event: the forensic error text stays on the audit trail
      // (§19 do-not-log list); the bus carries only the failed-outcome shape.
      await eventBus.emit('participation.reservation', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        outcome: 'error',
        reservationId: decision.reservation.reservationId,
        timestamp: nowMonotonicMs(),
      });
      return;
    }

    // A RETAINED reservation (react/reply) is handed to the exclusive egress-lease
    // phase (bible §8.5, jp36.5.1.3): a `reply` binds the fenced send-once lease
    // (the real pot draw + Law-36 single-probe breaker gate bind here) and
    // delivers; a `react` gets its explicit non-lease release. Fully fail-closed:
    // it never throws into the observe path. Absent (or disabled) egress phase
    // keeps the pre-jp36.5.1.3 behavior — nothing is sent.
    if (settlement !== 'retained' || !egressLeasePhase || !result) {
      return;
    }
    try {
      let egressDecision: EgressLeaseDecision;
      if (result.appraisal.action === 'reply') {
        const trigger: EgressReplyTrigger = {
          channelId: candidate.channelId,
          channelType: candidate.channelType,
          sourceMessageId: candidate.sourceMessageId,
          authorId: candidate.triggerAuthorId,
          authorName: candidate.triggerAuthorName,
          content: candidate.triggerContent,
          timestampMs: candidate.triggerTimestampMs,
        };
        egressDecision = await egressLeasePhase.grantReply(
          decision.reservation,
          result.appraisal,
          trigger,
          nowMonotonicMs(),
        );
      } else if (result.appraisal.action === 'react') {
        egressDecision = await egressLeasePhase.releaseReact(
          decision.reservation,
          nowMonotonicMs(),
        );
      } else {
        return;
      }
      safeguardAuditTrail.append('participation.egress.settled', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        reservationId: decision.reservation.reservationId,
        action: result.appraisal.action,
        outcome: egressDecision.outcome,
        ...(egressDecision.declineReason ? { declineReason: egressDecision.declineReason } : {}),
        ...(egressDecision.drawOutcome ? { drawOutcome: egressDecision.drawOutcome } : {}),
        ...(egressDecision.breakerState ? { breakerState: egressDecision.breakerState } : {}),
        ...(egressDecision.breakerFiring ? { breakerFiring: egressDecision.breakerFiring } : {}),
        ...(egressDecision.speakLeastWinner
          ? { yieldedTo: egressDecision.speakLeastWinner }
          : {}),
        ...(egressDecision.errorStage ? { errorStage: egressDecision.errorStage } : {}),
      });
      await eventBus.emit('participation.egress', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        reservationId: decision.reservation.reservationId,
        outcome: 'settled',
        action: result.appraisal.action,
        leaseOutcome: egressDecision.outcome,
        ...(egressDecision.declineReason ? { declineReason: egressDecision.declineReason } : {}),
        ...(egressDecision.drawOutcome ? { drawOutcome: egressDecision.drawOutcome } : {}),
        ...(egressDecision.breakerState ? { breakerState: egressDecision.breakerState } : {}),
        ...(egressDecision.breakerFiring ? { breakerFiring: egressDecision.breakerFiring } : {}),
        ...(egressDecision.speakLeastWinner
          ? { yieldedTo: egressDecision.speakLeastWinner }
          : {}),
        ...(egressDecision.errorStage ? { errorStage: egressDecision.errorStage } : {}),
        timestamp: nowMonotonicMs(),
      });
    } catch (egressError) {
      // Belt-and-braces: the egress phase is designed to fail closed internally;
      // this guard ensures nothing here can break message observation.
      const errorText = toErrorMessage(egressError);
      log.warn('Participation egress-lease phase failed', {
        channelId: candidate.channelId,
        messageId: candidate.sourceMessageId,
        error: errorText,
      });
      safeguardAuditTrail.append('participation.egress.error', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        reservationId: decision.reservation.reservationId,
        error: errorText,
      });
      // Content-free bus event: the forensic error text stays on the audit trail
      // (§19 do-not-log list); the bus carries only the failed-outcome shape.
      await eventBus.emit('participation.egress', {
        channelId: candidate.channelId,
        sourceMessageId: candidate.sourceMessageId,
        trigger: candidate.trigger,
        reservationId: decision.reservation.reservationId,
        outcome: 'error',
        timestamp: nowMonotonicMs(),
      });
    }
  };

  const pruneDuplicateCaches = (now: number): void => {
    const minTimestamp = now - DUPLICATE_MESSAGE_WINDOW_MS;
    for (const [key, cached] of recentHandleResponses.entries()) {
      if (cached.completedAt < minTimestamp) {
        recentHandleResponses.delete(key);
      }
    }
    for (const [key, seenAt] of recentDiscordMessages.entries()) {
      if (seenAt < minTimestamp) {
        recentDiscordMessages.delete(key);
      }
    }
    failedDiscordDeliveries.prune(minTimestamp);
    for (const [key, seenAt] of recentCompanionMessages.entries()) {
      if (seenAt < minTimestamp) {
        recentCompanionMessages.delete(key);
      }
    }
  };

  // No conversational message is ever dropped: if the agent is busy we wait
  // for idle and try again, indefinitely and loudly. A wedged agent surfaces
  // as repeated warnings in the journal, never as silent message loss.
  const promptWhenIdle = async (
    message: SubstrateMessage,
    deliveryLifecycle?: {
      recoveredResponse?: AgentResponse;
      finalizeDelivery(response: AgentResponse): Promise<void>;
    },
  ): Promise<AgentResponse> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return deliveryLifecycle
          ? await agentLoop.handleMessage(message, deliveryLifecycle)
          : await agentLoop.handleMessage(message);
      } catch (err) {
        if (!(err instanceof Error) || !AGENT_BUSY_PATTERN.test(err.message)) throw err;
        log.warn('Agent busy; holding discord message until in-flight work finishes', {
          channelId: message.channelId,
          messageId: message.id,
          attempt,
        });
        await agentLoop.waitForIdle();
      }
    }
  };

  // Messages that arrive while a turn is in flight queue here and are
  // bundled — same channel, same author, contiguous — into a single turn, so
  // a burst of operator messages gets one reply that has seen all of them.
  const discordPromptQueue: QueuedDiscordMessage[] = [];
  let discordPumpActive = false;

  const takeNextDiscordBundle = (): QueuedDiscordMessage[] => {
    const first = discordPromptQueue.shift();
    if (!first) return [];
    const bundle = [first];
    if (first.retryDelivery) return bundle;
    let index = 0;
    while (index < discordPromptQueue.length) {
      const entry = discordPromptQueue[index];
      if (entry.retryDelivery) break;
      if (entry.message.channelId === first.message.channelId) {
        if (entry.message.authorId !== first.message.authorId) break;
        bundle.push(entry);
        discordPromptQueue.splice(index, 1);
        continue;
      }
      index += 1;
    }
    return bundle;
  };

  const bundleDiscordMessages = (entries: readonly QueuedDiscordMessage[]): SubstrateMessage => {
    if (entries.length === 1) return entries[0].message;
    const messages = entries.map((entry) => entry.message);
    const newest = messages[messages.length - 1];
    return {
      ...newest,
      content: messages
        .map((entry) => entry.content)
        .filter((content) => content.trim().length > 0)
        .join('\n'),
      attachments: messages.flatMap((entry) => entry.attachments ?? []),
    };
  };

  const pumpDiscordQueue = async (): Promise<void> => {
    if (discordPumpActive) return;
    discordPumpActive = true;
    try {
      while (discordPromptQueue.length > 0) {
        const entries = takeNextDiscordBundle();
        if (entries.length === 0) break;
        const message = bundleDiscordMessages(entries);
        const dequeuedMonotonicAtMs = nowMonotonicMs();
        for (const entry of entries) {
          void emitTurnPerformance(eventBus, {
            traceId: entry.message.id,
            turnId: entry.message.id,
            requestId: entry.message.id,
            companionId,
            channelId: entry.message.channelId,
            channelType: entry.message.channelType,
            stage: 'channel_queue_wait',
            monotonicAtMs: dequeuedMonotonicAtMs,
            durationMs: Math.max(0, dequeuedMonotonicAtMs - entry.enqueuedMonotonicAtMs),
            queueDepth: discordPromptQueue.length,
          }).catch(error => log.warn('Discord queue performance telemetry emit failed', {
            messageId: entry.message.id,
            error: toErrorMessage(error),
          }));
        }
        if (entries.length > 1) {
          const messageIds = entries.map((entry) => entry.message.id);
          log.info('Bundling discord messages that arrived during an in-flight turn', {
            channelId: message.channelId,
            messageIds,
          });
          safeguardAuditTrail.append('discord.message.bundled', {
            channelId: message.channelId,
            messageIds,
            count: entries.length,
          });
        }
        let completed = false;
        let checkpoint = entries[0].retryDelivery;
        const dedupeKeys = checkpoint?.dedupeKeys
          ?? entries.flatMap((entry) => entry.dedupeKey ? [entry.dedupeKey] : []);
        try {
          if (!checkpoint) {
            const response = await promptWhenIdle(message);
            checkpoint = createDiscordDeliveryCheckpoint(response, dedupeKeys);
          }
          await deliverDiscordReply(message.channelId, checkpoint, {
            sendText: (channelId, content) => gateway.discordSend(channelId, content),
            sendMedia: (channelId, attachment) => gateway.discordSendMedia(channelId, attachment),
            onTextDelivered: (content) => {
              // An internal continuation can now suppress a replay
              // of the primary text even when later media delivery fails.
              outboundReplyGuard?.noteDelivered({
                channelId: message.channelId,
                content,
                sourceTurnId: message.id,
                senderKind: 'discord_inbound_reply',
              });
            },
          });
          completed = true;
        } catch (err) {
          await handleDiscordTurnFailure({
            error: err,
            channelId: message.channelId,
            messageId: message.id,
            checkpoint,
            failedDeliveries: failedDiscordDeliveries,
            ports: {
              discordSend: (channelId, content) => gateway.discordSend(channelId, content),
              audit: safeguardAuditTrail,
              log,
            },
          });
        } finally {
          finalizeDiscordDelivery({
            dedupeKeys,
            completed,
            inFlight: inFlightDiscordMessages,
            failedDeliveries: failedDiscordDeliveries,
            recent: recentDiscordMessages,
            finishedAt: Date.now(),
          });
        }
      }
    } finally {
      discordPumpActive = false;
    }
  };

  gateway.onHandleMessage(async (message: SubstrateMessage, turnControl?: MessageHandlerOptions) => {
    const dedupeKey = buildMessageDedupKey('handle', message);
    const now = Date.now();
    pruneDuplicateCaches(now);
    if (dedupeKey) {
      const cached = recentHandleResponses.get(dedupeKey);
      if (cached && now - cached.completedAt < DUPLICATE_MESSAGE_WINDOW_MS) {
        log.warn('Dropping duplicate gateway handle message; reusing cached response', {
          channelId: message.channelId,
          messageId: message.id,
          dedupeWindowMs: DUPLICATE_MESSAGE_WINDOW_MS,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'handle',
          channelId: message.channelId,
          messageId: message.id,
          disposition: 'cached',
        });
        return cached.response;
      }
      const inFlight = inFlightHandleMessages.get(dedupeKey);
      if (inFlight) {
        log.warn('Dropping duplicate gateway handle message; awaiting in-flight response', {
          channelId: message.channelId,
          messageId: message.id,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'handle',
          channelId: message.channelId,
          messageId: message.id,
          disposition: 'in_flight',
        });
        return inFlight;
      }
    }

    const processMessage = async (): Promise<AgentResponse> => {
      trackSessionActivity(message);
      if (message.routing?.responseMode === 'observe') {
        await agentLoop.observeMessage(message);
        safeguardAuditTrail.append('gateway.message.observed', {
          route: 'handle',
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.authorId,
        });
        return {
          content: '',
          channelId: message.channelId,
          metadata: {
            model: 'observation-only',
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          },
        };
      }
      log.info(`Voice message from ${message.authorName}: ${message.content.slice(0, 50)}...`);
      const routingDecision = satelliteRouting.evaluateDelegation(
        message,
        config,
        resolveCompanionIdFromConfig(config),
      );
      if (routingDecision?.isSatellite) {
        safeguardAuditTrail.append('satellite.routing.decision', {
          channelId: message.channelId,
          messageId: message.id,
          delegated: routingDecision.delegate,
          reason: routingDecision.reason,
          connectionId: routingDecision.routing?.connectionId,
          sessionId: routingDecision.routing?.sessionId,
          turnId: routingDecision.routing?.turnId,
          siteId: routingDecision.routing?.siteId,
          satelliteId: routingDecision.routing?.satelliteId,
        });
      }

      if (routingDecision?.delegate) {
        try {
          const delegated = await shardManager.delegateSatelliteSession({
            message,
            routing: routingDecision.routing,
          });
          safeguardAuditTrail.append('satellite.routing.delegated', {
            channelId: message.channelId,
            messageId: message.id,
            shardId: delegated.shardId,
            connectionId: routingDecision.routing?.connectionId,
            sessionId: routingDecision.routing?.sessionId,
            turnId: routingDecision.routing?.turnId,
            siteId: routingDecision.routing?.siteId,
            satelliteId: routingDecision.routing?.satelliteId,
          });
          return {
            content: delegated.content,
            channelId: message.channelId,
            metadata: {
              model: delegated.model,
              inputTokens: delegated.inputTokens,
              outputTokens: delegated.outputTokens,
              durationMs: delegated.durationMs,
            },
          };
        } catch (error) {
          const delegationError = toErrorMessage(error);
          safeguardAuditTrail.append('satellite.routing.fallback', {
            channelId: message.channelId,
            messageId: message.id,
            reason: 'delegation_error',
            error: delegationError,
            connectionId: routingDecision.routing?.connectionId,
            sessionId: routingDecision.routing?.sessionId,
            turnId: routingDecision.routing?.turnId,
          });
          log.warn('Satellite delegation failed; falling back to primary path', {
            channelId: message.channelId,
            error: delegationError,
          });
        }
      }

      if (routingDecision?.isSatellite) {
        safeguardAuditTrail.append('satellite.routing.primary', {
          channelId: message.channelId,
          messageId: message.id,
          reason: routingDecision.reason,
          connectionId: routingDecision.routing?.connectionId,
          sessionId: routingDecision.routing?.sessionId,
          turnId: routingDecision.routing?.turnId,
          siteId: routingDecision.routing?.siteId,
          satelliteId: routingDecision.routing?.satelliteId,
        });
      }

      // mmo9.6.1: forward the voice turn's cancellation identity + AbortSignal
      // so a barge-in `voice.stream.cancel` aborts this specific in-flight turn.
      return agentLoop.handleMessage(message, undefined, turnControl);
    };

    const execution = processMessage();
    if (dedupeKey) {
      inFlightHandleMessages.set(dedupeKey, execution);
    }

    try {
      const response = await execution;
      if (dedupeKey) {
        recentHandleResponses.set(dedupeKey, {
          completedAt: Date.now(),
          response,
        });
      }
      return response;
    } finally {
      if (dedupeKey) {
        inFlightHandleMessages.delete(dedupeKey);
      }
    }
  });

  gateway.onDiscordMessage(async (message: SubstrateMessage) => {
    const dedupeKey = buildMessageDedupKey('discord', message);
    const now = Date.now();
    pruneDuplicateCaches(now);
    const retryDelivery = dedupeKey ? failedDiscordDeliveries.find(dedupeKey) : undefined;
    if (dedupeKey) {
      const seenAt = recentDiscordMessages.get(dedupeKey);
      if (seenAt && now - seenAt < DUPLICATE_MESSAGE_WINDOW_MS) {
        log.warn('Dropping duplicate discord notification message', {
          channelId: message.channelId,
          messageId: message.id,
          dedupeWindowMs: DUPLICATE_MESSAGE_WINDOW_MS,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'discord',
          channelId: message.channelId,
          messageId: message.id,
          disposition: 'cached',
        });
        return;
      }
      const deliveryKeys = retryDelivery?.dedupeKeys ?? [dedupeKey];
      if (deliveryKeys.some((key) => inFlightDiscordMessages.has(key))) {
        log.warn('Dropping duplicate discord notification message while first copy is in-flight', {
          channelId: message.channelId,
          messageId: message.id,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'discord',
          channelId: message.channelId,
          messageId: message.id,
          disposition: 'in_flight',
        });
        return;
      }
      for (const key of deliveryKeys) {
        inFlightDiscordMessages.add(key);
      }
    }

    // Deserialize Date if it came as string
    if (typeof message.timestamp === 'string') {
      message.timestamp = new Date(message.timestamp);
    }

    const attachments = message.attachments ?? [];
    const isObservationOnly = message.routing?.responseMode === 'observe';
    log.info(`Message from ${message.authorName}: ${message.content.slice(0, 50)}...`, {
      channelId: message.channelId,
      attachmentCount: attachments.length,
      attachmentTypes: attachments.map((attachment) => attachment.contentType),
      attachmentNames: attachments.map((attachment) => attachment.name),
      responseMode: message.routing?.responseMode ?? 'respond',
    });

    if (isObservationOnly) {
      let completed = false;
      try {
        trackSessionActivity(message);
        await agentLoop.observeMessage(message);
        safeguardAuditTrail.append('discord.message.observed', {
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.authorId,
        });
        if (observedGroupMemoryScheduler) {
          try {
            const decision = await observedGroupMemoryScheduler.observeMessage(message);
            if (decision.status === 'scheduled') {
              safeguardAuditTrail.append('memory.group_observed.scheduled', {
                channelId: decision.channelId,
                messageId: message.id,
                triggerReason: decision.triggerReason,
                spanStartMessageId: decision.spanStartMessageId,
                spanEndMessageId: decision.spanEndMessageId,
                newEntryCount: decision.newEntryCount,
                watermarkLagMessageIds: decision.watermarkLagMessageIds,
                hasDeferredBacklog: decision.hasDeferredBacklog,
              });
            } else if (decision.reason === 'extraction_failed') {
              log.warn('Observed group memory extraction failed', {
                channelId: decision.channelId,
                messageId: message.id,
                watermarkLagMessageIds: decision.watermarkLagMessageIds,
                error: decision.error,
              });
              safeguardAuditTrail.append('memory.group_observed.error', {
                channelId: decision.channelId,
                messageId: message.id,
                reason: decision.reason,
                error: decision.error,
              });
            }
          } catch (schedulerError) {
            const errorText = toErrorMessage(schedulerError);
            log.warn('Observed group memory scheduling failed', {
              channelId: message.channelId,
              messageId: message.id,
              error: errorText,
            });
            safeguardAuditTrail.append('memory.group_observed.error', {
              channelId: message.channelId,
              messageId: message.id,
              error: errorText,
            });
          }
        }
        if (passiveNameCandidateBuilder) {
          try {
            const decision = await passiveNameCandidateBuilder.build(message);
            if (decision.status === 'created') {
              const { candidate } = decision;
              safeguardAuditTrail.append('participation.candidate.created', {
                channelId: candidate.channelId,
                sourceMessageId: candidate.sourceMessageId,
                trigger: candidate.trigger,
                matchedName: candidate.matchedName,
                matchedDirectAddress: candidate.matchedDirectAddress,
                precedingContextCount: candidate.precedingContext.length,
              });
              await eventBus.emit('participation.candidate', {
                channelId: candidate.channelId,
                sourceMessageId: candidate.sourceMessageId,
                outcome: 'created',
                trigger: candidate.trigger,
                matchedDirectAddress: candidate.matchedDirectAddress,
                precedingContextCount: candidate.precedingContext.length,
                timestamp: nowMonotonicMs(),
              });
              if (reservationPhase) {
                // Deterministic gate + reservation before appraisal (§8.5/§6.10):
                // a gated candidate never reaches the model call, and a reserved
                // candidate's reservation is released on an `ignore` outcome.
                await reserveAndAppraiseCandidate(candidate, reservationPhase);
              } else if (participationAppraiser) {
                await appraiseParticipationCandidate(candidate);
              }
            } else {
              safeguardAuditTrail.append('participation.candidate.suppressed', {
                channelId: decision.channelId,
                sourceMessageId: decision.sourceMessageId,
                reason: decision.reason,
                ...(decision.trigger ? { trigger: decision.trigger } : {}),
              });
              await eventBus.emit('participation.candidate', {
                channelId: decision.channelId,
                sourceMessageId: decision.sourceMessageId,
                outcome: 'suppressed',
                suppressionReason: decision.reason,
                ...(decision.trigger ? { trigger: decision.trigger } : {}),
                timestamp: nowMonotonicMs(),
              });
            }
          } catch (candidateError) {
            const errorText = toErrorMessage(candidateError);
            log.warn('Passive-name candidate gate failed', {
              channelId: message.channelId,
              messageId: message.id,
              error: errorText,
            });
            safeguardAuditTrail.append('participation.candidate.error', {
              channelId: message.channelId,
              messageId: message.id,
              error: errorText,
            });
            // Content-free bus event: the forensic error text stays on the audit
            // trail (§19 do-not-log list); the bus carries only the failed shape.
            await eventBus.emit('participation.candidate', {
              channelId: message.channelId,
              sourceMessageId: message.id,
              outcome: 'error',
              timestamp: nowMonotonicMs(),
            });
          }
        }
        completed = true;
      } catch (err) {
        const errorText = toErrorMessage(err);
        log.error('Error handling message', {
          channelId: message.channelId,
          messageId: message.id,
          error: errorText,
        });
        safeguardAuditTrail.append('discord.message.error', {
          channelId: message.channelId,
          messageId: message.id,
          error: errorText,
        });
      } finally {
        if (dedupeKey) {
          inFlightDiscordMessages.delete(dedupeKey);
          if (completed) {
            recentDiscordMessages.set(dedupeKey, Date.now());
          }
        }
      }
      return;
    }

    trackSessionActivity(message);
    const enqueuedMonotonicAtMs = nowMonotonicMs();
    void emitTurnPerformance(eventBus, {
      traceId: message.id,
      turnId: message.id,
      requestId: message.id,
      companionId,
      channelId: message.channelId,
      channelType: message.channelType,
      stage: 'transport_received',
      monotonicAtMs: enqueuedMonotonicAtMs,
    }).catch(error => log.warn('Discord transport performance telemetry emit failed', {
      messageId: message.id,
      error: toErrorMessage(error),
    }));
    discordPromptQueue.push({
      message,
      dedupeKey,
      enqueuedMonotonicAtMs,
      ...(retryDelivery ? { retryDelivery } : {}),
    });
    // The pump owns reply delivery, error reporting, and dedupe bookkeeping
    // for everything queued. Notification receipt must not await backend turn
    // work such as memory retrieval or model generation.
    void pumpDiscordQueue().catch((err: unknown) => {
      log.error('Discord message pump failed', {
        channelId: message.channelId,
        messageId: message.id,
        error: toErrorMessage(err),
      });
    });
  });

  // ── Inter-companion channel lane (sprint 10, W6) ──
  // Inbound peer messages run the NORMAL turn pipeline (fatigue, trust,
  // extraction) via agentLoop.handleMessage; the reply — when there is one —
  // goes back through the gateway's companion lane addressed to the same
  // channel, so the peer receives it as its own ordinary inbound turn. A
  // fatigue-suppressed turn returns empty content, which sends nothing: that
  // is exactly how a bot↔bot exchange terminates. No side-channel dispatch.
  const companionPromptQueue: SubstrateMessage[] = [];
  let companionPumpActive = false;

  const buildCompanionReplyDeliveryLifecycle = (
    message: SubstrateMessage,
    recoveredResponse?: AgentResponse,
    previousObservation?: IcpDeliveryObservation | null,
    sourceAlreadyPersisted = false,
  ) => createCompanionReplyDeliveryLifecycle({
    message,
    ...(recoveredResponse ? { recoveredResponse } : {}),
    ...(previousObservation !== undefined ? { previousObservation } : {}),
    ...(sourceAlreadyPersisted ? { sourceAlreadyPersisted: true } : {}),
    agent: agentLoop,
    gateway,
    ...(companionAuthorName ? { authorName: companionAuthorName } : {}),
    log,
  });

  const pumpCompanionQueue = async (): Promise<void> => {
    if (companionPumpActive) return;
    companionPumpActive = true;
    try {
      while (companionPromptQueue.length > 0) {
        const message = companionPromptQueue.shift()!;
        const dedupeKey = buildMessageDedupKey('companion', message);
        let completed = false;
        let failureReason: CompanionDeliveryFailureReason = 'processing_failed';
        try {
          const correlatedDeliveryLifecycle = message.routing?.icpCorrelation
            ? buildCompanionReplyDeliveryLifecycle(message)
            : undefined;
          const response = await promptWhenIdle(message, correlatedDeliveryLifecycle);
          await correlatedDeliveryLifecycle?.markTurnCompleted();
          if (response.attachments?.length) {
            // The companion lane carries text only for now; surface the drop
            // loudly instead of silently losing media.
            log.warn('Companion lane reply attachments are not deliverable; dropping media', {
              channelId: message.channelId,
              attachmentCount: response.attachments.length,
            });
          }
          if (!correlatedDeliveryLifecycle && response.content.trim()) {
            failureReason = 'reply_delivery_failed';
            await gateway.companionSend(
              message.channelId,
              response.content,
              companionAuthorName,
              message.id,
            );
          }
          completed = true;
        } catch (err) {
          await handleCompanionTurnFailure({
            error: err,
            channelId: message.channelId,
            messageId: message.id,
            failureReason,
            ports: {
              companionReportFailure: (reportParams) => gateway.companionReportFailure(reportParams),
              audit: safeguardAuditTrail,
              log,
            },
          });
        } finally {
          finalizeCompanionDelivery({
            dedupeKey,
            completed,
            inFlight: inFlightCompanionMessages,
            recent: recentCompanionMessages,
            finishedAt: Date.now(),
          });
        }
      }
    } finally {
      companionPumpActive = false;
    }
  };

  gateway.onCompanionMessage(async (message: SubstrateMessage) => {
    const dedupeKey = buildMessageDedupKey('companion', message);
    const now = Date.now();
    pruneDuplicateCaches(now);
    if (dedupeKey) {
      const seenAt = recentCompanionMessages.get(dedupeKey);
      if ((seenAt && now - seenAt < DUPLICATE_MESSAGE_WINDOW_MS)
        || inFlightCompanionMessages.has(dedupeKey)) {
        log.warn('Dropping duplicate companion notification message', {
          channelId: message.channelId,
          messageId: message.id,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'companion',
          channelId: message.channelId,
          messageId: message.id,
          disposition: inFlightCompanionMessages.has(dedupeKey) ? 'in_flight' : 'cached',
        });
        return;
      }
      // Own the deterministic envelope before any async durable lookup. A
      // concurrent arrival must never capture the same stale observation and
      // independently replay delivery/post-turn work.
      inFlightCompanionMessages.add(dedupeKey);
    }
    let handedToPump = false;
    try {
      let recordedSource: RecordedCompanionSourceMessage | null;
      try {
        normalizeTransportTimestamp(message);
        recordedSource = await agentLoop.findRecordedCompanionSourceMessage(
          message.channelId,
          message.id,
        );
        if (recordedSource && (recordedSource.correlation || message.routing?.icpCorrelation)) {
          bindRecordedCompanionSourceEnvelope(message, recordedSource);
        }
      } catch (error) {
        const errorText = toErrorMessage(error);
        log.error('Failed to read durable companion message dedupe state', {
          channelId: message.channelId,
          messageId: message.id,
          error: errorText,
        });
        safeguardAuditTrail.append('companion.message.durable_dedupe_error', {
          channelId: message.channelId,
          messageId: message.id,
          error: errorText,
        });
        try {
          await gateway.companionReportFailure({
            channelId: message.channelId,
            messageId: message.id,
            reason: 'processing_failed',
          });
        } catch (reportError) {
          const reportErrorText = toErrorMessage(reportError);
          log.error('Failed to report durable companion dedupe lookup failure', {
            channelId: message.channelId,
            messageId: message.id,
            error: reportErrorText,
          });
          safeguardAuditTrail.append('companion.message.failure_report_error', {
            channelId: message.channelId,
            messageId: message.id,
            reason: 'processing_failed',
            error: reportErrorText,
          });
        }
        return;
      }
      if (recordedSource) {
        if (message.routing?.icpCorrelation) {
          const recordedReply = await agentLoop.findRecordedIcpInitiation(message.channelId, message.id);
          const deliveryObservation = await agentLoop.findIcpDeliveryObservation(
            message.channelId,
            message.id,
          );
          if (deliveryObservation?.turnCompleted) {
            // The same source id already completed its ordinary delivery-gated
            // turn; fall through to the durable duplicate audit below.
          } else if (recordedReply || deliveryObservation?.recoveryResponse) {
            const recoveryResponse = deliveryObservation?.recoveryResponse
              ?? recordedReply?.recoveryResponse;
            if (!recoveryResponse?.metadata.icpCorrelation) {
              throw new Error('Durable ICP recovery response is missing correlation');
            }
            const parsedRecoveryResponse = parseIcpRecoveryResponse(recoveryResponse, {
              label: 'Durable companion recovery response',
              expectedChannelId: message.channelId,
              expectedSourceMessageId: message.id,
            });
            const recoveryCorrelation = parseIcpConversationCorrelation(
              parsedRecoveryResponse.metadata.icpCorrelation,
            );
            const recordedReplyCorrelation = recordedReply
              ? parseIcpConversationCorrelation(recordedReply.correlation)
              : null;
            if (recordedReplyCorrelation
              && JSON.stringify(recordedReplyCorrelation) !== JSON.stringify(recoveryCorrelation)) {
              throw new Error('Durable ICP recovery sources disagree on reply lineage');
            }
            if (!recordedSource.correlation) {
              throw new Error('Durable companion source is missing ICP correlation');
            }
            assertCompanionRecoveryLineage(
              recordedSource.correlation,
              recoveryCorrelation,
              message.id,
            );
            assertIcpRecoveryStatusBinding(
              deliveryObservation?.status,
              parsedRecoveryResponse,
              'Durable ICP recovery',
            );
            bindCompanionRecoveryCorrelation(
              message,
              recoveryCorrelation,
            );
            const lifecycle = buildCompanionReplyDeliveryLifecycle(
              message,
              parsedRecoveryResponse,
              deliveryObservation,
            );
            await promptWhenIdle(message, lifecycle);
            await lifecycle.markTurnCompleted();
            return;
          } else {
            const lifecycle = buildCompanionReplyDeliveryLifecycle(
              message,
              undefined,
              deliveryObservation,
              true,
            );
            await promptWhenIdle(message, lifecycle);
            await lifecycle.markTurnCompleted();
            return;
          }
        }
        log.warn('Dropping restart-replayed companion notification already present in L0', {
          channelId: message.channelId,
          messageId: message.id,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'companion',
          channelId: message.channelId,
          messageId: message.id,
          disposition: 'durable',
        });
        return;
      }

      log.info(`Companion message from ${message.authorName}: ${message.content.slice(0, 50)}...`, {
        channelId: message.channelId,
        authorId: message.authorId,
      });
      safeguardAuditTrail.append('companion.message.received', {
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.authorId,
      });

      trackSessionActivity(message);
      companionPromptQueue.push(message);
      handedToPump = true;
      void pumpCompanionQueue().catch((err: unknown) => {
        log.error('Companion message pump failed', {
          channelId: message.channelId,
          messageId: message.id,
          error: toErrorMessage(err),
        });
      });
    } finally {
      if (dedupeKey && !handedToPump) inFlightCompanionMessages.delete(dedupeKey);
    }
  });

  gateway.onCompanionDeliveryFailure(async (notification) => {
    log.warn('Peer companion could not process or answer a delivered message', notification);
    safeguardAuditTrail.append('companion.message.delivery_failed', notification);
    const observation: SubstrateMessage = {
      id: `companion-delivery-failure:${notification.messageId}:${notification.reportingCompanionId}`,
      channelId: notification.channelId,
      channelType: 'companion',
      authorId: 'system:companion-delivery',
      authorName: 'Companion Delivery',
      content: `Message ${notification.messageId} could not be completed by companion `
        + `${notification.reportingCompanionId} (${notification.reason}).`,
      timestamp: new Date(notification.reportedAt),
      routing: {
        source: 'companion',
        responseMode: 'observe',
      },
    };
    try {
      trackSessionActivity(observation);
      await agentLoop.observeMessage(observation);
    } catch (err) {
      const errorText = toErrorMessage(err);
      log.error('Failed to record companion delivery failure observation', {
        channelId: notification.channelId,
        messageId: notification.messageId,
        error: errorText,
      });
      safeguardAuditTrail.append('companion.message.delivery_failure_observation_error', {
        channelId: notification.channelId,
        messageId: notification.messageId,
        error: errorText,
      });
    }
  });

  return {
    icpTargetChannelInitiator: createIcpTargetChannelInitiator({
      localCompanionId: resolveCompanionIdFromConfig(config),
      agent: agentLoop,
      gateway: {
        sendInitiation: (input) => gateway.companionSendInitiation(input),
        consumeInitiationPermit: (input) => gateway.companionConsumeInitiationPermit(input),
      },
      ...(companionAuthorName ? { authorName: companionAuthorName } : {}),
    }),
  };
}
