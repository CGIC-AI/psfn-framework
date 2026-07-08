// ── Agent Container Entry Point ──
// Runs inside an isolated container. Connects to gateway via the configured RPC endpoint.
// Run: npx tsx src/app/agent/main.ts

import { join } from 'node:path';
import { ensureActiveTimezone } from '../../shared/time/active-timezone.js';
import { createComponentLogger } from '../../shared/logger.js';
import { GatewayClient } from '../../boundary/gateway/client.js';
import { formatGatewayRpcEndpoint } from '../../boundary/gateway/transport.js';
import { parsePositiveIntEnv } from '../../shared/utils/env.js';
import { MemoryWriter } from '../../faculties/memory/writer.js';
import { EpisodicSynthesizer } from '../../faculties/memory/episodic/index.js';
import { SleepCycleEpisodeConsolidator } from '../../faculties/memory/episodic/sleep-consolidation.js';
import { EpisodeArcWeaver } from '../../faculties/memory/episodic/arc-formation.js';
import { DreamMeaningPass } from '../../faculties/memory/episodic/dream-meaning-pass.js';
import { SleeptimeWikiPass } from '../../faculties/wiki/sleeptime-wiki-pass.js';
import { WikiStore } from '../../faculties/wiki/store.js';
import { ProactiveOutboundDispatcher } from '../../core/intention/proactive-outbound.js';
import {
  registerTemporalWakeupTasks,
  TEMPORAL_WAKEUP_MORNING_TASK_NAME,
} from '../../core/scheduler/temporal-wakeup.js';
import { registerFreeTimeTasks } from '../../core/scheduler/free-time.js';
import { formatReflectionPersonaBlock } from '../../core/scheduler/heartbeat-template-runtime.js';
import { registerWeightedThoughtOutreachTask } from '../../core/scheduler/weighted-thought-outreach-lane.js';
import { createLlmNudgeEvaluator } from '../../core/intention/weighted-thought-nudge-evaluator.js';
import { HEARTBEAT_SILENT_REFLECTION_TOKEN } from '../../core/scheduler/heartbeat-policy.js';
import {
  getRunChargeSnapshot,
  runWithChargeContext,
} from '../../shared/telemetry/run-charge.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { summarizeRecentSessionEntries } from '../../core/session/manager/compaction-service.js';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import { createFileOutreachOutboxStore } from '../../core/intention/outreach-outbox.js';
import { registerMemoryTools } from '../../faculties/memory/runtime-wiring.js';
import { registerGitTools } from '../../boundary/integrations/git/runtime-wiring.js';
import { GatewayGitOps } from '../../boundary/integrations/git/gateway-ops.js';
import { registerBeadsTools } from '../../boundary/integrations/beads/runtime-wiring.js';
import { GatewayBeadsOps } from '../../boundary/integrations/beads/gateway-ops.js';
import { registerWorldTools } from '../../boundary/integrations/world/runtime-wiring.js';
import { GatewayWorldOps } from '../../boundary/integrations/world/gateway-ops.js';
import { createBehavioralPatternMemoryPromotionHook } from '../../core/intention/patterns.js';
import {
  wireShardAndThinkRuntime,
} from '../startup/composition/composition.js';
import { buildShellExecPolicyConfig } from '../../boundary/sandbox/execution/shell-policy-config.js';
import {
  buildCharacterPromptVariablesProvider,
  buildReplConfig,
  wireHeartbeatRuntime,
} from '../startup/composition/parity.js';
import { createAgentPersistenceRuntime } from '../../persistence/runtime-factory.js';
import {
  resolveOutreachOutboxLedgerPath,
  resolvePendingContactApprovalsPath,
  resolveSocialGraphProposalsPath,
  resolveSocialGraphBuilderWatermarkPath,
} from '../../persistence/layout.js';
import { createFilePendingContactApprovalStore } from '../../core/contacts/pending-contact-approvals.js';
import {
  createFileSocialGraphProposalStore,
  createFileSocialGraphBuilderWatermarkStore,
} from '../../faculties/memory/social-graph/proposals.js';
import { createContactTrackingGate } from '../../core/contacts/tracking-gate.js';
import { rehydratePersistedInternalState } from '../../core/self-model/internal-state-persistence.js';
import { ModuleLoader } from '../../system/modules/loader.js';
import { DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE } from '../../core/agent/tool-wiring-validator.js';
import { registerGatewayMessageHandlers } from './gateway-message-handlers.js';
import { OutboundReplyDeduper } from '../../system/lifecycle/outbound-reply-dedupe.js';
import { ObservedGroupMemoryScheduler } from '../../faculties/memory/extraction/group-observed-scheduler.js';
import { JsonGroupMemoryWatermarkStore } from '../../faculties/memory/extraction/group-ranges.js';
import { createNoopSatelliteRoutingPort } from '../../core/agent/satellite-adapter-port.js';
import { createSignalShutdownHandler, registerProcessErrorHandlers } from '../startup/support/signal-shutdown.js';
import { buildAgentControlPlane } from './control-plane.js';
import type { AgentControlPlaneShutdownTargets } from './control-plane.js';
import { createSandboxBrokerExecutionPort } from '../../boundary/sandbox/sandbox-execution-broker.js';
import { createLLMProviderPort } from '../../core/agent/contracts.js';
import { createGatewayOpsPortFromClient } from '../../boundary/gateway/gateway-ops-port.js';
import {
  bootstrapAgentCoreRuntime,
} from './core-bootstrap.js';
import {
  buildApiHealthChecks,
  resolveAgentApiSurfaceBindings,
} from './api-surface.js';
import { startOptionalAdminTransportServer } from './admin-surface.js';
import {
  buildAgentSchedulerRuntime,
} from './scheduler-runtime.js';
import {
  createSessionActivityTracker,
  writeStartupSessionMetadata,
} from './session-activity.js';
import { hydrateStartupActiveMemoryContexts } from '../../faculties/memory/startup-hydration.js';
import { hydrateStartupActiveCoreMemoryBlocks } from '../../faculties/core-memory/startup-hydration.js';
import { enforceNetworkIsolationOnStartup } from './startup-guards.js';
import {
  createOptionalJournalAutoPublisher,
  registerMarkdownJournalTools,
} from './journal-runtime.js';
import { prepareAgentStartupContext } from './startup-context.js';
import { AgentApiBackend } from '../../channels/api/agent-backend.js';
import { resolveActiveHealthProbeConfig } from '../../channels/api/active-health-probe.js';
import { buildExternalChannelProfiles } from '../../channels/backplane/config.js';

