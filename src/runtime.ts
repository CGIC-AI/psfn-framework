import type Database from 'better-sqlite3';
import type { SubstrateConfig, Lifecycle } from './types.js';
import { createComponentLogger } from './logger.js';
import { EventBus } from './event-bus.js';
import { LLMClient } from './llm/client.js';
import type { CrashRecoveryExtractionCandidate, SessionStore } from './session/store.js';
import { SessionManager } from './session/manager.js';
import { SubstrateAgent } from './agent/substrate-agent.js';
import type { DiscordAdapter } from './channels/discord/adapter.js';
import { MemoryStore } from './memory/store.js';
import { MemoryExtractor } from './memory/extraction.js';
import { SalienceDecay } from './memory/decay.js';
import { Scheduler } from './scheduler/scheduler.js';
import type { ShardExecutionPort } from './shards/port.js';
import type { ChannelAdapter } from './channels/types.js';
import { AdminServer } from './channels/admin/server.js';
import { CapabilityRuntime } from './capabilities/runtime.js';
import { ModuleLoader } from './modules/loader.js';
import { writeLastActiveSession } from './lifecycle/notifications.js';
import type { LifecycleNotifier } from './lifecycle/notifications.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import { attachVoiceObservers } from './voice/observers/index.js';
import { WyomingTcpServer } from './channels/wyoming/server.js';
import { WyomingRuntime } from './channels/wyoming/runtime.js';
import {
  buildRuntimeChannelsConfigOverrides,
  createEmbeddingDimensionMismatchFatalMessage,
} from './runtime/bootstrap-helpers.js';
import { parseExtractionDrainTimeoutMs } from './runtime/env-parsing.js';
import { initializeSubstrateRuntime } from './runtime/startup-harness.js';
import {
  startChannelAdapters,
  stopChannelAdapters,
} from './runtime/channel-lifecycle.js';
import {
  runShutdownSequence,
  type ShutdownSequenceStep,
} from './runtime/shutdown-helpers.js';
export {
  buildRuntimeChannelsConfigOverrides,
  createEmbeddingDimensionMismatchFatalMessage,
};

const log = createComponentLogger('Runtime');
const DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS = 10_000;

interface RuntimeStopOptions {
  notifyShutdown?: boolean;
  shutdownReason?: string;
}

export class SubstrateRuntime implements Lifecycle {
  private config: SubstrateConfig;
  private eventBus: EventBus;
  private db!: Database.Database;
  private llmClient!: LLMClient;
  private sessionStore!: SessionStore;
  private sessionManager!: SessionManager;
  private memoryExtractor!: MemoryExtractor;
  private agentLoop!: SubstrateAgent;
  private discord!: DiscordAdapter;
  private memoryStore!: MemoryStore;
  private salienceDecay!: SalienceDecay;
  private scheduler!: Scheduler;
  private shardManager!: ShardExecutionPort;
  private channelRegistry = new Map<string, ChannelAdapter>();
  private capabilityRuntime!: CapabilityRuntime;
  private moduleLoader?: ModuleLoader;
  private adminServer?: AdminServer;
  private wyomingTcpServer?: WyomingTcpServer;
  private wyomingRuntime?: WyomingRuntime;
  private lifecycleNotifier?: LifecycleNotifier;
  private stopVoiceObservers?: () => void;
  private stopDebugObserver?: () => void;
  private crashRecoveryQueue: CrashRecoveryExtractionCandidate[] = [];
  private crashRecoveryRetryBacklog = new Map<string, CrashRecoveryExtractionCandidate>();
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private startTime: number;

  constructor(config: SubstrateConfig) {
    this.config = config;
    this.eventBus = new EventBus();
    this.stopVoiceObservers = attachVoiceObservers(this.eventBus);
    this.stopDebugObserver = attachTerminalDebugObserver(this.eventBus, { scope: 'runtime' });
    this.startTime = Date.now();
  }

  private async startChannels(): Promise<void> {
    await startChannelAdapters(
      this.channelRegistry,
      registry => this.agentLoop.setChannelRegistry(registry),
      log,
    );
  }

