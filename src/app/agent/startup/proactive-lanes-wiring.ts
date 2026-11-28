// ── Unified proactive outreach, autonomy & speaking-arbiter composition spine ──
//
// Extracted from app/agent/main.ts (Phase 4.3): converges the shared outward
// coordination primitives (fleet schedule stagger, outward quiet-hours release,
// ProactiveOutboundDispatcher, OutboundReplyDeduper) and composes all five
// proactive/autonomy lanes plus group-memory + speaking-arbiter wiring through
// one explicit orchestration boundary.

import { join } from 'node:path';
import type { GatewayClient } from '../../../boundary/gateway/client.js';
import type { GatewayWorldOps } from '../../../boundary/integrations/world/gateway-ops.js';
import type { resolveDiscordCompanionView } from '../../../channels/backplane/config.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { EmotionState } from '../../../core/emotion/state.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import type { OutreachOutboxStore } from '../../../core/intention/outreach-outbox.js';
import {
  createApprovedPrimaryChannelPolicy,
  ProactiveOutboundDispatcher,
} from '../../../core/intention/proactive-outbound.js';
import type { SocialOutreachDraftRegistry } from '../../../core/intention/social-outreach-turn/drafts.js';
import { registerEmoSimProactivitySampling } from '../../../core/scheduler/emosim-proactivity-lane.js';
import { staggerQuietHoursRelease } from '../../../core/scheduler/quiet-hours-release-stagger.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { FleetSlotStagger } from '../../../core/scheduler/types.js';
import type { SessionManager } from '../../../core/session/manager.js';
import { ObservedGroupMemoryScheduler } from '../../../faculties/memory/extraction/group-observed-scheduler.js';
import { JsonGroupMemoryWatermarkStore } from '../../../faculties/memory/extraction/group-ranges.js';
import type { AgentPersistenceRuntime } from '../../../persistence/runtime-factory.js';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { CapabilityRuntime } from '../../../system/capabilities/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { SchedulerRuntimeConfig } from '../../../system/config/scheduler-config.js';
import { OutboundReplyDeduper } from '../../../system/lifecycle/outbound-reply-dedupe.js';
import type { AgentCoreRuntime } from '../core-runtime.js';
import type { wireIcpInitiationSources } from '../icp-initiation-source-wiring.js';
import { registerFreeTimeLane, type FreeTimeLaneDeps } from './free-time-lane.js';
import { registerSocialDesireLane, type SocialDesireLaneDeps } from './social-desire-lane.js';
import type { SocialImpulseOutreachLane } from './social-impulse-outreach-lane.js';
import { wireSpeakingArbiterLane } from './speaking-arbiter-lane.js';
import { registerTemporalWakeupLane, type TemporalWakeupLaneDeps } from './temporal-wakeup-lane.js';
import { registerWeightedThoughtOutreachLane, type WeightedThoughtOutreachLaneDeps } from './weighted-thought-outreach-lane.js';
import { registerWorldExplorationLane } from './world-exploration-lane.js';

interface ProactiveOutreachLanesDeps {
  config: SubstrateConfig;
  schedulerConfig: SchedulerRuntimeConfig;
  placesRegistry: PlacesRegistryConfig;
  companionName: string;
  companionDataDir: string;
  heartbeatChannelId: string | undefined;
  heartbeatChannel: SocialDesireLaneDeps['heartbeatChannel'];
  discordChannelView: ReturnType<typeof resolveDiscordCompanionView>;
  gateway: GatewayClient;
  worldOps: GatewayWorldOps;
  scheduler: Scheduler;
  sessionManager: SessionManager;
  sessionStore: AgentCoreRuntime['sessionStore'];
  agentLoop: SubstrateAgent;
  llmProvider: LLMProviderPort;
  promptRegistry: PromptRegistryStatePort | null;
  eventBus: EventBus;
  externalRateLimiter: ConstructorParameters<typeof ProactiveOutboundDispatcher>[0]['rateLimiter'];
  capabilityRuntime: CapabilityRuntime;
  postTurnActions: TemporalWakeupLaneDeps['postTurnActions'] & SocialDesireLaneDeps['postTurnActions'];
  personalProjects: AgentCoreRuntime['personalProjects'];
  contactStore: ContactStorePort;
  concernStore: SocialDesireLaneDeps['concernStore'] & WeightedThoughtOutreachLaneDeps['concernStore'];
  memoryExtractor: AgentCoreRuntime['memoryExtractor'];
  emotionState: EmotionState;
  outreachOutbox: OutreachOutboxStore;
  socialOutreachDrafts: SocialOutreachDraftRegistry;
  socialImpulseOutreachLane: SocialImpulseOutreachLane;
  observerEvalSidecar: AgentCoreRuntime['observerEvalSidecar'];
  persistenceRuntime: AgentPersistenceRuntime;
  coreRuntime: AgentCoreRuntime;
  listPendingConcernCandidates: FreeTimeLaneDeps['listPendingConcernCandidates'];
  icpWeightedThoughtCandidateAdapter: ReturnType<typeof wireIcpInitiationSources>['weightedThoughtCandidateAdapter'];
  log: SocialDesireLaneDeps['log'];
}

