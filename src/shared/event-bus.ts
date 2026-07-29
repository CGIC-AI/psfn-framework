import type {
  SubstrateMessage,
  AgentResponse,
  IntentionalNoReplyMetadata,
  ModelBudgetBlockedEvent,
  ParentTurnContinuationStop,
  TurnUsage,
  InferredPostTurnAction,
  CorrelationMetadata,
  LLMCapturedProviderWirePayload,
  LLMStreamFirstOutputObservation,
  RunChargeEvent,
  FatigueBudgetEvent,
} from './contracts/runtime-base.js';
import type { TurnSnapshot } from '../core/turns/snapshot.js';
import type { SessionRouteResetMode } from '../core/session/session-routes.js';
import type {
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolSnapshotTelemetry,
} from '../core/agent/adaptive-tools-telemetry.js';
import type { CompletionHandoffRecord } from './contracts/completion-handoff.js';
import type { HumanAttentionPressureEvent } from '../core/agent/fatigue/human-attention-pressure.js';
import type { PlaceKind } from './contracts/places-registry.js';
import type { SatelliteTelemetryAuthContext } from './contracts/satellite-registry.js';
import type { IcpAvailabilityState, IcpInitiationCandidateStatus } from './contracts/icp-autonomy.js';
import type {
  ParticipationAction,
  ParticipationCandidateTrigger,
  ParticipationSuppressionReason,
} from '../core/participation/types.js';
import type {
  ReservationGateBlockReason,
  ReservationGateErrorStage,
} from '../core/agent/arbiter/reservation-phase.js';
import type {
  EgressLeaseErrorStage,
  EgressLeaseOutcome,
} from '../core/agent/arbiter/egress-lease-phase.js';
import type {
  AcquireEgressLeaseDeclineReason,
  RoomEpisodeBreakerState,
} from '../core/agent/arbiter/speaking-arbiter-store-port.js';
import type { RoomEpisodeCircuitBreakerFiring } from '../core/agent/fatigue/room-episode-circuit-breaker.js';
import type { SocialPotEnforcementOutcome } from '../core/agent/fatigue/social-pot-enforcement.js';
import type { PartnerAffectShadowTelemetryEvent } from './contracts/partner-affect.js';
import type { IcpConversationCostBreakerEvent } from './telemetry/model-usage.js';
import type { TurnPerformanceEvent } from './telemetry/turn-performance.js';
import type { ToolCallOutcome } from './contracts/tool-call-outcome.js';
import type { ContextCoherenceEvent } from './contracts/context-coherence.js';
import type {
  CompanionApprovalRequestedPayload,
  CompanionApprovalResolvedPayload,
  CompanionArtifactCreatedPayload,
  CompanionArtifactPreviewSource,
  CompanionEmotionSnapshotPayload,
  CompanionEmotionSnapshotTrigger,
  CompanionToolActivityPayload,
} from './contracts/companion-relay.js';
import type { AcacAxis, VADVector } from './contracts/emotion-contracts.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('EventBus');

// ── Event map: all typed events in the system ──

export interface ExternalTelemetryEvent {
  id: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
  nonce: string;
  channelId?: string;
  scope?: string;
  /**
   * Authenticated origin context stamped at the API telemetry ingress
   * (Sprint-10 finding 04-M1). Consumers that resolve a satellite origin
   * MUST fail closed when this is absent: payload-claimed satellite ids are
   * never trusted without the credential that authenticated the request.
   */
  auth?: SatelliteTelemetryAuthContext;
}

export type PerceptionBridgeTelemetryCounter =
  | 'delivered'
  | 'malformed'
  | 'unrecognized'
  | 'duplicate'
  | 'sink_error';

export interface PerceptionBridgeTelemetryEvent {
  counter: PerceptionBridgeTelemetryCounter;
  reason: string;
  eventId?: string;
  rawEventType?: string;
  source?: string;
  scope?: string;
  channelId?: string;
  satelliteId?: string;
  placeId?: string;
  perceptionKind?: 'presence' | 'identity_claim';
  timestamp: number;
}

type EventCorrelationFields = Partial<CorrelationMetadata>;

/**
 * Shared shape for deterministic pre-LLM gate outcomes (jpvd.4). Every
 * recurring LLM pass that is gated by `evaluateDeterministicGate` emits one of
 * these: `ran` when the gate opened (the LLM pass fired), `skipped` when it
 * closed (zero LLM spend). `reason` carries the gate reason and `inputs` echoes
 * the deterministic signals so the Garden subsystem-health view can show why.
 */
export interface DeterministicGateEvent {
  lane: string;
  outcome: 'ran' | 'skipped';
  reason: string;
  inputs: Record<string, number | string>;
  timestamp: number;
  sessionId?: string;
  channelId?: string;
}

/**
 * Outcome of one participation-appraiser run (bible §8.2). Content-free faculty
 * telemetry: the ternary decision, its advisory reason/confidence, and whether
 * the decision was a fail-closed `ignore` (disabled/timeout/error/malformed)
 * rather than a real model choice. Cost/billing is attributed separately via the
 * call's correlation metadata; this event is the decision-level record.
 */
export interface ParticipationAppraisalEvent {
  channelId: string;
  sourceMessageId: string;
  trigger: 'direct_mention' | 'passive_name';
  action: 'ignore' | 'react' | 'reply';
  reasonCode: string;
  confidence: number;
  failClosed: boolean;
  timestamp: number;
}

/**
 * Passive-name / direct-mention participation candidate lifecycle (bible §8.2,
 * §19; jp36.8.3). Content-free companion telemetry: the deterministic-gate
 * outcome plus ids/enums/counts only — never the matched name string, the
 * triggering message text, or preceding-room content (only its count). Mirrors
 * the richer `participation.candidate.*` audit trail, which retains the forensic
 * error text this bus event deliberately omits (§19 do-not-log list).
 */
export interface ParticipationCandidateEvent {
  channelId: string;
  /** The room message that produced (or would have produced) the candidate. */
  sourceMessageId: string;
  outcome: 'created' | 'suppressed' | 'error';
  /** created/suppressed only: the deterministic trigger class. */
  trigger?: ParticipationCandidateTrigger;
  /** created only: the match was an explicit direct address, not a bare name. */
  matchedDirectAddress?: boolean;
  /** created only: count of preceding-context messages (never their content). */
  precedingContextCount?: number;
  /** suppressed only: why the deterministic gate dropped the candidate. */
  suppressionReason?: ParticipationSuppressionReason;
  timestamp: number;
}

/**
 * Speaking-reservation lifecycle before/after appraisal (bible §8.5/§12.2,
 * §19; jp36.5.1.2). Content-free: gate reason, opaque reservation/episode ids,
 * and the settlement enum — no room text. Mirrors the
 * `participation.reservation.*` audit trail (which additionally keeps forensic
 * error text this event omits per the §19 do-not-log list).
 */
