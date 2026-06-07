// ── Shared Runtime Composition ──
// Common builders used across runtime, agent container, CLI, and test harnesses.
//
// Intentional wiring differences:
// - src/app/agent/main.ts runs in split mode (gateway + isolated agent) and wires gateway-backed providers.
// Keep core construction through these helpers so behavior stays aligned across split entrypoints.

import type { CoreSubstrateConfig, SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { createEventBusCostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import { SessionStore, type SessionIntegrityProvider } from '../../../persistence/sessions/store.js';
import { SessionManager } from '../../../core/session/manager.js';
import { UserContinuityStore } from '../../../core/session/continuity.js';
import {
  createDisabledCrossChannelContinuityPort,
  createUserContinuityPort,
} from '../../../core/session/cross-channel-continuity-port.js';
import { InternalRoleEnvelopeLedgerStore } from '../../../core/internal-role-envelopes/store.js';
import { wireInternalRoleEnvelopeRuntime } from '../../../core/internal-role-envelopes/runtime-wiring.js';
import {
  createEmbeddingProviderFromConfig as createEmbeddingProviderFromMemoryConfig,
  createEmbeddingProviderFromEnv as createEmbeddingProviderFromMemoryEnv,
  type EmbeddingRuntimeProvider,
} from '../../../faculties/memory/embedding.js';
import {
  SubstrateAgent,
  type EmotionRuntimeWiring,
  type SubstrateAgentOptions,
} from '../../../core/agent/substrate-agent.js';
import { MemoryRetriever } from '../../../faculties/memory/retrieval.js';
import type { EpisodicRetrievalStore } from '../../../faculties/memory/retrieval/episodic.js';
import { MemoryExtractor } from '../../../faculties/memory/extraction.js';
import { MemoryWriter } from '../../../faculties/memory/writer.js';
import type {
  CoreMemoryStorePort,
  MemoryStorePort,
} from '../../../faculties/memory/memory-store-port.js';
import { createCoreMemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { ShardManager } from '../../../faculties/shards/manager.js';
import { ShardFoldReviewController } from '../../../faculties/shards/fold-review.js';
import {
  createShardExecutionPort,
  type ShardExecutionPort,
} from '../../../faculties/shards/port.js';
import { createBoundedSubagentLaunchTool } from '../../../faculties/shards/tools.js';
import { SubagentFaculty } from '../../../faculties/subagents/faculty.js';
import { createSubagentTool } from '../../../faculties/subagents/tools.js';
import { createAnalysisWorkbenchTool } from '../../../core/tools/analysis-workbench/tools.js';
import { CoreMemoryStore } from '../../../faculties/core-memory/store.js';
import { createOrientTool } from '../../../faculties/core-memory/tools.js';
import { ValuesJournalStore } from '../../../faculties/values/store.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../../../core/tools/analysis-workbench/types.js';
import type { SandboxExecutionPort } from '../../../boundary/sandbox/capabilities/contracts.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import { loadCharacterCard, composeSystemPrompt } from '../../../core/identity/loader.js';
import { resolveCompanionIdFromConfig } from '../../../core/identity/companion-runtime.js';
import type { CharacterCardV2 } from '../../../core/identity/types.js';
import type { LLMProviderPort, EmbeddingProviderPort } from '../../../core/agent/contracts.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import type { ShardAuditTrail } from '../../../faculties/shards/manager.js';
import type { ApprovalQueuePort } from '../../../system/capabilities/approval-queue-port.js';
import type { ModuleRegistryMutation } from '../../../system/modules/types.js';
import type { RuntimeMode } from '../../../core/agent/tool-wiring-validator.js';
import type { ConcernStorePort } from '../../../core/intention/concern-store-port.js';
import {
  migrateLegacyPersistenceLayout,
  resolveConfiguredCompanionDataDir,
  resolveCoreMemoryPath,
  resolveContinuityDir,
  resolveLegacyValuesJournalPath,
  resolveShardFoldReviewStorePath,
  resolveShardSessionMemorySyncAuditPath,
  resolveSessionsDir,
  resolveValuesJournalPath,
} from '../../../persistence/layout.js';
import { createDefaultPostgresSessionAdapters } from '../../../persistence/sessions/postgres-adapters.js';

export interface SessionComposition {
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  continuityStore: UserContinuityStore | null;
  internalRoleEnvelopeLedger: InternalRoleEnvelopeLedgerStore;
}

export interface SessionCompositionOptions {
  config: SubstrateConfig;
  eventBus?: EventBus;
  sessionsDir?: string;
  enableContinuity?: boolean;
  promptRegistry?: PromptRegistryStatePort | null;
  sessionIntegrityProvider?: SessionIntegrityProvider | null;
}

function createSessionComposition(
  options: SessionCompositionOptions,
  sessionAdapters: Awaited<ReturnType<typeof createDefaultPostgresSessionAdapters>>,
  sessionsDir: string,
): SessionComposition {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  const sessionStore = new SessionStore(sessionsDir, {
    integrityProvider: options.sessionIntegrityProvider ?? null,
    sessionArchivePort: sessionAdapters.sessionArchivePort,
    transcriptProjection: sessionAdapters.transcriptProjection,
    turnRecordStore: sessionAdapters.turnRecordStore,
  });
  const sessionManager = new SessionManager(
    sessionStore,
    options.config,
    options.eventBus,
    options.promptRegistry ?? null,
    sessionAdapters.transcriptSearch,
  );
  const internalRoleEnvelopeLedger = wireInternalRoleEnvelopeRuntime(sessionManager, options.config);

  let continuityStore: UserContinuityStore | null = null;
  if (options.enableContinuity) {
    continuityStore = new UserContinuityStore(resolveContinuityDir(companionDataDir));
    sessionManager.crossChannelContinuity = createUserContinuityPort(continuityStore);
  } else {
    sessionManager.crossChannelContinuity = createDisabledCrossChannelContinuityPort();
  }

  return { sessionStore, sessionManager, continuityStore, internalRoleEnvelopeLedger };
}

export async function composeSessionRuntimeAsync(
  options: SessionCompositionOptions,
): Promise<SessionComposition> {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  migrateLegacyPersistenceLayout(companionDataDir);

  const sessionsDir = options.sessionsDir ?? resolveSessionsDir(companionDataDir);
  if (options.config.persistenceBackend !== 'postgres') {
    throw new Error('PostgreSQL session composition requires config.persistenceBackend=postgres');
  }
  const databaseUrl = options.config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL session composition requires config.postgresDatabaseUrl');
  }
  const sessionAdapters = await createDefaultPostgresSessionAdapters(databaseUrl, {
    sessionsDir,
  });
  return createSessionComposition(options, sessionAdapters, sessionsDir);
}

export function createEmbeddingProviderFromEnv(): EmbeddingRuntimeProvider {
  return createEmbeddingProviderFromMemoryEnv(process.env);
}

export function createEmbeddingProviderFromConfig(config: SubstrateConfig): EmbeddingRuntimeProvider {
  return createEmbeddingProviderFromMemoryConfig(config, process.env);
}

export interface IdentityComposition {
  companionId: string;
  card: CharacterCardV2;
  systemPrompt: string;
}

export function composeIdentity(config: SubstrateConfig): IdentityComposition {
  const card = loadCharacterCard(config.characterCardPath);
  return {
    companionId: resolveCompanionIdFromConfig(config),
    card,
    systemPrompt: composeSystemPrompt(card),
  };
}

export interface SubstrateAgentCompositionOptions {
  eventBus: EventBus;
  llmProvider: LLMProviderPort;
  sessionManager: SessionManager;
  systemPrompt: string;
  characterName?: string;
  characterPromptVariables?: Record<string, string>;
  characterPromptVariablesProvider?: () => Record<string, string>;
  config: CoreSubstrateConfig;
  runtimeMode?: RuntimeMode;
  emotionRuntime?: EmotionRuntimeWiring;
  streamRuntimeOptions?: SubstrateAgentOptions['streamRuntimeOptions'];
  streamTransport?: SubstrateAgentOptions['streamTransport'];
}

export function composeSubstrateAgent(options: SubstrateAgentCompositionOptions): SubstrateAgent {
  return new SubstrateAgent(
    options.eventBus,
    options.llmProvider,
    options.sessionManager,
    options.systemPrompt,
    options.config,
    {
      ...(options.characterName ? { characterName: options.characterName } : {}),
      ...(options.characterPromptVariables ? { characterPromptVariables: options.characterPromptVariables } : {}),
      ...(options.characterPromptVariablesProvider
        ? { characterPromptVariablesProvider: options.characterPromptVariablesProvider }
        : {}),
      ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
      ...(options.emotionRuntime ? { emotionRuntime: options.emotionRuntime } : {}),
      ...(options.streamRuntimeOptions ? { streamRuntimeOptions: options.streamRuntimeOptions } : {}),
      ...(options.streamTransport ? { streamTransport: options.streamTransport } : {}),
    },
  );
}

export interface SelfModelRuntimeTarget {
  setSelfModelRuntimeRequired(required: boolean): void;
}

export function wireSelfModelRuntime(target: SelfModelRuntimeTarget): void {
  target.setSelfModelRuntimeRequired(true);
}

export interface CoreMemoryRuntimeOptions {
  agentLoop: SubstrateAgent;
  sessionManager: SessionManager;
  config: SubstrateConfig;
  concernStore?: ConcernStorePort | null;
}

export function wireCoreMemoryRuntime(options: CoreMemoryRuntimeOptions): CoreMemoryStorePort {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  const store = createCoreMemoryStorePort(
    new CoreMemoryStore(resolveCoreMemoryPath(companionDataDir)),
  );
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(companionDataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(companionDataDir)],
  });
  options.sessionManager.setCoreMemoryProvider(store);
  options.agentLoop.registerTool(createOrientTool(store, {
    valuesJournal,
    concernStore: options.concernStore ?? null,
  }));
  return store;
}

