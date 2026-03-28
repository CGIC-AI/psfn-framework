// ── Shared Runtime Composition ──
// Common builders used across runtime, agent container, CLI, and test harnesses.
//
// Intentional wiring differences:
// - src/app/agent/main.ts runs in split mode (gateway + isolated agent) and wires gateway-backed providers.
// Keep core construction through these helpers so behavior stays aligned across split entrypoints.

import type { CoreSubstrateConfig, SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { SessionStore, type SessionIntegrityProvider } from '../../../persistence/sessions/store.js';
import { SessionManager } from '../../../core/session/manager.js';
import { UserContinuityStore } from '../../../core/session/continuity.js';
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
import { MemoryExtractor } from '../../../faculties/memory/extraction.js';
import type { MemoryStore } from '../../../faculties/memory/store.js';
import type { ContactStore } from '../../../core/contacts/store.js';
import { ShardManager } from '../../../faculties/shards/manager.js';
import {
  createShardExecutionPort,
  type ShardExecutionPort,
} from '../../../faculties/shards/port.js';
import { createBoundedSubagentLaunchTool } from '../../../faculties/shards/tools.js';
import { createThinkTool } from '../../../core/tools/think/tools.js';
import { CoreMemoryStore } from '../../../faculties/core-memory/store.js';
import {
  createCoreMemoryAppendTool,
  createCoreMemoryReplaceTool,
  createMemoryRethinkTool,
} from '../../../faculties/core-memory/tools.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../../../core/tools/think/types.js';
import type { SandboxExecutionPort } from '../../../boundary/sandbox/capabilities/contracts.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import { loadOrInitializeCharacterCard, composeSystemPrompt } from '../../../core/identity/loader.js';
import { resolveCompanionIdFromConfig } from '../../../core/identity/companion-runtime.js';
import type { CharacterCardV2 } from '../../../core/identity/types.js';
import type { LLMProvider, EmbeddingService } from '../../../core/agent/contracts.js';
import type { PromptRegistryStore } from '../../../core/identity/prompt-registry.js';
import type { ShardAuditTrail } from '../../../faculties/shards/manager.js';
import type { ConfirmationQueue } from '../../../system/capabilities/confirmation-queue.js';
import type { ModuleRegistryMutation } from '../../../system/modules/types.js';
import type { RuntimeMode } from '../../../core/agent/tool-wiring-validator.js';
import {
  ensurePersistenceLayout,
  migrateLegacyPersistenceLayout,
  resolveConfiguredCompanionDataDir,
  resolveCoreMemoryPath,
  resolveContinuityDir,
  resolveShardSessionMemorySyncAuditPath,
  resolveSessionsDir,
} from '../../../persistence/layout.js';

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
  promptRegistry?: PromptRegistryStore | null;
  sessionIntegrityProvider?: SessionIntegrityProvider | null;
}

export function composeSessionRuntime(options: SessionCompositionOptions): SessionComposition {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  ensurePersistenceLayout(companionDataDir);
  migrateLegacyPersistenceLayout(companionDataDir);

  const sessionsDir = options.sessionsDir ?? resolveSessionsDir(companionDataDir);
  const sessionStore = new SessionStore(sessionsDir, {
    integrityProvider: options.sessionIntegrityProvider ?? null,
  });
  const sessionManager = new SessionManager(
    sessionStore,
    options.config,
    options.eventBus,
    options.promptRegistry ?? null,
  );
  const internalRoleEnvelopeLedger = wireInternalRoleEnvelopeRuntime(sessionManager, options.config);

  let continuityStore: UserContinuityStore | null = null;
  if (options.enableContinuity) {
    continuityStore = new UserContinuityStore(resolveContinuityDir(companionDataDir));
    sessionManager.continuityStore = continuityStore;
  }

  return { sessionStore, sessionManager, continuityStore, internalRoleEnvelopeLedger };
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
  const card = loadOrInitializeCharacterCard(config.characterCardPath);
  return {
    companionId: resolveCompanionIdFromConfig(config),
    card,
    systemPrompt: composeSystemPrompt(card),
  };
}

export interface SubstrateAgentCompositionOptions {
  eventBus: EventBus;
  llmProvider: LLMProvider;
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
}

export function wireCoreMemoryRuntime(options: CoreMemoryRuntimeOptions): CoreMemoryStore {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  const store = new CoreMemoryStore(resolveCoreMemoryPath(companionDataDir));
  options.sessionManager.setCoreMemoryProvider(store);
  options.agentLoop.registerTool(createCoreMemoryAppendTool(store));
  options.agentLoop.registerTool(createCoreMemoryReplaceTool(store));
  options.agentLoop.registerTool(createMemoryRethinkTool(store));
  return store;
}

export interface MemoryRuntimeOptions {
  agentLoop: SubstrateAgent;
  llmProvider: LLMProvider;
  sessionManager: SessionManager;
  sessionStore?: SessionStore | null;
  memoryStore: MemoryStore;
  embeddingService: EmbeddingService;
  eventBus: EventBus;
  config?: SubstrateConfig;
  promptRegistry?: PromptRegistryStore | null;
  contactStore?: ContactStore | null;
}

export function wireMemoryRuntime(options: MemoryRuntimeOptions): MemoryExtractor {
  options.agentLoop.memoryProvider = options.config
    ? new MemoryRetriever(
      options.memoryStore,
      options.embeddingService,
      options.config,
      options.eventBus,
      options.contactStore ?? null,
      options.llmProvider,
    )
    : new MemoryRetriever(
      options.memoryStore,
      options.embeddingService,
      undefined,
      options.eventBus,
      options.contactStore ?? null,
      options.llmProvider,
    );

  const memoryExtractor = options.config
    ? new MemoryExtractor(
      options.llmProvider,
      options.sessionManager,
      options.memoryStore,
      options.embeddingService,
      options.eventBus,
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
      options.eventBus,
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
  llmProvider: LLMProvider;
  sessionStore: SessionStore;
  embeddingService: EmbeddingService;
  memoryStore: MemoryStore;
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
  moduleInstallConfirmationQueue?: ConfirmationQueue | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
  executionPort?: SandboxExecutionPort | null;
}

export function wireShardAndThinkRuntime(options: ToolRuntimeOptions): ShardExecutionPort {
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
    shardSessionMemorySyncAuditPath: options.companionDataDir
      ? resolveShardSessionMemorySyncAuditPath(options.companionDataDir)
      : undefined,
  });
  const shardExecutionPort = createShardExecutionPort(shardManager);
  options.agentLoop.registerTool(createBoundedSubagentLaunchTool(shardManager));

  options.agentLoop.registerTool(createThinkTool({
    llmProvider: options.llmProvider,
    embeddingService: options.embeddingService,
    memoryStore: options.memoryStore,
    sessionManager: options.sessionManager,
    scheduler: options.scheduler ?? null,
    eventBus: options.eventBus,
    getCapabilityTier: options.getCapabilityTier,
    compositionalPolicy: options.compositionalPolicy,
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
