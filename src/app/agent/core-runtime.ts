import type Database from 'better-sqlite3';
import type { CoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import { MemoryStore } from '../../faculties/memory/store.js';
import { MemoryJournal } from '../../faculties/memory/journal.js';
import { EpisodicStore, type EpisodicStorePort } from '../../faculties/memory/episodic/index.js';
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
  wireCoreMemoryRuntime,
  wireMemoryRuntime,
  wireSelfModelRuntime,
} from '../startup/composition/composition.js';
import { wirePromptRuntime, wireCharacterCardRuntime, wireStaticPromptRegistry, wireSettingsRuntime, wireSessionToolsRuntime, buildCharacterPromptVariablesProvider } from '../startup/composition/parity.js';
import { registerContactRuntime, wireContactRuntime } from '../../core/contacts/runtime-wiring.js';
import type { ContactRuntimeOptions } from '../../core/contacts/runtime-wiring.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import { wireSkillsRuntime } from '../../faculties/skills/runtime-wiring.js';
import { wireWikiRuntime } from '../../faculties/wiki/runtime-wiring.js';
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
  wireIntentionRuntime,
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
import type { ContactTrackingGate } from '../../core/contacts/tracking-gate.js';
import {
  createActiveMemoryRefreshFailureAlertHandler,
  createPromptGenerationFailureAlertHandler,
  isPromptGenerationFailureAlertConfigured,
} from '../startup/support/operator-alerts.js';
import { createAppCacheFromEnv } from '../../shared/cache/runtime.js';
import type { AppCache } from '../../shared/cache/types.js';
import type { NotificationPort } from '../../core/tools/ntfy.js';
import { createObserverEvalSidecarRuntimeFromConfig } from '../../core/eval/observer-sidecar/config.js';
import type { ObserverEvalSidecarRuntime } from '../../core/eval/observer-sidecar/types.js';
import {
  resolveContactsDir,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolvePersonalSkillsDir,
  resolveScratchpadMirrorPath,
} from '../../persistence/layout.js';
import { createSelfStatusTool } from '../../core/tools/self-status.js';
import { getObserverEvalSidecarHealthSnapshot } from '../../core/eval/observer-sidecar/runtime.js';

export interface AgentCoreRuntimeOptions {
  config: CoreSubstrateConfig;
  pathSnapshot: RuntimePathSnapshot;
  eventBus: EventBus;
  gateway: GatewayClient;
  db?: Database.Database | null;
  memoryStore?: MemoryStorePort;
  episodicStore?: EpisodicStorePort | null;
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
  intentionRuntime: IntentionRuntimeWiring;
  intentionAppraisalHooks: IntentionAppraisalHooks;
  intentionBehavioralHooks: IntentionBehavioralPatternHooks;
  observerEvalSidecar: ObserverEvalSidecarRuntime;
  memoryExtractor: MemoryExtractor;
  personaPreamble: PersonaPreamblePort;
  imageVisionReviewer: DefaultImageVisionReviewer;
  appCache: AppCache;
  fatigueBudget: FatigueBudgetComposition['fatigueBudget'];
  fatigueLedger: FatigueBudgetComposition['fatigueLedger'];
}

