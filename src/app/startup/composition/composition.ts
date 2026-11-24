// ── Shared Runtime Composition ──
// Common builders used across runtime, agent container, CLI, and test harnesses.
// Pure core builders live in `./core-composition.ts` so both full-framework
// entrypoints and standalone companion composition share one implementation
// without pulling Redis, ShardManager, Analysis Workbench, or HookRegistry.

import type { SubstrateConfig, CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { CapabilityGrantSnapshot } from '../../../system/capabilities/access.js';
import { createEventBusCostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { SessionTailCachePort } from '../../../persistence/sessions/session-tail-cache-port.js';
import { RedisSessionTailCache } from '../../../persistence/sessions/redis-session-tail-cache.js';
import {
  buildRedisClientOptions,
  createRedisClientFactoryFromPackage,
  resolveRedisConnectionConfigFromEnv,
} from '../../../shared/cache/redis-cache.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { CompressionGuidelineEvolutionPort } from '../../../core/session/compression-guideline-evolution.js';
import type { PolicyGovernedShardParentIcpDeliveryPort } from '../../../shared/contracts/shard-parent-icp.js';
import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import {
  DeterministicFatigueBudgetPort,
  type FatigueBudgetPort,
} from '../../../core/agent/fatigue/fatigue-budget.js';
import {
  DeterministicHumanAttentionPressure,
  type HumanAttentionPressurePort,
} from '../../../core/agent/fatigue/human-attention-pressure.js';
import { HumanAttentionPressureLedger } from '../../../core/agent/fatigue/human-attention-ledger.js';
import type { HybridEpisodeSearchPort } from '../../../faculties/memory/retrieval/episode-search.js';
import { MemoryWriter } from '../../../faculties/memory/writer.js';
import { createCompanionRoomMembershipAuthority } from '../../../faculties/memory/companion-provenance.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import { ShardManager, type ShardAuditTrail } from '../../../faculties/shards/manager.js';
import { ShardWorkloadRegistry } from '../../../faculties/shards/workload-registry.js';
import type { ShardWorkloadLifecyclePort } from '../../../system/capabilities/shard-approval-grant-contracts.js';
import type { AutomataRunRegistry } from '../../../faculties/automata/run-registry.js';
import type { AutomataSessionClassificationService } from '../../../faculties/automata/session-classification.js';
import type { AutomataBusWorkerAccess } from '../../../faculties/automata/bus/worker-access.js';
import type { AutomataTerminalLifecyclePort } from '../../../faculties/automata/terminal-lifecycle.js';
import type { AutomataClassLifecycleRuntime } from '../../../faculties/automata/bus/class-lifecycle.js';
import { ShardFoldReviewController } from '../../../faculties/shards/fold-review.js';
import {
  createShardExecutionPort,
  type ShardExecutionPort,
} from '../../../faculties/shards/port.js';
import { SubagentFaculty } from '../../../faculties/subagents/faculty.js';
import { createSubagentTool } from '../../../faculties/subagents/tools.js';
import { HookRegistry } from '../../../boundary/gateway/hook-registry.js';
import {
  loadWorkspaceHooks,
  type WorkspaceHookLoadResult,
} from '../../../boundary/gateway/hook-loader.js';
import { createAnalysisWorkbenchTool } from '../../../core/tools/analysis-workbench/tools.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../../../core/tools/analysis-workbench/types.js';
import type {
  SandboxExecutionPort,
  SandboxExecutionPortSeed,
  SandboxFileRead,
} from '../../../boundary/sandbox/capabilities/contracts.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import { resolveCompanionIdFromConfig } from '../../../core/identity/companion-runtime.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { ApprovalQueuePort } from '../../../system/capabilities/approval-queue-port.js';
import type { ModuleRegistryMutation } from '../../../system/modules/types.js';
import type { ToolWiringValidationMode } from '../../../core/agent/tool-wiring-validator.js';
import {
  migrateLegacyPersistenceLayout,
  resolveConfiguredCompanionDataDir,
  resolveFatigueLedgerPath,
  resolveHumanAttentionLedgerPath,
  resolveShardFoldReviewStorePath,
  resolveShardSessionMemorySyncAuditPath,
} from '../../../persistence/layout.js';
import { createPostgresShardSchemaLifecycle } from '../../../persistence/postgres/shard-schema-lifecycle.js';
import { FatigueLedger } from '../../../shared/telemetry/fatigue-ledger.js';
import {
  composeSessionRuntimeCoreAsync,
  type SessionComposition,
  type SessionCompositionOptions,
} from './core-composition.js';

export {
  composeIdentity,
  composeMemoryStoreAsync,
  composeSessionRuntimeCoreAsync,
  composeSubstrateAgent,
  wireCoreMemoryRuntime,
  wireDiagnosticsRuntime,
  wireMemoryRuntime,
  wireSelfModelRuntime,
  wireSubagentRuntime,
  type CoreMemoryRuntimeOptions,
  type IdentityComposition,
  type MemoryRuntimeOptions,
  type SelfModelRuntimeTarget,
  type SessionComposition,
  type SessionCompositionOptions,
  type SubagentRuntimeOptions,
  type SubagentRuntimeWiring,
  type SubstrateAgentCompositionOptions,
} from './core-composition.js';

async function composeSessionTailCache(
  config: SubstrateConfig,
  override: SessionTailCachePort | null | undefined,
): Promise<SessionTailCachePort | null> {
  if (override !== undefined) return override;
  const settings = config.sessionTailCache;
  if (!settings?.enabled) return null;
  const scope = resolveCompanionIdFromConfig(config);
  const redisConfig = resolveRedisConnectionConfigFromEnv(process.env);
  const clientFactory = await createRedisClientFactoryFromPackage();
  const client = clientFactory(buildRedisClientOptions(redisConfig));
  await client.connect();
  return new RedisSessionTailCache({
    client,
    maxEntriesPerChannel: settings.maxEntriesPerChannel,
    scope,
  });
}

export async function composeSessionRuntimeAsync(
  options: SessionCompositionOptions,
): Promise<SessionComposition> {
  return await composeSessionRuntimeCoreAsync(
    options,
    () => composeSessionTailCache(options.config, options.sessionTailCache),
  );
}

export interface FatigueBudgetComposition {
  fatigueLedger: FatigueLedger;
  fatigueBudget: FatigueBudgetPort;
  humanAttentionLedger: HumanAttentionPressureLedger;
  humanAttentionPressure: HumanAttentionPressurePort;
}

export interface FatigueBudgetCompositionOptions {
  config: SubstrateConfig;
  eventBus?: EventBus;
  now?: () => number;
}

export async function composeFatigueBudgetRuntime(
  options: FatigueBudgetCompositionOptions,
): Promise<FatigueBudgetComposition> {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  migrateLegacyPersistenceLayout(companionDataDir);
  const sharedOptions = {
    ...(options.now ? { now: options.now } : {}),
    readLimitSettings: options.config,
  };
  const fatigueLedger = await FatigueLedger.open(
    resolveFatigueLedgerPath(companionDataDir),
    options.eventBus ?? null,
    sharedOptions,
  );
  const humanAttentionLedger = await HumanAttentionPressureLedger.open(
    resolveHumanAttentionLedgerPath(companionDataDir),
    null,
    options.now ?? Date.now,
    { readLimitSettings: options.config },
  );
  const humanAttentionPolicy = options.config.chargePolicy?.fatigue.humanAttention;
  if (!humanAttentionPolicy) {
    throw new Error(
      'Human attention pressure requires chargePolicy.fatigue.humanAttention',
    );
  }
  return {
    fatigueLedger,
    fatigueBudget: new DeterministicFatigueBudgetPort(fatigueLedger, sharedOptions),
    humanAttentionLedger,
    humanAttentionPressure: new DeterministicHumanAttentionPressure(
      humanAttentionLedger,
      humanAttentionPolicy,
    ),
  };
}

export interface ToolRuntimeOptions {
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  llmProvider: LLMProviderPort;
  fileRead?: SandboxFileRead;
  sessionStore: SessionStore;
  embeddingService: EmbeddingProviderPort;
  memoryStore: MemoryStorePort;
  episodeSearch?: HybridEpisodeSearchPort | null;
  sessionManager: SessionManager;
  config: SubstrateConfig;
  parentSystemPrompt: string;
  companionDataDir?: string;
  scheduler?: Scheduler | null;
  replConfig?: REPLConfig;
  shardAuditTrail?: ShardAuditTrail | null;
  runtimeMode?: ToolWiringValidationMode;
  getCapabilityTier?: () => CapabilityTier;
  snapshotParentCapabilityGrant: () => CapabilityGrantSnapshot;
  compositionalPolicy?: SubstrateConfig['compositionalPolicy'];
  moduleInstallConfirmationQueue?: ApprovalQueuePort | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
  executionPort?: SandboxExecutionPort | SandboxExecutionPortSeed | null;
  compressionGuidelineEvolution?: CompressionGuidelineEvolutionPort | null;
  shardParentIcpDelivery: PolicyGovernedShardParentIcpDeliveryPort | null;
  shardWorkloadRegistry?: ShardWorkloadLifecyclePort;
  automataRunRegistry?: AutomataRunRegistry;
  automataSessionClassification?: Pick<AutomataSessionClassificationService, 'classifyAtCreation'>;
  automataBusWorkerAccess?: AutomataBusWorkerAccess | null;
  automataLifecyclePort?: AutomataTerminalLifecyclePort | null;
  automataClassLifecycle?: AutomataClassLifecycleRuntime | null;
}

function requireExplicitShardParentIcpDelivery(
  options: { shardParentIcpDelivery?: PolicyGovernedShardParentIcpDeliveryPort | null },
): PolicyGovernedShardParentIcpDeliveryPort | null {
  if (!Object.hasOwn(options, 'shardParentIcpDelivery')
    || options.shardParentIcpDelivery === undefined) {
    throw new Error(
      'Shard runtime composition requires an explicit policy-governed ordinary ICP delivery port',
    );
  }
  return options.shardParentIcpDelivery;
}

export function wireShardAndThinkRuntime(options: ToolRuntimeOptions): ShardExecutionPort {
  const shardParentIcpDelivery = requireExplicitShardParentIcpDelivery(options);
  const companionDataDir = options.companionDataDir ?? resolveConfiguredCompanionDataDir(options.config);
  const shardPostgresLifecycle = options.config.multiCompanion === true
    ? createPostgresShardSchemaLifecycle(
        options.config.postgresDatabaseUrl?.trim() ?? (() => {
          throw new Error('Multi-companion shard execution requires config.postgresDatabaseUrl');
        })(),
      )
    : null;
  const foldReviewMemoryWriter = new MemoryWriter(options.memoryStore, options.embeddingService, {
    memoryRetrievalPolicy: () => options.config.memoryRetrievalPolicy,
    ...(options.config.companionId ? { companionId: options.config.companionId } : {}),
    roomMembershipAuthority: createCompanionRoomMembershipAuthority(options.sessionStore),
  });
  foldReviewMemoryWriter.intakeSinkGateProvider = () => options.sessionManager.intakeSinkGate;
  const foldReviewController = new ShardFoldReviewController(
    resolveShardFoldReviewStorePath(companionDataDir),
    foldReviewMemoryWriter,
    () => ({
      screening: options.sessionManager.intakeScreening,
      sinkGate: options.sessionManager.intakeSinkGate,
    }),
  );
  const shardManager = new ShardManager({
    eventBus: options.eventBus,
    llmProvider: options.llmProvider,
    sessionStore: options.sessionStore,
    completionNoticeDelivery: {
      deliver: input => options.agentLoop.deliverCompletionNotice(input),
    },
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
    compressionGuidelineEvolution: options.compressionGuidelineEvolution ?? undefined,
    shardPostgresLifecycle,
    shardParentIcpDelivery,
    snapshotParentCapabilityGrant: options.snapshotParentCapabilityGrant,
    workloadRegistry: options.shardWorkloadRegistry ?? new ShardWorkloadRegistry(),
    activeTurnIntakeEnvelopesProvider: () => options.agentLoop.getActiveTurnIntakeEnvelopes(),
    automataClassLifecycle: options.automataClassLifecycle,
  });
  const subagentFaculty = new SubagentFaculty({
    eventBus: options.eventBus,
    llmProvider: options.llmProvider,
    sessionStore: options.sessionStore,
    completionNoticeDelivery: {
      deliver: input => options.agentLoop.deliverCompletionNotice(input),
    },
    embeddingService: options.embeddingService,
    memoryProvider: options.agentLoop.memoryProvider,
    config: options.config,
    parentSystemPrompt: options.parentSystemPrompt,
    toolCatalogProvider: () => options.agentLoop.getToolCatalog(),
    auditTrail: options.shardAuditTrail ?? undefined,
    runtimeMode: options.runtimeMode,
    snapshotParentCapabilityGrant: options.snapshotParentCapabilityGrant,
    foldReviewController,
    intakeScreeningProvider: () => options.sessionManager.intakeScreening,
    completionIntakeProvider: () => ({
      screening: options.sessionManager.intakeScreening,
      sinkGate: options.sessionManager.intakeSinkGate,
    }),
    activeTurnIntakeEnvelopesProvider: () => options.agentLoop.getActiveTurnIntakeEnvelopes(),
    automataRunRegistry: options.automataRunRegistry,
    automataSessionClassification: options.automataSessionClassification,
    automataBusWorkerAccess: options.automataBusWorkerAccess,
    automataLifecyclePort: options.automataLifecyclePort,
  });
  const shardExecutionPort = createShardExecutionPort(shardManager);
  options.agentLoop.registerTool(createSubagentTool(subagentFaculty), 'core');

  options.agentLoop.registerTool(createAnalysisWorkbenchTool({
    llmProvider: options.llmProvider,
    fileRead: options.fileRead,
    ...(options.config.fsReadMaxBytes !== undefined
      ? { fsReadMaxBytes: options.config.fsReadMaxBytes }
      : {}),
    embeddingService: options.embeddingService,
    memoryStore: options.memoryStore,
    episodeSearch: options.episodeSearch ?? null,
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

export interface OperatorHookRuntimeOptions {
  eventBus: EventBus;
  workspacePath: string;
}

export interface OperatorHookRuntime {
  hookRegistry: HookRegistry;
  hookLoadResult: WorkspaceHookLoadResult;
}

export async function wireOperatorHookRuntime(
  options: OperatorHookRuntimeOptions,
): Promise<OperatorHookRuntime> {
  const hookRegistry = new HookRegistry();
  const hookLoadResult = await loadWorkspaceHooks({
    workspacePath: options.workspacePath,
    registry: hookRegistry,
  });
  hookRegistry.attachLifecycleConsumer(options.eventBus);
  return { hookRegistry, hookLoadResult };
}
