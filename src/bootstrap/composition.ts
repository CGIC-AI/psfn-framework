// ── Shared Runtime Composition ──
// Common builders used across runtime, agent container, CLI, and test harnesses.
//
// Intentional wiring differences:
// - src/runtime.ts runs single-process and wires local transports/providers directly.
// - src/agent-main.ts runs in split mode (gateway + isolated agent) and wires gateway-backed providers.
// Keep core construction through these helpers so behavior stays aligned across both entrypoints.

import { join } from 'node:path';
import type { SubstrateConfig } from '../types.js';
import type { EventBus } from '../event-bus.js';
import { SessionStore, type SessionIntegrityProvider } from '../session/store.js';
import { SessionManager } from '../session/manager.js';
import { UserContinuityStore } from '../session/continuity.js';
import { EmbeddingProvider } from '../memory/embedding.js';
import { SubstrateAgent } from '../agent/substrate-agent.js';
import { MemoryRetriever } from '../memory/retrieval.js';
import { MemoryExtractor } from '../memory/extraction.js';
import type { MemoryStore } from '../memory/store.js';
import type { ContactStore } from '../contacts/store.js';
import { ShardManager } from '../shards/manager.js';
import { createSpawnShardTool } from '../shards/tools.js';
import { createThinkTool } from '../repl/tools.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../repl/types.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { CapabilityTier } from '../types.js';
import { loadCharacterCard, composeSystemPrompt } from '../identity/loader.js';
import type { CharacterCardV2 } from '../identity/types.js';
import type { LLMProvider, EmbeddingService } from '../agent/contracts.js';
import type { PromptRegistryStore } from '../identity/prompt-registry.js';
import type { ShardAuditTrail } from '../shards/manager.js';
import type { ConfirmationQueue } from '../capabilities/confirmation-queue.js';
import type { ModuleRegistryMutation } from '../modules/types.js';

export interface SessionComposition {
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  continuityStore: UserContinuityStore | null;
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
  const sessionsDir = options.sessionsDir ?? join(options.config.dataDir, 'sessions');
  const sessionStore = new SessionStore(sessionsDir, {
    integrityProvider: options.sessionIntegrityProvider ?? null,
  });
  const sessionManager = new SessionManager(
    sessionStore,
    options.config,
    options.eventBus,
    options.promptRegistry ?? null,
  );

  let continuityStore: UserContinuityStore | null = null;
  if (options.enableContinuity) {
    continuityStore = new UserContinuityStore(sessionsDir);
    sessionManager.continuityStore = continuityStore;
  }

  return { sessionStore, sessionManager, continuityStore };
}

export function createEmbeddingProviderFromEnv(): EmbeddingProvider {
  return new EmbeddingProvider({
    ollamaUrl: process.env.OLLAMA_URL,
    model: process.env.EMBEDDING_MODEL,
    dims: process.env.EMBEDDING_DIMS ? parseInt(process.env.EMBEDDING_DIMS, 10) : undefined,
  });
}

export interface IdentityComposition {
  card: CharacterCardV2;
  systemPrompt: string;
}

export function composeIdentity(config: SubstrateConfig): IdentityComposition {
  const card = loadCharacterCard(config.characterCardPath);
  return {
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
  config: SubstrateConfig;
}

export function composeSubstrateAgent(options: SubstrateAgentCompositionOptions): SubstrateAgent {
  return new SubstrateAgent(
    options.eventBus,
    options.llmProvider,
    options.sessionManager,
    options.systemPrompt,
    options.config,
    options.characterName ? { characterName: options.characterName } : undefined,
  );
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
    )
    : new MemoryRetriever(
      options.memoryStore,
      options.embeddingService,
      undefined,
      options.eventBus,
      options.contactStore ?? null,
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
  scheduler?: Scheduler | null;
  replConfig?: REPLConfig;
  shardAuditTrail?: ShardAuditTrail | null;
  getCapabilityTier?: () => CapabilityTier;
  moduleInstallConfirmationQueue?: ConfirmationQueue | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
}

export function wireShardAndThinkRuntime(options: ToolRuntimeOptions): ShardManager {
  const shardManager = new ShardManager({
    eventBus: options.eventBus,
    llmProvider: options.llmProvider,
    sessionStore: options.sessionStore,
    embeddingService: options.embeddingService,
    memoryProvider: options.agentLoop.memoryProvider,
    config: options.config,
    parentSystemPrompt: options.parentSystemPrompt,
    toolCatalogProvider: () => options.agentLoop.getToolCatalog(),
    auditTrail: options.shardAuditTrail ?? undefined,
  });
  options.agentLoop.registerTool(createSpawnShardTool(shardManager));

  options.agentLoop.registerTool(createThinkTool({
    llmProvider: options.llmProvider,
    embeddingService: options.embeddingService,
    memoryStore: options.memoryStore,
    sessionManager: options.sessionManager,
    scheduler: options.scheduler ?? null,
    eventBus: options.eventBus,
    getCapabilityTier: options.getCapabilityTier,
    moduleInstallConfirmationQueue: options.moduleInstallConfirmationQueue,
    onModuleRegistryMutation: options.onModuleRegistryMutation,
    config: options.replConfig ?? DEFAULT_REPL_CONFIG,
  }));

  return shardManager;
}