interface ProactiveOutreachLanesRuntime {
  gatewaySender: { send(channelId: string, content: string): Promise<void> };
  outboundReplyGuard: OutboundReplyDeduper;
  proactiveOutbound: ProactiveOutboundDispatcher | null;
  fleetScheduleStagger: FleetSlotStagger | undefined;
  socialDesireOutbound: ReturnType<typeof registerSocialDesireLane>['socialDesireOutbound'];
  socialDesireHumanDeliveryPolicy: ReturnType<typeof registerSocialDesireLane>['socialDesireHumanDeliveryPolicy'];
  observedGroupMemoryScheduler: ObservedGroupMemoryScheduler;
  speakingArbiter: ReturnType<typeof wireSpeakingArbiterLane>;
}

/**
 * Resolve the shared fleet stagger descriptor once so every fixed-time and
 * outward-release proactive lane aligns on one deterministic per-companion slot.
 */
export function resolveFleetScheduleStagger(
  fleetMaintenanceCoordinator: AgentPersistenceRuntime['fleetMaintenanceCoordinator'],
  windowMs: number,
): FleetSlotStagger | undefined {
  if (!fleetMaintenanceCoordinator) return undefined;
  return {
    manifestOrdinal: fleetMaintenanceCoordinator.manifestOrdinal,
    fleetSize: fleetMaintenanceCoordinator.fleetSize,
    windowMs,
  };
}

