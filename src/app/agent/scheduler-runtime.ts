import type Database from 'better-sqlite3';
import type { BackupRuntimeConfig } from '../../persistence/backups/config.js';
import {
  SCHEDULED_BACKUP_TASK_ID,
  SCHEDULED_BACKUP_TASK_NAME,
  registerScheduledBackupTask,
} from '../../persistence/backups/service.js';
import { deriveRestoreVerifyDatabaseUrl } from '../../persistence/backups/postgres-restore.js';
import { wirePostTurnActionRuntime } from '../startup/composition/post-turn-actions.js';
import type { PostTurnActionRuntime } from '../../core/agent/post-turn-action-runtime.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import { SalienceDecay } from '../../faculties/memory/decay.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { registerAmbientPresenceTask } from '../../core/scheduler/ambient-presence.js';
import { registerConcernGroomingTask } from '../../core/intention/concern-grooming.js';
import { createDefaultConcernRouteDispatcher } from './concern-route-wiring.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import {
  SocialGraphBuilderWorker,
  createSocialGraphBuilderMemoryReader,
  SOCIAL_GRAPH_BUILDER_TASK_ID,
} from '../../faculties/memory/social-graph/graph-builder-worker.js';
import type {
  SocialGraphProposalStore,
  SocialGraphBuilderWatermarkStore,
} from '../../faculties/memory/social-graph/proposals.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SchedulerRuntimeConfig } from '../../system/config/scheduler-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  resolveCharacterCardHistoryPath,
  resolveMemoryJournalPath,
  resolvePostTurnActionQueuePath,
  resolveSessionsDir,
  type RuntimePathSnapshot,
} from '../../persistence/layout.js';

const log = createComponentLogger('Agent');
const COMPACTION_GUIDELINE_REVIEW_TASK_ID = 'compaction-guideline-review';

export interface AgentSchedulerRuntime {
  scheduler: Scheduler;
  postTurnActions: PostTurnActionRuntime;
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
  db?: Database.Database | null;
  backupConfig: BackupRuntimeConfig;
  pathSnapshot: RuntimePathSnapshot;
  // ── Social-graph builder worker (E4.2) ──
  contactStore?: ContactStorePort | null;
  socialGraphProposalStore?: SocialGraphProposalStore | null;
  socialGraphWatermarkStore?: SocialGraphBuilderWatermarkStore | null;
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
    },
  );

  const salienceDecay = new SalienceDecay(options.memoryStore);
  scheduler.register({
    id: 'salience-decay',
    name: 'Memory Salience Decay',
    type: 'every',
    intervalMs: options.config.maintenanceIntervalMs,
    handler: () => salienceDecay.run(),
    eligibility: { requiredTokens: ['memory.write'] },
    state: 'idle',
  });
  scheduler.register({
    id: COMPACTION_GUIDELINE_REVIEW_TASK_ID,
    name: 'Compression Guideline Review',
    type: 'every',
    intervalMs: options.config.maintenanceIntervalMs,
    handler: async () => {
      const result = await options.sessionManager.runPeriodicCompressionGuidelineUpdate(
        options.gateway,
      );
      if (result.status === 'updated') {
        log.info('Compression guideline updated from failure log review', {
          version: result.version,
          reviewedFailureCount: result.reviewedFailureCount,
        });
        return;
      }
      log.debug('Compression guideline review skipped', {
        reason: result.reason,
        reviewedFailureCount: result.reviewedFailureCount,
      });
    },
    eligibility: { requiredTokens: ['memory.write'] },
    state: 'idle',
  });

  const postgresDatabaseUrl = options.config.postgresDatabaseUrl?.trim() || '';
  if (options.config.persistenceBackend === 'postgres' && !postgresDatabaseUrl) {
    throw new Error(
      'PostgreSQL scheduled backups require config.postgresDatabaseUrl — refusing to use a SQLite handle as a Postgres fallback',
    );
  }
  if (!options.db && !postgresDatabaseUrl) {
    throw new Error(
      'Scheduled backups require a SQLite handle or config.postgresDatabaseUrl — refusing to run without a database backup source',
    );
  }
  registerScheduledBackupTask({
    scheduler,
    ...(options.db
      ? { db: options.db, databasePath: options.config.databasePath }
      : {}),
    ...(postgresDatabaseUrl
      ? {
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
      }
      : {}),
    companionDataDir: options.pathSnapshot.companionDataDir,
    systemDataDir: options.pathSnapshot.systemDataDir,
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
    onBackupFailure: (error) => {
      void options.eventBus.emit('backup.failed', {
        taskId: SCHEDULED_BACKUP_TASK_ID,
        taskName: SCHEDULED_BACKUP_TASK_NAME,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
    },
  });
  log.info('Scheduled backups enabled', {
    intervalMs: options.backupConfig.intervalMs,
    sqliteSource: Boolean(options.db),
    postgresSource: Boolean(postgresDatabaseUrl),
    maxRotatingBackups: options.backupConfig.maxRotatingBackups,
    maxWeeklyBackups: options.backupConfig.maxWeeklyBackups,
    maxMonthlyBackups: options.backupConfig.maxMonthlyBackups,
    backupRootDir: options.backupConfig.rootDir,
    mirrorDir: options.backupConfig.mirrorDir || '(none)',
    verifyRestore: options.backupConfig.verifyRestore,
    encryption: options.backupConfig.encryption.mode,
    workspacePath: options.pathSnapshot.workspacePath,
  });

  scheduler.registerHeartbeat(async () => {
    const now = Date.now();
    await options.eventBus.emit('schedule.healthcheck', {
      timestamp: now,
      taskCount: scheduler.taskCount,
    });
  });
  registerAmbientPresenceTask({
    scheduler,
    sessionManager: options.sessionManager,
    restWindow: options.schedulerConfig.episodicProcessing,
    eventBus: options.eventBus,
  });
  if (options.concernStore) {
    registerConcernGroomingTask({
      scheduler,
      concernStore: options.concernStore,
      eventBus: options.eventBus,
      routeDispatcher: createDefaultConcernRouteDispatcher({
        companionDataDir: options.pathSnapshot.companionDataDir,
        eventBus: options.eventBus,
      }),
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
      },
    });
    scheduler.register({
      id: SOCIAL_GRAPH_BUILDER_TASK_ID,
      name: 'Social Graph Builder',
      type: 'every',
      intervalMs: builderCadence.intervalMs,
      handler: async () => {
        await socialGraphBuilder.run();
      },
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    });
    log.info('Social-graph builder worker registered', {
      intervalMs: builderCadence.intervalMs,
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
  options.eventBus.on('agent.turn.end', ({ message, response }) => {
    const captured = options.sessionManager.recordCompressionFailureFromResponse(
      message.channelId,
      message.id,
      response.content,
    );
    if (!captured) return;
    log.info('Captured compression failure signal for guideline evolution', {
      channelId: message.channelId,
      sourceMessageId: message.id,
    });
  });

  scheduler.start();
  log.info(`Memory system enabled (${options.gateway.dims}d embeddings via gateway)`);
  return {
    scheduler,
    postTurnActions,
  };
}