export interface ParticipationReservationEvent {
  channelId: string;
  sourceMessageId: string;
  trigger: ParticipationCandidateTrigger;
  outcome: 'gated' | 'reserved' | 'settled' | 'error';
  /** gated only: which deterministic gate blocked the reservation. */
  blockedBy?: ReservationGateBlockReason;
  /** gated + `icp_availability` only: the specific non-open availability state. */
  availabilityState?: Exclude<IcpAvailabilityState, 'available' | 'open_to_chat'>;
  /** gated + `gate_error` only: the stage that failed. */
  errorStage?: ReservationGateErrorStage;
  /** reserved/settled/error: the opaque reservation id. */
  reservationId?: string;
  /** reserved only: the opaque room-episode id the reservation joined. */
  episodeId?: string;
  /** reserved only: a durable reservation already existed for this room event. */
  replayed?: boolean;
  /** settled only: the appraised action the reservation settled against. */
  action?: ParticipationAction;
  /** settled only: whether the reservation was released or retained for egress. */
  settlement?: 'released' | 'retained';
  timestamp: number;
}

/**
 * Exclusive egress-lease result for a retained react/reply reservation (bible
 * §8.5, §19; jp36.5.1.3). Content-free: the terminal lease outcome plus the
 * Law-36 breaker state, social-pot draw outcome, fairness yield target (opaque
 * companion id), and error stage — never the generated reply or trigger text.
 * Mirrors the `participation.egress.*` audit trail.
 */
export interface ParticipationEgressEvent {
  channelId: string;
  sourceMessageId: string;
  trigger: ParticipationCandidateTrigger;
  reservationId: string;
  outcome: 'settled' | 'error';
  /** settled only: the appraised action handed to the egress phase. */
  action?: ParticipationAction;
  /** settled only: the terminal egress-lease outcome. */
  leaseOutcome?: EgressLeaseOutcome;
  /** settled only: an acquire decline reason (held / already delivered). */
  declineReason?: AcquireEgressLeaseDeclineReason;
  /** settled only: the social-pot enforcement outcome for the turn's draw. */
  drawOutcome?: SocialPotEnforcementOutcome;
  /** settled only: the Law-36 room-episode breaker state at the decision. */
  breakerState?: RoomEpisodeBreakerState;
  /**
   * settled only, present ONLY on a fresh trip (transition into `open`): the
   * charter §8.11 auditable firing record. Fully structural — enums, numbers,
   * and the channel id only (pressure/thresholds/contributing signals/
   * attribution:system_circuit_breaker) — never companion prose or trigger text.
   */
  breakerFiring?: RoomEpisodeCircuitBreakerFiring;
  /** settled + `yielded_speak_least` only: the opaque winner companion id. */
  yieldedTo?: string;
  /** settled + `gate_error` only: the stage that failed. */
  errorStage?: EgressLeaseErrorStage;
  timestamp: number;
}

export const GARDEN_QUEUE_NAMES = [
  'confirmations',
  'contact-approvals',
  'graph-proposals',
  'intake-quarantine',
] as const;

export type GardenQueueName = typeof GARDEN_QUEUE_NAMES[number];

export function isGardenQueueName(value: unknown): value is GardenQueueName {
  return typeof value === 'string'
    && (GARDEN_QUEUE_NAMES as readonly string[]).includes(value);
}