export function wireProactiveOutreachLanes(
  deps: ProactiveOutreachLanesDeps,
): ProactiveOutreachLanesRuntime {
  const {
    config,
    schedulerConfig,
    placesRegistry,
    companionName,
    companionDataDir,
    heartbeatChannelId,
    heartbeatChannel,
    discordChannelView,
    gateway,
    worldOps,
    scheduler,
    sessionManager,
    sessionStore,
    agentLoop,
    llmProvider,
    promptRegistry,
    eventBus,
    externalRateLimiter,
    capabilityRuntime,
    postTurnActions,
    personalProjects,
    contactStore,
    concernStore,
    memoryExtractor,
    emotionState,
    outreachOutbox,
    socialOutreachDrafts,
    socialImpulseOutreachLane,
    observerEvalSidecar,
    persistenceRuntime,
    coreRuntime,
    listPendingConcernCandidates,
    icpWeightedThoughtCandidateAdapter,
    log,
  } = deps;

  const gatewaySender = {
    send: (channelId: string, content: string) => gateway.discordSend(channelId, content),
  };
  const outboundReplyGuard = new OutboundReplyDeduper();
  const proactiveOutbound = heartbeatChannelId
    ? new ProactiveOutboundDispatcher({
      sender: gatewaySender,
      rateLimiter: externalRateLimiter,
      isApprovedPrimaryChannel: createApprovedPrimaryChannelPolicy(heartbeatChannelId),
      eventBus,
    })
    : null;

  const fleetScheduleStagger = resolveFleetScheduleStagger(
    persistenceRuntime.fleetMaintenanceCoordinator,
    schedulerConfig.fleetStagger.windowMs,
  );
  const outwardQuietHours = staggerQuietHoursRelease(
    schedulerConfig.episodicProcessing,
    fleetScheduleStagger,
  );

  registerWorldExplorationLane({
    scheduler,
    config: schedulerConfig.worldExploration,
    quietHours: outwardQuietHours,
    agentLoop,
    placesRegistry,
    worldOps,
    capabilityRuntime,
    eventBus,
    chargePolicy: config.chargePolicy,
    invitationState: persistenceRuntime.schedulerLaneStateStore,
  });

  registerTemporalWakeupLane({
    scheduler,
    sessionManager,
    config: schedulerConfig.temporalWakeup,
    quietHours: outwardQuietHours,
    eventBus,
    agentLoop,
    llmProvider,
    promptRegistry,
    proactiveOutbound,
    companionName,
    postTurnActions,
    ...(fleetScheduleStagger ? { fleetScheduleStagger } : {}),
  });

  registerFreeTimeLane({
    scheduler,
    sessionManager,
    config: schedulerConfig.freeTime,
    restWindow: schedulerConfig.episodicProcessing,
    ...(fleetScheduleStagger ? { fleetStagger: fleetScheduleStagger } : {}),
    chooserSettings: schedulerConfig.socialAutonomy.freeTimeChooser,
    eventBus,
    agentLoop,
    llmProvider,
    promptRegistry,
    companionName,
    companionId: config.companionId,
    chargePolicy: config.chargePolicy,
    personalProjects,
    contactStore,
    ...(coreRuntime.automataClassLifecycle
      ? { automataLifecycle: coreRuntime.automataClassLifecycle }
      : {}),
    listPendingConcernCandidates,
    restSilenceStore: persistenceRuntime.schedulerLaneStateStore,
    postTurnActions,
  });

  registerWeightedThoughtOutreachLane({
    ...(fleetScheduleStagger ? { fleetStagger: fleetScheduleStagger } : {}),
    scheduler,
    schedulerConfig,
    eventBus,
    weightedThoughtStore: persistenceRuntime.weightedThoughtStore,
    llmProvider,
    companionName,
    heartbeatChannelId,
    contactStore,
    concernStore,
    icpWeightedThoughtCandidateAdapter,
  });

  const { socialDesireOutbound, socialDesireHumanDeliveryPolicy, impulseTarget } =
    registerSocialDesireLane({
      ...(fleetScheduleStagger ? { fleetStagger: fleetScheduleStagger } : {}),
      schedulerConfig,
      scheduler,
      postTurnActions,
      eventBus,
      log,
      socialDesireStore: persistenceRuntime.socialDesireStore,
      outreachOutbox,
      heartbeatChannel,
      contactStore,
      icpPeers: coreRuntime.icpAutonomyRuntime,
      localCompanionId: config.companionId,
      turns: agentLoop,
      sessions: sessionStore,
      readEmotion: () => emotionState.getState(),
      drafts: socialOutreachDrafts,
      concernStore,
      companionName,
      attachFeltSignalWriter: (writer) => {
        agentLoop.socialDesireFeltSignals = writer;
      },
    });
  socialImpulseOutreachLane.setDesireTarget(impulseTarget);
  registerEmoSimProactivitySampling(scheduler, observerEvalSidecar);

  const observedGroupMemoryScheduler = new ObservedGroupMemoryScheduler({
    channelGroupMemory: discordChannelView.groupMemory,
    sessionReader: sessionStore,
    watermarkStore: new JsonGroupMemoryWatermarkStore(
      join(companionDataDir, 'group-memory-watermarks.json'),
    ),
    memoryExtractor,
    failureRetry: schedulerConfig.groupMemoryExtraction.failureRetry,
    onRangeFailure: (event) => {
      eventBus.emit('memory.pipeline.failure', {
        pipeline: 'group_extraction',
        subjectId: event.channelId,
        attemptCount: event.attemptCount,
        maxAttempts: event.maxAttempts,
        terminal: event.terminal,
        timestamp: event.timestamp,
      }).catch((error: unknown) => {
        log.warn('Group-memory failure telemetry emit failed', {
          channelId: event.channelId,
          error: String(error),
        });
      });
    },
    contactStore,
    companionNames: [companionName],
    companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
    ...(config.groupMemory ? { groupMemory: config.groupMemory } : {}),
  });

  const speakingArbiter = wireSpeakingArbiterLane({
    config,
    schedulerConfig,
    llmProvider,
    agentLoop,
    companionName,
    observedGroupMemoryScheduler,
    sessionStore,
    persistenceRuntime,
    coreRuntime,
    gatewaySender: {
      send: (channelType, channelId, content) => (channelType === 'discord'
        ? gateway.discordSend(channelId, content)
        : gateway.channelSendRoomReply(channelType, channelId, content)),
    },
    outboundReplyGuard,
  });

  return {
    gatewaySender,
    outboundReplyGuard,
    proactiveOutbound,
    fleetScheduleStagger,
    socialDesireOutbound,
    socialDesireHumanDeliveryPolicy,
    observedGroupMemoryScheduler,
    speakingArbiter,
  };
}
