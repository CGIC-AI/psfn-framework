import type Database from 'better-sqlite3';
import type { CoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import { MemoryStore } from '../../faculties/memory/store.js';
import { MemoryJournal } from '../../faculties/memory/journal.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import type { EmotionRuntimeWiring } from '../../core/agent/substrate-agent.js';
import type { PromptRegistryStore } from '../../core/identity/prompt-registry.js';
import type { CoreMemoryStore } from '../../faculties/core-memory/store.js';
import type { MemoryExtractor } from '../../faculties/memory/extraction.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { SkillsRuntime } from '../../faculties/skills/runtime.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import type { RuntimePathSnapshot } from '../../persistence/layout.js';
import type { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import type { IntentionRuntimeWiring, IntentionAppraisalHooks, IntentionBehavioralPatternHooks } from '../../core/intention/runtime-wiring.js';
import { composeSessionRuntime, composeSubstrateAgent, wireCoreMemoryRuntime, wireMemoryRuntime, wireSelfModelRuntime } from '../startup/composition/composition.js';
import { wirePromptRuntime, wireCharacterCardRuntime, wireStaticPromptRegistry, wireSettingsRuntime, wireSessionToolsRuntime, buildCharacterPromptVariablesProvider } from '../startup/composition/parity.js';
import { wireContactRuntime } from '../../core/contacts/runtime-wiring.js';
import { wireSkillsRuntime } from '../../faculties/skills/runtime-wiring.js';
import { registerFilesystemTools } from '../../boundary/integrations/filesystem/runtime-wiring.js';
import { GatewayFilesystemOps } from '../../boundary/integrations/filesystem/gateway-ops.js';
import { registerImageTools } from '../../primitives/images/runtime-wiring.js';
import { GatewayImageOps } from '../../primitives/images/gateway-ops.js';
import { DefaultImageVisionReviewer } from '../../primitives/images/vision-reviewer.js';
import { registerWebTools } from '../../boundary/integrations/web/runtime-wiring.js';
import { GatewayWebFetchOps } from '../../boundary/integrations/web/gateway-ops.js';
import { createIntentionAppraisalHooks, createIntentionBehavioralPatternHooks, wireIntentionRuntime } from '../../core/intention/runtime-wiring.js';
import { createIdentityCoolingOffManagerFromEnv } from '../../system/capabilities/safeguards.js';
import { composeSystemPromptTemplate } from '../../core/identity/loader.js';
import type { PromptLayerStore } from '../../core/identity/prompt-store.js';
import type { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { createPromptGenerationFailureAlertHandler } from '../startup/support/operator-alerts.js';
import type { NtfyNotifier } from '../../core/tools/ntfy.js';
import {
  resolveContactsDir,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveScratchpadMirrorPath,
} from '../../persistence/layout.js';

export interface AgentCoreRuntimeOptions {
  config: CoreSubstrateConfig;
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