export interface EventMap {
  'icp.availability.changed': {
    companionId: string;
    action: 'published' | 'cleared';
    state?: import('./contracts/icp-autonomy.js').IcpAvailabilityState;
    source?: import('./contracts/icp-autonomy.js').IcpAvailabilitySource;
    revision: number;
    expiresAtMs?: number;
    timestamp: number;
  };
  'icp.initiation.gate': {
    candidateId: string;
    senderCompanionId: string;
    recipientCompanionId: string;
    channelId: string;
    outcome: 'open' | 'closed';
    reasonCode?: import('./contracts/icp-autonomy.js').IcpAutonomyReasonCode;
    reasonClass?: 'deferrable' | 'terminal';
    timestamp: number;
  };
  /** Content-free companion-local candidate lifecycle projection. */
  'icp.initiation.candidate.lifecycle': {
    candidateId: string;
    localCompanionId: string;
    peerCompanionId: string;
    source: import('./contracts/icp-autonomy.js').IcpInitiationSource;
    previousStatus: IcpInitiationCandidateStatus | null;
    status: IcpInitiationCandidateStatus;
    reasonCode?: import('./contracts/icp-autonomy.js').IcpAutonomyReasonCode;
    timestamp: number;
  };
  'icp.permit.lifecycle': {
    candidateId: string;
    conversationId: string;
    senderCompanionId: string;
    recipientCompanionId: string;
    channelId: string;
    action: 'issued' | 'consumed' | 'revoked' | 'expired' | 'replayed' | 'mismatch' | 'not_found';
    reasonCode?: import('./contracts/icp-autonomy.js').IcpAutonomyReasonCode;
    timestamp: number;
  };
  'message.received': { message: SubstrateMessage } & EventCorrelationFields;
  'message.sent': { response: AgentResponse } & EventCorrelationFields;
  'agent.turn.start': { message: SubstrateMessage } & EventCorrelationFields;
  'agent.turn.snapshot': { snapshot: TurnSnapshot } & EventCorrelationFields;
  'agent.turn.end': { message: SubstrateMessage; response: AgentResponse } & EventCorrelationFields;
  'session.context.stale_window_heal': {
    channelId: string;
    turnId: string;
    requestId: string;
    expectedMinEntryId: number;
    staleWindowMaxEntryId: number | null;
    reconciledMaxEntryId: number | null;
    recapturedWindowMaxEntryId: number | null;
    healed: boolean;
    timestamp: number;
  };
  'session.context.stale_window_heal_failed': {
    channelId: string;
    turnId: string;
    requestId: string;
    expectedMinEntryId: number;
    staleWindowMaxEntryId: number | null;
    error: string;
    timestamp: number;
  };
  'context.coherence.detected': ContextCoherenceEvent;
  /** Content-free terminal event emitted when the parent-turn emergency fuse opens. */
  'agent.turn.continuation_stopped': {
    turnId: string;
    requestId: string;
    channelId: string;
    stop: ParentTurnContinuationStop;
    timestamp: number;
  } & EventCorrelationFields;
  'session.route.reset': {
    sourceChannelId: string;
    oldLogicalSessionId: string;
    newLogicalSessionId: string;
    routeGeneration: number;
    mode: SessionRouteResetMode;
    actor: string;
    reason: string;
    timestamp: number;
  };
  'agent.post_turn.actions.inferred': {
    message: SubstrateMessage;
    response: AgentResponse;
    actions: InferredPostTurnAction[];
  } & EventCorrelationFields;
  'agent.post_turn.action.telemetry': {
    actionId: string;
    actionKind: string;
    channelId?: string;
    sourceMessageId?: string;
    dedupeKey: string;
    capability: 'generic' | 'subagent_spawn';
    runtimeClass:
      | 'foreground_chat'
      | 'post_turn_appraisal'
      | 'background_continuation'
      | 'maintenance_reflection';
    chargeLane: 'interactive' | 'companion_social' | 'background' | 'maintenance' | 'subagent' | 'shard';
    phase:
      | 'queued'
      | 'deduplicated'
      | 'started'
      | 'succeeded'
      | 'rescheduled'
      | 'retry_scheduled'
      | 'failed'
      | 'dropped_budget'
      | 'cancelled'
      | 'acknowledged'
      | 'malformed_dropped';
    attempt: number;
    maxAttempts: number;
    queueDepth: number;
    timestamp: number;
    nextRetryAt?: number;
    delayMs?: number;
    error?: string;
    rawType?: string;
  };
  'agent.post_turn.drain': {
    channelId: string;
    phase: 'registered' | 'wait_started' | 'drained' | 'timeout';
    turnId?: string;
    requestId?: string;
    previousChannelId?: string;
    previousTurnId?: string;
    previousRequestId?: string;
    workCount: number;
    taskNames: string[];
    waitMs?: number;
    timeoutMs?: number;
    failureCount?: number;
    timestamp: number;
  } & EventCorrelationFields;
  'context.feedback.telemetry': {
    actionId: string;
    turnId: string;
    channelId: string;
    phase: 'started' | 'scored' | 'persisted' | 'failed';
    score?: number;
    scoreBucket?: 'low' | 'medium' | 'high';
    signals?: {
      confabulation: boolean;
      missed_context: boolean;
      wasted_tokens: boolean;
      good: boolean;
    };
    followUpIncluded?: boolean;
    memoryId?: string;
    error?: string;
    timestamp: number;
  };
  'agent.completion_handoff': {
    handoff: CompletionHandoffRecord;
    targetChannelId?: string;
    noticeBuffered?: boolean;
    noticeDelivery?: 'active_nudge' | 'buffered';
    timestamp: number;
  } & EventCorrelationFields;
  'agent.human_attention_pressure': HumanAttentionPressureEvent;
  // Lightweight near-turn memory lane fire-rate telemetry (E5.2). The lane
  // replaced the old turn-based "sleeptime" cadence; heavy passes now run
  // only from the rest-window scheduler task.
  'memory.near_turn.cadence': {
    channelId: string;
    sessionId: string;
    scope: 'direct' | 'group';
    turnCount: number;
    newEntriesSinceLastRun: number;
    firedAtMs: number;
    firesLastHour: number;
    timestamp: number;
  };
  // Deterministic episode-synthesis trigger gate outcome (E5.3). Every skip
  // carries a reason so the Garden subsystem-health view can display why the
  // lane did or did not process (zero LLM spend on skips).
  'memory.episode_synthesis.gate': {
    sessionId: string;
    channelId: string;
    trigger: 'timer' | 'turn_threshold';
    outcome: 'processed' | 'skipped';
    reason?: 'no_new_messages' | 'below_relevance_minimum' | 'session_retired';
    newEntryCount: number;
    relevantTurnCount: number;
    minRelevantTurns: number;
    timestamp: number;
  };
  // Contextual topic-cutting outcome per gated chunk (E5.4). A malformed
  // segmentation proposal fails closed: outcome 'failed', no episode written
  // for the chunk, nothing claimed, watermark not advanced past the chunk.
  'memory.episode_synthesis.segmentation': {
    sessionId: string;
    channelId: string;
    outcome: 'segmented' | 'failed';
    chunkEntryCount: number;
    segmentCount: number;
    heldBackEntryCount: number;
    error?: string;
    timestamp: number;
  };
  // Nightly sleep-cycle consolidation failed closed for one candidate
  // cluster (m58.1): malformed or failed LLM thematic grouping leaves the
  // candidates untouched and surfaces here instead of being swallowed.
  'memory.sleep_consolidation.failure': {
    sessionId: string;
    scopeKey: string;
    candidateEpisodeIds: string[];
    stage: 'thematic_grouping';
    error: string;
    timestamp: number;
  };
  // Arc-formation pass rejected a proposal or failed a judgment (m58.2).
  // Malformed LLM arc proposals fail closed per proposal — never partially
  // applied, never swallowed silently.
  'memory.arc_formation.outcome': {
    sessionId: string;
    outcome: 'proposal_rejected' | 'judgment_failed';
    reason: string;
    label?: string;
    confidence?: number;
    timestamp: number;
  };
  // Topic-thread materialization outcome (apq0): an arc-driven thread union
  // merged two topic threads, no-oped (already unified), extracted a legacy
  // session-keyed endpoint into its own singleton topic thread, or was skipped
  // fail-safe because the losing thread exceeded the write-amplification cap.
  // Oversize skips are surfaced here, never silently mis-threaded.
  'memory.episodic.thread_assignment': {
    outcome: 'merged' | 'noop' | 'merge_skipped_oversize' | 'legacy_session_thread_extracted';
    winningThreadId: string;
    losingThreadId: string;
    updatedEpisodeCount: number;
    timestamp: number;
  };
  // Deterministic pre-LLM gate outcomes (jpvd.4). One per recurring LLM pass;
  // a `skipped` outcome means the gate closed and the pass spent zero tokens.
  // Reasons + inputs surface on the Garden subsystem-health lanes.
  //   - orientation rewrite: nightly core-memory orient-block rewrite, gated on
  //     evidence of change since the last rewrite (new transcript turns / stale
  //     with activity). Skipping is the common case on quiet days.
  //   - dream meaning: nightly first-person meaning pass, gated on cadence and
  //     new consolidated episodes without a meaning.
  //   - sleep-consolidation refinement: bounded LLM cleanup, gated on the count
  //     of unrefined episodes in reach with transcript coverage.
  //   - emotion appraisal: gated on turn cadence OR VAD movement magnitude.
  //   - concern candidate review: pending-count and turn-interval gates.
  // The extraction pre-LLM gate uses the same primitive but keeps surfacing its
  // skips through memory.extraction.end telemetry (no direct event-bus handle).
  'memory.orientation_rewrite.gate': DeterministicGateEvent;
  'memory.dream_meaning.gate': DeterministicGateEvent;
  'memory.sleep_consolidation.refinement_gate': DeterministicGateEvent;
  'memory.sleeptime_wiki.gate': DeterministicGateEvent;
  'emotion.appraisal.gate': DeterministicGateEvent;
  'intention.concern_candidate.gate': DeterministicGateEvent;
  // Participation appraiser outcome (bible §8.2): the tool-less ternary decision
  // over a datamarked summons, emitted per created candidate on the observe path.
  'participation.appraisal': ParticipationAppraisalEvent;
  // Participation lifecycle telemetry (bible §19, jp36.8.3): the passive-name
  // candidate gate, the two-phase speaking reservation, and the exclusive
  // egress lease, each promoted from the audit-only trail to a typed,
  // content-free bus event the Fleet Command telemetry views consume. Payloads
  // carry ids/enums/counts only — the §19 do-not-log list (room/DM/journal text,
  // matched name strings, forensic error text) stays on the audit trail alone.
  'participation.candidate': ParticipationCandidateEvent;
  'participation.reservation': ParticipationReservationEvent;
  'participation.egress': ParticipationEgressEvent;
  //   - reflection template novelty: cadence-fired reflection
  //     templates, gated on new scope entries since the template's last
  //     reflection run. Manual run_template invocations bypass the gate.
  'reflection.template.novelty.gate': DeterministicGateEvent;
  // Social-graph builder worker completion (E4.2). Law 31: results are visible,
  // never silent — Garden renders the proposal queue and these counts.
  'memory.social_graph.builder': {
    scanned: number;
    proposed: number;
    conflicts: number;
    skippedUntracked: number;
    deduped: number;
    watermarkAdvancedToMs: number;
    runAtMs: number;
    timestamp: number;
  };
  /** Authenticated Garden refresh hint. Never carries queue entries, ids, or content. */
  'garden.queue.changed': {
    queue: GardenQueueName;
    /** Gateway-internal owner used only to route the hint to one companion. */
    companionId?: string;
    timestamp: number;
  };
  'agent.tools.adaptive.decision': AdaptiveToolDecisionTelemetry & EventCorrelationFields;
  'agent.tools.adaptive.snapshot': AdaptiveToolSnapshotTelemetry & EventCorrelationFields;
  'agent.tools.documentation_search': {
    timestamp: number;
    query: string | null;
    limit: number;
    totalMatches: number;
    matchedTools: string[];
  };
  'agent.turn.stage': {
    turnId: string;
    channelId: string;
    stage: string;
    elapsedMs: number;
    [key: string]: unknown;
  };
  /** Content-free monotonic foreground timing envelope (mmo9.2). */
  'agent.turn.performance': TurnPerformanceEvent;
  /**
   * Runtime datetime-contradiction guard activation (psfn-framework-upx0.13).
   * Content-free Garden-visible telemetry: signal ids, attempt count, and the
   * guard outcome only — never the companion's response text.
   * `retry_scheduled` fires when the first detection triggers the
   * strengthened-anchor retry; `retry_cleared` when the retried response no
   * longer disputes the anchor; `system_note_appended` when the retry still
   * disputed it and the concern was surfaced as a system note while her reply
   * stayed verbatim (psfn-framework-zagpk).
   */
  'agent.datetime_guard.activation': {
    channelId: string;
    turnId: string;
    stage: 'initial' | 'retry';
    outcome: 'retry_scheduled' | 'retry_cleared' | 'system_note_appended';
    matchedSignals: string[];
    attempts: number;
    timestamp: number;
  } & EventCorrelationFields;
  /** First substantive text/thinking/tool event observed at the provider stream boundary. */
  'agent.provider.first_output': LLMStreamFirstOutputObservation & {
    provider: string;
    model: string;
  } & EventCorrelationFields;
  /** True provider wire body captured as-sent for one provider call (bead hgw3-80f6). */
  'agent.provider.payload_captured': {
    payload: LLMCapturedProviderWirePayload;
    provider: string;
    model: string;
  } & EventCorrelationFields;
  'agent.turn.usage': { message: SubstrateMessage; usage: TurnUsage } & EventCorrelationFields;
  /** An optional prompt section was dropped because macros stayed unresolved (E2.5 no-silent-leak). */
  'agent.prompt.section_dropped': {
    channelId: string;
    turnId?: string;
    sectionLabel: string;
    unresolvedTokens: string[];
  } & EventCorrelationFields;
  'agent.no_reply.intentional': IntentionalNoReplyMetadata & EventCorrelationFields;
  'agent.charge': RunChargeEvent;
  'agent.fatigue': FatigueBudgetEvent;
  'agent.stream.delta': { channelId: string; text: string } & EventCorrelationFields;
  'agent.stream.thinking': { channelId: string; text: string } & EventCorrelationFields;
  'api.turn.abort': {
    channelId: string;
    reason: 'timeout' | 'client_disconnected';
  } & EventCorrelationFields;
  'agent.toolcall.start': {
    channelId: string;
    contentIndex: number;
    toolCallId?: string;
    toolName?: string;
    shardId?: string;
  } & EventCorrelationFields;
  'agent.toolcall.delta': {
    channelId: string;
    contentIndex: number;
    delta: string;
    toolCallId?: string;
    toolName?: string;
    shardId?: string;
  } & EventCorrelationFields;
  'agent.toolcall.end': {
    channelId: string;
    contentIndex: number;
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    shardId?: string;
  } & EventCorrelationFields;
  'agent.tool.start': { channelId: string; toolCallId: string; toolName: string; shardId?: string } & EventCorrelationFields;
  'agent.tool.end': {
    channelId: string;
    toolCallId: string;
    toolName: string;
    outcome: ToolCallOutcome;
    isError: boolean;
    errorMessage?: string;
    shardId?: string;
  } & EventCorrelationFields;
  // Agent-process emotion snapshot source (bead psfn-framework-7ang.1). Carries
  // a CONTENT-FREE numeric projection of `InternalState.emotional` (VAD/mood,
  // discrete scores, confidence, ACAC axis SCORES only — never rationale text,
  // concerns, or salient entities). The companion event forwarder redacts and
  // forwards these to the gateway relay; nothing else consumes them. Fired on
  // the steady per-turn cadence (`post_turn`) and on `vad_shift` appraisal.
  'agent.emotion.snapshot': {
    trigger: CompanionEmotionSnapshotTrigger;
    vad: VADVector;
    mood: VADVector;
    discrete: Record<string, number>;
    confidence: number;
    /** ACAC axis scores only; never the axis rationale text. */
    acacAxisScores?: Partial<Record<AcacAxis, number>>;
    channelId?: string;
    timestamp: number;
  };
  'agent.compaction.start': {
    channelId: string;
    reason: 'threshold' | 'overflow';
    tokensBefore: number;
    tokenBudget: number;
  };
  'agent.compaction.end': { channelId: string; tokensBefore: number; tokensAfter: number };
  'agent.retry.start': {
    channelId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: string;
  };
  'agent.retry.end': { channelId: string; success: boolean; attempt: number };
  'agent.analysis_workbench.trace': {
    timestamp: number;
    task: string;
    result: {
      iterations: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      durationMs: number;
      truncated: boolean;
      budgetStop: string | null;
      subQueries: number;
      toolCalls: number;
      sessionCostUsd: number;
      warnings: string[];
      nestedAnalysis: {
        nestedAnalysisCallCount: number;
        nestedAnalysisSuccessCount: number;
        nestedAnalysisFailureCount: number;
        maxNestedAnalysisDepthReached: number;
      };
      steps: Array<{
        iteration: number;
        timestamp: number;
        code: string;
        output: string;
        error: string | null;
        inputTokens: number;
        outputTokens: number;
        cumulativeTokens: number;
        durationMs: number;
        variablesChanged: string[];
      }>;
    };
  } & EventCorrelationFields;
  'agent.error': { message: SubstrateMessage; error: Error } & EventCorrelationFields;
  'memory.extraction.start': { channelId: string; triggerReason?: string } & EventCorrelationFields;
  'memory.extraction.end': {
    channelId: string;
    count: number;
    triggerReason?: string;
    triggerContactId?: string;
    routedContactIds?: string[];
    sourceSpeakerNames?: string[];
    coveredUpToMessageId?: number;
    parsedCount?: number;
    acceptedCount?: number;
    rejectedCount?: number;
    writeCount?: number;
    deduplicatedCount?: number;
    supersededCount?: number;
    rejectionBreakdown?: Record<string, number>;
    routedFactCount?: number;
    ambiguousSpeakerSkippedCount?: number;
    ambiguousSpeakerSkipReasons?: Record<string, number>;
    writeCapSkips?: Array<{
      reason: string;
      skippedCount: number;
      configuredLimit: number;
      affectedContactIds?: string[];
      affectedSubjectContactIds?: string[];
      affectedClasses?: string[];
      affectedScopeRefs?: Array<{
        kind: string;
        id: string;
        label?: string;
      }>;
    }>;
    compositionalMode?: 'single_pass' | 'chunk_compose';
    chunkCount?: number;
    mergedFactCount?: number;
    crossChunkDeduplicatedCount?: number;
    boundaryFactCount?: number;
  } & EventCorrelationFields;
  'intention.concern_candidate.enqueued': {
    candidateCount: number;
    pendingCount: number;
    candidateIds: string[];
    channelId: string;
    turnId?: string;
    timestamp: number;
  } & EventCorrelationFields;
  'intention.concern_candidate.reviewed': {
    candidateCount: number;
    outcomeCount: number;
    outcomes: Array<{
      candidateId: string;
      action: string;
      status: string;
      reason: string;
      concernId?: string;
      routeTarget?: string;
    }>;
    timestamp: number;
  } & EventCorrelationFields;
  'intention.concern.groomed': {
    staleResolvedCount: number;
    capResolvedCount: number;
    activeCountBeforeCap: number;
    activeCountAfterCap: number;
    routedCount?: number;
    blockedRouteCount?: number;
    timestamp: number;
  } & EventCorrelationFields;
  // Durable handoff of a routed concern outcome into an existing substrate
  // (north-star, reflection journal, etc.). Emitted by ConcernRouteDispatcher so
  // Garden intention/subsystem-health surfaces can show routed vs blocked routes.
  'intention.concern.routed': {
    target: string;
    source: string;
    substrate: string;
    reason: string;
    targetRef?: string;
    candidateId?: string;
    concernId?: string;
    timestamp: number;
  } & EventCorrelationFields;
  // A route decision that could not hand off (no configured handler, invalid
  // handler, or handler failure). Surfaced explicitly; the source item is never
  // silently dropped and concerns are not reopened on routing failure.
  'intention.concern.route_blocked': {
    target: string;
    source: string;
    substrate: string;
    reason: string;
    candidateId?: string;
    concernId?: string;
    timestamp: number;
  } & EventCorrelationFields;
  // Resolution-as-appraisal (vw3w.1): emitted when a concern resolves and both a
  // formation VAD and a resolution VAD are available. Carries the relief delta
  // (resolutionVad − formationVad) with NO forced valence sign — resolution may
  // read as relief, release, or anticlimax (charter 8.3). The symmetric
  // counterpart to the formation snapshot; feeds downstream appraisal/memory
  // integration (sibling work) rather than mutating emotion state directly.
  'intention.concern.resolution_appraisal': {
    concernId: string;
    /** Stable identity of this active-to-terminal concern generation. */
    resolutionGenerationId: string;
    /** Which resolve path produced the appraisal. */
    source: 'decision' | 'grooming_stale' | 'grooming_cap';
    formationVad: { valence: number; arousal: number; dominance: number };
    resolutionVad: { valence: number; arousal: number; dominance: number };
    /** resolutionVad − formationVad, component-wise. Sign is preserved as-is. */
    reliefDelta: { valence: number; arousal: number; dominance: number };
    resolvedAt?: string;
    timestamp: number;
  } & EventCorrelationFields;
  'memory.extraction.flush': {
    channelId: string;
    templateId: string;
    templateName: string;
    timeoutMs: number;
    waitMs: number;
    phase: 'completed' | 'failed' | 'timeout';
    canonicalContactId?: string;
    error?: string;
  } & EventCorrelationFields;
  'memory.retrieval': {
    channelId: string;
    accessScope?: 'channel_participant' | 'companion_self_reflection' | 'companion_self_creation';
    count: number;
    candidates?: number;
    ranked?: number;
    returned?: number;
    candidateCount?: number;
    episodicChainCount?: number;
    episodicEpisodeCount?: number;
    rankedCount?: number;
    returnedCount?: number;
    reason?: string;
    retrievalSource?: 'embedding' | 'lexical_fallback';
    channelVisibility?: string;
    visibilityScope?: 'public_only' | 'approved_private_context' | 'non_broadcast';
    operatorApproval?: boolean;
    provenanceRefs?: string[];
	    policyAllowedCount?: number;
	    sessionQuarantineRejectedCount?: number;
	    roomVisibilityRejectedCount?: number;
    contactScopeRejectedCount?: number;
    sensitivityRejectedCount?: number;
    policyRejectedCount?: number;
    policyRejectedReasonTags?: Record<string, number>;
    withheldCount?: number;
    withheldReasonCounts?: Record<string, number>;
    withheldRelevanceBands?: Record<string, number>;
    scoreRejectedCount?: number;
    retrievalLimit?: number;
    retrievalBudgetPct?: number;
    retrievalTokenBudget?: number;
    retrievalLimitMode?: 'budget' | 'hard_limit';
    budgetCappedCount?: number;
    selectedTypes?: Record<string, number>;
    compositionalMode?: 'disabled_policy' | 'llm_unavailable' | 'insufficient_candidates' | 'malformed_or_failed' | 'applied';
    compositionalCandidateCount?: number;
    compositionalEvaluationBatchCount?: number;
    compositionalFinalistCount?: number;
    embeddingCalls?: number;
    searchCalls?: number;
    stageTimingsMs?: Record<string, number>;
  } & EventCorrelationFields;
  /**
   * E8.3: outcome of a wiki pgvector projection write (store write-hook or a
   * rebuild pass). The projection is a rebuildable mirror; an embedding or
   * write failure fails closed for semantic search (`outcome: 'failed'`) while
   * the canonical workspace document is untouched and the wiki write itself is
   * never blocked. Feeds the `wiki_projection_rag` subsystem-health lane.
   */
  'wiki.projection.sync': {
    documentId: string;
    /** s10f9: present when the write hit the SHARED-WORLD projection for a site. */
    siteId?: string;
    outcome: 'ran' | 'failed';
    chunkCount: number;
    error?: string;
    timestamp: number;
  };
  /**
   * E8.3: outcome of the supplemental wiki RAG retrieval for a chat turn. It is
   * deterministically gated (config flag, similarity threshold, context class)
   * and does not run every turn; a closed gate emits `outcome: 'skipped'` with
   * a reason and spends zero embedding calls. Wiki context never displaces
   * memory context. Feeds the `wiki_projection_rag` subsystem-health lane.
   */
  'wiki.retrieval': {
    channelId: string;
    outcome: 'ran' | 'skipped' | 'degraded';
    reason?: string;
    contextClass?: 'dm' | 'group' | 'focus';
    candidateCount?: number;
    selectedCount?: number;
    tokenCap?: number;
    tokenCount?: number;
    error?: string;
    timestamp: number;
  } & EventCorrelationFields;
  /**
   * mmo9.7.4: a foreground turn proceeded without a fresh wiki cached snapshot.
   * Mirrors `memory.active_context.turn_degraded`: degradation is explicit,
   * never silent. The turn serves the last-good block (possibly empty) while
   * the off-path refresh catches up. A closed deterministic gate (disabled) is
   * `ready` and emits nothing here.
   */
  'wiki.retrieval.turn_degraded': {
    channelId: string;
    key: string;
    reason: 'not_ready' | 'refresh_failed' | 'stale';
    refreshStatus: 'refreshing' | 'degraded' | null;
    turnId: string;
    requestId: string;
    lastRefreshError?: string;
    timestamp: number;
  } & EventCorrelationFields;
  'memory.active_context.refresh': {
    channelId: string;
    key: string;
    phase: 'ready' | 'degraded';
    selectedMemoryIds?: string[];
    contextChars?: number;
    error?: string;
    timestamp: number;
  } & EventCorrelationFields;
  /**
   * A foreground turn proceeded without a fresh active-memory context (E5.5).
   * Degradation is explicit, never silent: the turn serves the last-good
   * context (possibly empty) and the background refresh catches up next pass.
   */
  'memory.active_context.turn_degraded': {
    channelId: string;
    key: string;
    reason: 'not_ready' | 'refresh_failed' | 'stale';
    refreshStatus: 'refreshing' | 'degraded' | null;
    turnId: string;
    requestId: string;
    lastRefreshError?: string;
    timestamp: number;
  } & EventCorrelationFields;
  'broadcast.pre_send.classified': {
    channelId: string;
    risky: boolean;
    signals: Array<'sensitive' | 'private' | 'off_brand'>;
    visibilityScope: 'public_only' | 'approved_private_context';
  } & EventCorrelationFields;
  'broadcast.approval.required': {
    channelId: string;
    signals: Array<'sensitive' | 'private' | 'off_brand'>;
    visibilityScope: 'public_only' | 'approved_private_context';
    draftLength: number;
  } & EventCorrelationFields;
  'broadcast.provenance': {
    channelId: string;
    visibilityScope: 'public_only' | 'approved_private_context';
    operatorApproval: boolean;
    risky: boolean;
    signals: Array<'sensitive' | 'private' | 'off_brand'>;
    provenanceRefs: string[];
    contextMessageCount: number;
    memoryContextChars: number;
  } & EventCorrelationFields;
  'channel.queue.telemetry': {
    channelId: string;
    phase: 'acquired' | 'contended' | 'coalesced' | 'released';
    policy?: 'drop' | 'defer-latest' | 'queue' | 'steer';
    source?: string;
    queueDepth: number;
    waitMs: number;
    processingChannels: number;
    reason?: string;
    superseded?: boolean;
    timestamp: number;
  };
  'channel.message.error': {
    channelId: string;
    channelType: 'discord' | 'telegram' | 'api' | 'terminal' | 'psfn-amica' | 'unknown';
    messageId?: string;
    phase: 'ingress' | 'handler' | 'egress' | 'unknown';
    error: string;
  };
  'capability.eligibility': {
    operationKind: 'tool.execute' | 'llm.purpose' | 'scheduler.task' | 'post_turn.action' | 'plugin.activate' | 'plugin.action';
    operationRef: string;
    allowed: boolean;
    reasonCode: string;
    tier: string;
    requiredTokens: string[];
    missingTokens: string[];
    minimumTier?: string;
    timestamp: number;
  };
  'session.created': { channelId: string };
  'session.compacted': { channelId: string; before: number; after: number };
  'session.authorship_guard.retagged': {
    channelId: string;
    reason: string;
    authorId: string;
    authorName: string;
    timestamp: number;
  };
  'schedule.tick': { timestamp: number };
  'schedule.task.run': { taskId: string; taskName: string; type: string } & EventCorrelationFields;
  'schedule.task.denied': {
    taskId: string;
    taskName: string;
    type: string;
    reasonCode: string;
    tier: string;
    requiredTokens: string[];
    missingTokens: string[];
    minimumTier?: string;
  } & EventCorrelationFields;
  'schedule.healthcheck': { timestamp: number; taskCount: number };
  'backup.failed': { taskId: string; taskName: string; error: string; timestamp: number };
  'internal_state.gap_detected': { offlineSince: string; gapMs: number; timestamp: number };
  // Cross-companion co-location (sprint 10, W5a): the observing agent's
  // presence refresh found a companion at its own place that was not there on
  // the previous refresh (including everyone already present when the observer
  // itself arrives). Emitted once per arrival, never on refreshes of an
  // already-known co-present companion. Consumers (e.g. opening a shared room
  // channel, W6) subscribe here.
  'presence.companion.co_located': {
    /** The companion newly observed at the observer's place. */
    companionId: string;
    /** The companion whose presence refresh made the observation. */
    observerCompanionId: string;
    siteId: string;
    placeId: string;
    kind: PlaceKind;
    /** ISO-8601 arrival time (the observed companion's presence `since`). */
    since: string;
    timestamp: number;
  };
  // Deliberate virtual-room continuity only. Physical presence observations
  // never emit this event and therefore cannot move an emanation or control a
  // room. Trusted activity in a place-bound virtual room may still update the
  // separate virtual overlay.
  'presence.emanation.follow': {
    trigger: 'virtual_activity';
    /** Contact whose presence/activity the companion followed. */
    contactId: string;
    /** Channel whose activity pulled the virtual move. */
    channelId?: string;
    fromPlaceId?: string;
    toPlaceId: string;
    siteId: string;
    kind: PlaceKind;
    timestamp: number;
  };
  /** Content-free shared-device observation delivery audit. */
  'satellite.observation.delivered': {
    satelliteId: string;
    companionId: string;
    scope: string;
    eventId: string;
    timestamp: number;
  };
  /** Content-free shared-device speech lease transition audit. */
  'satellite.response.lease': {
    action: 'acquired' | 'declined' | 'no_op' | 'timed_out' | 'released' | 'speech';
    satelliteId: string;
    companionId: string;
    leaseId: string;
    priority: 'explicit_address' | 'active_conversation' | 'primary' | 'emanation_member';
    timestamp: number;
    reason?: string;
  };
  'intention.outbound.dispatched': { actionId: string; channelId: string; channelType: string; contentLength?: number; timestamp: number };
  'intention.outbound.blocked': { actionId: string; channelId: string; channelType: string; reason?: string; timestamp: number };
  // Internal-state-driven outreach nudges (Charter 6.24, bead 1xb.2). The
  // deterministic gate decides whether the LLM nudge runs at all; the nudge
  // itself is the consent moment the companion accepts or declines.
  'intention.nudge.gate': { open: boolean; reason: string; maxWeight: number; threshold: number; thoughtCount: number; timestamp: number };
  'intention.nudge.produced': { thoughtId: string; thoughtClass: string; weight: number; channelId: string; channelType: string; target: string; timestamp: number };
  'intention.nudge.accepted': { thoughtId: string; channelId: string; channelType: string; target: string; timestamp: number };
  'intention.nudge.declined': { thoughtId: string; reason?: string; dampenedWeight: number; timestamp: number };
  'intention.nudge.blocked': { thoughtId: string; reason: string; channelId?: string; nextEligibleAtMs?: number; timestamp: number };
  // Social-desire consent moments (epic oth4, bead oth4.2). Deterministic
  // eligibility + budget gates decide whether the LLM consent moment runs at
  // all; the moment itself is her choice of message / defer / decline.
  'social_desire.consent.accepted': { contactId: string; orientation: string; pressure: number; channelId: string; channelType: string; companionTarget: boolean; timestamp: number };
  'social_desire.consent.deferred': { contactId: string; reason?: string; dampenedPressure: number; timestamp: number };
  'social_desire.consent.declined': { contactId: string; reason?: string; dampenedPressure: number; timestamp: number };
  'social_desire.consent.blocked': { contactId: string; reason: string; timestamp: number };
  'model.budget.blocked': ModelBudgetBlockedEvent;
  'icp.conversation.cost.decision': IcpConversationCostBreakerEvent;
  'channel.voice.start': { guildId: string; channelId: string; userId: string };
  'channel.voice.end': { guildId: string; channelId: string; userId: string; reason: string };
  'channel.voice.transcript.partial': {
    guildId: string;
    channelId: string;
    userId: string;
    transcript: string;
    confidence?: number;
    startMs?: number;
    endMs?: number;
  };
  'channel.voice.transcript': { guildId: string; channelId: string; userId: string; transcript: string };
  'channel.voice.tts.sent': { guildId: string; channelId: string; userId: string; text: string };
  'channel.voice.error': {
    guildId?: string;
    channelId?: string;
    userId?: string;
    error: string;
  };
  'voice.connection.state': {
    guildId: string;
    channelId: string;
    userId: string;
    generation: number;
    previousStatus: string;
    status: string;
    timestampMs: number;
  };
  'voice.connection.recovery': {
    guildId: string;
    channelId: string;
    userId: string;
    generation: number;
    failureCount: number;
    tolerance: number;
    attempt: number;
    maxAttempts: number;
    windowMs: number;
    cooldownMs: number;
    timestampMs: number;
  };
  'voice.connection.recovery.exhausted': {
    guildId: string;
    channelId: string;
    userId: string;
    generation: number;
    failureCount: number;
    tolerance: number;
    maxAttempts: number;
    windowMs: number;
    timestampMs: number;
  };
  'voice.turn.start': {
    turnId: string;
    channelId?: string;
    userId?: string;
    timestampMs?: number;
  };
  'voice.turn.end': {
    turnId: string;
    channelId?: string;
    userId?: string;
    status?: 'completed' | 'cancelled' | 'timeout' | 'error';
    reason?: string;
    timestampMs?: number;
  };
  'voice.turn.interrupted': {
    turnId: string;
    channelId?: string;
    userId?: string;
    reason?: string;
    timestampMs?: number;
  };
  'voice.frame.dropped': {
    turnId?: string;
    channelId?: string;
    userId?: string;
    stage?: 'transport' | 'stt' | 'tts' | 'pipeline' | 'unknown';
    reason?: string;
    count?: number;
    timestampMs?: number;
  };
  'voice.turn.error': {
    turnId?: string;
    channelId?: string;
    userId?: string;
    stage?: 'ingest' | 'transport' | 'stt' | 'llm' | 'tts' | 'orchestrator' | 'unknown';
    code?: string;
    error: string;
    timestampMs?: number;
  };
  'voice.turn.observation': {
    turnId: string;
    channelId?: string;
    userId?: string;
    stage?: 'ingest' | 'transport' | 'stt' | 'llm' | 'tts' | 'orchestrator' | 'unknown';
    kind: string;
    code?: string;
    detail?: Record<string, unknown>;
    timestampMs?: number;
  };
  'voice.stt.partial': {
    turnId: string;
    channelId?: string;
    userId?: string;
    text?: string;
    timestampMs?: number;
  };
  'voice.stt.final': {
    turnId: string;
    channelId?: string;
    userId?: string;
    text: string;
    timestampMs?: number;
  };
  'voice.tts.requested': {
    turnId: string;
    channelId?: string;
    userId?: string;
    text?: string;
    timestampMs?: number;
  };
  'voice.tts.first-byte': {
    turnId: string;
    channelId?: string;
    userId?: string;
    timestampMs?: number;
  };
  'wyoming.connection.open': {
    connectionId: string;
    openedAtMs: number;
    remoteAddress?: string;
    remotePort?: number;
    timestampMs: number;
  };
  'wyoming.connection.close': {
    connectionId: string;
    reason: string;
    openedAtMs: number;
    lastSeenAtMs: number;
    durationMs: number;
    timestampMs: number;
  };
  'wyoming.connection.error': {
    connectionId: string;
    code: string;
    error: string;
    timestampMs: number;
  };
  'wyoming.frame.received': {
    connectionId: string;
    frameType: string;
    sessionId?: string;
    payloadBytes: number;
    timestampMs: number;
  };
  'wyoming.frame.sent': {
    connectionId: string;
    frameType: string;
    sessionId?: string;
    payloadBytes: number;
    timestampMs: number;
  };
  'wyoming.session.start': {
    connectionId: string;
    sessionId: string;
    activeSessions: number;
    maxSessions: number;
    timestampMs: number;
  };
  'wyoming.session.end': {
    connectionId: string;
    sessionId: string;
    reason: string;
    durationMs: number;
    activeSessions: number;
    timestampMs: number;
  };
  'wyoming.policy.violation': {
    connectionId: string;
    scope: 'runtime' | 'transport' | 'codec';
    code: string;
    message: string;
    sessionId?: string;
    eventType?: string;
    limit?: number;
    observed?: number;
    action: 'error_frame' | 'close_connection';
    timestampMs: number;
  };
  'wyoming.audit.summary': {
    method: string;
    decision: 'ALLOW' | 'DENY' | 'NEEDS_APPROVAL';
    params?: Record<string, unknown>;
    error?: string;
    timestampMs: number;
  };
  // Companion event relay (w9hj.1). Payloads are ALREADY redacted at emission
  // via channels/backplane/companion-relay/redaction.ts — these events must never
  // carry raw tool params, file contents, or transcript text. Approval events
  // fire at the confirmation-queue choke points (gateway process); artifact
  // events fire when generated media is persisted post-turn (agent process);
  // tool activity re-emits on the gateway bus after crossing the RPC boundary.
  'companion.approval.requested': {
    // Parent owner is ALWAYS the authenticated enqueue owner (routing key).
    companionId: string;
    // Optional shard provenance: present iff a shard-originated request was
    // enqueued with authenticated shard lineage. Never an owner, never a peer
    // companion id. The parent binding above stays the routing/ownership key.
    shardId?: string;
    payload: CompanionApprovalRequestedPayload;
    timestamp: number;
  };
  'companion.approval.resolved': {
    // Same authenticated parent owner captured at enqueue for this id.
    companionId: string;
    // Same immutable shard provenance captured at enqueue for this id.
    shardId?: string;
    payload: CompanionApprovalResolvedPayload;
    timestamp: number;
  };
  'companion.artifact.created': {
    payload: CompanionArtifactCreatedPayload;
    /** In-process preview source; stripped before anything leaves for the hub. */
    preview?: CompanionArtifactPreviewSource;
    channelId?: string;
    /** Authenticated gateway connection identity; never accepted from event JSON. */
    companionId?: string;
    timestamp: number;
  };
  'companion.tool.activity': {
    payload: CompanionToolActivityPayload;
    channelId?: string;
    companionId?: string;
    timestamp: number;
  };
  // Redacted emotion snapshot re-emitted on the gateway bus after crossing the
  // RPC boundary (bead psfn-framework-7ang.1). Payload is ALREADY redacted at
  // agent-side emission and re-validated field-by-field at the boundary; the
  // relay fans it out only to subscribers granted the `emotion` scope.
  'companion.emotion.snapshot': {
    payload: CompanionEmotionSnapshotPayload;
    channelId?: string;
    companionId?: string;
    timestamp: number;
  };
  'external.telemetry.ingested': { event: ExternalTelemetryEvent } & EventCorrelationFields;
  'agent.perception.bridge.telemetry': PerceptionBridgeTelemetryEvent & EventCorrelationFields;
  // Shadow-only partner-affect observation counters (docs/partner-affect.md
  // slice 1). Structural telemetry only; carries no observation content.
  'emotion.partner_affect.shadow.telemetry': PartnerAffectShadowTelemetryEvent & EventCorrelationFields;
  'module.install': {
    id: string;
    name: string;
    version: number;
    source: 'startup' | 'install' | 'update' | 'enable';
  };
  'module.uninstall': {
    id: string;
    name: string;
    reason: 'disable' | 'reload' | 'shutdown';
  };
  'module.error': {
    id: string;
    name: string;
    stage: 'activate' | 'deactivate';
    error: string;
  };
  'module.health': {
    id: string;
    name: string;
    ok: boolean;
    details?: string;
  };
  'reflection.guardrail': {
    templateId: string;
    templateName: string;
    channelId: string;
    executionSource: string;
    reflectionMode: string;
    timestamp: number;
    snapshotSource: string;
    warnings: unknown[];
    counters: Record<string, unknown>;
    canonicalContactId?: string;
    primarySessionId?: string;
    internalStateSnapshotRef?: string;
  } & EventCorrelationFields;
  'system.init': Record<string, never>;
  'system.ready': Record<string, never>;
  'system.shutdown': Record<string, never>;
  'system.error': { error: Error; context?: string };
  // Habit-derived morning wake timing resolution (E7.2). Emitted when the
  // morning wake slot is resolved: 'fixed', a successful 'habit' estimate, or a
  // 'habit_fallback' to the fixed time with a reason. Makes the fallback reason
  // and the effective wake slot visible without coupling the estimator to a bus.
  'scheduler.wake_timing.resolved': {
    timingMode: 'fixed' | 'habit';
    source: 'fixed' | 'habit' | 'habit_fallback';
    effectiveLocalTime: string;
    timeZone: string;
    sampleDays: number;
    fallbackReason?: string;
    windowStartLocalTime?: string;
    windowEndLocalTime?: string;
  };
  // Free-time lanes (E8.1). The pre-spend deterministic gate emits the shared
  // DeterministicGateEvent shape so the subsystem-health view can render why a
  // free-time block did or did not run (min interval, daily cap, active
  // conversation, or lane-not-eligible), with zero LLM spend on a skip.
  'scheduler.free_time.gate': DeterministicGateEvent;
  // Emitted once per free-time block that actually ran. Charter 8.9: spend is
  // visible, never silent. `activity` is false for a zero-output "loaf".
  'scheduler.free_time.block': {
    lane: 'quiet_hours' | 'idle';
    channelId: string;
    turnsUsed: number;
    activity: boolean;
    endReason: string;
    spentChargeUnits: number;
    maxChargeUnits: number;
    maxTurns: number;
    startedAtMs: number;
    endedAtMs: number;
    returnSurfaced: boolean;
    timestamp: number;
  };
}

