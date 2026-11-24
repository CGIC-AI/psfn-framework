// ── Pure Core Runtime Composition ──
// Shared composition builders free of host-only scaffolding (Redis, ShardManager,
// Analysis Workbench, HookRegistry). Re-exported by `composition.ts` for full
// framework entrypoints and standalone companion composition (`startCompanionRuntime`).

import type { RetrievalDecisionPort } from '../../../faculties/memory/retrieval/decision-routing.js';
import type { CoreSubstrateConfig, SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { AppCache } from '../../../shared/cache/types.js';
import type { NotificationPort } from '../../../shared/contracts/notification-port.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { CapabilityGrantSnapshot } from '../../../system/capabilities/access.js';
import { wireRuntimeDiagnosticsEventCapture } from '../../../shared/diagnostics/runtime-diagnostics.js';
import { createEventBusCostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import { SessionStore, type SessionIntegrityProvider } from '../../../persistence/sessions/store.js';
import type { SessionTailCachePort } from '../../../persistence/sessions/session-tail-cache-port.js';
import { SessionManager } from '../../../core/session/manager.js';
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
import type { FatigueBudgetPort } from '../../../core/agent/fatigue/fatigue-budget.js';
import type { IcpFatigueRegulationReservationPort } from '../../../core/agent/fatigue/regulation-reservation.js';
import type { HumanAttentionPressurePort } from '../../../core/agent/fatigue/human-attention-pressure.js';
import type { ObserverEvalSidecarRuntime } from '../../../core/eval/observer-sidecar/types.js';
import { MemoryRetriever } from '../../../faculties/memory/retrieval.js';
import type { EpisodicRetrievalStore } from '../../../faculties/memory/retrieval/episodic.js';
import {
  MemoryExtractor,
  type MemoryExtractorFormationOptions,
} from '../../../faculties/memory/extraction.js';
import type { ConcernCandidateExtractionSink } from '../../../faculties/memory/extraction/types.js';
import { MemoryWriter } from '../../../faculties/memory/writer.js';
import { createCompanionRoomMembershipAuthority } from '../../../faculties/memory/companion-provenance.js';
import type {
  CoreMemoryStorePort,
  MemoryStorePort,
} from '../../../faculties/memory/memory-store-port.js';
import { createCoreMemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { ContactTrackingGate } from '../../../core/contacts/tracking-gate.js';
import type { AutomataRunRegistry } from '../../../faculties/automata/run-registry.js';
import type { AutomataSessionClassificationService } from '../../../faculties/automata/session-classification.js';
import type { AutomataBusWorkerAccess } from '../../../faculties/automata/bus/worker-access.js';
import type { AutomataTerminalLifecyclePort } from '../../../faculties/automata/terminal-lifecycle.js';
import { ShardFoldReviewController } from '../../../faculties/shards/fold-review.js';
import { SubagentFaculty } from '../../../faculties/subagents/faculty.js';
import type { SubagentHostExecutionPort } from '../../../faculties/subagents/host-execution.js';
import type { SubagentControlPort } from '../../../faculties/subagents/port.js';
import { createSubagentTool } from '../../../faculties/subagents/tools.js';
import { CoreMemoryStore } from '../../../faculties/core-memory/store.js';
import { createOrientTool } from '../../../faculties/core-memory/tools.js';
import { createConcernsTool } from '../../../core/intention/concerns-tool.js';
import { resolveCurrentInternalStateConcernVAD } from '../../../core/intention/concern-grooming.js';
import { ValuesJournalStore } from '../../../faculties/values/store.js';
import { loadCharacterCard, composeSystemPrompt } from '../../../core/identity/loader.js';
import { resolveCompanionIdFromConfig } from '../../../core/identity/companion-runtime.js';
import type { RuntimeCompanionId } from '../../../shared/routing/companion-id.js';
import type { CharacterCardV2 } from '../../../core/identity/types.js';
import type { LLMProviderPort, MemoryProvider } from '../../../core/agent/contracts.js';
import type { ProviderRuntime } from '../../../primitives/llm/provider-runtime.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
import type { ShardAuditTrail } from '../../../faculties/shards/types.js';
import type { ToolWiringValidationMode } from '../../../core/agent/tool-wiring-validator.js';
import type { ConcernStorePort } from '../../../core/intention/concern-store-port.js';
import {
  migrateLegacyPersistenceLayout,
  resolveBackupsDir,
  resolveCogSecEventsPath,
  resolveConfiguredCompanionDataDir,
  resolveCoreMemoryPath,
  resolveContinuityDir,
  resolveLegacyValuesJournalPath,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveShardFoldReviewStorePath,
  resolveScratchpadMirrorPath,
  resolveSessionsDir,
  resolveValuesJournalPath,
} from '../../../persistence/layout.js';
import { createBackgroundWorkHandoffRecoveryDisposition } from '../../../persistence/repair/background-work-handoff-recovery-disposition.js';
import { createDefaultPostgresSessionAdapters } from '../../../persistence/sessions/postgres-adapters.js';
import { FilesystemAutomataRetentionWriteBarrier } from '../../../persistence/sessions/automata-retention-write-barrier.js';
import { awaitPostgresStoreReadiness } from '../../../persistence/postgres/runtime-readiness.js';
import { resolveConfigTenantPoolScope } from '../../../persistence/postgres/tenant-pool-scope.js';
import { CogSecEventStore } from '../../../core/cogsec/events.js';
import { createSessionIntegrityIncidentObserver } from '../../../core/cogsec/session-integrity-incident.js';
import { createProjectionDriftIncidentObserver } from '../../../core/cogsec/projection-drift-incident.js';
import { createSafeguardAuditTrail } from '../../../system/capabilities/safeguards.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const log = createComponentLogger('StartupComposition');

export interface SessionComposition {
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  continuityStore: UserContinuityStore | null;
  internalRoleEnvelopeLedger: InternalRoleEnvelopeLedgerStore;
  /** Non-null only when settings.json sessionTailCache.enabled=true (psfn-framework-hgw3.5). */
  sessionTailCache: SessionTailCachePort | null;
  sessionsDir: string;
  exactSessionProjection: Awaited<ReturnType<typeof createDefaultPostgresSessionAdapters>>['exactSessionProjection'];
  conversationalActivityWorkset: Awaited<ReturnType<typeof createDefaultPostgresSessionAdapters>>['conversationalActivityWorkset'];
  exactSessionWriteBarrier: FilesystemAutomataRetentionWriteBarrier;
}

interface SessionCompositionBaseOptions {
  config: SubstrateConfig;
  postgresDatabaseUrl?: string;
  eventBus?: EventBus;
  sessionsDir?: string;
  enableContinuity?: boolean;
  continuityChannelIds?: readonly string[];
  continuityChannelPrefixes?: readonly string[];
  promptRegistry?: PromptRegistryStatePort | null;
  sessionIntegrityRepairBackupRootDir?: string;
  sessionTailCache?: SessionTailCachePort | null;
  automataRetentionCompanionId?: string;
}

interface SessionIntegrityOperatorAlertComposition {
  notifier: NotificationPort;
  companionName: string;
}

export type SessionCompositionOptions = SessionCompositionBaseOptions & (
  | {
      runtimeMode: 'production';
      sessionIntegrityProvider: SessionIntegrityProvider;
      sessionIntegrityOperatorAlert: SessionIntegrityOperatorAlertComposition;
    }
  | {
      runtimeMode?: 'non-production';
      sessionIntegrityProvider?: SessionIntegrityProvider | null;
      sessionIntegrityOperatorAlert?: SessionIntegrityOperatorAlertComposition;
    }
);

function assertProductionSessionIntegrityComposition(options: unknown): void {
  if (!isRecord(options) || options.runtimeMode !== 'production') return;
  if (!options.sessionIntegrityProvider) {
    throw new Error('Production session composition requires a non-null integrity provider');
  }
  const operatorAlert = options.sessionIntegrityOperatorAlert;
  if (!isRecord(operatorAlert)
    || !operatorAlert.notifier
    || typeof operatorAlert.companionName !== 'string'
    || !operatorAlert.companionName.trim()) {
    throw new Error('Production session composition requires an operator integrity alert path');
  }
}

function createSessionComposition(
  options: SessionCompositionOptions,
  sessionAdapters: Awaited<ReturnType<typeof createDefaultPostgresSessionAdapters>>,
  sessionsDir: string,
  sessionTailCache: SessionTailCachePort | null,
  exactSessionWriteBarrier: FilesystemAutomataRetentionWriteBarrier,
): SessionComposition {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  const turnRecordEligibilityFence = (sessionAdapters as Partial<typeof sessionAdapters>)
    .turnRecordEligibilityFence;
  if (!turnRecordEligibilityFence) {
    throw new Error('PostgreSQL session composition requires a TurnRecord eligibility fence');
  }
  const conversationalActivityWorkset = (sessionAdapters as Partial<typeof sessionAdapters>)
    .conversationalActivityWorkset;
  if (!conversationalActivityWorkset) {
    throw new Error('PostgreSQL session composition requires a conversational activity workset');
  }
  const cogSecEventsPath = resolveCogSecEventsPath(companionDataDir);
  const integrityObserver = options.sessionIntegrityProvider
    ? createSessionIntegrityIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(cogSecEventsPath),
      ...(options.sessionIntegrityOperatorAlert
        ? { operatorAlert: options.sessionIntegrityOperatorAlert }
        : {}),
    })
    : null;
  const sessionStore = new SessionStore(sessionsDir, {
    integrityProvider: options.sessionIntegrityProvider ?? null,
    sessionArchivePort: sessionAdapters.sessionArchivePort,
    transcriptProjection: sessionAdapters.transcriptProjection,
    turnRecordStore: sessionAdapters.turnRecordStore,
    turnRecordEligibilityFence,
    tailCache: sessionTailCache,
    integrityObserver,
    ...(options.sessionIntegrityProvider
      ? {
        backgroundWorkHandoffRecoveryDisposition:
          createBackgroundWorkHandoffRecoveryDisposition({
            sessionsDir,
            backupRootDir: options.sessionIntegrityRepairBackupRootDir
              ?? resolveBackupsDir(companionDataDir),
            integrityProvider: options.sessionIntegrityProvider,
            audit: createSafeguardAuditTrail(companionDataDir),
          }),
      }
      : {}),
    automataRetentionWriteBarrier: exactSessionWriteBarrier,
    ...(options.config.sessionTombstoneAuthorityOwners !== undefined
      ? { turnTombstoneAuthorityOwners: options.config.sessionTombstoneAuthorityOwners }
      : {}),
  });
  void sessionStore.primeTurnTombstoneAuthority()
    .then((report) => {
      log.debug('Primed L0 turn-tombstone authority off the primary event loop', {
        considered: report.considered,
        primed: report.primed,
        alreadyCurrent: report.alreadyCurrent,
        deferred: report.deferred.length,
        bytesReadOffPrimary: report.bytesReadOffPrimary,
      });
    })
    .catch((error: unknown) => {
      log.warn('Deferred L0 turn-tombstone authority priming failed; '
        + 'authority will be rebuilt fail-closed on demand', {
        error: toErrorMessage(error),
      });
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
    if (!options.continuityChannelIds && !options.continuityChannelPrefixes) {
      throw new Error('Enabled cross-channel continuity requires configured channels.json channel ids or channel plugin prefixes');
    }
    const continuityChannelIds = new Set(options.continuityChannelIds ?? []);
    const continuityChannelPrefixes = options.continuityChannelPrefixes ?? [];
    if (continuityChannelPrefixes.some(prefix => prefix.length === 0)) {
      throw new Error('Cross-channel continuity channel prefixes must be non-empty');
    }
    continuityStore = new UserContinuityStore(resolveContinuityDir(companionDataDir));
    sessionManager.crossChannelContinuity = createUserContinuityPort(
      continuityStore,
      (channelId, minId, maxId) => sessionStore.getEntriesInRange(channelId, minId, maxId),
      channelId => continuityChannelIds.has(channelId)
        || continuityChannelPrefixes.some(prefix => channelId.startsWith(prefix)),
    );
  } else {
    sessionManager.crossChannelContinuity = createDisabledCrossChannelContinuityPort();
  }

  return {
    sessionStore,
    sessionManager,
    continuityStore,
    internalRoleEnvelopeLedger,
    sessionTailCache,
    sessionsDir,
    exactSessionProjection: sessionAdapters.exactSessionProjection,
    conversationalActivityWorkset,
    exactSessionWriteBarrier,
  };
}

/**
 * Pure core session runtime composition without Redis tail-cache wiring.
 * Full framework composition wraps this with optional RedisSessionTailCache.
 */
export async function composeSessionRuntimeCoreAsync(
  options: SessionCompositionOptions,
  resolveTailCache: () => Promise<SessionTailCachePort | null> = async () => options.sessionTailCache ?? null,
): Promise<SessionComposition> {
  assertProductionSessionIntegrityComposition(options);
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
  const tenantScope = resolveConfigTenantPoolScope(options.config);
  const postgresSchema = tenantScope?.schema ?? options.config.postgresSchema?.trim();
  const postgresRole = tenantScope?.role;
  const redactionDriftObserver = createProjectionDriftIncidentObserver({
    cogSecEvents: () => new CogSecEventStore(resolveCogSecEventsPath(companionDataDir)),
  });
  const automataRetentionCompanionId = options.automataRetentionCompanionId?.trim()
    || options.config.companionId?.trim();
  if (!automataRetentionCompanionId) {
    throw new Error('PostgreSQL session composition requires an Automata retention companionId');
  }
  const exactSessionWriteBarrier = new FilesystemAutomataRetentionWriteBarrier(
    sessionsDir,
    automataRetentionCompanionId,
  );
  const sessionAdapters = await awaitPostgresStoreReadiness(
    'session_transcripts',
    () => createDefaultPostgresSessionAdapters(databaseUrl, {
      sessionsDir,
      redactionDriftObserver,
      automataRetentionWriteBarrier: exactSessionWriteBarrier,
      ...(postgresSchema ? { schema: postgresSchema } : {}),
      ...(postgresRole ? { role: postgresRole } : {}),
    }),
  );
  const sessionTailCache = await resolveTailCache();
  return createSessionComposition(
    options,
    sessionAdapters,
    sessionsDir,
    sessionTailCache,
    exactSessionWriteBarrier,
  );
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
  const tenantScope = resolveConfigTenantPoolScope(config);
  const postgresSchema = tenantScope?.schema ?? config.postgresSchema?.trim();

  return await awaitPostgresStoreReadiness(
    'memory',
    () => createPostgresMemoryStore(databaseUrl, embeddingDims, {
      notesDir: resolveNotesDir(companionDataDir),
      scratchpadMirrorPath: resolveScratchpadMirrorPath(companionDataDir),
      journal: new MemoryJournal(resolveMemoryJournalPath(companionDataDir)),
      ...(postgresSchema
        ? {
            schema: postgresSchema,
            ...(tenantScope ? { role: tenantScope.role } : {}),
          }
        : {}),
    }),
  );
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
  runtime?: ProviderRuntime;
  sessionManager: SessionManager;
  systemPrompt: string;
  characterName?: string;
  characterPromptVariables?: Record<string, string>;
  characterPromptVariablesProvider?: () => Record<string, string>;
  config: CoreSubstrateConfig;
  runtimeMode?: ToolWiringValidationMode;
  emotionRuntime?: EmotionRuntimeWiring;
  fatigueBudget?: FatigueBudgetPort | null;
  humanAttentionPressure?: HumanAttentionPressurePort | null;
  fatigueRegulationReservations?: IcpFatigueRegulationReservationPort | null;
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  streamRuntimeOptions?: SubstrateAgentOptions['streamRuntimeOptions'];
  streamTransport?: SubstrateAgentOptions['streamTransport'];
  appCache?: AppCache;
  contactTrackingGate?: ContactTrackingGate | null;
  placesRegistryConfig?: PlacesRegistryConfig;
  backgroundWorkStore?: SubstrateAgentOptions['backgroundWorkStore'];
  backgroundWorkTuning?: SubstrateAgentOptions['backgroundWorkTuning'];
  backgroundWorkDisabled?: boolean;
  backgroundWorkWelfare?: SubstrateAgentOptions['backgroundWorkWelfare'];
  backgroundWorkAutomataLifecycle?: SubstrateAgentOptions['backgroundWorkAutomataLifecycle'];
  intentionHooksAutomataRunner?: SubstrateAgentOptions['intentionHooksAutomataRunner'];
  classifySessionAtCreation?: SubstrateAgentOptions['classifySessionAtCreation'];
  custodySnapshotStore?: SubstrateAgentOptions['custodySnapshotStore'];
  egressDeliveryRecordStore?: SubstrateAgentOptions['egressDeliveryRecordStore'];
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
      ...(options.humanAttentionPressure
        ? { humanAttentionPressure: options.humanAttentionPressure }
        : {}),
      ...(options.fatigueRegulationReservations
        ? { fatigueRegulationReservations: options.fatigueRegulationReservations }
        : {}),
      ...(options.runtime ? { runtime: options.runtime } : {}),
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
      ...(options.backgroundWorkAutomataLifecycle
        ? { backgroundWorkAutomataLifecycle: options.backgroundWorkAutomataLifecycle }
        : {}),
      ...(options.intentionHooksAutomataRunner
        ? { intentionHooksAutomataRunner: options.intentionHooksAutomataRunner }
        : {}),
      ...(options.classifySessionAtCreation
        ? { classifySessionAtCreation: options.classifySessionAtCreation }
        : {}),
      ...(options.custodySnapshotStore
        ? { custodySnapshotStore: options.custodySnapshotStore }
        : {}),
      ...(options.egressDeliveryRecordStore
        ? { egressDeliveryRecordStore: options.egressDeliveryRecordStore }
        : {}),
    },
  );
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
  eventBus?: EventBus | null;
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
  }));
  if (options.concernStore) {
    options.agentLoop.registerTool(createConcernsTool(options.concernStore, {
      eventBus: options.eventBus ?? null,
      resolutionVadProvider: concern => resolveCurrentInternalStateConcernVAD(
        concern,
        options.agentLoop.getCurrentInternalState(),
        new Date().toISOString(),
      ),
    }), 'core');
  }
  return store;
}