export async function buildAgentCoreRuntime(options: AgentCoreRuntimeOptions): Promise<AgentCoreRuntime> {
  const {
    config,
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
  const db = options.db ?? null;
  const episodicStore = options.episodicStore ?? (() => {
    if (config.persistenceBackend === 'postgres') {
      throw new Error('PostgreSQL core runtime requires an injected episodic store');
    }
    return db ? new EpisodicStore(db) : null;
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
  const observerEvalSidecar = createObserverEvalSidecarRuntimeFromConfig(config);
  const sessionComposition = await composeSessionRuntimeAsync({
    config,
    eventBus,
    enableContinuity: true,
    promptRegistry,
    sessionIntegrityProvider: gateway.createSessionIntegrityProvider(),
  });
  const fatigueRuntime = composeFatigueBudgetRuntime({ config, eventBus });
  const { sessionStore, sessionManager } = sessionComposition;
  sessionManager.characterName = card.data.name;

  const memoryStore = options.memoryStore
    ? createMemoryStorePort(options.memoryStore)
    : (() => {
      if (config.persistenceBackend === 'postgres') {
        throw new Error('PostgreSQL core runtime requires an injected memory store');
      }
      if (!db) {
        throw new Error('SQLite memory fallback requires an initialized database handle');
      }
      return createMemoryStorePort(new MemoryStore(db, gateway.dims, {
        notesDir: resolveNotesDir(pathSnapshot.companionDataDir),
        scratchpadMirrorPath: resolveScratchpadMirrorPath(pathSnapshot.companionDataDir),
        journal: new MemoryJournal(resolveMemoryJournalPath(pathSnapshot.companionDataDir)),
      }));
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
    emotionRuntime,
    observerEvalSidecar,
    appCache,
    contactTrackingGate,
  });
  agentLoop.scratchpadProvider = memoryStore;
  agentLoop.setCapabilityRuntime(capabilityRuntime);
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
  agentLoop.registerTool(createSelfStatusTool({
    config,
    getCapabilityTier: () => capabilityRuntime.getTier(),
    getAdaptiveToolRuntimeState: () => agentLoop.getAdaptiveToolRuntimeState(),
    getToolCatalogSnapshot: () => agentLoop.getToolCatalogSnapshot(),
    getToolHealthStatusByName: () => agentLoop.getToolHealthStatusByName(),
    getObserverEvalSidecarHealth: () => getObserverEvalSidecarHealthSnapshot(observerEvalSidecar),
    getMemoryStats: () => memoryStore.getStats(),
    listRecentSessions: (limit) => sessionManager.listRecentSessions(limit),
    getStreamingState: () => agentLoop.isStreaming,
  }), 'core');

  const skillsRuntime = wireSkillsRuntime(agentLoop, {
    dataDir: pathSnapshot.systemDataDir,
    seedDir: process.env.CONFIG_DIR,
    repoRoot: process.cwd(),
    managedRootDir: resolvePersonalSkillsDir(pathSnapshot.workspaceRoot),
  });
  registerWebTools(agentLoop, new GatewayWebFetchOps(gatewayOps), {
    gatewayMode: true,
    searchQueryJson: createWebSearchQueryJson(llmProvider),
  });
  registerFilesystemTools(agentLoop, new GatewayFilesystemOps(gatewayOps), { gatewayMode: true });
  const wikiRuntime = await wireWikiRuntime(agentLoop, pathSnapshot.workspaceRoot, {
    ...(config.postgresDatabaseUrl?.trim() ? { databaseUrl: config.postgresDatabaseUrl.trim() } : {}),
    embedding: gateway,
    eventBus,
    getConfig: () => config,
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
  });
  agentLoop.imageVisionReviewer = imageVisionReviewer;
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
    },
  );
  wireCharacterCardRuntime(agentLoop, cardVersionStore, {
    getCapabilityTier: () => capabilityRuntime.getTier(),
    confirmationQueue: cardProposalQueue,
  });
  wireSettingsRuntime(agentLoop, config, { registerSystemTool: false });
  wireSessionToolsRuntime(agentLoop, sessionManager, pathSnapshot.companionDataDir, gateway);
  const contactRuntimeOptions: ContactRuntimeOptions = {
    exportDir: resolveContactsDir(pathSnapshot.companionDataDir),
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
  const contactStore = options.contactStore
    ? await registerContactRuntime(agentLoop, options.contactStore, primaryUserId, contactRuntimeOptions)
    : await (() => {
      if (config.persistenceBackend === 'postgres') {
        throw new Error('PostgreSQL core runtime requires an injected contact store');
      }
      if (!db) {
        throw new Error('Contact runtime requires an injected ContactStorePort for non-sqlite backends');
      }
      return wireContactRuntime(
        agentLoop,
        db,
        primaryUserId,
        contactRuntimeOptions,
      );
    })();
  const intentionRuntime = options.intentionRuntime ?? (() => {
    if (config.persistenceBackend === 'postgres') {
      throw new Error('PostgreSQL core runtime requires injected intention persistence stores');
    }
    if (!db) {
      throw new Error('Intention runtime requires injected persistence stores for non-sqlite backends');
    }
    return wireIntentionRuntime(agentLoop, db);
  })();
  if (options.intentionRuntime) {
    wireIntentionRuntimeStores(agentLoop, options.intentionRuntime, intentionProviders ?? {
      concernProvider: null,
      pendingFollowUpProvider: null,
      behavioralPatternProvider: null,
    });
  }
  const coreMemoryStore = wireCoreMemoryRuntime({
    agentLoop,
    sessionManager,
    config,
    concernStore: intentionRuntime.concernStore,
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
  const automatedConcernRuntime = createAutomatedConcernRuntime({
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
    intentionRuntime,
    intentionAppraisalHooks,
    intentionBehavioralHooks,
    observerEvalSidecar,
    memoryExtractor,
    personaPreamble,
    imageVisionReviewer,
    appCache,
    fatigueBudget: fatigueRuntime.fatigueBudget,
    fatigueLedger: fatigueRuntime.fatigueLedger,
  };
}