export type EventName = keyof EventMap;
type Handler<T> = (data: T) => void | Promise<void>;
type Guard<T> = (data: T) => boolean | Promise<boolean>;

interface HandlerEntry<T = unknown> {
  handler: Handler<T>;
  once: boolean;
}

export class EventBus {
  private handlers = new Map<EventName, HandlerEntry[]>();
  private guards = new Map<EventName, Guard<unknown>[]>();

  on<E extends EventName>(event: E, handler: Handler<EventMap[E]>): () => void {
    return this.addHandler(event, handler, false);
  }

  once<E extends EventName>(event: E, handler: Handler<EventMap[E]>): () => void {
    return this.addHandler(event, handler, true);
  }

  off<E extends EventName>(event: E, handler: Handler<EventMap[E]>): void {
    const entries = this.handlers.get(event);
    if (!entries) return;
    const idx = entries.findIndex(e => e.handler === handler);
    if (idx !== -1) entries.splice(idx, 1);
  }

  guard<E extends EventName>(event: E, guard: Guard<EventMap[E]>): () => void {
    const guards = this.guards.get(event) ?? [];
    guards.push(guard as Guard<unknown>);
    this.guards.set(event, guards);
    return () => {
      const idx = guards.indexOf(guard as Guard<unknown>);
      if (idx !== -1) guards.splice(idx, 1);
    };
  }

