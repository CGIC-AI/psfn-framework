import type { BackupRuntimeConfig } from '../../persistence/backups/config.js';
import {
  SCHEDULED_BACKUP_TASK_ID,
  SCHEDULED_BACKUP_TASK_NAME,
  registerScheduledBackupTask,
} from '../../persistence/backups/service.js';
import { deriveRestoreVerifyDatabaseUrl } from '../../persistence/backups/postgres-restore.js';
import { resolveKubernetesHelmBackupConfig } from '../../persistence/backups/kubernetes-helm.js';
import {
  buildFleetBackupRunOptions,
  isFleetBackupLeader,
  registerScheduledFleetBackupTask,
} from '../../persistence/backups/fleet-scheduler.js';
import { wirePostTurnActionRuntime } from '../startup/composition/post-turn-actions.js';
import type { PostTurnActionRuntime } from '../../core/agent/post-turn-action-runtime.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import { SalienceDecay } from '../../faculties/memory/decay.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import {
  registerAmbientPresenceOperation,
} from '../../core/scheduler/ambient-presence.js';
import {
  BackgroundMaintenanceRegistry,
  type BackgroundMaintenanceRegistrar,
} from '../../core/scheduler/background-maintenance.js';
import {
  registerConcernGroomingOperation,
  resolveCurrentInternalStateConcernVAD,
} from '../../core/intention/concern-grooming.js';
import { createDefaultConcernRouteDispatcher } from './concern-route-wiring.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import {
  SocialGraphBuilderWorker,
  createSocialGraphBuilderMemoryReader,
  SOCIAL_GRAPH_BUILDER_OPERATION_ID,
} from '../../faculties/memory/social-graph/graph-builder-worker.js';
import type {
  SocialGraphProposalStore,
  SocialGraphBuilderWatermarkStore,
} from '../../faculties/memory/social-graph/proposals.js';
import type { CompanionPresenceTurnPort } from '../../core/agent/companion-presence-runtime.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { CompanionAvailabilityRuntime } from '../../core/agent/companion-availability.js';
import { emitGardenQueueChanged } from '../../shared/garden-queue-change.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { SessionManager } from '../../core/session/manager.js';
import {
  createCompressionGuidelineEvolution,
  type CompressionGuidelineEvolutionPort,
} from '../../core/session/compression-guideline-evolution.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import {
  BACKGROUND_WORK_SUPERVISOR_TASK_ID,
  registerDurableBackgroundWorkSupervisorTask,
} from '../../core/agent/background-work/scheduler-task.js';
import type { SchedulerRuntimeConfig } from '../../system/config/scheduler-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { SharedWorldWikiCaretakerService } from '../../faculties/wiki/shared-world-caretaker.js';
import {
  resolveCharacterCardHistoryPath,
  resolveMemoryJournalPath,
  resolvePostTurnActionQueuePath,
  resolveSessionsDir,
  type RuntimePathSnapshot,
} from '../../persistence/layout.js';

const log = createComponentLogger('Agent');
export { BACKGROUND_WORK_SUPERVISOR_TASK_ID };
export const SHARED_WORLD_WIKI_CARETAKER_OPERATION_ID = 'shared-world-wiki-caretaker';

export interface AgentSchedulerRuntime {
  scheduler: Scheduler;
  postTurnActions: PostTurnActionRuntime;
  backgroundMaintenance: BackgroundMaintenanceRegistrar;
  compressionGuidelineEvolution: CompressionGuidelineEvolutionPort;
}

