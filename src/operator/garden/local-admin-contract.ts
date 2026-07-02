import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import { join } from 'node:path';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { PendingContactApprovalStore } from '../../core/contacts/pending-contact-approvals.js';
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
import { invalidateCachedPromptRuntimeLayoutStore } from '../../core/identity/prompt-runtime-store-cache.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { PostTurnActionRuntime } from '../../core/agent/post-turn-action-runtime.js';
import { getObserverEvalSidecarHealthSnapshot } from '../../core/eval/observer-sidecar/runtime.js';
import type { ObserverEvalSidecarRuntime } from '../../core/eval/observer-sidecar/types.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import type { OutreachOutboxStore } from '../../core/intention/outreach-outbox.js';
import { NorthStarStore } from '../../faculties/north-star/store.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import { JsonGroupMemoryWatermarkStore } from '../../faculties/memory/extraction/group-ranges.js';
import type { GroupMemoryBackfillExtractorPort } from '../../faculties/memory/extraction/group-backfill.js';
import type { EpisodicStorePort } from '../../faculties/memory/episodic/store.js';
import type { ShardExecutionPort } from '../../faculties/shards/port.js';
import type { SkillsRuntime } from '../../faculties/skills/runtime.js';
import { ValuesJournalStore } from '../../faculties/values/store.js';
import {
  resolveConfiguredCompanionDataDir,
  resolveChargeLedgerPath,
  resolveFatigueLedgerPath,
  resolveLegacyValuesJournalPath,
  resolveNorthStarPath,
  resolveValuesJournalPath,
} from '../../persistence/layout.js';
import { readLastActiveSession } from '../../system/lifecycle/notifications.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { EventBus } from '../../shared/event-bus.js';
import { RunChargeLedger } from '../../shared/telemetry/charge-ledger.js';
import { FatigueLedger } from '../../shared/telemetry/fatigue-ledger.js';
import type { ChannelGroupMemoryConfig } from '../../system/config/group-memory-config.js';
import { createPostgresModelUsageStoreFromConfig } from '../../persistence/postgres/model-usage-store.js';
import { createPostgresObserverEvalSidecarStore } from '../../core/eval/observer-sidecar/persistence.js';
import { createOwnerFileConfigStore } from '../../system/config/config-store.js';
import {
  createDefaultObserverEvalSidecarSettings,
  type SubstrateConfig,
} from '../../system/config/runtime-config-contracts.js';
import type {
  AdaptiveToolsStateProvider,
  AdminModelDiscoveryApi,
  ConfirmationQueueAdminApi,
  GardenAdminDomainServices,
} from './admin-contract.js';
import { AdminChatBootstrapService } from './chat/bootstrap.js';
import { AdminActionPipeDataService } from './services/action-pipe-service.js';
import { AdminAdaptiveToolsDataService } from './services/adaptive-tools-service.js';
import {
  AdminAuditHistoryDataService,
  GardenAuditHistoryJsonlStore,
  type GatewayAuditHistoryReader,
} from './services/audit-history-service.js';
import { registerAuditTimelineSources } from './services/audit-event-collector.js';
import { AdminChargeLedgerDataService } from './services/charge-ledger-service.js';
import { AdminConcernDataService } from './services/concern-service.js';
import { AdminContactsDataService } from './services/contacts-service.js';
import { createAdminPendingContactsService } from './services/pending-contacts-service.js';
import { createAdminRoomsService } from './services/rooms-service.js';
import { createAdminGraphProposalsService } from './services/graph-proposals-service.js';
import type { SocialGraphProposalStore } from '../../faculties/memory/social-graph/proposals.js';
import { AdminDashboardDataService } from './services/dashboard-service.js';
import { AdminEpisodicMemoryDataService } from './services/episodic-memory-service.js';
import { AdminGroupMemoryDataService } from './services/group-memory-diagnostics-service.js';
import { AdminIdentityDataService } from './services/identity-service.js';
import { AdminImagesDataService } from './services/images-service.js';
import { AdminMemoryDataService } from './services/memory-service.js';
import { AdminModelUsageDataService } from './services/model-usage-service.js';
import {
  AdminObserverEvalSidecarDataService,
  type AdminObserverEvalSidecarService,
} from './services/observer-eval-sidecar-service.js';
import { AdminPromptsDataService } from './services/prompts-service.js';
import { AdminSchedulerService } from './services/scheduler-service.js';
import { AdminSubsystemHealthDataService } from './services/subsystem-health-service.js';
import { AdminSessionDataService } from './services/session-service.js';
import { AdminSettingsDataService } from './services/settings-service.js';
import { AdminShardFoldReviewDataService } from './services/shard-fold-review-service.js';
import { AdminWikiDataService } from './services/wiki-service.js';
import type { AdminToolHealthProvider } from './tool-health-provider.js';

