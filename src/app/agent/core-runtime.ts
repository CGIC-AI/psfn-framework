import type Database from 'better-sqlite3';
import type { CoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import { MemoryStore } from '../../faculties/memory/store.js';
import { MemoryJournal } from '../../faculties/memory/journal.js';
import { EpisodicStore } from '../../faculties/memory/episodic/index.js';
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
import { composeSessionRuntimeAsync, composeSubstrateAgent, wireCoreMemoryRuntime, wireMemoryRuntime, wireSelfModelRuntime } from '../startup/composition/composition.js';
import { wirePromptRuntime, wireCharacterCardRuntime, wireStaticPromptRegistry, wireSettingsRuntime, wireSessionToolsRuntime, buildCharacterPromptVariablesProvider } from '../startup/composition/parity.js';
import { registerContactRuntime, wireContactRuntime } from '../../core/contacts/runtime-wiring.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import { wireSkillsRuntime } from '../../faculties/skills/runtime-wiring.js';
import { registerFilesystemTools } from '../../boundary/integrations/filesystem/runtime-wiring.js';
import { GatewayFilesystemOps } from '../../boundary/integrations/filesystem/gateway-ops.js';
import { registerImageTools } from '../../primitives/images/runtime-wiring.js';
import { GatewayImageOps } from '../../primitives/images/gateway-ops.js';
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
import { createIdentityCoolingOffManagerFromEnv } from '../../system/capabilities/safeguards.js';
import { composeSystemPromptTemplate } from '../../core/identity/loader.js';
import {
  createPromptStatePort,
  type PromptStatePort,
} from '../../core/identity/prompt-state-port.js';
import type { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { createPromptGenerationFailureAlertHandler } from '../startup/support/operator-alerts.js';
import type { NotificationPort } from '../../core/tools/ntfy.js';
import {
  resolveContactsDir,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolvePersonalSkillsDir,
  resolveScratchpadMirrorPath,
} from '../../persistence/layout.js';

export interface AgentCoreRuntimeOptions {
  config: CoreSubstrateConfig;
  pathSnapshot: RuntimePathSnapshot;
  eventBus: EventBus;
  gateway: GatewayClient;
  db?: Database.Database | null;
  memoryStore?: MemoryStorePort;
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
  memoryExtractor: MemoryExtractor;
  imageVisionReviewer: DefaultImageVisionReviewer;
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
  const db = options.db ?? null;

  const promptRegistry = wireStaticPromptRegistry(pathSnapshot.companionDataDir);
  const llmProvider = createLLMProviderPort(gateway);
  const gatewayOps = createGatewayOpsPortFromClient(gateway);
  const sessionComposition = await composeSessionRuntimeAsync({
    config,
    eventBus,
    enableContinuity: true,
    promptRegistry,
    sessionIntegrityProvider: gateway.createSessionIntegrityProvider(),
  });
  const { sessionStore, sessionManager } = sessionComposition;
  sessionManager.characterName = card.data.name;

  const memoryStore = options.memoryStore
    ? createMemoryStorePort(options.memoryStore)
    : (() => {
      if (!db) {
        throw new Error('SQLite memory fallback requires an initialized database handle');
      }
      return createMemoryStorePort(new MemoryStore(db, gateway.dims, {
        notesDir: resolveNotesDir(pathSnapshot.companionDataDir),
        scratchpadMirrorPath: resolveScratchpadMirrorPath(pathSnapshot.companionDataDir),
        journal: new MemoryJournal(resolveMemoryJournalPath(pathSnapshot.companionDataDir)),
      }));
    })();

  const agentLoop = composeSubstrateAgent({
    eventBus,
    llmProvider,
    sessionManager,
    systemPrompt,
    characterName: card.data.name,
    characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
    config,
    runtimeMode: 'gateway',
    streamTransport: {
      stream: gateway.stream.bind(gateway),
    },
    streamRuntimeOptions: {
      onTerminalFailure: createPromptGenerationFailureAlertHandler(operatorNotifier, card.data.name),
    },
    emotionRuntime,
  });
  agentLoop.scratchpadProvider = memoryStore;
  agentLoop.setCapabilityRuntime(capabilityRuntime);

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
  const imageVisionReviewer = new DefaultImageVisionReviewer(config, {
    binaryFetcher: gateway.webFetchBinary.bind(gateway),
    llmProvider,
  });
  registerImageTools(agentLoop, new GatewayImageOps(gateway), {
    gatewayMode: true,
    reviewer: imageVisionReviewer,
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
    },
  );
  wireCharacterCardRuntime(agentLoop, cardVersionStore, {
    getCapabilityTier: () => capabilityRuntime.getTier(),
    confirmationQueue: cardProposalQueue,
  });
  wireSettingsRuntime(agentLoop, config, { registerSystemTool: false });
  wireSessionToolsRuntime(agentLoop, sessionManager, pathSnapshot.companionDataDir, gateway);
  const contactRuntimeOptions = {
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
    episodicStore: db ? new EpisodicStore(db) : null,
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
    memoryExtractor,
    imageVisionReviewer,
  };
}
