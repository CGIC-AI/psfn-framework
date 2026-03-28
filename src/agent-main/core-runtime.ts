import type Database from 'better-sqlite3';
import type { SubstrateConfig } from '../system/config/runtime-config-contracts.js';
import type { EventBus } from '../shared/event-bus.js';
import { MemoryStore } from '../memory/store.js';
import { MemoryJournal } from '../memory/journal.js';
import type { GatewayClient } from '../boundary/gateway/client.js';
import type { EmotionRuntimeWiring } from '../agent/substrate-agent.js';
import type { PromptRegistryStore } from '../identity/prompt-registry.js';
import type { CoreMemoryStore } from '../core-memory/store.js';
import type { MemoryExtractor } from '../memory/extraction.js';
import type { SessionManager } from '../session/manager.js';
import type { SessionStore } from '../session/store.js';
import type { SkillsRuntime } from '../skills/runtime.js';
import type { CharacterCardV2 } from '../identity/types.js';
import type { CapabilityRuntime } from '../system/capabilities/runtime.js';
import type { RuntimePathSnapshot } from '../persistence/layout.js';
import type { ConfirmationQueue } from '../system/capabilities/confirmation-queue.js';
import type { IntentionRuntimeWiring, IntentionAppraisalHooks, IntentionBehavioralPatternHooks } from '../intention/runtime-wiring.js';
import { composeSessionRuntime, composeSubstrateAgent, wireCoreMemoryRuntime, wireMemoryRuntime, wireSelfModelRuntime } from '../app/startup/composition/composition.js';
import { wirePromptRuntime, wireCharacterCardRuntime, wireStaticPromptRegistry, wireSettingsRuntime, wireSessionToolsRuntime, buildCharacterPromptVariablesProvider } from '../app/startup/composition/parity.js';
import { wireContactRuntime } from '../contacts/runtime-wiring.js';
import { wireSkillsRuntime } from '../skills/runtime-wiring.js';
import { registerFilesystemTools } from '../filesystem/runtime-wiring.js';
import { GatewayFilesystemOps } from '../filesystem/gateway-ops.js';
import { registerImageTools } from '../images/runtime-wiring.js';
import { GatewayImageOps } from '../images/gateway-ops.js';
import { DefaultImageVisionReviewer } from '../images/vision-reviewer.js';
import { registerWebTools } from '../boundary/integrations/web/runtime-wiring.js';
import { GatewayWebFetchOps } from '../boundary/integrations/web/gateway-ops.js';
import { createIntentionAppraisalHooks, createIntentionBehavioralPatternHooks, wireIntentionRuntime } from '../intention/runtime-wiring.js';
import { createIdentityCoolingOffManagerFromEnv } from '../system/capabilities/safeguards.js';
import { composeSystemPromptTemplate } from '../identity/loader.js';
import type { PromptLayerStore } from '../identity/prompt-store.js';
import type { CharacterCardVersionStore } from '../identity/card-versioning.js';
import type { SubstrateAgent } from '../agent/substrate-agent.js';
import { createPromptGenerationFailureAlertHandler } from '../app/startup/support/operator-alerts.js';
import type { NtfyNotifier } from '../tools/ntfy.js';
import {
  resolveContactsDir,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveScratchpadMirrorPath,
} from '../persistence/layout.js';

export interface AgentCoreRuntimeOptions {
  config: SubstrateConfig;
  pathSnapshot: RuntimePathSnapshot;
  eventBus: EventBus;
  gateway: GatewayClient;
  db: Database.Database;
  memoryStore?: MemoryStore;
  card: CharacterCardV2;
  systemPrompt: string;
  capabilityRuntime: CapabilityRuntime;
  cardVersionStore: CharacterCardVersionStore;
  cardProposalQueue: ConfirmationQueue;
  emotionRuntime: EmotionRuntimeWiring;
  operatorNotifier: NtfyNotifier;
  identityCoolingOff?: ReturnType<typeof createIdentityCoolingOffManagerFromEnv>;
  primaryUserId?: string;
  primaryTelegramUserId?: string;
}

export interface AgentCoreRuntime {
  agentLoop: SubstrateAgent;
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  promptRegistry: PromptRegistryStore;
  promptStore: PromptLayerStore;
  skillsRuntime: SkillsRuntime;
  memoryStore: MemoryStore;
  contactStore: ReturnType<typeof wireContactRuntime>;
  coreMemoryStore: CoreMemoryStore;
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
    db,
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
  } = options;

  const promptRegistry = wireStaticPromptRegistry(pathSnapshot.companionDataDir);
  const sessionComposition = composeSessionRuntime({
    config,
    eventBus,
    enableContinuity: true,
    promptRegistry,
    sessionIntegrityProvider: gateway.createSessionIntegrityProvider(),
  });
  const { sessionStore, sessionManager } = sessionComposition;
  sessionManager.characterName = card.data.name;

  const memoryStore = options.memoryStore ?? new MemoryStore(db, gateway.dims, {
    notesDir: resolveNotesDir(pathSnapshot.companionDataDir),
    scratchpadMirrorPath: resolveScratchpadMirrorPath(pathSnapshot.companionDataDir),
    journal: new MemoryJournal(resolveMemoryJournalPath(pathSnapshot.companionDataDir)),
  });

  const agentLoop = composeSubstrateAgent({
    eventBus,
    llmProvider: gateway,
    sessionManager,
    systemPrompt,
    characterName: card.data.name,
    characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
    config,
    runtimeMode: 'gateway',
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
  });
  registerWebTools(agentLoop, new GatewayWebFetchOps(gateway), { gatewayMode: true });
  registerFilesystemTools(agentLoop, new GatewayFilesystemOps(gateway), { gatewayMode: true });
  const imageVisionReviewer = new DefaultImageVisionReviewer(config, {
    binaryFetcher: gateway.webFetchBinary.bind(gateway),
    llmProvider: gateway,
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
      identityCoolingOff,
      getCapabilityTier: () => capabilityRuntime.getTier(),
    },
  );
  wireCharacterCardRuntime(agentLoop, cardVersionStore, {
    getCapabilityTier: () => capabilityRuntime.getTier(),
    confirmationQueue: cardProposalQueue,
  });
  wireSettingsRuntime(agentLoop, config);
  wireSessionToolsRuntime(agentLoop, sessionManager, pathSnapshot.companionDataDir, gateway);
  const coreMemoryStore = wireCoreMemoryRuntime({
    agentLoop,
    sessionManager,
    config,
  });
  const contactStore = wireContactRuntime(
    agentLoop,
    db,
    primaryUserId,
    {
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
    },
  );
  const intentionRuntime = wireIntentionRuntime(agentLoop, db);
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
    llmProvider: gateway,
    sessionManager,
    sessionStore,
    memoryStore,
    embeddingService: gateway,
    eventBus,
    config,
    promptRegistry,
    contactStore,
  });

  return {
    agentLoop,
    sessionStore,
    sessionManager,
    promptRegistry,
    promptStore,
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
