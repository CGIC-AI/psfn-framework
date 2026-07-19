// ── Shared Runtime Composition ──
// Common builders used across runtime, agent container, CLI, and test harnesses.
//
// Intentional wiring differences:
// - src/app/agent/main.ts runs in split mode (gateway + isolated agent) and wires gateway-backed providers.
// Keep core construction through these helpers so behavior stays aligned across split entrypoints.

import type { CoreSubstrateConfig, SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { AppCache } from '../../../shared/cache/types.js';
import type { CapabilityGrantSnapshot } from '../../../system/capabilities/access.js';
import { wireRuntimeDiagnosticsEventCapture } from '../../../shared/diagnostics/runtime-diagnostics.js';
import { createEventBusCostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import { SessionStore, type SessionIntegrityProvider } from '../../../persistence/sessions/store.js';
import type { SessionTailCachePort } from '../../../persistence/sessions/session-tail-cache-port.js';
import { RedisSessionTailCache } from '../../../persistence/sessions/redis-session-tail-cache.js';
import {
  buildRedisClientOptions,
  createRedisClientFactoryFromPackage,
  resolveRedisConnectionConfigFromEnv,
} from '../../../shared/cache/redis-cache.js';
import { SessionManager } from '../../../core/session/manager.js';
import type { CompressionGuidelineEvolutionPort } from '../../../core/session/compression-guideline-evolution.js';
import type { PolicyGovernedShardParentIcpDeliveryPort } from '../../../shared/contracts/shard-parent-icp.js';
import { UserContinuityStore } from '../../../core/session/continuity.js';
import {
  createDisabledCrossChannelContinuityPort,
  createUserContinuityPort,
} from '../../../core/session/cross-channel-continuity-port.js';
import { InternalRoleEnvelopeLedgerStore } from '../../../core/internal-role-envelopes/store.js';
import { wireInternalRoleEnvelopeRuntime } from '../../../core/internal-role-envelopes/runtime-wiring.js';
import { MemoryJournal } from '../../../faculties/memory/journal.js';
import { createPostgresMemoryStore } from '../../../faculties/memory/postgres-store.js';
import {
  SubstrateAgent,
  type EmotionRuntimeWiring,
  type SubstrateAgentOptions,
} from '../../../core/agent/substrate-agent.js';
import {
  DeterministicFatigueBudgetPort,
  type FatigueBudgetPort,
} from '../../../core/agent/fatigue/fatigue-budget.js';
import type { IcpFatigueRegulationReservationPort } from '../../../core/agent/fatigue/regulation-reservation.js';
import type { ObserverEvalSidecarRuntime } from '../../../core/eval/observer-sidecar/types.js';
import { MemoryRetriever } from '../../../faculties/memory/retrieval.js';
import type { EpisodicRetrievalStore } from '../../../faculties/memory/retrieval/episodic.js';
import { MemoryExtractor } from '../../../faculties/memory/extraction.js';
import type { ConcernCandidateExtractionSink } from '../../../faculties/memory/extraction/types.js';
import { MemoryWriter } from '../../../faculties/memory/writer.js';
import type {
  CoreMemoryStorePort,
  MemoryStorePort,
} from '../../../faculties/memory/memory-store-port.js';
import { createCoreMemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { ContactTrackingGate } from '../../../core/contacts/tracking-gate.js';
import { ShardManager } from '../../../faculties/shards/manager.js';
import { ShardFoldReviewController } from '../../../faculties/shards/fold-review.js';
import {
  createShardExecutionPort,
  type ShardExecutionPort,
} from '../../../faculties/shards/port.js';
import { SubagentFaculty } from '../../../faculties/subagents/faculty.js';
import { createSubagentTool } from '../../../faculties/subagents/tools.js';
import { createAnalysisWorkbenchTool } from '../../../core/tools/analysis-workbench/tools.js';
import { CoreMemoryStore } from '../../../faculties/core-memory/store.js';
import { createOrientTool } from '../../../faculties/core-memory/tools.js';
import { ValuesJournalStore } from '../../../faculties/values/store.js';
import type { IntrospectionConsentStore } from '../../../faculties/introspection/consent-store.js';
import type { IntrospectionTurnSensitivityDecisions } from '../../../faculties/introspection/turn-sensitivity.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../../../core/tools/analysis-workbench/types.js';
import type { SandboxExecutionPort } from '../../../boundary/sandbox/capabilities/contracts.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import { loadCharacterCard, composeSystemPrompt } from '../../../core/identity/loader.js';
import { resolveCompanionIdFromConfig } from '../../../core/identity/companion-runtime.js';
import type { RuntimeCompanionId } from '../../../shared/routing/companion-id.js';
import type { CharacterCardV2 } from '../../../core/identity/types.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
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
  resolveFatigueLedgerPath,
  resolveLegacyValuesJournalPath,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveShardFoldReviewStorePath,
  resolveShardSessionMemorySyncAuditPath,
  resolveScratchpadMirrorPath,
  resolveSessionsDir,
  resolveValuesJournalPath,
} from '../../../persistence/layout.js';
import { createDefaultPostgresSessionAdapters } from '../../../persistence/sessions/postgres-adapters.js';
import { derivePostgresTenantRole } from '../../../persistence/postgres/tenancy.js';
import { createPostgresShardSchemaLifecycle } from '../../../persistence/postgres/shard-schema-lifecycle.js';
import { FatigueLedger } from '../../../shared/telemetry/fatigue-ledger.js';

export interface SessionComposition {
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  continuityStore: UserContinuityStore | null;
  internalRoleEnvelopeLedger: InternalRoleEnvelopeLedgerStore;
  /** Non-null only when settings.json sessionTailCache.enabled=true (psfn-framework-hgw3.5). */
  sessionTailCache: SessionTailCachePort | null;
}

export interface SessionCompositionOptions {
  config: SubstrateConfig;
  /**
   * Explicit database credential for callers whose core config is
   * intentionally secret-sanitized. When absent, legacy/full-config callers
   * may still supply config.postgresDatabaseUrl.
   */
  postgresDatabaseUrl?: string;
  eventBus?: EventBus;
  sessionsDir?: string;
  enableContinuity?: boolean;
  promptRegistry?: PromptRegistryStatePort | null;
  sessionIntegrityProvider?: SessionIntegrityProvider | null;
  /**
   * Injected session tail cache (tests/harnesses). `undefined` builds the
   * Redis-backed tail from settings.json + env when enabled; explicit `null`
   * disables it regardless of config.
   */
  sessionTailCache?: SessionTailCachePort | null;
}

/**
 * Build the Redis-backed session tail (psfn-framework-hgw3.5) when
 * settings.json enables it. Fail closed at startup: enabled config with
 * missing/invalid Redis env, a missing companion identity, or an unreachable
 * Redis refuses to start — a silently absent tail would hide the shared-view
 * guarantee. Tail/epoch keys are scoped by COMPANION_ID so multiple
 * companions sharing one Redis (fleet topology) can never read each other's
 * session tails.
 */
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

function createSessionComposition(
  options: SessionCompositionOptions,
  sessionAdapters: Awaited<ReturnType<typeof createDefaultPostgresSessionAdapters>>,
  sessionsDir: string,
  sessionTailCache: SessionTailCachePort | null,
): SessionComposition {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  // Keep the adapter contract required at compile time while still rejecting
  // malformed/custom runtime adapters at the composition boundary.
  const turnRecordEligibilityFence = (sessionAdapters as Partial<typeof sessionAdapters>)
    .turnRecordEligibilityFence;
  if (!turnRecordEligibilityFence) {
    throw new Error('PostgreSQL session composition requires a TurnRecord eligibility fence');
  }
  const sessionStore = new SessionStore(sessionsDir, {
    integrityProvider: options.sessionIntegrityProvider ?? null,
    sessionArchivePort: sessionAdapters.sessionArchivePort,
    transcriptProjection: sessionAdapters.transcriptProjection,
    turnRecordStore: sessionAdapters.turnRecordStore,
    turnRecordEligibilityFence,
    tailCache: sessionTailCache,
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

  return { sessionStore, sessionManager, continuityStore, internalRoleEnvelopeLedger, sessionTailCache };
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
  const databaseUrl = options.postgresDatabaseUrl?.trim()
    || options.config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL session composition requires config.postgresDatabaseUrl');
  }
  const postgresSchema = options.config.postgresSchema?.trim();
  const postgresRole = options.config.multiCompanion === true && postgresSchema
    ? derivePostgresTenantRole(postgresSchema)
    : undefined;
  const sessionAdapters = await createDefaultPostgresSessionAdapters(databaseUrl, {
    sessionsDir,
    ...(postgresSchema ? { schema: postgresSchema } : {}),
    ...(postgresRole ? { role: postgresRole } : {}),
  });
  const sessionTailCache = await composeSessionTailCache(options.config, options.sessionTailCache);
  return createSessionComposition(options, sessionAdapters, sessionsDir, sessionTailCache);
}

export async function composeMemoryStoreAsync(
  config: SubstrateConfig,
  embeddingDims: number,
): Promise<MemoryStorePort> {
  const companionDataDir = resolveConfiguredCompanionDataDir(config);
  migrateLegacyPersistenceLayout(companionDataDir);

  if (config.persistenceBackend !== 'postgres') {
    throw new Error('PostgreSQL memory composition requires config.persistenceBackend=postgres');
  }
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL memory composition requires config.postgresDatabaseUrl');
  }

  return await createPostgresMemoryStore(databaseUrl, embeddingDims, {
    notesDir: resolveNotesDir(companionDataDir),
    scratchpadMirrorPath: resolveScratchpadMirrorPath(companionDataDir),
    journal: new MemoryJournal(resolveMemoryJournalPath(companionDataDir)),
    ...(config.postgresSchema?.trim()
      ? {
          schema: config.postgresSchema.trim(),
          ...(config.multiCompanion === true
            ? { role: derivePostgresTenantRole(config.postgresSchema.trim()) }
            : {}),
        }
      : {}),
  });
}

export interface IdentityComposition {
  companionId: RuntimeCompanionId;
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
  fatigueBudget?: FatigueBudgetPort | null;
  fatigueRegulationReservations?: IcpFatigueRegulationReservationPort | null;
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  streamRuntimeOptions?: SubstrateAgentOptions['streamRuntimeOptions'];
  streamTransport?: SubstrateAgentOptions['streamTransport'];
  appCache?: AppCache;
  /** Contact-tracking policy gate (E3.4). Absent gate behaves as 'auto' everywhere. */
  contactTrackingGate?: ContactTrackingGate | null;
  /** Places soft-registry (S10). Absent behaves as an empty registry. */
  placesRegistryConfig?: PlacesRegistryConfig;
  backgroundWorkStore?: SubstrateAgentOptions['backgroundWorkStore'];
  backgroundWorkTuning?: SubstrateAgentOptions['backgroundWorkTuning'];
  backgroundWorkDisabled?: boolean;
  backgroundWorkWelfare?: SubstrateAgentOptions['backgroundWorkWelfare'];
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
      ...(options.fatigueBudget ? { fatigueBudget: options.fatigueBudget } : {}),
      ...(options.fatigueRegulationReservations
        ? { fatigueRegulationReservations: options.fatigueRegulationReservations }
        : {}),
      ...(options.observerEvalSidecar ? { observerEvalSidecar: options.observerEvalSidecar } : {}),
      ...(options.streamRuntimeOptions ? { streamRuntimeOptions: options.streamRuntimeOptions } : {}),
      ...(options.streamTransport ? { streamTransport: options.streamTransport } : {}),
      ...(options.appCache ? { appCache: options.appCache } : {}),
      ...(options.contactTrackingGate ? { contactTrackingGate: options.contactTrackingGate } : {}),
      ...(options.placesRegistryConfig ? { placesRegistryConfig: options.placesRegistryConfig } : {}),
      ...(options.backgroundWorkStore ? { backgroundWorkStore: options.backgroundWorkStore } : {}),
      ...(options.backgroundWorkTuning
        ? { backgroundWorkTuning: options.backgroundWorkTuning }
        : {}),
      ...(options.backgroundWorkDisabled ? { backgroundWorkDisabled: true } : {}),
      ...(options.backgroundWorkWelfare ? { backgroundWorkWelfare: options.backgroundWorkWelfare } : {}),
    },
  );
}