export interface MemoryRuntimeOptions {
  agentLoop: SubstrateAgent;
  llmProvider: LLMProviderPort;
  decisionRuntime?: RetrievalDecisionPort;
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
  isAutoContactCreationAllowed?: ((channelId: string) => boolean) | null;
  personaPreamble?: PersonaPreamblePort | null;
  biographicalProjection?: Pick<MemoryProvider, 'projectBiographicalContext'> | null;
  biographicalRebuild?: MemoryExtractorFormationOptions['biographicalRebuild'];
  automataBusWorkerAccess?: AutomataBusWorkerAccess | null;
  automataRunRegistry?: AutomataRunRegistry | null;
  automataTerminalLifecycle?: AutomataTerminalLifecyclePort | null;
}

export function wireMemoryRuntime(options: MemoryRuntimeOptions): MemoryExtractor {
  const costTelemetry = createEventBusCostTelemetryPort(options.eventBus);
  const roomMembershipAuthority = options.sessionStore
    ? createCompanionRoomMembershipAuthority(options.sessionStore)
    : null;
  const memoryRetriever = options.config
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
      options.biographicalProjection ?? null,
      roomMembershipAuthority,
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
      options.biographicalProjection ?? null,
      roomMembershipAuthority,
    );
  if (options.decisionRuntime) memoryRetriever.setDecisionRuntime(options.decisionRuntime);
  options.agentLoop.memoryProvider = memoryRetriever;

  const extractorFormationOptions = {
    ...(options.decisionRuntime ? { decisions: options.decisionRuntime } : {}),
    ...(options.concernCandidateSink
      ? { emitConcernCandidates: options.concernCandidateSink }
      : {}),
    ...(options.isAutoContactCreationAllowed
      ? { isAutoContactCreationAllowed: options.isAutoContactCreationAllowed }
      : {}),
    ...(options.personaPreamble
      ? { personaPreamble: options.personaPreamble }
      : {}),
    ...(options.biographicalRebuild
      ? { biographicalRebuild: options.biographicalRebuild }
      : {}),
    ...(options.automataBusWorkerAccess
      ? { automataBusWorkerAccess: options.automataBusWorkerAccess }
      : {}),
    ...(options.automataRunRegistry
      ? { automataRunRegistry: options.automataRunRegistry }
      : {}),
    ...(options.automataTerminalLifecycle
      ? { automataTerminalLifecycle: options.automataTerminalLifecycle }
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

export interface SubagentRuntimeOptions {
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
  auditTrail?: ShardAuditTrail | null;
  runtimeMode?: ToolWiringValidationMode;
  snapshotParentCapabilityGrant: () => CapabilityGrantSnapshot;
  automataRunRegistry?: AutomataRunRegistry;
  automataSessionClassification?: Pick<AutomataSessionClassificationService, 'classifyAtCreation'>;
  automataBusWorkerAccess?: AutomataBusWorkerAccess | null;
  automataLifecyclePort?: AutomataTerminalLifecyclePort | null;
  hostExecution?: SubagentHostExecutionPort | null;
}

export interface SubagentRuntimeWiring {
  foldReviewController: ShardFoldReviewController;
  subagentFaculty: SubagentControlPort;
}

/**
 * Pure core subagent + fold-review wiring without the full-framework
 * ShardManager or Analysis Workbench tools.
 */
export function wireSubagentRuntime(options: SubagentRuntimeOptions): SubagentRuntimeWiring {
  const companionDataDir = options.companionDataDir ?? resolveConfiguredCompanionDataDir(options.config);
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
    auditTrail: options.auditTrail ?? undefined,
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
    hostExecution: options.hostExecution ?? null,
  });
  options.agentLoop.registerTool(createSubagentTool(subagentFaculty), 'core');
  return { foldReviewController, subagentFaculty };
}