export interface BuildAgentSchedulerRuntimeOptions {
  eventBus: EventBus;
  eligibilityGate: EligibilityGate;
  config: SubstrateConfig;
  schedulerConfig: SchedulerRuntimeConfig;
  sessionManager: SessionManager;
  gateway: GatewayClient;
  memoryStore: MemoryStorePort;
  agentLoop: SubstrateAgent;
  concernStore?: ConcernStorePort | null;
  backupConfig: BackupRuntimeConfig;
  pathSnapshot: RuntimePathSnapshot;
  /** Deployment wiring used only to resolve the optional Kubernetes recovery bundle. */
  env?: NodeJS.ProcessEnv;
  /**
   * Cross-companion presence runtime (multi-companion only; null flag-off).
   * When present, the heartbeat lane bumps this agent's own presence row on the
   * heartbeat cadence so an idle-but-alive emanation stays inside siblings'
   * co-presence (read-side staleness TTL).
   */
  companionPresence?: CompanionPresenceTurnPort | null;
  // ── Social-graph builder worker (E4.2) ──
  contactStore?: ContactStorePort | null;
  socialGraphProposalStore?: SocialGraphProposalStore | null;
  socialGraphWatermarkStore?: SocialGraphBuilderWatermarkStore | null;
  /** Multi-companion-only operator-owned shared-world projection caretaker. */
  sharedWorldWikiCaretaker?: Pick<SharedWorldWikiCaretakerService, 'cleanupChangedContent'> | null;
  companionAvailability?: Pick<CompanionAvailabilityRuntime, 'run'>;
}

export function registerSalienceDecayOperation(input: {
  backgroundMaintenance: BackgroundMaintenanceRegistrar;
  memoryStore: MemoryStorePort;
  config?: SubstrateConfig;
}): void {
  const salienceDecay = new SalienceDecay(input.memoryStore, {
    ...(input.config
      ? { memoryRetrievalPolicy: () => input.config?.memoryRetrievalPolicy }
      : {}),
  });
  input.backgroundMaintenance.registerOperation({
    id: 'salience-decay',
    name: 'Memory Salience Decay',
    description: 'Applies the configured memory weight decay pass to durable memories.',
    handler: () => salienceDecay.run(),
    eligibility: { requiredTokens: ['memory.write'] },
  });
}

export function registerSharedWorldWikiCaretakerOperation(input: {
  backgroundMaintenance: BackgroundMaintenanceRegistrar;
  caretaker: Pick<SharedWorldWikiCaretakerService, 'cleanupChangedContent'>;
  batchSize: number;
}): void {
  input.backgroundMaintenance.registerOperation({
    id: SHARED_WORLD_WIKI_CARETAKER_OPERATION_ID,
    name: 'Shared-World Wiki Caretaker',
    description:
      'Checks a bounded batch of approved shared-world documents and reprojects only changed content.',
    handler: async () => {
      const result = await input.caretaker.cleanupChangedContent(input.batchSize);
      log.info('Shared-world wiki caretaker maintenance batch completed', {
        checked: result.checked,
        reprojected: result.reprojected,
        failed: result.failed,
      });
      if (result.failed > 0) {
        throw new Error(
          `Shared-world wiki caretaker failed ${result.failed} of ${result.checked} projection checks`,
        );
      }
    },
  });
}

export interface RegisterAgentDatabaseBackupLaneOptions {
  scheduler: Scheduler;
  eventBus: EventBus;
  config: Pick<
    SubstrateConfig,
    | 'fleetAuthVerifier'
    | 'postgresDatabaseUrl'
    | 'multiCompanion'
    | 'companionFleet'
    | 'companionId'
    | 'characterCardPath'
  >;
  backupConfig: BackupRuntimeConfig;
  pathSnapshot: RuntimePathSnapshot;
  env?: NodeJS.ProcessEnv;
}