export interface FatigueBudgetComposition {
  fatigueLedger: FatigueLedger;
  fatigueBudget: FatigueBudgetPort;
}

export interface FatigueBudgetCompositionOptions {
  config: SubstrateConfig;
  eventBus?: EventBus;
  now?: () => number;
}

export function composeFatigueBudgetRuntime(
  options: FatigueBudgetCompositionOptions,
): FatigueBudgetComposition {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  migrateLegacyPersistenceLayout(companionDataDir);
  const sharedOptions = options.now ? { now: options.now } : {};
  const fatigueLedger = new FatigueLedger(
    resolveFatigueLedgerPath(companionDataDir),
    options.eventBus ?? null,
    sharedOptions,
  );
  return {
    fatigueLedger,
    fatigueBudget: new DeterministicFatigueBudgetPort(fatigueLedger, sharedOptions),
  };
}

export interface SelfModelRuntimeTarget {
  setSelfModelRuntimeRequired(required: boolean): void;
}

export function wireSelfModelRuntime(target: SelfModelRuntimeTarget): void {
  target.setSelfModelRuntimeRequired(true);
}

export function wireDiagnosticsRuntime(eventBus: EventBus): void {
  wireRuntimeDiagnosticsEventCapture(eventBus);
}

export interface CoreMemoryRuntimeOptions {
  agentLoop: SubstrateAgent;
  sessionManager: SessionManager;
  config: SubstrateConfig;
  concernStore?: ConcernStorePort | null;
  introspectionConsentStore?: IntrospectionConsentStore | null;
  introspectionTurnSensitivityDecisions?: IntrospectionTurnSensitivityDecisions | null;
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
    introspectionConsentStore: options.introspectionConsentStore ?? null,
    introspectionTurnSensitivityDecisions: options.introspectionTurnSensitivityDecisions ?? null,
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
  concernCandidateSink?: ConcernCandidateExtractionSink | null;
  /** Contact-tracking policy gate predicate (E3.4); absent behaves as 'auto'. */
  isAutoContactCreationAllowed?: ((channelId: string) => boolean) | null;
  /** Shared persona preamble service (E6.1); soft persona framing before extraction/profile prompts. */
  personaPreamble?: PersonaPreamblePort | null;
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
	      options.sessionManager,
	      true,
	    )
	    : new MemoryRetriever(
	      options.memoryStore,
	      options.embeddingService,
      undefined,
	      costTelemetry,
	      options.contactStore ?? null,
	      options.llmProvider,
	      options.episodicStore ?? null,
	      options.sessionManager,
	      true,
	    );

  const extractorFormationOptions = {
    ...(options.concernCandidateSink
      ? { emitConcernCandidates: options.concernCandidateSink }
      : {}),
    ...(options.isAutoContactCreationAllowed
      ? { isAutoContactCreationAllowed: options.isAutoContactCreationAllowed }
      : {}),
    ...(options.personaPreamble
      ? { personaPreamble: options.personaPreamble }
      : {}),
  };
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
      extractorFormationOptions,
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
      extractorFormationOptions,
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
  snapshotParentCapabilityGrant: () => CapabilityGrantSnapshot;
  compositionalPolicy?: SubstrateConfig['compositionalPolicy'];
  moduleInstallConfirmationQueue?: ApprovalQueuePort | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
  executionPort?: SandboxExecutionPort | null;
  compressionGuidelineEvolution?: CompressionGuidelineEvolutionPort | null;
  shardParentIcpDelivery: PolicyGovernedShardParentIcpDeliveryPort | null;
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
  // htm9.3: shard fold-back memory writes gate at the memory_write sink; the
  // gate is late-bound onto the session manager by composition.
  const foldReviewMemoryWriter = new MemoryWriter(options.memoryStore, options.embeddingService, {
    memoryRetrievalPolicy: () => options.config.memoryRetrievalPolicy,
  });
  foldReviewMemoryWriter.intakeSinkGateProvider = () => options.sessionManager.intakeSinkGate;
  const foldReviewController = new ShardFoldReviewController(
    resolveShardFoldReviewStorePath(companionDataDir),
    foldReviewMemoryWriter,
  );
  const shardManager = new ShardManager({
    eventBus: options.eventBus,
    llmProvider: options.llmProvider,
    sessionStore: options.sessionStore,
    completionNotices: options.agentLoop.completionNotices,
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
  });
  const subagentFaculty = new SubagentFaculty({
    eventBus: options.eventBus,
    llmProvider: options.llmProvider,
    sessionStore: options.sessionStore,
    completionNotices: options.agentLoop.completionNotices,
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