export interface MemoryRuntimeOptions {
  agentLoop: SubstrateAgent;
  llmProvider: LLMProviderPort;
  sessionManager: SessionManager;
  sessionStore?: SessionStore | null;
  memoryStore: MemoryStorePort;
  embeddingService: EmbeddingProviderPort;
  eventBus: EventBus;
  config?: SubstrateConfig;
  promptRegistry?: PromptRegistryStatePort | null;
  contactStore?: ContactStorePort | null;
  episodicStore?: EpisodicRetrievalStore | null;
}

export function wireMemoryRuntime(options: MemoryRuntimeOptions): MemoryExtractor {
  const costTelemetry = createEventBusCostTelemetryPort(options.eventBus);
  options.agentLoop.memoryProvider = options.config
    ? new MemoryRetriever(
      options.memoryStore,
      options.embeddingService,
      options.config,
      costTelemetry,
      options.contactStore ?? null,
      options.llmProvider,
      options.episodicStore ?? null,
    )
    : new MemoryRetriever(
      options.memoryStore,
      options.embeddingService,
      undefined,
      costTelemetry,
      options.contactStore ?? null,
      options.llmProvider,
      options.episodicStore ?? null,
    );

  const memoryExtractor = options.config
    ? new MemoryExtractor(
      options.llmProvider,
      options.sessionManager,
      options.memoryStore,
      options.embeddingService,
      costTelemetry,
      options.config,
      options.promptRegistry ?? null,
      options.sessionStore ?? null,
      options.contactStore ?? null,
    )
    : new MemoryExtractor(
      options.llmProvider,
      options.sessionManager,
      options.memoryStore,
      options.embeddingService,
      costTelemetry,
      undefined,
      options.promptRegistry ?? null,
      options.sessionStore ?? null,
      options.contactStore ?? null,
    );
  options.sessionManager.setPreCompactionExtractionHandler(async ({
    channelId,
    entries,
    canonicalContactId,
  }) => {
    await memoryExtractor.queueCompactionExtraction(
      channelId,
      entries,
      canonicalContactId,
    );
  });
  options.agentLoop.memoryExtractor = memoryExtractor;
  return memoryExtractor;
}

