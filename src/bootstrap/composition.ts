// ── Shared Runtime Composition ──
// Common builders used across runtime, agent container, CLI, and test harnesses.

import { join } from 'node:path';
import type { SubstrateConfig } from '../types.js';
import type { EventBus } from '../event-bus.js';
import { SessionStore } from '../session/store.js';
import { SessionManager } from '../session/manager.js';
import { UserContinuityStore } from '../session/continuity.js';
import { EmbeddingProvider } from '../memory/embedding.js';
import { AgentLoop } from '../agent-loop.js';
import { MemoryRetriever } from '../memory/retrieval.js';
import { MemoryExtractor } from '../memory/extraction.js';
import type { MemoryStore } from '../memory/store.js';
import { ShardManager } from '../shards/manager.js';
import { createSpawnShardTool } from '../shards/tools.js';
import { createThinkTool } from '../repl/tools.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../repl/types.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { loadCharacterCard, composeSystemPrompt } from '../identity/loader.js';
import type { CharacterCardV2 } from '../identity/types.js';
import type { LLMProvider, EmbeddingService } from '../agent/contracts.js';
import type { PromptRegistryStore } from '../identity/prompt-registry.js';

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
}

export function composeSessionRuntime(options: SessionCompositionOptions): SessionComposition {
  const sessionsDir = options.sessionsDir ?? join(options.config.dataDir, 'sessions');
  const sessionStore = new SessionStore(sessionsDir);
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

export interface AgentLoopCompositionOptions {
  eventBus: EventBus;
  llmProvider: LLMProvider;
  sessionManager: SessionManager;
  systemPrompt: string;
  config: SubstrateConfig;
}

export function composeAgentLoop(options: AgentLoopCompositionOptions): AgentLoop {
  return new AgentLoop(
    options.eventBus,
    options.llmProvider,
    options.sessionManager,
    options.systemPrompt,
    options.config,
  );
}

export interface MemoryRuntimeOptions {
  agentLoop: AgentLoop;
  llmProvider: LLMProvider;
  sessionManager: SessionManager;
  memoryStore: MemoryStore;
  embeddingService: EmbeddingService;
  eventBus: EventBus;
  config?: SubstrateConfig;
  promptRegistry?: PromptRegistryStore | null;
}

export function wireMemoryRuntime(options: MemoryRuntimeOptions): MemoryExtractor {
  options.agentLoop.memoryProvider = options.config
    ? new MemoryRetriever(options.memoryStore, options.embeddingService, options.config)
    : new MemoryRetriever(options.memoryStore, options.embeddingService);

  const memoryExtractor = options.config
    ? new MemoryExtractor(
      options.llmProvider,
      options.sessionManager,
      options.memoryStore,
      options.embeddingService,
      options.eventBus,
      options.config,
      options.promptRegistry ?? null,
    )
    : new MemoryExtractor(
      options.llmProvider,
      options.sessionManager,
      options.memoryStore,
      options.embeddingService,
      options.eventBus,
      undefined,
      options.promptRegistry ?? null,
    );
  options.agentLoop.memoryExtractor = memoryExtractor;
  return memoryExtractor;
}

export interface ToolRuntimeOptions {
  agentLoop: AgentLoop;
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
  });
  options.agentLoop.registerTool(createSpawnShardTool(shardManager));

  options.agentLoop.registerTool(createThinkTool({
    llmProvider: options.llmProvider,
    embeddingService: options.embeddingService,
    memoryStore: options.memoryStore,
    sessionManager: options.sessionManager,
    scheduler: options.scheduler ?? null,
    eventBus: options.eventBus,
    config: options.replConfig ?? DEFAULT_REPL_CONFIG,
  }));

  return shardManager;
}
