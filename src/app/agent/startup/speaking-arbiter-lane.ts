// ── Social participation + speaking-arbiter wiring (bible §8, jp36) ──
// Extracted from agent/main.ts (charter 12.1 god-file split, emh3p.1).
// Passive-name candidates (§8.1) -> cheap participation appraiser (§8.2,
// jp36.3.3) -> ICP-over-social precedence (jp36.5.2.1) -> reservation phase
// (§8.5/§12.2, jp36.5.1.2) -> egress-lease phase (§8.5/§18/§20.1,
// jp36.5.1.3). The egress lease is gated OFF by default and stays
// code-pinned fail-closed (qgqw.3, P1): observe/appraise/reserve is live,
// nothing sends autonomously.

import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { SchedulerRuntimeConfig as SchedulerConfig } from '../../../system/config/scheduler-config.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { ParticipationAppraiser } from '../../../core/participation/appraiser.js';
import { PassiveNameCandidateBuilder } from '../../../core/participation/passive-name-candidate.js';
import { SpeakingReservationPhase, type IcpSocialPrecedenceResolver } from '../../../core/agent/arbiter/reservation-phase.js';
import { SpeakingEgressLeasePhase } from '../../../core/agent/arbiter/egress-lease-phase.js';
import { createIcpSpeakingPrecedenceResolver } from '../../../core/icp/speaking-precedence-resolver.js';
import { readRoomEpisodePressureFromLedger } from '../../../core/agent/fatigue/room-episode-pressure.js';
import { createDefaultEgressLeasePhaseSettings } from '../../../system/config/participation-config.js';
import { createAgentLoopEgressReplySender } from '../egress-reply-sender.js';
import type { ObservedGroupMemoryScheduler } from '../../../faculties/memory/extraction/group-observed-scheduler.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { OutboundReplyDeduper } from '../../../system/lifecycle/outbound-reply-dedupe.js';
import { classifyChannelDisclosure } from '../../../system/trust/policy.js';
import type { createAgentPersistenceRuntime } from '../../../persistence/runtime-factory.js';
import type { AgentCoreRuntime } from '../core-runtime.js';

export interface SpeakingArbiterLaneDeps {
  config: SubstrateConfig;
  schedulerConfig: SchedulerConfig;
  llmProvider: LLMProviderPort;
  agentLoop: SubstrateAgent;
  companionName: string;
  observedGroupMemoryScheduler: ObservedGroupMemoryScheduler;
  sessionStore: SessionStore;
  persistenceRuntime: Awaited<ReturnType<typeof createAgentPersistenceRuntime>>;
  coreRuntime: AgentCoreRuntime;
  gatewaySender: { send: (channelId: string, content: string) => Promise<void> };
  outboundReplyGuard: OutboundReplyDeduper;
}

export interface SpeakingArbiterLaneResult {
  passiveNameCandidateBuilder: PassiveNameCandidateBuilder;
  participationAppraiser: ParticipationAppraiser;
  reservationPhase: SpeakingReservationPhase | undefined;
  egressLeasePhase: SpeakingEgressLeasePhase | undefined;
}