  private async stopChannels(): Promise<void> {
    await stopChannelAdapters(this.channelRegistry);
  }

  private seedCrashRecoveryRetryBacklog(candidates: CrashRecoveryExtractionCandidate[]): void {
    this.crashRecoveryRetryBacklog.clear();
    for (const candidate of candidates) {
      this.crashRecoveryRetryBacklog.set(candidate.channelId, candidate);
    }
  }

  private refreshCrashRecoveryRetryBacklog(channelId: string): boolean {
    const sessionStore = this.sessionStore;
    if (typeof sessionStore.getCrashRecoveryExtractionCandidates !== 'function') {
      return this.crashRecoveryRetryBacklog.has(channelId);
    }

    const candidate = sessionStore
      .getCrashRecoveryExtractionCandidates()
      .find(item => item.channelId === channelId);
    if (candidate) {
      this.crashRecoveryRetryBacklog.set(channelId, candidate);
      return true;
    }

    this.crashRecoveryRetryBacklog.delete(channelId);
    return false;
  }

  private resolveUnresolvedCrashRecoveryChannels(): Set<string> {
    const sessionStore = this.sessionStore;
    if (typeof sessionStore.getCrashRecoveryExtractionCandidates !== 'function') {
      return new Set(this.crashRecoveryRetryBacklog.keys());
    }

    const unresolvedCandidates = sessionStore.getCrashRecoveryExtractionCandidates();
    const unresolvedChannelIds = new Set(unresolvedCandidates.map(candidate => candidate.channelId));

    for (const candidate of unresolvedCandidates) {
      this.crashRecoveryRetryBacklog.set(candidate.channelId, candidate);
    }
    for (const channelId of [...this.crashRecoveryRetryBacklog.keys()]) {
      if (!unresolvedChannelIds.has(channelId)) {
        this.crashRecoveryRetryBacklog.delete(channelId);
      }
    }

    return unresolvedChannelIds;
  }

  private queueCrashRecoveryExtractions(): void {
    if (this.crashRecoveryQueue.length === 0) return;

    const queued = this.crashRecoveryQueue;
    this.crashRecoveryQueue = [];
    const pendingEntryCount = queued.reduce(
      (total, candidate) => total + candidate.unextractedEntries.length,
      0,
    );
    log.info('Queueing crash recovery extraction', {
      channelCount: queued.length,
      pendingEntryCount,
    });

    for (const candidate of queued) {
      this.crashRecoveryRetryBacklog.set(candidate.channelId, candidate);
      void this.memoryExtractor.queueRetroactiveExtraction(
        candidate.channelId,
        candidate.unextractedEntries,
      )
        .catch((error) => {
          log.error('Crash recovery extraction queue failed', {
            channelId: candidate.channelId,
            error: String(error),
          });
        })
        .finally(() => {
          let unresolved = false;
          try {
            unresolved = this.refreshCrashRecoveryRetryBacklog(candidate.channelId);
          } catch (error) {
            log.error('Crash recovery retry bookkeeping failed', {
              channelId: candidate.channelId,
              error: String(error),
            });
            return;
          }
          if (!unresolved) return;

          const pending = this.crashRecoveryRetryBacklog.get(candidate.channelId);
          log.warn('Crash recovery extraction remains unresolved; retry deferred to next startup', {
            channelId: candidate.channelId,
            pendingEntryCount: pending?.unextractedEntries.length
              ?? candidate.unextractedEntries.length,
          });
        });
    }
  }

  private restoreLatestSessionMetadata(companionDataDir: string): void {
    const behavior = this.config.sessionRestartBehavior ?? 'reuse_latest_session';
    const resolved = this.sessionManager.resolveStartupSessionMetadata(behavior);
    if (!resolved) return;

    writeLastActiveSession(companionDataDir, resolved);
    if (behavior === 'new_session') {
      log.info('Initialized fresh startup session metadata', {
        sessionId: resolved.sessionId,
        channelType: resolved.channelType ?? 'unknown',
        timestamp: resolved.timestamp,
      });
      return;
    }

    log.info('Restored latest session metadata', {
      sessionId: resolved.sessionId,
      channelType: resolved.channelType ?? 'unknown',
      timestamp: resolved.timestamp,
    });
  }

