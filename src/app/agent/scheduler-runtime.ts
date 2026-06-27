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
  db?: Database.Database | null;
  backupConfig: BackupRuntimeConfig;
  pathSnapshot: RuntimePathSnapshot;
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
  });

  scheduler.registerHeartbeat(async () => {
    const now = Date.now();
    await options.eventBus.emit('schedule.healthcheck', {
      timestamp: now,
      taskCount: scheduler.taskCount,
    });
  });

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
