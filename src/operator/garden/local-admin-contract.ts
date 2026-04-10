import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import { resolveCompanionNameFromConfig } from '../../core/identity/companion-runtime.js';
import {
  createPromptStatePort,
  type PromptStatePort,
} from '../../core/identity/prompt-state-port.js';
import {
  PromptRuntimeLayoutStore,
  resolvePromptRuntimeLayoutPath,
} from '../../core/identity/prompt-runtime.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { SessionManager } from '../../core/session/manager.js';
import { NorthStarStore } from '../../faculties/north-star/store.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { ShardExecutionPort } from '../../faculties/shards/port.js';
import type { SkillsRuntime } from '../../faculties/skills/runtime.js';
import { ValuesJournalStore } from '../../faculties/values/store.js';
import {
  resolveConfiguredCompanionDataDir,
  resolveLegacyValuesJournalPath,
  resolveNorthStarPath,
  resolveValuesJournalPath,
} from '../../persistence/layout.js';
import { readLastActiveSession } from '../../system/lifecycle/notifications.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createOwnerFileConfigStore } from '../../system/config/config-store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  AdaptiveToolsStateProvider,
  AdminModelDiscoveryApi,
  ConfirmationQueueAdminApi,
  GardenAdminDomainServices,
} from './admin-contract.js';
import { AdminChatBootstrapService } from './chat/bootstrap.js';
import { AdminAdaptiveToolsDataService } from './services/adaptive-tools-service.js';
import { AdminContactsDataService } from './services/contacts-service.js';
import { AdminDashboardDataService } from './services/dashboard-service.js';
import { AdminIdentityDataService } from './services/identity-service.js';
import { AdminMemoryDataService } from './services/memory-service.js';
import { AdminPromptsDataService } from './services/prompts-service.js';
import { AdminSchedulerService } from './services/scheduler-service.js';
import { AdminSessionDataService } from './services/session-service.js';
import { AdminSettingsDataService } from './services/settings-service.js';
import type { AdminToolHealthProvider } from './tool-health-provider.js';

export interface InProcessGardenAdminContractOptions {
  apiBaseUrl?: string;
  apiHost?: string;
  apiPort?: number;
  memoryStore: MemoryStorePort;
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  scheduler: Scheduler;
  shardManager: ShardExecutionPort;
  eventBus: EventBus;
  contactStore?: ContactStorePort | null;
  characterCard: CharacterCardV2;
  config: SubstrateConfig;
  embeddingService: EmbeddingProviderPort | null;
  modelDiscovery?: AdminModelDiscoveryApi | null;
  promptState?: PromptStatePort | null;
  cardVersionStore?: CharacterCardVersionStore | null;
  skillsRuntime?: SkillsRuntime | null;
  confirmationQueueApi?: ConfirmationQueueAdminApi | null;
  adaptiveToolsStateProvider?: AdaptiveToolsStateProvider | null;
  toolHealthProvider?: AdminToolHealthProvider | null;
}

export function createInProcessGardenAdminContract(
  options: InProcessGardenAdminContractOptions,
): GardenAdminDomainServices {
  const promptState = options.promptState ?? createPromptStatePort({});
  const configStore = createOwnerFileConfigStore({
    dataDir: options.config.dataDir,
    seedDir: process.env.CONFIG_DIR,
    defaultContextWindow: options.config.defaultContextWindow,
  });
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  const resolveLastActiveSessionId = () => readLastActiveSession(companionDataDir)?.sessionId ?? null;
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(companionDataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(companionDataDir)],
  });
  const northStarStore = new NorthStarStore(resolveNorthStarPath(companionDataDir));
  const promptRuntimeLayoutStore = new PromptRuntimeLayoutStore(
    resolvePromptRuntimeLayoutPath(companionDataDir),
  );

  return {
    dashboard: new AdminDashboardDataService({
      memoryStore: options.memoryStore,
      sessionStore: options.sessionStore,
      sessionManager: options.sessionManager,
      scheduler: options.scheduler,
      shardManager: options.shardManager,
      eventBus: options.eventBus,
      resolveLastActiveSessionId,
    }),
    adaptiveTools: new AdminAdaptiveToolsDataService({
      eventBus: options.eventBus,
      stateProvider: options.adaptiveToolsStateProvider ?? null,
      toolHealthProvider: options.toolHealthProvider ?? null,
    }),
    memory: new AdminMemoryDataService({
      memoryStore: options.memoryStore,
      contactStore: options.contactStore,
      embeddingService: options.embeddingService,
      resolveCompanionName: () => resolveCompanionNameFromConfig(options.config),
    }),
    sessions: new AdminSessionDataService({
      sessionStore: options.sessionStore,
      sessionManager: options.sessionManager,
      eventBus: options.eventBus,
      contactStore: options.contactStore,
    }),
    contacts: new AdminContactsDataService({
      contactStore: options.contactStore,
      memoryStore: options.memoryStore,
      sessionStore: options.sessionStore,
    }),
    settings: new AdminSettingsDataService({
      config: options.config,
      configStore,
    }),
    identity: new AdminIdentityDataService({
      characterCard: options.characterCard,
      config: options.config,
      cardVersionStore: options.cardVersionStore,
      promptStore: promptState.layers,
    }),
    prompts: new AdminPromptsDataService({
      promptStore: promptState.layers,
      promptRegistry: promptState.registry,
      northStarStore,
      promptRuntimeLayoutStore,
      sessionStore: options.sessionStore,
      sessionManager: options.sessionManager,
      resolveCompanionName: () => resolveCompanionNameFromConfig(options.config),
      companionValuesLayerProvider: () => valuesJournal.buildCompanionDerivedLayer(),
    }),
    scheduler: new AdminSchedulerService(options.scheduler, options.config.dataDir),
    skills: options.skillsRuntime ?? null,
    confirmations: options.confirmationQueueApi ?? null,
    values: valuesJournal,
    modelDiscovery: options.modelDiscovery ?? null,
    chatBootstrap: new AdminChatBootstrapService(options.contactStore, {
      apiBaseUrl: options.apiBaseUrl,
      apiHost: options.apiHost,
      apiPort: options.apiPort,
      config: options.config,
      resolveGlobalDefaultSessionId: resolveLastActiveSessionId,
    }),
  };
}
