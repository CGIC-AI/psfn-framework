import type Database from 'better-sqlite3';
import type { BackupRuntimeConfig } from '../../backup/config.js';
import { registerScheduledBackupTask } from '../../backup/service.js';
import { wirePostTurnActionRuntime, type PostTurnActionRuntime } from '../../bootstrap/post-turn-actions.js';
import type { GatewayClient } from '../../gateway/client.js';
import { SalienceDecay } from '../../memory/decay.js';
import type { MemoryStore } from '../../memory/store.js';
import { Scheduler } from '../../scheduler/scheduler.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { SessionManager } from '../../session/manager.js';
import type { SubstrateAgent } from '../../agent/substrate-agent.js';
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
  memoryStore: MemoryStore;
  agentLoop: SubstrateAgent;
  db: Database.Database;
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

  registerScheduledBackupTask({
    scheduler,
    db: options.db,
    databasePath: options.config.databasePath,
    sessionsDir: resolveSessionsDir(options.pathSnapshot.companionDataDir),
    memoriesJournalPath: resolveMemoryJournalPath(options.pathSnapshot.companionDataDir),
    characterCardPath: options.config.characterCardPath,
    characterCardHistoryPath: resolveCharacterCardHistoryPath(options.pathSnapshot.companionDataDir),
    config: options.backupConfig,
  });
  log.info('Scheduled backups enabled', {
    intervalMs: options.backupConfig.intervalMs,
    maxRotatingBackups: options.backupConfig.maxRotatingBackups,
    maxWeeklyBackups: options.backupConfig.maxWeeklyBackups,
    maxMonthlyBackups: options.backupConfig.maxMonthlyBackups,
    backupRootDir: options.backupConfig.rootDir,
    mirrorDir: options.backupConfig.mirrorDir || '(none)',
    verifyRestore: options.backupConfig.verifyRestore,
  });

  scheduler.registerHeartbeat(async () => {
    const now = Date.now();
    await options.eventBus.emit('schedule.heartbeat', {
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