  async init(): Promise<void> {
    await initializeSubstrateRuntime(this);
  }

  async start(): Promise<void> {
    log.info('Starting...');
    this.scheduler.start();
    await this.startChannels();
    if (this.adminServer) await this.adminServer.start();
    if (this.wyomingTcpServer) {
      await this.wyomingTcpServer.start();
      log.info(`Wyoming voice bridge listening on ${this.config.wyomingHost ?? '127.0.0.1'}:${this.config.wyomingPort ?? 10400}`);
    }
    this.queueCrashRecoveryExtractions();
    await this.eventBus.emit('system.ready', {});

    // Send "I'm back" notification (fire-and-forget — don't block startup)
    this.lifecycleNotifier?.notifyReady().catch((err) => {
      log.error('Ready notification failed', { error: String(err) });
    });

    log.info('Ready');
  }

  async stop(options: RuntimeStopOptions = {}): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    this.stopPromise = this.stopInternal(options);
    await this.stopPromise;
  }

  private async stopInternal(options: RuntimeStopOptions): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const shutdownReason = options.shutdownReason?.trim();
    log.info('Shutting down...');

    const timeoutMs = parseExtractionDrainTimeoutMs(
      process.env,
      DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS,
    );

    const unresolvedCrashRecoveryChannels = this.resolveUnresolvedCrashRecoveryChannels();
    if (unresolvedCrashRecoveryChannels.size > 0) {
      log.warn('Skipping graceful markers for channels with unresolved extraction backlog', {
        channels: [...unresolvedCrashRecoveryChannels],
      });
    }

    const shutdownSteps: ShutdownSequenceStep[] = [
      ...(options.notifyShutdown ?? true
        ? [{
            step: 'send graceful shutdown notification',
            action: () => this.lifecycleNotifier?.notifyShutdown(
              shutdownReason && shutdownReason.length > 0 ? shutdownReason : undefined,
            ),
          }]
        : []),
      { step: 'emit system.shutdown event', action: () => this.eventBus.emit('system.shutdown', {}) },
      {
        step: 'stop voice observers',
        action: () => {
          this.stopVoiceObservers?.();
          this.stopVoiceObservers = undefined;
        },
      },
      {
        step: 'stop debug observer',
        action: () => {
          this.stopDebugObserver?.();
          this.stopDebugObserver = undefined;
        },
      },
      { step: 'stop scheduler', action: () => this.scheduler.stop() },
      {
        step: 'drain memory extractor',
        action: async () => {
          const drained = await this.memoryExtractor.stop({ timeoutMs });
          if (drained === false) {
            log.warn('Proceeding with shutdown before extraction drain completed', { timeoutMs });
          }
        },
      },
      {
        step: 'write graceful shutdown markers',
        action: () => {
          const markedChannels = this.sessionStore.markGracefulShutdownForActiveChannels(
            Date.now(),
            { skipChannels: unresolvedCrashRecoveryChannels },
          );
          if (markedChannels.length > 0) {
            log.info('Wrote graceful shutdown markers', { channels: markedChannels });
          }
        },
      },
      { step: 'stop Wyoming runtime', action: () => this.wyomingRuntime?.stop() },
      { step: 'stop Wyoming TCP server', action: () => this.wyomingTcpServer?.stop() },
      { step: 'stop admin server', action: () => this.adminServer?.stop() },
      { step: 'shutdown modules', action: () => this.moduleLoader?.shutdown() },
      { step: 'stop channel adapters', action: () => this.stopChannels() },
      {
        step: 'close database',
        action: () => {
          this.db.close();
        },
      },
    ];

    await runShutdownSequence(shutdownSteps, log);
    log.info('Stopped');
  }
}