export function wireSpeakingArbiterLane(deps: SpeakingArbiterLaneDeps): SpeakingArbiterLaneResult {
  const {
    config,
    schedulerConfig,
    llmProvider,
    agentLoop,
    companionName,
    observedGroupMemoryScheduler,
    sessionStore,
    persistenceRuntime,
    coreRuntime,
    gatewaySender,
    outboundReplyGuard,
  } = deps;

  // Deterministic passive-name participation candidate gate (bible §8.1). Reuses
  // the group-salience name detector and the scheduler's canonical
  // direct-vs-group classifier — no parallel detection paths. Runs on observed
  // group-room traffic; downstream appraisal (jp36.3.3) and the speaking arbiter
  // (jp36.5) consume the candidates it records.
  const passiveNameCandidateBuilder = new PassiveNameCandidateBuilder({
    scopeClassifier: observedGroupMemoryScheduler,
    contextReader: sessionStore,
    companionNames: [companionName],
    companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
    // Passive-name gate tunables are owned by scheduler.json
    // socialAutonomy.passiveNameCandidate (jp36.8.2).
    settings: schedulerConfig.socialAutonomy.passiveNameCandidate,
  });

  // Cheap, tool-less participation appraiser (bible §8.2, jp36.3.3). Consumes the
  // candidates above on the same observe path and produces the ignore/react/reply
  // ternary over datamarked room text using the shared background-model port —
  // no parallel LLM plumbing. Fails closed to `ignore`; billing (background lane)
  // is attributed to the owning companion via the call correlation.
  const participationAppraiser = new ParticipationAppraiser({
    llmProvider,
    companionName,
    // Appraiser bounds are owned by scheduler.json socialAutonomy.appraiser
    // (jp36.8.2).
    settings: schedulerConfig.socialAutonomy.appraiser,
    ...(config.companionId ? { companionId: config.companionId } : {}),
  });

  // ICP-over-social precedence transport (jp36.5.2.1): the arbiter's reservation
  // gate consumes LIVE ICP signals — the companion's own availability lease (via
  // the gateway-RPC broker read) and its in-flight ICP turn fence (a `pending`
  // turn reservation in the shared fatigue store) — so an in-flight ICP turn or
  // a declared busy/resting/DND yields the social turn (§8.5: ICP dominates on
  // any conflict or race). Any signal-source error propagates and the
  // reservation phase fails closed to a suppressing `gate_error`. When the ICP
  // fleet surfaces are absent (single-companion / no contacts) there is no ICP
  // authority to contend, so precedence admits.
  const speakingIcpPrecedence: IcpSocialPrecedenceResolver =
    config.companionId && coreRuntime.icpAutonomyRuntime && coreRuntime.icpTurnFenceReader
      ? createIcpSpeakingPrecedenceResolver({
        companionId: config.companionId,
        availability: coreRuntime.icpAutonomyRuntime,
        turnFence: coreRuntime.icpTurnFenceReader,
        // The ICP continuation-lane hard stop has no clean companion-scope read
        // yet: it is per-relationship, per-conversation, and needs the per-turn
        // policy limit. The shared-economy budget it guards is already enforced
        // by the reservation phase's social-pot funding gate, so a dedicated
        // continuation-exhaustion read is deferred (jp36.5.2.1 handoff). This
        // never fabricates an exhausted signal.
        continuationFatigue: { isContinuationExhausted: async () => false },
      })
      : { resolve: () => ({ icpTurnFenced: false, icpFatigueExhausted: false }) };

  // Speaking-arbiter reservation phase (bible §8.5/§12.2, §6.10, jp36.5.1.2):
  // deterministic gate that runs BEFORE the appraiser's model call. Constructed
  // only when the gateway-owned arbiter store and social pot are present (the
  // multi-companion runtime) and a charge policy funds the economy. ICP-over-
  // social precedence consumes the live ICP transport above (jp36.5.2.1); the
  // decayed room-episode pressure gate is opt-in behind the jp36.5.4
  // single-source seam and is not wired here.
  const reservationPhase = (
    config.multiCompanion === true
    && persistenceRuntime.speakingArbiterStore
    && persistenceRuntime.socialPotStore
    && config.chargePolicy
    && config.companionId
  )
    ? new SpeakingReservationPhase({
      store: persistenceRuntime.speakingArbiterStore,
      socialPot: persistenceRuntime.socialPotStore,
      companionId: config.companionId,
      icpPrecedence: speakingIcpPrecedence,
      config: {
        // Reservation-phase tunables (reservationTtlMs, minReserveDrawUnits) are
        // owned by scheduler.json socialAutonomy.reservationPhase (jp36.8.2); the
        // pot / breaker / wrap-up fields still come from the charge-policy ledger.
        ...schedulerConfig.socialAutonomy.reservationPhase,
        socialPot: config.chargePolicy.fatigue.socialPot,
        roomEpisodeCircuitBreaker:
          config.chargePolicy.fatigue.socialRegulation.roomEpisodeCircuitBreaker,
        wrapUpThreshold:
          config.chargePolicy.fatigue.socialRegulation.roomEpisodePressure.wrapUpThreshold,
      },
    })
    : undefined;

  // Speaking-arbiter egress-lease phase (bible §8.5/§12.2, §18, §20.1,
  // jp36.5.1.3): phase 2, the exclusive send-once binding at delivery. Promoting
  // a retained candidate to a REAL autonomous room reply is a new,
  // CogSec-sensitive surface, so it is gated OFF by default (the egress-lease
  // settings `enabled` flag): with it disabled the observe/appraise/reserve path
  // is unchanged and nothing is sent. The room-episode pressure gate reads the
  // ONE reconciled ledger-derived source (jp36.5.4 seam) — never the arbiter
  // store's raw pressure scalar, which stays a write-only projection.
  // Egress-lease TUNABLES (leaseTtlMs, egressDrawUnits, minReplyConfidence) are
  // owned by scheduler.json socialAutonomy.egressLease (jp36.8.2). The `enabled`
  // flag is DELIBERATELY not owner-file-exposed and stays code-pinned to the
  // fail-closed default (false): promoting an observed candidate to a real
  // autonomous send is blocked until qgqw.3 (P1), so no config path may enable
  // it. Merging the tunables over the code default preserves enabled === false.
  const egressLeaseSettings = {
    ...createDefaultEgressLeasePhaseSettings(),
    ...schedulerConfig.socialAutonomy.egressLease,
  };
  const egressLeasePhase = (
    egressLeaseSettings.enabled
    && config.multiCompanion === true
    && persistenceRuntime.speakingArbiterStore
    && persistenceRuntime.socialPotStore
    && config.chargePolicy
    && config.companionId
  )
    ? new SpeakingEgressLeasePhase({
      store: persistenceRuntime.speakingArbiterStore,
      socialPot: persistenceRuntime.socialPotStore,
      companionId: config.companionId,
      // Single reconciled room-episode pressure source: ledger-derived, decayed,
      // across every peer in the channel (caller obligation jp36.5.1 #2).
      roomPressure: {
        resolve: (ctx) => readRoomEpisodePressureFromLedger(coreRuntime.fatigueLedger, {
          localCompanionId: config.companionId as string,
          channelId: ctx.channelId,
          nowMs: ctx.nowMs,
          config: config.chargePolicy!.fatigue.socialRegulation.roomEpisodePressure,
        }),
      },
      // Consumes the granted lease to generate + deliver the reply (temporal-
      // wakeup pattern: synthetic terminal generation, then explicit send).
      // qgqw.3 hardening: the SHARED outbound-reply guard (same instance as the
      // reply pump) plus the sender's per-trigger-event fence give single
      // delivery across re-drives, and the destination room's disclosure pair
      // clamps the synthetic generation context to the room's ceiling.
      sender: createAgentLoopEgressReplySender({
        generator: agentLoop,
        delivery: gatewaySender,
        companionName,
        outboundReplyGuard,
        resolveDestinationDisclosure: (channelId) => classifyChannelDisclosure(channelId),
      }),
      config: {
        leaseTtlMs: egressLeaseSettings.leaseTtlMs,
        egressDrawUnits: egressLeaseSettings.egressDrawUnits,
        minReplyConfidence: egressLeaseSettings.minReplyConfidence,
        socialPot: config.chargePolicy.fatigue.socialPot,
        roomEpisodeCircuitBreaker:
          config.chargePolicy.fatigue.socialRegulation.roomEpisodeCircuitBreaker,
        wrapUpThreshold:
          config.chargePolicy.fatigue.socialRegulation.roomEpisodePressure.wrapUpThreshold,
        replyPressureUnits:
          config.chargePolicy.fatigue.socialRegulation.roomEpisodePressure.replyPressureUnits,
      },
    })
    : undefined;

  return {
    passiveNameCandidateBuilder,
    participationAppraiser,
    reservationPhase,
    egressLeasePhase,
  };
}