export function registerAgentDatabaseBackupLane(
  options: RegisterAgentDatabaseBackupLaneOptions,
): void {
  if (options.config.fleetAuthVerifier !== undefined) {
    log.warn(
      'Fleet auth is enabled: database backups are owned by the gateway consistent-backup lane; this agent registers no database backup task',
    );
    return;
  }

  const postgresDatabaseUrl = options.config.postgresDatabaseUrl?.trim() || '';
  if (!postgresDatabaseUrl) {
    throw new Error(
      'PostgreSQL scheduled backups require config.postgresDatabaseUrl — refusing to run without a database backup source',
    );
  }
  const onBackupFailure = (error: unknown): void => {
    void options.eventBus.emit('backup.failed', {
      taskId: SCHEDULED_BACKUP_TASK_ID,
      taskName: SCHEDULED_BACKUP_TASK_NAME,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
  };
  const kubernetesHelm = resolveKubernetesHelmBackupConfig(options.env ?? process.env);

  const fleet = options.config.multiCompanion ? options.config.companionFleet : undefined;
  if (options.config.multiCompanion && !fleet) {
    throw new Error(
      'Multi-companion mode is enabled but the resolved config carries no companion fleet — refusing to register a single-companion backup lane',
    );
  }
  if (fleet) {
    if (isFleetBackupLeader(options.config.companionId, fleet)) {
      const fleetOptions = buildFleetBackupRunOptions({
        fleet,
        ownCompanionId: options.config.companionId,
        ownResolvedCompanionDataDir: options.pathSnapshot.companionDataDir,
        systemDataDir: options.pathSnapshot.systemDataDir,
        postgres: { databaseUrl: postgresDatabaseUrl },
        backupConfig: options.backupConfig,
        ...(kubernetesHelm ? { kubernetesHelm } : {}),
      });
      registerScheduledFleetBackupTask({
        scheduler: options.scheduler,
        fleetOptions,
        config: options.backupConfig,
        onBackupFailure,
      });
      log.info('Fleet backups enabled (leader)', {
        companionCount: fleet.companions.length,
        mode: fleetOptions.groupMode ? 'group' : 'per-companion',
        intervalMs: options.backupConfig.intervalMs,
        backupRootDir: options.backupConfig.rootDir,
        verifyRestore: options.backupConfig.verifyRestore,
        encryption: options.backupConfig.encryption.mode,
        kubernetesHelmRecovery: Boolean(kubernetesHelm),
      });
    } else {
      log.info('Fleet backup delegated to leader companion; no backup lane registered in this follower process', {
        companionId: options.config.companionId,
        leaderCompanionId: fleet.companions[0].companionId,
      });
    }
    return;
  }

  registerScheduledBackupTask({
    scheduler: options.scheduler,
    postgres: {
      databaseUrl: postgresDatabaseUrl,
      ...(options.backupConfig.verifyRestore
        ? {
          restoreVerifyDatabaseUrl: (() => {
            const derived = deriveRestoreVerifyDatabaseUrl(postgresDatabaseUrl);
            if (!derived) {
              throw new Error(
                'Backup verifyRestore is enabled but the restore-verify scratch database URL cannot be derived from config.postgresDatabaseUrl',
              );
            }
            return derived;
          })(),
        }
        : {}),
    },
    companionDataDir: options.pathSnapshot.companionDataDir,
    systemDataDir: options.pathSnapshot.systemDataDir,
    ...(kubernetesHelm ? { kubernetesHelm } : {}),
    workspacePath: options.pathSnapshot.workspacePath,
    workspaceProtectedPaths: [
      options.pathSnapshot.systemDataDir,
      options.pathSnapshot.companionDataDir,
      options.pathSnapshot.runtimePathLayout.logsDir,
      options.pathSnapshot.runtimePathLayout.tempDir,
      options.pathSnapshot.runtimePathLayout.backupsDir,
    ],
    sessionsDir: resolveSessionsDir(options.pathSnapshot.companionDataDir),
    memoriesJournalPath: resolveMemoryJournalPath(options.pathSnapshot.companionDataDir),
    characterCardPath: options.config.characterCardPath,
    characterCardHistoryPath: resolveCharacterCardHistoryPath(options.pathSnapshot.companionDataDir),
    config: options.backupConfig,
    onBackupFailure,
  });
  log.info('Scheduled backups enabled', {
    intervalMs: options.backupConfig.intervalMs,
    postgresSource: true,
    maxRotatingBackups: options.backupConfig.maxRotatingBackups,
    maxDailyBackups: options.backupConfig.maxDailyBackups,
    maxWeeklyBackups: options.backupConfig.maxWeeklyBackups,
    maxMonthlyBackups: options.backupConfig.maxMonthlyBackups,
    backupRootDir: options.backupConfig.rootDir,
    mirrorDir: options.backupConfig.mirrorDir || '(none)',
    verifyRestore: options.backupConfig.verifyRestore,
    encryption: options.backupConfig.encryption.mode,
    workspacePath: options.pathSnapshot.workspacePath,
    kubernetesHelmRecovery: Boolean(kubernetesHelm),
  });
}

export function buildAgentSchedulerRuntime(
  options: BuildAgentSchedulerRuntimeOptions,
): AgentSchedulerRuntime {
  const scheduler = new Scheduler(
    options.eventBus,
    {
      tickIntervalMs: options.schedulerConfig.tickIntervalMs,
      heartbeatIntervalMs: options.schedulerConfig.heartbeatIntervalMs,
    },
    {
      eligibilityGate: options.eligibilityGate,
      ...(options.companionAvailability
        ? {
            runProtectedTask: (state, handler) =>
              options.companionAvailability!.run(state, handler),
          }
        : {}),
    },
  );
  registerDurableBackgroundWorkSupervisorTask({
    agentLoop: options.agentLoop,
    intervalMs: options.schedulerConfig.tickIntervalMs,
    scheduler,
  });

  const backgroundMaintenance = new BackgroundMaintenanceRegistry({
    scheduler,
    eligibilityGate: options.eligibilityGate,
    intervalMs: options.schedulerConfig.backgroundMaintenance.intervalMs,
  });
  const compressionGuidelineEvolution = createCompressionGuidelineEvolution({
    eligibilityGate: options.eligibilityGate,
    llmProvider: options.gateway,
  });

  registerSalienceDecayOperation({
    backgroundMaintenance,
    memoryStore: options.memoryStore,
    config: options.config,
  });

  if (options.config.multiCompanion === true) {
    if (!options.sharedWorldWikiCaretaker) {
      throw new Error(
        'Multi-companion background maintenance requires shared-world wiki caretaker dependencies',
      );
    }
    const fleet = options.config.companionFleet;
    if (!fleet) {
      throw new Error(
        'Multi-companion background maintenance requires the resolved companion fleet',
      );
    }
    // Every companion process owns a scheduler. Reuse the fleet's deterministic
    // leader so one shared projection is not redundantly embedded N times.
    if (isFleetBackupLeader(options.config.companionId, fleet)) {
      registerSharedWorldWikiCaretakerOperation({
        backgroundMaintenance,
        caretaker: options.sharedWorldWikiCaretaker,
        batchSize:
          options.schedulerConfig.backgroundMaintenance.sharedWorldWikiCaretaker.batchSize,
      });
    } else {
      log.info('Shared-world wiki caretaker maintenance delegated to fleet leader', {
        companionId: options.config.companionId,
        leaderCompanionId: fleet.companions[0].companionId,
      });
    }
  }

  registerAgentDatabaseBackupLane({
    scheduler,
    eventBus: options.eventBus,
    config: options.config,
    backupConfig: options.backupConfig,
    pathSnapshot: options.pathSnapshot,
    ...(options.env ? { env: options.env } : {}),
  });

  scheduler.registerHeartbeat(async () => {
    const now = Date.now();
    await options.eventBus.emit('schedule.healthcheck', {
      timestamp: now,
      taskCount: scheduler.taskCount,
    });
    // Multi-companion presence liveness beat. No-op flag-off (companionPresence
    // is null) and when this agent has no current situated place. Refresh errors
    // are logged loudly inside the runtime and never thrown, so they can never
    // take down the heartbeat lane.
    await options.companionPresence?.refreshOwnPresence();
  });
  registerAmbientPresenceOperation({
    backgroundMaintenance,
    sessionManager: options.sessionManager,
    restWindow: options.schedulerConfig.episodicProcessing,
    eventBus: options.eventBus,
    minIdleMs:
      options.schedulerConfig.backgroundMaintenance.ambientPresence.minIdleMinutes * 60_000,
    minNoteIntervalMs:
      options.schedulerConfig.backgroundMaintenance.ambientPresence.minNoteIntervalMinutes * 60_000,
  });
  if (options.concernStore) {
    registerConcernGroomingOperation({
      backgroundMaintenance,
      concernStore: options.concernStore,
      eventBus: options.eventBus,
      maxActiveConcerns:
        options.schedulerConfig.backgroundMaintenance.concernGrooming.maxActiveConcerns,
      routeDispatcher: createDefaultConcernRouteDispatcher({
        companionDataDir: options.pathSnapshot.companionDataDir,
        eventBus: options.eventBus,
      }),
      // Resolution-as-appraisal (vw3w.1): grooming resolves off-turn, so it
      // reads the agent's live internal VAD to snapshot resolutionVAD.
      resolutionVadProvider: (concern, asOf) => resolveCurrentInternalStateConcernVAD(
        concern,
        options.agentLoop.getCurrentInternalState(),
        asOf,
      ),
    });
  }

  // ── Social-graph builder worker (E4.2, memory-agent lane) ──
  // Background job that proposes social-graph edges from accumulated room
  // evidence. Purely heuristic (no LLM call, so no model charge); it runs on the
  // same background-maintenance posture as sleeptime/salience-decay via the
  // scheduler eligibility gate. NEVER inline in the chat path. Law 31: results
  // land in the durable proposal store and are surfaced in Garden — never silent.
  if (
    options.contactStore
    && options.socialGraphProposalStore
    && options.socialGraphWatermarkStore
  ) {
    const contactStore = options.contactStore;
    const memoryStore = options.memoryStore;
    const builderCadence = options.schedulerConfig.socialGraphBuilder;
    const socialGraphBuilder = new SocialGraphBuilderWorker({
      memoryReader: createSocialGraphBuilderMemoryReader({
        listRoomChannelIds: async () => (
          await contactStore.listKnownRooms({ limit: builderCadence.scanMemoryLimit })
        ).map(room => room.channelId),
        getMemoriesByChannel: (channelId, limit) => memoryStore.getMemoriesByChannel(channelId, limit),
      }),
      contacts: contactStore,
      proposalStore: options.socialGraphProposalStore,
      watermarkStore: options.socialGraphWatermarkStore,
      config: {
        coPresenceMinSessions: builderCadence.coPresenceMinSessions,
        coPresenceWindowMinutes: builderCadence.coPresenceWindowMinutes,
        scanMemoryLimit: builderCadence.scanMemoryLimit,
      },
      onComplete: (telemetry) => {
        void options.eventBus.emit('memory.social_graph.builder', {
          ...telemetry,
          timestamp: Date.now(),
        });
        if (telemetry.proposed > 0 || telemetry.conflicts > 0) {
          emitGardenQueueChanged(options.eventBus, 'graph-proposals');
        }
      },
    });
    backgroundMaintenance.registerOperation({
      id: SOCIAL_GRAPH_BUILDER_OPERATION_ID,
      name: 'Social Graph Builder',
      description:
        'Scans bounded room-memory evidence and creates operator-reviewed social-graph proposals.',
      handler: async () => {
        await socialGraphBuilder.run();
      },
      eligibility: { requiredTokens: ['memory.write'] },
    });
    log.info('Social-graph builder worker registered', {
      intervalMs: options.schedulerConfig.backgroundMaintenance.intervalMs,
      coPresenceMinSessions: builderCadence.coPresenceMinSessions,
    });
  }

  const postTurnActions = wirePostTurnActionRuntime({
    eventBus: options.eventBus,
    scheduler,
    agentLoop: options.agentLoop,
    eligibilityGate: options.eligibilityGate,
    persistencePath: resolvePostTurnActionQueuePath(options.pathSnapshot.companionDataDir),
  });
  log.info(`Memory system enabled (${options.gateway.dims}d embeddings via gateway)`);
  return {
    scheduler,
    postTurnActions,
    backgroundMaintenance,
    compressionGuidelineEvolution,
  };
}