export interface ToolRuntimeOptions {
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  llmProvider: LLMProviderPort;
  sessionStore: SessionStore;
  embeddingService: EmbeddingProviderPort;
  memoryStore: MemoryStorePort;
  sessionManager: SessionManager;
  config: SubstrateConfig;
  parentSystemPrompt: string;
  companionDataDir?: string;
  scheduler?: Scheduler | null;
  replConfig?: REPLConfig;
  shardAuditTrail?: ShardAuditTrail | null;
  runtimeMode?: RuntimeMode;
  getCapabilityTier?: () => CapabilityTier;
  compositionalPolicy?: SubstrateConfig['compositionalPolicy'];
  moduleInstallConfirmationQueue?: ApprovalQueuePort | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
  executionPort?: SandboxExecutionPort | null;
}

export function wireShardAndThinkRuntime(options: ToolRuntimeOptions): ShardExecutionPort {
  const companionDataDir = options.companionDataDir ?? resolveConfiguredCompanionDataDir(options.config);
  const foldReviewController = new ShardFoldReviewController(
    resolveShardFoldReviewStorePath(companionDataDir),
    new MemoryWriter(options.memoryStore, options.embeddingService),
  );
  const shardManager = new ShardManager({
    eventBus: options.eventBus,
    llmProvider: options.llmProvider,
    sessionStore: options.sessionStore,
    sessionManager: options.sessionManager,
    embeddingService: options.embeddingService,
    memoryProvider: options.agentLoop.memoryProvider,
    config: options.config,
    parentSystemPrompt: options.parentSystemPrompt,
    toolCatalogProvider: () => options.agentLoop.getToolCatalog(),
    auditTrail: options.shardAuditTrail ?? undefined,
    runtimeMode: options.runtimeMode,
    shardSessionMemorySyncAuditPath: resolveShardSessionMemorySyncAuditPath(companionDataDir),
    foldReviewController,
  });
  const subagentFaculty = new SubagentFaculty({
    eventBus: options.eventBus,
    llmProvider: options.llmProvider,
    sessionStore: options.sessionStore,
    embeddingService: options.embeddingService,
    memoryProvider: options.agentLoop.memoryProvider,
    config: options.config,
    parentSystemPrompt: options.parentSystemPrompt,
    toolCatalogProvider: () => options.agentLoop.getToolCatalog(),
    auditTrail: options.shardAuditTrail ?? undefined,
    runtimeMode: options.runtimeMode,
  });
  const shardExecutionPort = createShardExecutionPort(shardManager);
  options.agentLoop.registerTool(createSubagentTool(subagentFaculty), 'core');
  options.agentLoop.registerTool(createBoundedSubagentLaunchTool(shardManager), 'extended');

  options.agentLoop.registerTool(createAnalysisWorkbenchTool({
    llmProvider: options.llmProvider,
    embeddingService: options.embeddingService,
    memoryStore: options.memoryStore,
    sessionManager: options.sessionManager,
    scheduler: options.scheduler ?? null,
    eventBus: options.eventBus,
    costTelemetry: createEventBusCostTelemetryPort(options.eventBus),
    getCapabilityTier: options.getCapabilityTier,
    compositionalPolicy: options.compositionalPolicy,
    chargePolicy: options.config.chargePolicy,
    moduleInstallConfirmationQueue: options.moduleInstallConfirmationQueue,
    onModuleRegistryMutation: options.onModuleRegistryMutation,
    executionPort: options.executionPort ?? null,
    config: options.replConfig ?? DEFAULT_REPL_CONFIG,
    mutationPolicy: {
      allowRepoMutation: false,
      allowWorkspaceWrite: false,
    },
  }));

  return shardExecutionPort;
}
