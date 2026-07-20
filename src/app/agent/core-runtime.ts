import type { CoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { EpisodicStorePort } from '../../faculties/memory/episodic/index.js';
import {
  createMemoryStorePort,
  type CoreMemoryStorePort,
  type MemoryStorePort,
} from '../../faculties/memory/memory-store-port.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import { createGatewayOpsPortFromClient } from '../../boundary/gateway/gateway-ops-port.js';
import { createLLMProviderPort } from '../../core/agent/contracts.js';
import type { EmotionRuntimeWiring } from '../../core/agent/substrate-agent.js';
import type { MemoryExtractor } from '../../faculties/memory/extraction.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { SessionTailCachePort } from '../../persistence/sessions/session-tail-cache-port.js';
import type { SkillsRuntime } from '../../faculties/skills/runtime.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import type { RuntimePathSnapshot } from '../../persistence/layout.js';
import type { ApprovalQueuePort } from '../../system/capabilities/approval-queue-port.js';
import type {
  IntentionRuntimeWiring,
  IntentionAppraisalHooks,
  IntentionBehavioralPatternHooks,
  IntentionRuntimeProviders,
} from '../../core/intention/runtime-wiring.js';
import {
  composeFatigueBudgetRuntime,
  composeSessionRuntimeAsync,
  composeSubstrateAgent,
  type FatigueBudgetComposition,
  wireDiagnosticsRuntime,
  wireCoreMemoryRuntime,
  wireMemoryRuntime,
  wireSelfModelRuntime,
} from '../startup/composition/composition.js';
import { wirePromptRuntime, wireCharacterCardRuntime, wireStaticPromptRegistry, wireSettingsRuntime, wireSessionToolsRuntime, buildCharacterPromptVariablesProvider } from '../startup/composition/parity.js';
import { registerContactRuntime } from '../../core/contacts/runtime-wiring.js';
import type { ContactRuntimeOptions } from '../../core/contacts/runtime-wiring.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import { wireSkillsRuntime } from '../../faculties/skills/runtime-wiring.js';
import { wireWikiRuntime } from '../../faculties/wiki/runtime-wiring.js';
import type { PersonalProjectLibrary } from '../../faculties/wiki/personal-projects.js';
import type { SharedWorldWikiCaretakerService } from '../../faculties/wiki/shared-world-caretaker.js';
import { registerFilesystemTools } from '../../boundary/integrations/filesystem/runtime-wiring.js';
import { GatewayFilesystemOps } from '../../boundary/integrations/filesystem/gateway-ops.js';
import { registerImageTools } from '../../primitives/images/runtime-wiring.js';
import { GatewayImageOps } from '../../primitives/images/gateway-ops.js';
import { ImageReferenceStore } from '../../primitives/images/reference-store.js';
import { DefaultImageVisionReviewer } from '../../primitives/images/vision-reviewer.js';
import { registerWebTools } from '../../boundary/integrations/web/runtime-wiring.js';
import { GatewayWebFetchOps } from '../../boundary/integrations/web/gateway-ops.js';
import { createWebSearchQueryJson } from '../../boundary/integrations/web/search.js';
import {
  createIntentionAppraisalHooks,
  createIntentionBehavioralPatternHooks,
  wireIntentionRuntimeStores,
} from '../../core/intention/runtime-wiring.js';
import { createAutomatedConcernRuntime } from '../../core/intention/concern-candidates.js';
import { createDefaultConcernRouteDispatcher } from './concern-route-wiring.js';
import { createIdentityCoolingOffManagerFromEnv } from '../../system/capabilities/safeguards.js';
import { composeSystemPromptTemplate } from '../../core/identity/loader.js';
import {
  createPromptStatePort,
  type PromptStatePort,
} from '../../core/identity/prompt-state-port.js';
import type { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import { createPersonaPreambleService, type PersonaPreamblePort } from '../../core/identity/persona-preamble.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { IcpFatigueRegulationReservationPort } from '../../core/agent/fatigue/regulation-reservation.js';
import { PostgresIcpFatigueRegulationReservationStore } from '../../persistence/postgres/icp-fatigue-regulation-reservation-store.js';
import type { ContactTrackingGate } from '../../core/contacts/tracking-gate.js';
import {
  createActiveMemoryRefreshFailureAlertHandler,
  createPromptGenerationFailureAlertHandler,
  isPromptGenerationFailureAlertConfigured,
} from '../startup/support/operator-alerts.js';
import { createAppCacheFromEnv } from '../../shared/cache/runtime.js';
import type { AppCache } from '../../shared/cache/types.js';
import type { NotificationPort } from '../../core/tools/ntfy.js';
import { resolveEmbeddingProviderProvenanceFromConfig } from '../../faculties/memory/embedding.js';
import { createObserverEvalSidecarRuntimeFromConfig } from '../../core/eval/observer-sidecar/config.js';
import type { ObserverEvalSidecarRuntime } from '../../core/eval/observer-sidecar/types.js';
import {
  resolveContactsDir,
  resolveContactBlockListPath,
  resolveIntrospectionConsentLedgerPath,
  resolvePersonalSkillsDir,
} from '../../persistence/layout.js';
import { IntrospectionConsentStore } from '../../faculties/introspection/consent-store.js';
import { IntrospectionTurnSensitivityDecisions } from '../../faculties/introspection/turn-sensitivity.js';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import { maybeCreateIntakeSinkGate } from '../../core/cogsec/intake/sink-gates.js';
import { loadIntakePolicyConfig } from '../../system/config/intake-policy-config.js';
import { createComponentLogger } from '../../shared/logger.js';
import { createSelfStatusTool } from '../../core/tools/self-status.js';
import { createSelfStatusMemoryStatsProvider } from './self-status-memory-stats.js';
import {
  createPostgresModelUsageStoreFromConfig,
  type PostgresModelUsageStore,
} from '../../persistence/postgres/model-usage-store.js';
import type { ModelUsageQueryPort } from '../../shared/telemetry/model-usage.js';
import {
  createToolConformanceRunner,
  type ToolConformanceRunner,
} from '../../core/agent/tool-conformance/runner.js';
import { getObserverEvalSidecarHealthSnapshot } from '../../core/eval/observer-sidecar/runtime.js';
import { createSensorCognitionBridge } from '../../core/agent/perception/sensor-cognition-bridge.js';
import { createIdentityClaimResolvingSink } from '../../core/agent/perception/identity-claim-resolver.js';
import { createPerceptionNoteDeliverer } from '../../core/agent/perception/presence-note-delivery.js';
import { createPresenceFollowSink } from '../../core/agent/perception/presence-follow.js';
import { HubIdentityEnrollmentService } from '../../core/enrollment/service.js';
import type { HubIdentityEnrollmentStorePort } from '../../core/enrollment/enrollment-store-port.js';
import {
  createAgentFacingIcpAutonomyRuntime,
  type AgentFacingIcpAutonomyRuntime,
} from '../../core/icp/agent-facing-autonomy.js';
import { icpTargetChannelInitiationCommand } from './icp-target-channel-command.js';
import type { BackgroundWorkStorePort } from '../../core/agent/background-work/store-port.js';
import type { BackgroundWorkRuntimeTuning } from '../../core/agent/background-work/config.js';
import type { BackgroundWorkWelfarePolicy } from '../../core/agent/background-work/store-port.js';

const log = createComponentLogger('AgentCoreRuntime');

export interface AgentCoreRuntimeOptions {
  config: CoreSubstrateConfig;
  /** Exact channels.json context-envelope registry ids allowed into merged continuity. */
  continuityChannelIds: readonly string[];
  /** Database credential kept outside the secret-sanitized core config. */
  postgresDatabaseUrl: string;
  pathSnapshot: RuntimePathSnapshot;
  eventBus: EventBus;
  gateway: GatewayClient;
  memoryStore?: MemoryStorePort;
  episodicStore?: EpisodicStorePort | null;
  backgroundWorkStore: BackgroundWorkStorePort;
  backgroundWorkTuning: BackgroundWorkRuntimeTuning;
  /** Anti-starvation welfare policy (mmo9.7.4), resolved from scheduler.json. */
  backgroundWorkWelfare?: Partial<BackgroundWorkWelfarePolicy>;
  contactStore?: ContactStorePort;
  card: CharacterCardV2;
  systemPrompt: string;
  capabilityRuntime: CapabilityRuntime;
  cardVersionStore: CharacterCardVersionStore;
  cardProposalQueue: ApprovalQueuePort;
  emotionRuntime: EmotionRuntimeWiring;
  operatorNotifier: NotificationPort;
  intentionRuntime?: IntentionRuntimeWiring;
  intentionProviders?: IntentionRuntimeProviders;
  identityCoolingOff?: ReturnType<typeof createIdentityCoolingOffManagerFromEnv>;
  primaryUserId?: string;
  primaryTelegramUserId?: string;
  /** Contact-tracking policy gate (E3.4). Absent gate behaves as 'auto' everywhere. */
  contactTrackingGate?: ContactTrackingGate | null;
  /** Satellite security registry (S10). Used by perception ingestion to resolve static place binding. */
  satelliteRegistryConfig?: SatelliteRegistryConfig;
  /** Places soft-registry (S10). Absent behaves as an empty registry. */
  placesRegistryConfig?: PlacesRegistryConfig;
  /**
   * Hub identity ↔ contact enrollment binding store (S10 D2a). When present
   * alongside a contact store, the perception path resolves face identity-claim
   * events to contacts (bead .13); absent leaves the bridge sink a no-op.
   */
  hubIdentityEnrollmentStore?: HubIdentityEnrollmentStorePort;
}

export interface AgentCoreRuntime {
  agentLoop: SubstrateAgent;
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  promptState: PromptStatePort;
  skillsRuntime: SkillsRuntime;
  memoryStore: MemoryStorePort;
  contactStore: ContactStorePort;
  coreMemoryStore: CoreMemoryStorePort;
  introspectionConsentStore: IntrospectionConsentStore;
  intentionRuntime: IntentionRuntimeWiring;
  intentionAppraisalHooks: IntentionAppraisalHooks;
  intentionBehavioralHooks: IntentionBehavioralPatternHooks;
  observerEvalSidecar: ObserverEvalSidecarRuntime;
  memoryExtractor: MemoryExtractor;
  personaPreamble: PersonaPreamblePort;
  imageVisionReviewer: DefaultImageVisionReviewer;
  personalProjects: PersonalProjectLibrary;
  appCache: AppCache;
  /** Redis-backed hot session tail; null unless settings.json enables it (psfn-framework-hgw3.5). */
  sessionTailCache: SessionTailCachePort | null;
  fatigueBudget: FatigueBudgetComposition['fatigueBudget'];
  fatigueLedger: FatigueBudgetComposition['fatigueLedger'];
  fatigueRegulationReservations?: IcpFatigueRegulationReservationPort;
  toolConformanceRunner: ToolConformanceRunner;
  sharedWorldWikiCaretaker: SharedWorldWikiCaretakerService | null;
  closeWikiRuntime: () => Promise<void>;
  /** Shared lazy durable model-usage query handle (b0yl.5); null on non-postgres. */
  getModelUsageQuery: () => ModelUsageQueryPort | null;
  icpAutonomyRuntime?: AgentFacingIcpAutonomyRuntime;
}

export async function buildAgentCoreRuntime(options: AgentCoreRuntimeOptions): Promise<AgentCoreRuntime> {
  const {
    config,
    postgresDatabaseUrl,
    pathSnapshot,
    eventBus,
    gateway,
    card,
    systemPrompt,
    capabilityRuntime,
    cardVersionStore,
    cardProposalQueue,
    emotionRuntime,
    operatorNotifier,
    identityCoolingOff = createIdentityCoolingOffManagerFromEnv(process.env, { auditTrail: undefined }),
    primaryUserId,
    primaryTelegramUserId,
    intentionProviders,
  } = options;
  const contactTrackingGate = options.contactTrackingGate ?? null;
  const icpAutonomyRuntime = config.multiCompanion === true && options.contactStore
    ? createAgentFacingIcpAutonomyRuntime({
        contactStore: options.contactStore,
        gateway,
        command: icpTargetChannelInitiationCommand,
      })
    : undefined;
  const episodicStore = options.episodicStore ?? (() => {
    throw new Error('PostgreSQL core runtime requires an injected episodic store');
  })();
  const invalidatePromptCache = (reason: string): void => {
    config.runtimeHooks?.invalidatePromptPrefixCache?.(reason);
  };

  const promptRegistry = wireStaticPromptRegistry(pathSnapshot.companionDataDir, {
    invalidatePromptCache,
  });
  const appCache = await createAppCacheFromEnv();
  const llmProvider = createLLMProviderPort(gateway);
  const gatewayOps = createGatewayOpsPortFromClient(gateway);
  const observerEvalSidecar = createObserverEvalSidecarRuntimeFromConfig(config, {
    postgresDatabaseUrl,
  });
  const sessionComposition = await composeSessionRuntimeAsync({
    config,
    postgresDatabaseUrl,
    eventBus,
    enableContinuity: true,
    continuityChannelIds: options.continuityChannelIds,
    promptRegistry,
    sessionIntegrityProvider: gateway.createSessionIntegrityProvider(),
  });
  const fatigueRuntime = composeFatigueBudgetRuntime({ config, eventBus });
  const fatigueRegulationReservations = config.multiCompanion === true
    ? await PostgresIcpFatigueRegulationReservationStore.connect(postgresDatabaseUrl)
    : null;
  const { sessionStore, sessionManager } = sessionComposition;
  sessionManager.characterName = card.data.name;

  // ── Cognition intake firewall sink gates (htm9.3) ──
  // One gate instance per agent process, built from intake-policy.json
  // (system-data owner file). Null when the firewall mode is 'off'. The gate
  // is threaded to every consequential sink: session context assembly
  // (prompt_assembly), memory candidacy (memory_write), the wiki tool
  // (wiki_write), the identity tool (persona_mutation), the contact tool
  // (trust_mutation), and the substrate agent's egress tool guard
  // (tool_egress + lethal-trifecta invariant).
  const intakeSinkGate = maybeCreateIntakeSinkGate({
    policy: loadIntakePolicyConfig(pathSnapshot.systemDataDir),
    actor: 'agent:intake-sink-gate',
  });
  sessionManager.intakeSinkGate = intakeSinkGate;
  if (intakeSinkGate) {
    log.info('Intake sink gates wired across consequential sinks', {
      mode: intakeSinkGate.mode,
    });
  }

  const memoryStore = options.memoryStore
    ? createMemoryStorePort(options.memoryStore)
    : (() => {
      throw new Error('PostgreSQL core runtime requires an injected memory store');
    })();

  const characterPromptVariablesProvider = buildCharacterPromptVariablesProvider(cardVersionStore);
  // E6.1: one shared persona preamble service. Its template + per-subsystem
  // labels/instructions are operator-editable through the prompt registry; the
  // companion name and compressed persona derive from the live character card.
  const personaPreamble = createPersonaPreambleService({
    registry: promptRegistry,
    personaVariables: characterPromptVariablesProvider,
  });

  const agentLoop = composeSubstrateAgent({
    eventBus,
    llmProvider,
    sessionManager,
    systemPrompt,
    characterName: card.data.name,
    characterPromptVariablesProvider,
    config,
    runtimeMode: 'gateway',
    streamTransport: {
      stream: gateway.stream.bind(gateway),
    },
    streamRuntimeOptions: {
      onTerminalFailure: createPromptGenerationFailureAlertHandler(operatorNotifier, card.data.name, {
        enabled: isPromptGenerationFailureAlertConfigured(process.env),
      }),
    },
    fatigueBudget: fatigueRuntime.fatigueBudget,
    ...(fatigueRegulationReservations ? { fatigueRegulationReservations } : {}),
    emotionRuntime,
    observerEvalSidecar,
    appCache,
    backgroundWorkStore: options.backgroundWorkStore,
    backgroundWorkTuning: options.backgroundWorkTuning,
    ...(options.backgroundWorkWelfare ? { backgroundWorkWelfare: options.backgroundWorkWelfare } : {}),
    contactTrackingGate,
    ...(options.placesRegistryConfig ? { placesRegistryConfig: options.placesRegistryConfig } : {}),
  });
  agentLoop.artifactApprovalQueue = cardProposalQueue;
  agentLoop.artifactApprovalNotifier = operatorNotifier;
  agentLoop.shareApprovedArtifacts = async (attachments, destination) => {
    if (destination.channelType !== 'discord') {
      throw new Error(
        `Approved artifact delivery is not supported for channel type ${destination.channelType}`,
      );
    }
    for (const attachment of attachments) {
      await gateway.discordSendMedia(destination.channelId, attachment);
    }
  };
  agentLoop.scratchpadProvider = memoryStore;
  agentLoop.intakeSinkGate = intakeSinkGate;
  agentLoop.setCapabilityRuntime(capabilityRuntime);
  wireDiagnosticsRuntime(eventBus);
  // E5.5: persistent active-memory refresh failure raises an operator alert
  // through the system-derived gateway notification path. The threshold is
  // config-owned (settings.json memoryRefreshFailureAlertThreshold) and the
  // handler factory fails closed on a missing or invalid value.
  eventBus.on(
    'memory.active_context.refresh',
    createActiveMemoryRefreshFailureAlertHandler({
      notifier: operatorNotifier,
      companionName: card.data.name,
      failureThreshold: config.memoryRefreshFailureAlertThreshold,
      enabled: isPromptGenerationFailureAlertConfigured(process.env),
    }),
  );
  // Lazily construct a read-only model-usage query port on first `diagnose`
  // call. Deferring avoids an idle pool and a startup migration race with the
  // gateway-side recorder; it fails closed to null on non-postgres backends.
  let cachedModelUsageStore: PostgresModelUsageStore | null | undefined;
  const getModelUsageQuery = (): ModelUsageQueryPort | null => {
    if (cachedModelUsageStore === undefined) {
      cachedModelUsageStore = createPostgresModelUsageStoreFromConfig({
        persistenceBackend: config.persistenceBackend,
        postgresDatabaseUrl,
        companionId: config.companionId,
      });
    }
    return cachedModelUsageStore;
  };
  const runtimePathLayout = pathSnapshot.runtimePathLayout;
  // Tool-surface conformance runner. getToolCatalog is a lazy closure evaluated
  // at run time, so it reflects the full tool set even though the sweep is
  // triggered long after this registration point.
  const toolConformanceRunner = createToolConformanceRunner({
    getToolCatalog: () => agentLoop.getToolCatalog(),
    systemDataDir: pathSnapshot.systemDataDir,
  });
  agentLoop.registerTool(createSelfStatusTool({
    config,
    getCapabilityTier: () => capabilityRuntime.getTier(),
    getAdaptiveToolRuntimeState: () => agentLoop.getAdaptiveToolRuntimeState(),
    getToolCatalogSnapshot: () => agentLoop.getToolCatalogSnapshot(),
    getToolHealthStatusByName: () => agentLoop.getToolHealthStatusByName(),
    getObserverEvalSidecarHealth: () => getObserverEvalSidecarHealthSnapshot(observerEvalSidecar),
    getMemoryStats: createSelfStatusMemoryStatsProvider(memoryStore),
    listRecentSessions: (limit) => sessionManager.listRecentSessions(limit),
    getStreamingState: () => agentLoop.isStreaming,
    logsDir: pathSnapshot.runtimePathLayout.logsDir,
    diagnosis: {
      env: process.env,
      paths: {
        systemDataDir: pathSnapshot.systemDataDir,
        companionDataDir: pathSnapshot.companionDataDir,
        workspacePath: pathSnapshot.workspacePath,
        logsDir: runtimePathLayout.logsDir,
        tempDir: runtimePathLayout.tempDir,
        backupsDir: runtimePathLayout.backupsDir,
      },
      repoRoot: process.cwd(),
      getModelUsageQuery,
    },
    runConformance: (trigger) => toolConformanceRunner.run(trigger),
    ...(icpAutonomyRuntime ? { availability: icpAutonomyRuntime } : {}),
  }), 'core');

  const skillsRuntime = wireSkillsRuntime(agentLoop, {
    // skills.json and usage telemetry are per-companion; deployment-provided
    // skill documents remain rooted at repoRoot, while managed skills remain
    // contained by this companion's Personal Workspace.
    dataDir: pathSnapshot.companionDataDir,
    seedDir: process.env.CONFIG_DIR,
    repoRoot: process.cwd(),
    managedRootDir: resolvePersonalSkillsDir(pathSnapshot.workspaceRoot),
  });
  registerWebTools(agentLoop, new GatewayWebFetchOps(gatewayOps), {
    gatewayMode: true,
    searchQueryJson: createWebSearchQueryJson(llmProvider),
    // Explicit backend selection (bead htm9.10): when OpenRouter
    // web tools are configured, the search action uses the gateway web.search
    // server-tool path instead of the local-crawler LLM planner.
    backend: config.openRouterWebTools?.enabled ? 'openrouter' : 'self_hosted',
  });
  registerFilesystemTools(agentLoop, new GatewayFilesystemOps(gatewayOps), { gatewayMode: true });
  const wikiRuntime = await wireWikiRuntime(agentLoop, pathSnapshot.workspaceRoot, {
    databaseUrl: postgresDatabaseUrl,
    ...(config.postgresSchema?.trim() ? { postgresSchema: config.postgresSchema.trim() } : {}),
    embedding: gateway,
    embeddingProvenance: resolveEmbeddingProviderProvenanceFromConfig(config, gateway.dims),
    eventBus,
    getConfig: () => config,
    getMultiCompanion: () => config.multiCompanion === true,
    getIntakeSinkGate: () => intakeSinkGate,
    ...(config.companionId ? { companionId: config.companionId } : {}),
    systemDataDir: pathSnapshot.systemDataDir,
  });
  // E8.3: attach the supplemental wiki RAG provider (null when the projection
  // is unavailable); pre-turn assembly consults it AFTER memory context.
  agentLoop.wikiRetrieval = wikiRuntime.retrievalService;
  const imageVisionReviewer = new DefaultImageVisionReviewer(config, {
    binaryFetcher: gateway.webFetchBinary.bind(gateway),
    llmProvider,
  });
  registerImageTools(agentLoop, new GatewayImageOps(gateway), {
    gatewayMode: true,
    reviewer: imageVisionReviewer,
    referenceResolver: new ImageReferenceStore(pathSnapshot.companionDataDir),
    wardrobeLookResolver: wikiRuntime.personalProjects,
  });
  agentLoop.imageVisionReviewer = imageVisionReviewer;
  // htm9.8: vision intake screening — every inbound image attachment is
  // screened via the gateway (`intake.screen_image`) before it can become a
  // vision block; the gateway answers 'skipped' when the firewall is off.
  agentLoop.visionIntakeScreener = {
    screenImageIntake: (input) => gateway.screenImageIntake(input),
  };
  const promptStore = wirePromptRuntime(
    agentLoop,
    pathSnapshot.companionDataDir,
    composeSystemPromptTemplate(),
    {
      cardStore: cardVersionStore,
      confirmationQueue: cardProposalQueue,
      identityCoolingOff,
      getCapabilityTier: () => capabilityRuntime.getTier(),
      invalidatePromptCache,
      getIntakeSinkGate: () => intakeSinkGate,
    },
  );
  wireCharacterCardRuntime(agentLoop, cardVersionStore, {
    getCapabilityTier: () => capabilityRuntime.getTier(),
    confirmationQueue: cardProposalQueue,
  });
  wireSettingsRuntime(agentLoop, config, { registerSystemTool: false });
  wireSessionToolsRuntime(agentLoop, sessionManager, pathSnapshot.companionDataDir, gateway, promptRegistry);
  const contactRuntimeOptions: ContactRuntimeOptions = {
    exportDir: resolveContactsDir(pathSnapshot.companionDataDir),
    // Reuse the shared confirmation queue (also used by card/module proposals)
    // so trusted-tier promotion proposals surface on the Garden Confirmations page.
    proposalQueue: cardProposalQueue,
    // htm9.16: companion-initiated block list. Same on-disk store the gateway
    // reads to drop blocked inbound before it reaches this agent process.
    blockList: new ContactBlockListStore(
      resolveContactBlockListPath(pathSnapshot.companionDataDir),
    ),
    ...(config.multiCompanion === true ? { permitInvalidation: gateway } : {}),
    ...(icpAutonomyRuntime ? { peerAvailability: icpAutonomyRuntime } : {}),
    getIntakeSinkGate: () => intakeSinkGate,
    ...(primaryTelegramUserId
      ? {
          bootstrapPrimaryIdentityLinks: [{
            channel: 'telegram',
            userId: primaryTelegramUserId,
            privacyLevel: 'private',
          }],
        }
      : {}),
  };
  if (!options.contactStore) {
    throw new Error('PostgreSQL core runtime requires an injected contact store');
  }
  const contactStore = await registerContactRuntime(
    agentLoop,
    options.contactStore,
    primaryUserId,
    contactRuntimeOptions,
  );

  // Perception ingestion (S10 Workstream D). The bridge normalizes presence/face
  // telemetry into PerceptionEvents; the identity-claim resolver (bead .13) turns
  // a face identity claim into a fail-closed ResolvedPresence. Bead .14 delivers
  // both resolved presences and raw presence detected/cleared events as
  // context-visible `[Presence] ...` notes on the satellite session channel.
  // Absent enrollment store leaves the sink a no-op; off/absent registry config
  // leaves the bridge itself inactive.
  const perceptionNoteDeliverer = createPerceptionNoteDeliverer(sessionManager);
  // Physical conversation-follows-you (vinz.20): resolved presences pass
  // through the follow decorator BEFORE note delivery — a fresh, trusted
  // (primary/trusted, human) identity claim at another satellite-bound
  // physical place auto-hands the emanation off to that satellite. The
  // companion-presence port is read lazily because the agent entrypoint wires
  // it after this composition; null (single-companion / flag-off) keeps the
  // follow local-only, which is the pre-multi-companion behavior.
  const presenceFollowSink = createPresenceFollowSink({
    inner: perceptionNoteDeliverer,
    target: agentLoop,
    getCompanionPresence: () => agentLoop.companionPresence,
    ...(options.placesRegistryConfig ? { placesRegistry: options.placesRegistryConfig } : {}),
    eventBus,
  });
  const perceptionSink = options.hubIdentityEnrollmentStore
    ? createIdentityClaimResolvingSink({
      enrollmentService: new HubIdentityEnrollmentService(
        options.hubIdentityEnrollmentStore,
        contactStore,
      ),
      contactStore,
      presenceSink: presenceFollowSink,
      inner: perceptionNoteDeliverer,
    })
    : undefined;
  createSensorCognitionBridge({
    eventBus,
    satelliteRegistry: options.satelliteRegistryConfig,
    placesRegistry: options.placesRegistryConfig,
    ...(perceptionSink ? { sink: perceptionSink } : {}),
  });
  const intentionRuntime = options.intentionRuntime ?? (() => {
    throw new Error('PostgreSQL core runtime requires injected intention persistence stores');
  })();
  wireIntentionRuntimeStores(agentLoop, intentionRuntime, intentionProviders ?? {
    concernProvider: null,
    pendingFollowUpProvider: null,
    behavioralPatternProvider: null,
  });
  const introspectionConsentStore = new IntrospectionConsentStore(
    resolveIntrospectionConsentLedgerPath(pathSnapshot.companionDataDir),
  );
  // Read the complete append-only chain at startup. Corruption or tampering is
  // fatal; an absent ledger remains safely unconfigured/disabled.
  introspectionConsentStore.load();
  const introspectionTurnSensitivityDecisions = new IntrospectionTurnSensitivityDecisions();
  agentLoop.setIntrospectionTurnSensitivityDecisions(introspectionTurnSensitivityDecisions);
  const coreMemoryStore = wireCoreMemoryRuntime({
    agentLoop,
    sessionManager,
    config,
    concernStore: intentionRuntime.concernStore,
    introspectionConsentStore,
    introspectionTurnSensitivityDecisions,
  });
  wireSelfModelRuntime(agentLoop);
  const intentionAppraisalHooks = createIntentionAppraisalHooks(
    intentionRuntime.concernStore,
    intentionRuntime.pendingFollowUpStore,
  );
  const intentionBehavioralHooks = createIntentionBehavioralPatternHooks(
    intentionRuntime.behavioralPatternTracker,
  );
  const concernRouteDispatcher = createDefaultConcernRouteDispatcher({
    companionDataDir: pathSnapshot.companionDataDir,
    eventBus,
  });
  const automatedConcernRuntime = await createAutomatedConcernRuntime({
    eventBus,
    llmProvider,
    concernStore: intentionRuntime.concernStore,
    personaPreamble,
    routeDispatcher: concernRouteDispatcher,
  });
  const memoryExtractor = wireMemoryRuntime({
    agentLoop,
    llmProvider,
    sessionManager,
    sessionStore,
    memoryStore,
    embeddingService: gateway,
    eventBus,
    config,
    promptRegistry,
    contactStore,
    episodicStore,
    concernCandidateSink: automatedConcernRuntime.extractionSink,
    isAutoContactCreationAllowed: contactTrackingGate
      ? (channelId: string) => contactTrackingGate.isAutoContactCreationAllowed(channelId)
      : null,
    personaPreamble,
  });
  const promptState = createPromptStatePort({
    layers: promptStore,
    registry: promptRegistry,
  });

  return {
    agentLoop,
    sessionStore,
    sessionManager,
    promptState,
    skillsRuntime,
    memoryStore,
    contactStore,
    coreMemoryStore,
    introspectionConsentStore,
    intentionRuntime,
    intentionAppraisalHooks,
    intentionBehavioralHooks,
    observerEvalSidecar,
    memoryExtractor,
    personaPreamble,
    imageVisionReviewer,
    personalProjects: wikiRuntime.personalProjects,
    appCache,
    sessionTailCache: sessionComposition.sessionTailCache,
    fatigueBudget: fatigueRuntime.fatigueBudget,
    fatigueLedger: fatigueRuntime.fatigueLedger,
    ...(fatigueRegulationReservations ? { fatigueRegulationReservations } : {}),
    toolConformanceRunner,
    sharedWorldWikiCaretaker: wikiRuntime.sharedWorldCaretaker,
    closeWikiRuntime: wikiRuntime.close,
    // Durable model-usage query handle (b0yl.5): shared lazy store also used by
    // the self-diagnosis tool, reused by the tool-usage evaluator scheduler lane
    // so the two do not open separate pools.
    getModelUsageQuery,
    ...(icpAutonomyRuntime ? { icpAutonomyRuntime } : {}),
  };
}