export interface InProcessGardenAdminContractOptions {
  apiBaseUrl?: string;
  apiHost?: string;
  apiPort?: number;
  memoryStore: MemoryStorePort;
  episodicStore?: EpisodicStorePort | null;
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  scheduler: Scheduler;
  shardManager: ShardExecutionPort;
  eventBus: EventBus;
  contactStore?: ContactStorePort | null;
  concernStore?: ConcernStorePort | null;
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
  postTurnActions?: PostTurnActionRuntime | null;
  outreachOutbox?: OutreachOutboxStore | null;
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  channelGroupMemory?: ChannelGroupMemoryConfig;
  memoryExtractor?: GroupMemoryBackfillExtractorPort | null;
  companionAuthorIds?: readonly string[];
  /** Pending contact approvals queue (E3.4 contact-tracking policy gate). */
  pendingContactApprovals?: PendingContactApprovalStore | null;
  /** Social-graph edge proposals emitted by the graph-builder worker (E4.2). */
  socialGraphProposals?: SocialGraphProposalStore | null;
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
  const chargeLedger = new RunChargeLedger(resolveChargeLedgerPath(companionDataDir), options.eventBus);
  const fatigueLedger = new FatigueLedger(resolveFatigueLedgerPath(companionDataDir), options.eventBus);
  const modelUsageStore = createPostgresModelUsageStoreFromConfig(options.config);
  const auditHistory = new AdminAuditHistoryDataService({
    gardenStore: new GardenAuditHistoryJsonlStore(join(options.config.dataDir, 'garden-audit-history.jsonl')),
    gatewayReader: resolveGatewayAuditReader(options.config),
    chargeLedger,
  });
  registerAuditTimelineSources({
    eventBus: options.eventBus,
    activeToolInvocations: new Map(),
    appendAuditTimelineEntry: (actionType, decision, narrative, details, actor) => {
      const joinedDetails = details
        ?.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0)
        .join(' ');
      auditHistory.appendGardenEntry({
        actionType,
        decision,
        narrative,
        ...(joinedDetails ? { details: joinedDetails } : {}),
        ...(actor ? { actor } : {}),
      });
    },
    resolveCompanionName: () => resolveCompanionNameFromConfig(options.config),
  });
  const promptRuntimeLayoutPath = resolvePromptRuntimeLayoutPath(companionDataDir);
  const promptRuntimeLayoutStore = new PromptRuntimeLayoutStore(
    promptRuntimeLayoutPath,
    {
      onMutation: (reason) => {
        invalidateCachedPromptRuntimeLayoutStore(promptRuntimeLayoutPath);
        options.config.runtimeHooks?.invalidatePromptPrefixCache?.(reason);
      },
    },
  );
  const adaptiveTools = new AdminAdaptiveToolsDataService({
    eventBus: options.eventBus,
    stateProvider: options.adaptiveToolsStateProvider ?? null,
    toolHealthProvider: options.toolHealthProvider ?? null,
  });
  const schedulerService = new AdminSchedulerService(options.scheduler, options.config.dataDir);
  const subsystemHealth = new AdminSubsystemHealthDataService({
    eventBus: options.eventBus,
    scheduler: schedulerService,
  });

  return {
    dashboard: new AdminDashboardDataService({
      memoryStore: options.memoryStore,
      sessionStore: options.sessionStore,
      sessionManager: options.sessionManager,
      scheduler: options.scheduler,
      shardManager: options.shardManager,
      eventBus: options.eventBus,
      adaptiveToolsService: adaptiveTools,
      resolveLastActiveSessionId,
    }),
    images: new AdminImagesDataService({
      config: options.config,
      companionDataDir,
    }),
    auditHistory,
    charges: new AdminChargeLedgerDataService(chargeLedger, fatigueLedger, options.config.chargePolicy?.fatigue ?? null),
    modelUsage: modelUsageStore ? new AdminModelUsageDataService(modelUsageStore, options.modelDiscovery) : null,
    observerEvalSidecar: createObserverEvalSidecarAdminService({
      config: options.config,
      runtime: options.observerEvalSidecar ?? null,
    }),
    actionPipe: options.postTurnActions
      ? new AdminActionPipeDataService(options.postTurnActions, options.outreachOutbox ?? null)
      : null,
    shards: new AdminShardFoldReviewDataService(options.shardManager),
    adaptiveTools,
    wiki: options.config.workspacePath
      ? new AdminWikiDataService(options.config.workspacePath)
      : null,
    episodicMemory: options.episodicStore
      ? new AdminEpisodicMemoryDataService(options.episodicStore)
      : null,
    groupMemory: new AdminGroupMemoryDataService({
      ...(options.config.groupMemory ? { groupMemory: options.config.groupMemory } : {}),
      ...(options.channelGroupMemory ? { channelGroupMemory: options.channelGroupMemory } : {}),
      sessionStore: options.sessionStore,
      memoryStore: options.memoryStore,
      ...(options.contactStore ? { contactStore: options.contactStore } : {}),
      watermarkStore: new JsonGroupMemoryWatermarkStore(join(companionDataDir, 'group-memory-watermarks.json')),
      ...(options.memoryExtractor ? { memoryExtractor: options.memoryExtractor } : {}),
      eventBus: options.eventBus,
      companionNames: [resolveCompanionNameFromConfig(options.config)],
      companionAuthorIds: options.companionAuthorIds ?? [],
    }),
    memory: new AdminMemoryDataService({
      memoryStore: options.memoryStore,
      contactStore: options.contactStore,
      embeddingService: options.embeddingService,
      resolveCompanionName: () => resolveCompanionNameFromConfig(options.config),
      appendAuditTimelineEntry: (actionType, decision, narrative, details) => {
        const joinedDetails = details
          ?.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0)
          .join(' ');
        auditHistory.appendGardenEntry({
          actionType,
          decision,
          narrative,
          ...(joinedDetails ? { details: joinedDetails } : {}),
          actor: 'operator',
        });
      },
    }),
    sessions: new AdminSessionDataService({
      sessionStore: options.sessionStore,
      sessionManager: options.sessionManager,
      eventBus: options.eventBus,
      contactStore: options.contactStore,
      memoryStore: options.memoryStore,
      config: options.config,
    }),
    contacts: new AdminContactsDataService({
      contactStore: options.contactStore,
      memoryStore: options.memoryStore,
      sessionStore: options.sessionStore,
    }),
    pendingContacts: options.pendingContactApprovals
      ? createAdminPendingContactsService({
        pendingApprovals: options.pendingContactApprovals,
        contactStore: options.contactStore ?? null,
      })
      : null,
    rooms: createAdminRoomsService({
      contactStore: options.contactStore ?? null,
    }),
    graphProposals: options.socialGraphProposals
      ? createAdminGraphProposalsService({
        proposalStore: options.socialGraphProposals,
        contactStore: options.contactStore ?? null,
      })
      : null,
    concerns: options.concernStore
      ? new AdminConcernDataService(options.concernStore)
      : null,
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
      appendAuditTimelineEntry: (actionType, decision, narrative, details) => {
        const joinedDetails = details
          ?.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0)
          .join(' ');
        auditHistory.appendGardenEntry({
          actionType,
          decision,
          narrative,
          ...(joinedDetails ? { details: joinedDetails } : {}),
          actor: 'operator',
        });
      },
      companionValuesLayerProvider: () => valuesJournal.buildCompanionDerivedLayer(),
    }),
    scheduler: schedulerService,
    subsystemHealth,
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

function createObserverEvalSidecarAdminService(input: {
  config: SubstrateConfig;
  runtime?: ObserverEvalSidecarRuntime | null;
}): AdminObserverEvalSidecarService | null {
  const settings = input.config.observerEvalSidecar ?? createDefaultObserverEvalSidecarSettings();

  const postgresDatabaseUrl = input.config.postgresDatabaseUrl?.trim();
  const persistence = settings.persistence.enabled
    && settings.garden.exposeTelemetry
    && input.config.persistenceBackend === 'postgres'
    && postgresDatabaseUrl
    ? createPostgresObserverEvalSidecarStore(postgresDatabaseUrl)
    : null;

  return new AdminObserverEvalSidecarDataService({
    persistence,
    getHealthSnapshot: () => getObserverEvalSidecarHealthSnapshot(input.runtime),
  });
}

function resolveGatewayAuditReader(_config: SubstrateConfig): GatewayAuditHistoryReader | null {
  return null;
}