const log = createComponentLogger('Agent');
ensureActiveTimezone();
const DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const {
    config,
    coreConfig,
    lifecycleRuntimeContract,
    runtimeStatusMeta,
    pathSnapshot,
    schedulerConfig,
    channelsConfig,
    satelliteRegistryConfig,
    placesRegistryConfig,
    backupConfig,
    capabilityRuntime,
    eligibilityGate,
    gatewayRpcEndpoint,
    moduleRegistryPath,
    eventBus,
    stopDebugObserver,
  } = prepareAgentStartupContext({
    env: process.env,
    log,
  });

  log.info('Initializing...');
  log.info('Lifecycle runtime contract resolved', runtimeStatusMeta);
  await enforceNetworkIsolationOnStartup();

  // ── Connect to gateway ──

  const embeddingDims = config.embeddingDims ?? 1024;
  const primaryUserId = config.voiceTargetUserId?.trim() || process.env.PRIMARY_USER_ID;

  log.info(`Connecting to gateway at ${formatGatewayRpcEndpoint(gatewayRpcEndpoint)}...`);
  const gateway = await GatewayClient.connectEndpoint(gatewayRpcEndpoint, embeddingDims);
  const llmProvider = createLLMProviderPort(gateway);
  const gatewayOps = createGatewayOpsPortFromClient(gateway);
  log.info('Connected to gateway');
  let shuttingDown = false;
  let stopFn: () => Promise<void> = async () => {};
  const unregisterGatewayDisconnect = gateway.onDisconnect(async (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.error('Gateway connection lost; shutting down agent process', {
      source: event.source,
      error: event.error?.message,
    });
    try {
      await stopFn();
    } finally {
      process.exit(1);
    }
  });

  const persistenceRuntime = await createAgentPersistenceRuntime({
    config,
    pathSnapshot,
    embeddingDims,
    primaryUserId,
  });
  const {
    backend: persistenceBackend,
    memoryStore: companionMemoryStore,
    episodicStore: companionEpisodicStore,
    reflectionStore,
    contactStore: persistedContactStore,
    hubIdentityEnrollmentStore: persistedHubIdentityEnrollmentStore,
    intentionRuntime: persistedIntentionRuntime,
    intentionProviders,
  } = persistenceRuntime;
  log.info('PostgreSQL persistence backend selected; skipping SQLite startup checks', {
    persistenceBackend,
  });

  // ── Contact-tracking policy gate (E3.4) ──
  // Per-channel contactTracking labels come from channels.json contextEnvelope
  // (default 'auto'). Approval-mode channels enqueue new speakers into a
  // durable pending-approval queue; the operator notification goes through the
  // gateway notification path with a system-derived sender.
  const pendingContactApprovals = createFilePendingContactApprovalStore(
    resolvePendingContactApprovalsPath(pathSnapshot.companionDataDir),
  );

  // ── Social-graph builder worker stores (E4.2) ──
  // Durable, file-backed proposal queue + advisory watermark cursor for the
  // background graph-builder worker. Shared between the scheduler task (writer)
  // and the Garden review surface (reader/decider).
  const socialGraphProposalStore = createFileSocialGraphProposalStore(
    resolveSocialGraphProposalsPath(pathSnapshot.companionDataDir),
  );
  const socialGraphWatermarkStore = createFileSocialGraphBuilderWatermarkStore(
    resolveSocialGraphBuilderWatermarkPath(pathSnapshot.companionDataDir),
  );
  const contactTrackingGate = createContactTrackingGate({
    channelLabels: channelsConfig.contextEnvelope.channels,
    pendingApprovals: pendingContactApprovals,
    notifyOperatorPendingContact: async (entry) => {
      await gateway.notifyNtfy({
        sender: { kind: 'system', provenance: 'system.contacts.pending_approval' },
        title: 'PSFN contact approval required',
        priority: 4,
        message: [
          `New speaker awaiting contact approval: ${entry.displayName}`,
          `Channel: ${entry.channel} (${entry.channelId})`,
          `First seen: ${entry.firstSeenAt}`,
          'Review in admin: /contact-approvals',
        ].join('\n'),
      });
    },
    logger: log,
  });

  // ── Load identity (mounted read-only in container) ──

  const {
    card,
    systemPrompt,
    cardVersionStore,
    cardProposalQueue,
    coreRuntime,
    emotionState,
    operatorNotifier,
    safeguardSurfaces,
  } = await bootstrapAgentCoreRuntime({
    config: coreConfig,
    pathSnapshot,
    eventBus,
    gateway,
    memoryStore: companionMemoryStore,
    episodicStore: companionEpisodicStore,
    contactStore: persistedContactStore,
    intentionRuntime: persistedIntentionRuntime,
    intentionProviders,
    capabilityRuntime,
    contactTrackingGate,
    satelliteRegistryConfig,
    placesRegistryConfig,
    ...(persistedHubIdentityEnrollmentStore
      ? { hubIdentityEnrollmentStore: persistedHubIdentityEnrollmentStore }
      : {}),
  });
  const {
    safeguardAuditTrail,
    lifecycleRestartSafeguard,
    externalRateLimiter,
  } = safeguardSurfaces;

  const {
    agentLoop,
    sessionStore,
    sessionManager,
    promptState,
    skillsRuntime,
    memoryStore,
    contactStore,
    coreMemoryStore,
    intentionRuntime,
    intentionAppraisalHooks,
    intentionBehavioralHooks,
    memoryExtractor,
    personaPreamble,
    observerEvalSidecar,
    appCache,
    toolConformanceRunner,
  } = coreRuntime;

  sessionManager.characterName = card.data.name;
  writeStartupSessionMetadata(
    sessionManager,
    pathSnapshot.companionDataDir,
    config.sessionRestartBehavior ?? 'reuse_latest_session',
  );
  try {
    await hydrateStartupActiveMemoryContexts({
      memoryProvider: agentLoop.memoryProvider,
      sessionManager,
    });
  } catch (error) {
    log.warn('Startup active memory hydration failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    hydrateStartupActiveCoreMemoryBlocks({ sessionManager });
  } catch (error) {
    log.warn('Startup active core-memory hydration failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  agentLoop.setInternalStateStore(persistenceRuntime.internalStateStore);
  const internalStateRehydration = await rehydratePersistedInternalState({
    store: persistenceRuntime.internalStateStore,
    agent: agentLoop,
  });
  if (internalStateRehydration.outcome === 'restored') {
    log.info('Rehydrated persisted internal state', {
      savedAt: internalStateRehydration.savedAt,
      ageMs: internalStateRehydration.ageMs,
    });
  } else if (internalStateRehydration.outcome === 'gap_detected') {
    log.warn('Persisted internal state too stale to rehydrate; continuity gap surfaced', {
      offlineSince: internalStateRehydration.gap.offlineSince,
      gapMs: internalStateRehydration.gap.gapMs,
    });
    await eventBus.emit('internal_state.gap_detected', {
      offlineSince: internalStateRehydration.gap.offlineSince,
      gapMs: internalStateRehydration.gap.gapMs,
      timestamp: Date.now(),
    });
  } else {
    log.info('No persisted internal state snapshot found; starting fresh');
  }

  const { scheduler, postTurnActions } = buildAgentSchedulerRuntime({
    eventBus,
    eligibilityGate,
    config,
    schedulerConfig,
    sessionManager,
    gateway,
    memoryStore,
    agentLoop,
    concernStore: intentionRuntime.concernStore,
    backupConfig,
    pathSnapshot,
    contactStore,
    socialGraphProposalStore,
    socialGraphWatermarkStore,
  });

  const moduleLoader = new ModuleLoader({
    eventBus,
    registerTool: (tool, category) => agentLoop.registerTool(tool, category),
    registryPath: moduleRegistryPath,
  });
  log.info('Split module registry path resolved', { moduleRegistryPath });

  const replConfig = buildReplConfig(config);
  const sandboxExecutionPort = createSandboxBrokerExecutionPort({
    workspacePath: pathSnapshot.workspaceRoot,
    policy: buildShellExecPolicyConfig(process.env),
    brokerId: 'agent-process',
  });
  const shardManager = wireShardAndThinkRuntime({
    agentLoop,
    eventBus,
    llmProvider,
    sessionStore,
    embeddingService: gateway,
    memoryStore,
    sessionManager,
    config,
    parentSystemPrompt: systemPrompt,
    runtimeMode: 'gateway',
    scheduler,
    replConfig,
    shardAuditTrail: safeguardAuditTrail,
    getCapabilityTier: () => capabilityRuntime.getTier(),
    compositionalPolicy: config.compositionalPolicy,
    moduleInstallConfirmationQueue: cardProposalQueue,
    onModuleRegistryMutation: async (mutation) => {
      await moduleLoader.applyRegistryMutation(mutation);
    },
    executionPort: sandboxExecutionPort,
  });

  // Memory write/import tools — intentional memory creation
  const memoryWriter = new MemoryWriter(memoryStore, gateway);
  const episodicStore = companionEpisodicStore;
  // Episodic lane tuning is JSON-owned (scheduler.json episodeSynthesis /
  // sleepConsolidation / arcFormation) — no hardcoded cadences or windows.
  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const episodicSynthesizer = new EpisodicSynthesizer(episodicStore, sessionManager, {
    transcriptMessageLimit: schedulerConfig.episodeSynthesis.transcriptMessageLimit,
    maxEpisodesPerRun: schedulerConfig.episodeSynthesis.maxEpisodesPerRun,
    gapSplitMinutes: schedulerConfig.episodeSynthesis.gapSplitMinutes,
    maxEntriesPerEpisode: schedulerConfig.episodeSynthesis.maxEntriesPerEpisode,
    minConversationalEntries: schedulerConfig.episodeSynthesis.minConversationalEntries,
    minSingleEntryChars: schedulerConfig.episodeSynthesis.minSingleEntryChars,
    // Contextual topic cutting (E5.4): JSON-owned flag; the provider is the
    // same gateway-backed LLM port the other episodic passes use. Disabled
    // flag => deterministic cuts unchanged; enabled without a provider fails
    // closed at construction.
    topicSegmentation: {
      enabled: schedulerConfig.episodeSynthesis.topicSegmentationEnabled,
      llmProvider,
      personaPreamble,
      onEvent: (event) => {
        eventBus.emit('memory.episode_synthesis.segmentation', event).catch((error) => {
          log.warn('Episode-synthesis segmentation telemetry emit failed', {
            sessionId: event.sessionId,
            outcome: event.outcome,
            error: String(error),
          });
        });
      },
    },
  });
  const sleepConsolidator = new SleepCycleEpisodeConsolidator(episodicStore, sessionManager, llmProvider, {
    reviewWindowMs: schedulerConfig.sleepConsolidation.reviewWindowDays * DAY_MS,
    refinementWindowMs: schedulerConfig.sleepConsolidation.refinementWindowHours * HOUR_MS,
    adjacencyGapMs: schedulerConfig.sleepConsolidation.adjacencyGapMinutes * MINUTE_MS,
    maxRefinementsPerRun: schedulerConfig.sleepConsolidation.maxRefinementsPerRun,
    maxConsolidationsPerRun: schedulerConfig.sleepConsolidation.maxConsolidationsPerRun,
    personaPreamble,
    // Fail-closed consolidation failures are typed events, never silence.
    onConsolidationFailure: (failure) => {
      eventBus.emit('memory.sleep_consolidation.failure', failure).catch((error: unknown) => {
        log.warn('Sleep-consolidation failure event emit failed', {
          sessionId: failure.sessionId,
          error: String(error),
        });
      });
    },
    onRefinementGate: (event) => {
      eventBus.emit('memory.sleep_consolidation.refinement_gate', event).catch((error: unknown) => {
        log.warn('Sleep-consolidation refinement gate event emit failed', { error: String(error) });
      });
    },
  });
  const arcWeaver = new EpisodeArcWeaver(episodicStore, llmProvider, {
    passIntervalMs: schedulerConfig.arcFormation.passIntervalDays * DAY_MS,
    reviewWindowMs: schedulerConfig.arcFormation.reviewWindowDays * DAY_MS,
    minConfidence: schedulerConfig.arcFormation.minConfidence,
    maxArcsPerRun: schedulerConfig.arcFormation.maxArcsPerRun,
    maxEpisodesPerRun: schedulerConfig.arcFormation.maxEpisodesPerRun,
    // Fail-closed arc-formation outcomes are typed events, never silence.
    onEvent: (event) => {
      eventBus.emit('memory.arc_formation.outcome', event).catch((error: unknown) => {
        log.warn('Arc-formation outcome event emit failed', {
          sessionId: event.sessionId,
          outcome: event.outcome,
          error: String(error),
        });
      });
    },
    personaPreamble,
  });
  const dreamMeaningPass = new DreamMeaningPass(episodicStore, agentLoop, {
    onGateEvent: (event) => {
      eventBus.emit('memory.dream_meaning.gate', event).catch((error: unknown) => {
        log.warn('Dream-meaning gate event emit failed', { error: String(error) });
      });
    },
  });
  // Sleeptime wiki update pass (E8.2): schema-bound background synthesis (not the
  // agent loop) with its own deterministic gate + watermark. Curates durable,
  // non-private world knowledge into the wiki after episodes/memories settle.
  const sleeptimeWikiPass = new SleeptimeWikiPass({
    llmProvider,
    wikiStore: new WikiStore(pathSnapshot.workspaceRoot),
    episodicStore,
    memoryStore,
    config: schedulerConfig.wikiPass,
    promptRegistry: promptState.registry,
    personaPreamble,
    onGateEvent: (event) => {
      eventBus.emit('memory.sleeptime_wiki.gate', event).catch((error: unknown) => {
        log.warn('Sleeptime wiki gate event emit failed', { error: String(error) });
      });
    },
  });
  intentionRuntime.behavioralPatternTracker.setPromotionHook(
    createBehavioralPatternMemoryPromotionHook(memoryWriter),
  );
  registerMemoryTools(agentLoop, {
    writer: memoryWriter,
    memoryStore,
    episodicStore,
    contactStore,
  });
  log.info('Context feedback runtime deferred (Phase VI): background context-scoring LLM calls disabled');

  // Git tools — parent turns stay read-only; mutation must return through shard outputs.
  registerGitTools(agentLoop, new GatewayGitOps(gatewayOps), {
    gatewayMode: true,
    access: 'read_only',
  });
  log.info('Git repository inspection tools enabled for parent agent');

  // Beads issue-management tools — policy-scoped gateway RPC access (no shell passthrough)
  registerBeadsTools(agentLoop, new GatewayBeadsOps(gatewayOps), { gatewayMode: true });
  log.info('Beads issue-management tools enabled');

  // World tool — perceive/list/control physical & virtual affordances via the
  // places registry and the privileged Home Assistant gateway method (bead .8).
  // Affordance→entity resolution is agent-side against places.json (defence in depth).
  // Capability gating: perceive/list->world.read, control->world.control
  // (resolveWorldRequirement). Effector control is staged OFF by default
  // (WORLD_CONTROL_RUNTIME_ENABLED) and, once enabled, additionally requires a
  // primary/trusted requester — resolved from the live turn request context.
  registerWorldTools(agentLoop, new GatewayWorldOps(gatewayOps), {
    placesRegistry: placesRegistryConfig,
    gatewayMode: true,
    resolveRequesterTrust: () => getRequestContext()?.viewerTrustLevel,
  });
  log.info('World tool enabled (perceive/list live; control staged off, trust-gated)');

  // Journal tools — durable markdown notes in the personal workspace.
  registerMarkdownJournalTools(agentLoop, pathSnapshot.workspaceRoot);

  // Validate tool wiring — catch misconfigured tools before they crash at invocation
  agentLoop.validateToolWiring('gateway', gateway, DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE);

  const moduleSummary = await moduleLoader.loadEnabledModules();
  log.info('Runtime modules initialized', moduleSummary);
  log.info('Re-validating tool wiring after module load', {
    mode: lifecycleRuntimeContract.mode,
    wiringMode: 'gateway',
    loadedModules: moduleSummary.loaded,
    failedModules: moduleSummary.failed,
  });
  agentLoop.validateToolWiring('gateway', gateway, DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE);

  // ── API backend (gateway-hosted edge) ──

  const {
    apiHost,
    apiPort,
    adminPort,
  } = resolveAgentApiSurfaceBindings(process.env);
  const apiHealthChecks = buildApiHealthChecks({
    config,
    memoryStore,
    gateway,
    scheduler,
    runtimeStatusMeta,
  }, resolveActiveHealthProbeConfig(process.env));
  const apiBackend = new AgentApiBackend({
    agentLoop,
    eventBus,
    sessionManager,
    llmProvider,
    contactStore,
    healthChecks: apiHealthChecks,
    externalChannelProfiles: buildExternalChannelProfiles(channelsConfig),
    satelliteRegistry: satelliteRegistryConfig,
    onStreamDelta: (requestId, text) => gateway.notifyApiStreamDelta(requestId, text),
  });
  gateway.onApiChatCompletion((params) => apiBackend.handleChatCompletion(params));
  gateway.onApiChatCancel((params) => apiBackend.cancelChatCompletion(params));
  gateway.onApiTelemetryIngest((params) => apiBackend.handleTelemetryIngest(params));
  gateway.onApiHealth(() => apiBackend.handleHealth());

  // ── Admin transport (optional) ──

  const outreachOutbox = createFileOutreachOutboxStore(
    resolveOutreachOutboxLedgerPath(pathSnapshot.companionDataDir),
  );

  const adminTransport = await startOptionalAdminTransportServer({
    adminPort,
    apiHost,
    apiPort,
    env: process.env,
    config,
    satelliteRegistryConfig,
    channelGroupMemory: channelsConfig.discord.groupMemory,
    gateway,
    eventBus,
    scheduler,
    postTurnActions,
    outreachOutbox,
    episodicStore,
    pendingContactApprovals,
    socialGraphProposals: socialGraphProposalStore,
    hubIdentityEnrollmentStore: persistedHubIdentityEnrollmentStore,
    card,
    shardManager,
    cardVersionStore,
    cardProposalQueue,
    coreRuntime: {
      memoryStore,
      sessionStore,
      sessionManager,
      contactStore,
      promptState,
      skillsRuntime,
      agentLoop,
      observerEvalSidecar,
      memoryExtractor,
      intentionRuntime,
      toolConformanceRunner,
    },
  });
  if (adminTransport) {
    log.info('Garden admin transport listening', {
      endpoint: adminTransport.describeEndpoint(),
    });
  }

  const heartbeatChannelId = channelsConfig.discord.heartbeatChannelId || undefined;
  const shutdownTargets: AgentControlPlaneShutdownTargets = {};
  const controlPlane = buildAgentControlPlane({
    heartbeatChannelId,
    dataDir: pathSnapshot.companionDataDir,
    config,
    eventBus,
    gateway,
    unregisterGatewayDisconnect,
    stopDebugObserver,
    writeGracefulShutdownMarkers: () => {
      const markedChannels = sessionStore.markGracefulShutdownForActiveChannels();
      if (markedChannels.length > 0) {
        log.info('Wrote graceful shutdown markers', { channels: markedChannels });
      }
    },
    closeDatabase: () => {},
    scheduler,
    moduleLoader,
    memoryExtractor,
    agentLoop,
    operatorNotifier,
    lifecycleRestartSafeguard,
    externalRateLimiter,
    capabilityRuntime,
    lifecycleRuntimeContract,
    shutdownTargets,
  });
  const { lifecycleNotifier } = controlPlane;
  let apiBackendDisposed = false;
  const disposeApiBackend = () => {
    if (apiBackendDisposed) return;
    apiBackendDisposed = true;
    apiBackend.dispose();
  };
  stopFn = async () => {
    disposeApiBackend();
    await controlPlane.stopFn();
  };
  shutdownTargets.adminTransport = adminTransport;
  shutdownTargets.appCache = appCache;
  const gatewaySender = {
    send: (channelId: string, content: string) => gateway.discordSend(channelId, content),
  };
  // Shared outbound-reply dedupe guard (psfn-framework-mdxu): the inbound
  // Discord reply pump records every delivered reply here, and the
  // deferred-tool-handoff continuation consults it to suppress a duplicate of a
  // reply the operator already received one turn earlier.
  const outboundReplyGuard = new OutboundReplyDeduper();
  // First proactive-outreach slice: only the configured primary heartbeat DM
  // is an approved target. Contact-graph channel resolution arrives with the
  // durable outbox (1xb.2).
  const proactiveOutbound = heartbeatChannelId
    ? new ProactiveOutboundDispatcher({
      sender: gatewaySender,
      rateLimiter: externalRateLimiter,
      isApprovedPrimaryChannel: (channelId) => channelId === heartbeatChannelId,
      eventBus,
    })
    : null;

  // ── Temporal wake-up lanes (E7.1) ──
  // Morning wake + idle time-of-day refresher. Both inject explicit system
  // notes (never partner speech). The catch-up summary reuses the SHARED
  // session summarization service (summarizeRecentSessionEntries, purpose
  // 'wake_session'); outward messages ride the existing proactive-outbound
  // dispatcher and quiet-hours time gate.
  // Wake summary budgets and the wake_continuity entry floor are JSON-owned
  // (scheduler.json temporalWakeup.wakeSummary); thread them into the session
  // manager so the context builder never falls back to hardcoded budgets.
  sessionManager.wakeSummaryConfig = { ...schedulerConfig.temporalWakeup.wakeSummary };
  registerTemporalWakeupTasks({
    scheduler,
    sessionManager,
    config: schedulerConfig.temporalWakeup,
    quietHours: schedulerConfig.episodicProcessing,
    // Surface how the morning wake slot was resolved (E7.2): fixed, habit
    // estimate, or habit fallback with a reason. Typed event + Garden read route.
    onWakeTimingResolved: (snapshot) => {
      void eventBus.emit('scheduler.wake_timing.resolved', {
        timingMode: snapshot.timingMode,
        source: snapshot.source,
        effectiveLocalTime: snapshot.effective.localTime,
        timeZone: snapshot.timeZone,
        sampleDays: snapshot.sampleDays,
        ...(snapshot.fallbackReason ? { fallbackReason: snapshot.fallbackReason } : {}),
        ...(snapshot.window
          ? {
            windowStartLocalTime: snapshot.window.startLocalTime,
            windowEndLocalTime: snapshot.window.endLocalTime,
          }
          : {}),
      });
    },
    summarizeCatchUp: async ({ channelId, entries }) => summarizeRecentSessionEntries({
      channelId,
      entries,
      characterName: card.data.name,
      llmProvider,
      promptRegistry: promptState.registry,
      maxTokens: schedulerConfig.temporalWakeup.morningWake.catchUpSummaryMaxTokens,
      purpose: 'wake_session',
    }),
    invokeWakeTurn: async ({ note }) => {
      const response = await agentLoop.handleMessage({
        id: `reflection-temporal-wakeup-${Date.now()}`,
        channelId: 'internal:reflection:temporal-wakeup',
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: TEMPORAL_WAKEUP_MORNING_TASK_NAME,
        content: [
          'A temporal wake note was just placed in your active session:',
          '',
          note,
          '',
          'This is your morning wake turn. If you want to send your partner an',
          'outward message right now, reply with only that message. If you have',
          `nothing you want to send outward, reply with "${HEARTBEAT_SILENT_REFLECTION_TOKEN}" — staying quiet is`,
          'completely fine; nothing about this wake requires an outward response.',
        ].join('\n'),
        timestamp: new Date(),
      });
      const trimmed = response.content.trim();
      if (!trimmed || trimmed.toLowerCase() === HEARTBEAT_SILENT_REFLECTION_TOKEN) {
        return null;
      }
      return trimmed;
    },
    ...(proactiveOutbound
      ? {
        dispatchOutbound: async ({ channelId, channelType, content }: {
          channelId: string;
          channelType: ChannelType;
          content: string;
        }) => proactiveOutbound.dispatch({
          actionId: `temporal-wakeup-${Date.now()}`,
          channelId,
          channelType,
          content,
          reason: 'temporal_wakeup_morning',
        }),
      }
      : {}),
  });

  // ── Free-time lanes (E8.1) ──
  // Self-directed time: two entry lanes (quiet-hours inside the rest window;
  // idle after a long partner gap) share one bounded, budget-capped, multi-turn
  // agent-loop block on an INTERNAL channel. Full persona (E6.2), her normal
  // tools under existing policy, outputs durable only. Deterministic gates run
  // before any spend; the block runs inside a 'background' charge context and
  // ends gracefully when the per-block turn/charge budget is exhausted. After a
  // block WITH activity, a "while you were away" note is placed on the partner
  // session via the shared summarizer; empty "loafed" blocks surface nothing.
  const freeTimePersonaVariablesProvider = buildCharacterPromptVariablesProvider(cardVersionStore);
  registerFreeTimeTasks({
    scheduler,
    sessionManager,
    config: schedulerConfig.freeTime,
    restWindow: schedulerConfig.episodicProcessing,
    eventBus,
    resolvePersonaBlock: () => formatReflectionPersonaBlock(freeTimePersonaVariablesProvider()),
    // The whole block runs inside a 'background' charge context so per-turn LLM
    // spend accumulates against the background lane; getRunChargeSnapshot lets
    // the runner read cumulative spend before each turn for the hard cap.
    runBlock: ({ run }) => {
      const chargePolicy = config.chargePolicy;
      if (!chargePolicy) {
        // No charge policy → run with a zero reader; the turn cap still bounds.
        return run(() => 0);
      }
      return runWithChargeContext({
        chargePolicy,
        eventBus,
        lane: 'background',
        correlation: getRequestContext(),
      }, () => run(() => getRunChargeSnapshot()?.spentByLane.background ?? 0));
    },
    // One free-time turn through the ordinary agent loop on the internal
    // channel. Internal channelId => isInternalSessionId() true => the loop
    // cannot dispatch outward to a partner channel. Full persona + her normal
    // tools apply (no restricted reflection policy). A "silent" reply ends the
    // block; staying quiet / loafing is a valid outcome.
    invokeTurn: async ({ lane, channelId, turnIndex, content }) => {
      const response = await agentLoop.handleMessage({
        id: `free-time-${lane}-${turnIndex}-${Date.now()}`,
        channelId,
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: 'Free Time',
        content,
        timestamp: new Date(),
      });
      return { content: response.content };
    },
    // Shared summarizer, free-time lane identity: distinct purpose/originStage
    // ('free_time_return') and a freeTime-owned token budget — never borrowed
    // from the morning-wake catch-up lane.
    summarizeActivity: async ({ channelId, entries }) => summarizeRecentSessionEntries({
      channelId,
      entries,
      characterName: card.data.name,
      llmProvider,
      promptRegistry: promptState.registry,
      maxTokens: schedulerConfig.freeTime.returnNote.summaryMaxTokens,
      purpose: 'free_time_return',
    }),
  });
  // ── Weighted-thought outreach lane (E?/1xb.2) ──
  // Internal-state-driven outreach: a weighted thought crossing threshold
  // produces an LLM nudge the companion accepts or declines; accepted nudges
  // ride the existing durable-outbox delivery path. Disabled by default
  // (scheduler.json weightedThoughtOutreach.enabled) and fail-closed on channel
  // resolution — primary heartbeat DM only until a group-continuation policy
  // approver is wired.
  if (persistenceRuntime.weightedThoughtStore) {
    registerWeightedThoughtOutreachTask({
      scheduler,
      eventBus,
      config: schedulerConfig.weightedThoughtOutreach,
      quietHours: schedulerConfig.episodicProcessing,
      store: persistenceRuntime.weightedThoughtStore,
      nudgeEvaluator: createLlmNudgeEvaluator({
        llmProvider,
        characterName: card.data.name,
      }),
      channelPolicy: {
        ...(heartbeatChannelId ? { primaryChannelId: heartbeatChannelId } : {}),
        primaryChannelType: 'discord',
      },
    });
  } else if (schedulerConfig.weightedThoughtOutreach.enabled) {
    log.warn('weightedThoughtOutreach enabled but no weighted-thought store is available; lane not registered');
  }

  // Journal auto-publisher (for heartbeat reflections -> markdown journal)
  const journalAutoPublisher = createOptionalJournalAutoPublisher(pathSnapshot.workspaceRoot, config);

  // Group-memory observation scheduler doubles as the canonical direct-vs-group
  // scope classifier for sleeptime cadence, so it is built before the heartbeat
  // runtime wiring below.
  const observedGroupMemoryScheduler = new ObservedGroupMemoryScheduler({
    channelGroupMemory: channelsConfig.discord.groupMemory,
    sessionReader: sessionStore,
    watermarkStore: new JsonGroupMemoryWatermarkStore(
      join(pathSnapshot.companionDataDir, 'group-memory-watermarks.json'),
    ),
    memoryExtractor,
    contactStore,
    companionNames: [card.data.name],
    companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
    ...(config.groupMemory ? { groupMemory: config.groupMemory } : {}),
  });

  // Heartbeat reflections — policy-driven multi-template reflection system
  await wireHeartbeatRuntime(
    agentLoop,
    scheduler,
    agentLoop,
    gatewaySender,
    pathSnapshot.companionDataDir,
    heartbeatChannelId,
    {
      eventBus,
      llmProvider,
      capabilityTier: config.capabilityTier,
      compositionalPolicy: config.compositionalPolicy,
      characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
      memoryWriter,
      promptRegistry: promptState.registry,
      reflectionStore,
      sessionManager,
      emotionState,
      contactStore,
      getActiveConcerns: intentionAppraisalHooks.getActiveConcerns,
      getRecentResolvedConcerns: intentionAppraisalHooks.getRecentResolvedConcerns,
      onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision,
      onIntentionFollowUpDecision: intentionAppraisalHooks.onIntentionFollowUpDecision,
      getPendingFollowUpsForResurfacing: intentionAppraisalHooks.getPendingFollowUpsForResurfacing,
      onIntentionFollowUpActivated: intentionAppraisalHooks.onIntentionFollowUpActivated,
      onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome,
      pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
      scheduledPromptStore: persistenceRuntime.scheduledPromptStore,
      coreMemoryStore,
      episodicSynthesizer,
      sleepConsolidator,
      arcWeaver,
      dreamMeaningPass,
      sleeptimeWikiPass,
      proactiveOutbound,
      outboundReplyGuard,
      outreachOutbox,
      memoryMaintenanceStore: memoryStore,
      episodicDiagnosticsStore: episodicStore,
      postTurnActions,
      episodicProcessingRestWindow: schedulerConfig.episodicProcessing,
      orientationRewriteGate: schedulerConfig.orientationRewrite,
      reflectionNoveltyGate: schedulerConfig.reflectionNovelty,
      nearTurnMemoryCadence: schedulerConfig.nearTurnMemory,
      episodeSynthesis: schedulerConfig.episodeSynthesis,
      episodicWatermarkStore: episodicStore,
      companionNames: [card.data.name],
      companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
      memoryScopeClassifier: observedGroupMemoryScheduler,
      intentionAppraisalEnabled: config.intentionAppraisalEnabled !== false,
      ...(journalAutoPublisher ? { vaultAutoPublisher: journalAutoPublisher } : {}),
    },
  );

  const trackSessionActivity = createSessionActivityTracker(
    sessionManager,
    pathSnapshot.companionDataDir,
  );

  // ── Register gateway inbound message handlers ──
  // Handles generic voice.handleMessage / voice.stream.* with legacy discord.* aliases.
  registerGatewayMessageHandlers({
    gateway,
    agentLoop,
    shardManager,
    safeguardAuditTrail,
    satelliteRouting: createNoopSatelliteRoutingPort(),
    config,
    log,
    trackSessionActivity,
    observedGroupMemoryScheduler,
    outboundReplyGuard,
  });

  await eventBus.emit('system.init', {});
  await eventBus.emit('system.ready', {});

  // Send "I'm back" notification (fire-and-forget)
  lifecycleNotifier.notifyReady().catch((err) => {
    log.error('Ready notification failed', { error: String(err) });
  });

  log.info('Ready — waiting for messages');

  // ── Graceful shutdown ──

  const shutdown = createSignalShutdownHandler({
    logger: log,
    runGracefulShutdown: stopFn,
    exit: (code) => { process.exit(code); },
    forceExitTimeoutMs: parsePositiveIntEnv(
      process.env.SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
    ),
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT').catch((error) => {
      log.error('Unhandled SIGINT shutdown error', { error: String(error) });
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').catch((error) => {
      log.error('Unhandled SIGTERM shutdown error', { error: String(error) });
      process.exit(1);
    });
  });

  registerProcessErrorHandlers({
    logger: log,
    requestShutdown: () => {
      void shutdown('uncaughtException').catch(() => process.exit(1));
    },
  });
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});