  async emit<E extends EventName>(event: E, data: EventMap[E]): Promise<void> {
    // Run guards — if any return false, cancel the event
    const guards = this.guards.get(event);
    if (guards) {
      for (const guard of guards) {
        const allowed = await guard(data);
        if (!allowed) return;
      }
    }

    const entries = this.handlers.get(event);
    if (!entries || entries.length === 0) return;

    // Snapshot to handle mutations during iteration
    const snapshot = [...entries];
    const toRemove: HandlerEntry[] = [];

    const results = await Promise.allSettled(
      snapshot.map(async (entry) => {
        if (entry.once) toRemove.push(entry);
        await entry.handler(data);
      }),
    );

    // Remove once-handlers
    for (const entry of toRemove) {
      const idx = entries.indexOf(entry);
      if (idx !== -1) entries.splice(idx, 1);
    }

    // Log errors but don't throw — one handler failure shouldn't kill others
    for (const result of results) {
      if (result.status === 'rejected') {
        log.error(`Handler error on "${event}": ${result.reason}`);
      }
    }
  }

  /**
   * Deliver a required domain event and surface every consumer failure to the
   * caller. Normal telemetry continues to use {@link emit}, whose isolation
   * contract intentionally logs and swallows subscriber errors.
   */
  async emitRequired<E extends EventName>(event: E, data: EventMap[E]): Promise<void> {
    const guards = this.guards.get(event);
    if (guards) {
      for (const guard of guards) {
        if (!await guard(data)) {
          throw new Error(`Required event "${event}" was rejected by a guard`);
        }
      }
    }

    const entries = this.handlers.get(event);
    if (!entries || entries.length === 0) {
      throw new Error(`Required event "${event}" has no registered consumers`);
    }
    const snapshot = [...entries];
    const toRemove: HandlerEntry[] = [];
    const results = await Promise.allSettled(snapshot.map(async (entry) => {
      if (entry.once) toRemove.push(entry);
      await entry.handler(data);
    }));
    for (const entry of toRemove) {
      const index = entries.indexOf(entry);
      if (index !== -1) entries.splice(index, 1);
    }
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `Required event "${event}" failed in ${failures.length} consumers`);
    }
  }

  removeAllListeners(event?: EventName): void {
    if (event) {
      this.handlers.delete(event);
      this.guards.delete(event);
    } else {
      this.handlers.clear();
      this.guards.clear();
    }
  }

  private addHandler<E extends EventName>(
    event: E,
    handler: Handler<EventMap[E]>,
    once: boolean,
  ): () => void {
    const entries = this.handlers.get(event) ?? [];
    const entry: HandlerEntry = { handler: handler as Handler<unknown>, once };
    entries.push(entry);
    this.handlers.set(event, entries);
    return () => this.off(event, handler);
  }
}
