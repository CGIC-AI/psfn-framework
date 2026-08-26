import type {
  ChannelAdapterPort,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  ChannelPromptAdapter,
  ChannelSecurityAdapter,
  MessageHandler,
  MessageHandlerOptions,
  OutboundContext,
} from '../backplane/types.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  MulticaHttpClient,
  MulticaHttpError,
  type MulticaFetch,
  withMulticaOperationTimeout,
} from './http-client.js';
import { normalizeMulticaOrigin } from './origin.js';
import {
  isTerminalTaskStatus,
  parseClaimResponse,
  parseIssueResponse,
  parseRegistrationResponse,
  parseTaskStatusResponse,
  type MulticaClaimedTask,
  type MulticaIssue,
} from './protocol.js';
import type {
  MulticaRuntimeLease,
  MulticaRuntimeLeaseHandle,
} from './runtime-lease.js';
import { toMulticaSubstrateMessage } from './task-message.js';

const MULTICA_RUNTIME_PROVIDER = 'psfn';
const MULTICA_RUNTIME_VERSION = 'gateway-channel-v1';
const MULTICA_DEVICE_NAME = 'PSFN Gateway';
const DEFAULT_MULTICA_HEARTBEAT_INTERVAL_MS = 15_000;
const MULTICA_MAX_OPERATION_ATTEMPTS = 3;

export interface MulticaAdapterConfig {
  enabled: boolean;
  baseUrl: string;
  workspaceId: string;
  companionId: string;
  token: string;
  pollIntervalMs: number;
  runtimeName?: string;
}

export interface MulticaAdapterLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

interface MulticaOperatorAlert {
  title: string;
  message: string;
  idempotencyKey: string;
}

type MulticaOperatorAlertHandler = (alert: MulticaOperatorAlert) => Promise<void>;

export interface MulticaAdapterOptions {
  runtimeLease: MulticaRuntimeLease;
  shutdownTimeoutMs?: number;
  fetchImpl?: MulticaFetch;
  log?: MulticaAdapterLogger;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
  intakeScreening?: IntakeScreeningService | null;
}

class MulticaWorkspaceBoundaryError extends Error {}
class MulticaTaskInterruptedError extends Error {}
class MulticaTaskStartReconciliationError extends Error {}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// AbortSignal changes asynchronously across awaits; keep lifecycle checks from
// being incorrectly narrowed to the constructor-time value by static analysis.
function signalWasAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(toErrorMessage(error));
}

function combineErrors(message: string, errors: readonly unknown[]): Error {
  return new AggregateError(errors.map(asError), message);
}

function waitForNextPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class MulticaAdapter implements ChannelAdapterPort {
  readonly id = 'multica';
  readonly name = this.id;
  readonly meta = { label: 'Multica' };
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ['channel', 'thread'], media: false, reactions: false,
    threads: true, streaming: false, promptChannelType: 'multica_work_item',
  };
  readonly config: ChannelConfigAdapter;
  readonly outbound: ChannelOutboundAdapter;
  readonly gateway: ChannelGatewayAdapter;
  readonly security: ChannelSecurityAdapter = { supportsDirectMessages: false };
  readonly prompt: ChannelPromptAdapter = {
    resolveChannelType: () => 'multica_work_item',
    resolveTaskKind: () => 'work_item',
  };

  private readonly multica: MulticaAdapterConfig;
  private readonly http: MulticaHttpClient;
  private readonly log: MulticaAdapterLogger;
  private readonly heartbeatIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly intakeScreening: IntakeScreeningService | null;
  private readonly runtimeLease: MulticaRuntimeLease;
  private readonly daemonId: string;
  private readonly leaseKey: string;
  private handler: MessageHandler | null = null;
  private operatorAlertHandler: MulticaOperatorAlertHandler | null = null;
  private runtimeId: string | null = null;
  private running = false;
  private runController: AbortController | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private standbyPromise: Promise<void> | null = null;
  private ownership: MulticaRuntimeLeaseHandle | null = null;
  private ownershipWatchPromise: Promise<void> | null = null;
  private pollLoopPromise: Promise<void> | null = null;
  private heartbeatLoopPromise: Promise<void> | null = null;
  private terminalFailurePromise: Promise<void> | null = null;
  private terminalError: Error | null = null;

  constructor(config: MulticaAdapterConfig, options: MulticaAdapterOptions) {
    this.multica = { ...config, baseUrl: normalizeMulticaOrigin(config.baseUrl, 'Multica adapter baseUrl') };
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_MULTICA_HEARTBEAT_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_MULTICA_HEARTBEAT_INTERVAL_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? this.requestTimeoutMs;
    this.http = new MulticaHttpClient(
      this.multica.baseUrl,
      this.multica.token,
      this.requestTimeoutMs,
      options.fetchImpl,
    );
    this.intakeScreening = options.intakeScreening ?? null;
    this.runtimeLease = options.runtimeLease;
    this.daemonId = `psfn-gateway-${this.multica.companionId}`;
    this.leaseKey = `multica:${this.multica.workspaceId}:${this.multica.companionId}`;
    this.log = options.log ?? createComponentLogger('MulticaAdapter');
    this.config = { enabled: config.enabled, connectionLabel: this.multica.baseUrl };
    this.outbound = {
      textChunkLimit: 100_000,
      sendText: async (_ctx: OutboundContext, _text: string): Promise<void> => {
        throw new Error('Multica task replies are delivered from the channel handler result');
      },
    };
    this.gateway = {
      init: async () => undefined,
      start: async () => this.start(),
      stop: async () => this.stop(),
    };
  }

  async init(): Promise<void> { await this.gateway.init(); }
  onMessage(handler: MessageHandler): void { this.handler = handler; }
  onOperatorAlert(handler: MulticaOperatorAlertHandler): void { this.operatorAlertHandler = handler; }
  async send(channelId: string, content: string): Promise<void> {
    await this.outbound.sendText({ channelId }, content);
  }

  async start(): Promise<void> {
    if (!this.multica.enabled) return;
    if (this.stopPromise) {
      await this.stopPromise;
      await this.start();
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.running || (this.runController && !this.runController.signal.aborted)) return;
    if (!this.handler) throw new Error('Multica adapter requires an inbound message handler before start');
    if (!this.operatorAlertHandler) throw new Error('Multica adapter requires an operator alert handler before start');
    const controller = new AbortController();
    this.runController = controller;
    const startPromise = this.beginRuntimeStart(controller);
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  private async beginRuntimeStart(controller: AbortController): Promise<void> {
    const ownership = await this.runtimeLease.tryAcquire(this.leaseKey, {
      signal: controller.signal,
    });
    if (ownership) {
      await this.activateOwnedRuntime(controller, ownership);
      return;
    }

    // A rolling replacement must become ready while the old pod still owns the
    // stable Multica identity. Ownership transfer continues in the background;
    // the replacement cannot register, recover, or poll before this resolves.
    const standbyPromise = this.acquireStandbyOwnership(controller.signal)
      .then(async handle => await this.activateOwnedRuntime(controller, handle))
      .catch(async (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) throw error;
        let standbyError = asError(error);
        this.log.error('Multica standby activation failed', { error: toErrorMessage(error) });
        try {
          await this.alertOperator('standby', 'Multica standby failed to acquire runtime ownership', error);
        } catch (alertError) {
          standbyError = combineErrors('Multica standby and operator alert failed', [
            standbyError,
            alertError,
          ]);
        }
        this.terminalError = standbyError;
        if (this.runController === controller) this.runController = null;
        throw standbyError;
      });
    this.standbyPromise = standbyPromise;
    void standbyPromise.catch(() => undefined).finally(() => {
      if (this.standbyPromise === standbyPromise) this.standbyPromise = null;
    });
  }

  private async acquireStandbyOwnership(signal: AbortSignal): Promise<MulticaRuntimeLeaseHandle> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MULTICA_MAX_OPERATION_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await this.runtimeLease.acquire(this.leaseKey, {
          signal,
          pollIntervalMs: this.multica.pollIntervalMs,
        });
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error;
        lastError = error;
        if (attempt < MULTICA_MAX_OPERATION_ATTEMPTS) {
          this.log.warn('Multica standby ownership failed; retrying', {
            attempt,
            maxAttempts: MULTICA_MAX_OPERATION_ATTEMPTS,
            error: toErrorMessage(error),
          });
        }
      }
    }
    throw new Error(
      `Multica standby ownership failed after ${MULTICA_MAX_OPERATION_ATTEMPTS} attempts: ${toErrorMessage(lastError)}`,
    );
  }

  private async activateOwnedRuntime(
    controller: AbortController,
    ownership: MulticaRuntimeLeaseHandle,
  ): Promise<void> {
    if (controller.signal.aborted) {
      await ownership.release();
      return;
    }
    this.ownership = ownership;
    const signal = AbortSignal.any([controller.signal, ownership.lost]);
    try {
      const registration = await this.withAttempts('Multica runtime registration', async attemptSignal => (
        parseRegistrationResponse(await this.http.postJson('/api/daemon/register', {
          workspace_id: this.multica.workspaceId,
          daemon_id: this.daemonId,
          legacy_daemon_ids: [],
          device_name: MULTICA_DEVICE_NAME,
          cli_version: MULTICA_RUNTIME_VERSION,
          launched_by: 'gateway',
          runtimes: [{
            name: this.multica.runtimeName?.trim() || 'PSFN Companion',
            type: MULTICA_RUNTIME_PROVIDER,
            version: MULTICA_RUNTIME_VERSION,
            status: 'online',
          }],
          failed_profiles: [],
        }, this.multica.token, attemptSignal), MULTICA_RUNTIME_PROVIDER)
      ), signal);
      this.runtimeId = registration.id;
      await this.withAttempts('Multica orphan recovery', async attemptSignal => await this.http.postJson(
        `/api/daemon/runtimes/${encodeURIComponent(registration.id)}/recover-orphans`,
        {},
        this.multica.token,
        attemptSignal,
      ), signal);
    } catch (error) {
      if (ownership.lost.aborted) {
        await this.abandonLostOwnership(ownership, error);
        throw new Error(`Multica runtime ownership was lost during startup: ${toErrorMessage(error)}`);
      }
      if (signalWasAborted(controller.signal)) {
        await this.cleanupOwnedRuntime(ownership);
        return;
      }
      let startupError = asError(error);
      try {
        await this.alertOperator('startup', 'Multica channel failed to start', startupError);
      } catch (alertError) {
        this.log.error('Multica startup operator alert failed', { error: toErrorMessage(alertError) });
        startupError = combineErrors('Multica startup and operator alert failed', [startupError, alertError]);
      }
      try {
        await this.cleanupOwnedRuntime(ownership);
      } catch (cleanupError) {
        this.log.error('Multica failed-start runtime cleanup failed', {
          error: toErrorMessage(cleanupError),
        });
        startupError = combineErrors('Multica startup and cleanup failed', [startupError, cleanupError]);
      }
      if (this.runController === controller) this.runController = null;
      throw startupError;
    }
    if (ownership.lost.aborted) {
      const error = new Error('Multica runtime ownership was lost before activation');
      await this.abandonLostOwnership(ownership, error);
      throw error;
    }
    if (signalWasAborted(controller.signal)) {
      await this.cleanupOwnedRuntime(ownership);
      return;
    }
    this.running = true;
    this.terminalError = null;
    this.terminalFailurePromise = null;
    this.pollLoopPromise = this.runPollLoop(signal);
    this.heartbeatLoopPromise = this.runHeartbeatLoop(signal);
    const watchPromise = this.watchOwnership(ownership, controller);
    this.ownershipWatchPromise = watchPromise;
    void watchPromise.finally(() => {
      if (this.ownershipWatchPromise === watchPromise) this.ownershipWatchPromise = null;
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    const stopPromise = this.stopRuntime();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    }
  }

  private async stopRuntime(): Promise<void> {
    const activeStart = this.startPromise;
    const activeStandby = this.standbyPromise;
    if (!this.running && !this.runtimeId && !activeStart && !activeStandby && !this.ownership) {
      const terminalError = this.terminalError;
      this.terminalError = null;
      if (terminalError) throw terminalError;
      return;
    }
    this.running = false;
    const shutdownSignal = AbortSignal.timeout(this.shutdownTimeoutMs);
    this.runController?.abort(new DOMException('Multica adapter stopped', 'AbortError'));
    const terminalErrorBeforeLoops = this.terminalError;
    let stopError = terminalErrorBeforeLoops;
    for (const startup of [activeStart, activeStandby]) {
      if (!startup) continue;
      try {
        await startup;
      } catch (error) {
        if (isAbortError(error)) continue;
        stopError = stopError
          ? combineErrors('Multica startup and stop failed', [stopError, error])
          : asError(error);
      }
    }
    this.running = false;
    await Promise.all([
      this.pollLoopPromise,
      this.heartbeatLoopPromise,
      this.ownershipWatchPromise,
    ]);
    const terminalErrorAfterLoops = this.terminalError;
    if (
      terminalErrorAfterLoops
      && terminalErrorAfterLoops !== terminalErrorBeforeLoops
      && terminalErrorAfterLoops !== stopError
    ) {
      stopError = stopError
        ? combineErrors('Multica stop observed multiple terminal failures', [stopError, terminalErrorAfterLoops])
        : terminalErrorAfterLoops;
    }
    this.pollLoopPromise = null;
    this.heartbeatLoopPromise = null;
    const ownership = this.ownership;
    if (ownership) {
      try {
        if (ownership.lost.aborted) await this.abandonLostOwnership(ownership, ownership.lost.reason);
        else await this.cleanupOwnedRuntime(ownership, shutdownSignal);
      } catch (error) {
        stopError = stopError
          ? combineErrors('Multica terminal failure and deregistration failed', [stopError, error])
          : asError(error);
        try {
          await this.alertOperator(
            'deregistration',
            'Multica channel failed to deregister',
            error,
            undefined,
            shutdownSignal,
          );
        } catch (alertError) {
          this.log.error('Multica deregistration operator alert failed', {
            error: toErrorMessage(alertError),
          });
          stopError = combineErrors('Multica stop and operator alert failed', [stopError, alertError]);
        }
      }
    }
    this.runController = null;
    this.terminalError = null;
    if (stopError) throw stopError;
  }

  private async runPollLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (this.running && !signal.aborted) {
      try {
        await this.claimAndHandleOne(signal);
        failures = 0;
      } catch (error) {
        if (isAbortError(error)) break;
        failures += 1;
        this.log.error('Multica task polling failed', {
          attempt: failures, maxAttempts: MULTICA_MAX_OPERATION_ATTEMPTS, error: toErrorMessage(error),
        });
        if (failures >= MULTICA_MAX_OPERATION_ATTEMPTS) {
          await this.failRuntime('polling', error);
          return;
        }
      }
      await waitForNextPoll(this.multica.pollIntervalMs, signal);
    }
  }

  private async runHeartbeatLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (this.running && !signal.aborted) {
      const runtimeId = this.runtimeId;
      if (!runtimeId) return;
      try {
        await this.http.postJson('/api/daemon/heartbeat', { runtime_id: runtimeId }, this.multica.token, signal);
        failures = 0;
      } catch (error) {
        if (isAbortError(error)) break;
        failures += 1;
        this.log.warn('Multica runtime heartbeat failed', {
          attempt: failures, maxAttempts: MULTICA_MAX_OPERATION_ATTEMPTS, error: toErrorMessage(error),
        });
        if (failures >= MULTICA_MAX_OPERATION_ATTEMPTS) {
          await this.failRuntime('heartbeat', error);
          return;
        }
      }
      await waitForNextPoll(this.heartbeatIntervalMs, signal);
    }
  }

  private async claimAndHandleOne(signal: AbortSignal): Promise<void> {
    const runtimeId = this.runtimeId;
    const handler = this.handler;
    if (!runtimeId || !handler) return;
    const task = parseClaimResponse(await this.http.postJson(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/tasks/claim`, {}, this.multica.token, signal,
    ));
    if (!task) return;
    try {
      this.assertTaskBoundary(task, runtimeId);
      const issue = task.issue_id ? await this.getIssue(task.issue_id, task.auth_token, signal) : null;
      if (issue) this.assertIssueBoundary(task, issue);
      await this.startClaimedTask(task.id, signal);
      const taskController = new AbortController();
      const watcherController = new AbortController();
      const taskSignal = AbortSignal.any([signal, taskController.signal]);
      const watcherSignal = AbortSignal.any([signal, watcherController.signal]);
      const watcher = this.watchTaskCancellation(task.id, taskController, watcherSignal);
      try {
        let response: Awaited<ReturnType<MessageHandler>>;
        try {
          response = await handler(
            await toMulticaSubstrateMessage(task, issue, this.intakeScreening),
            { signal: taskSignal } satisfies MessageHandlerOptions,
          );
        } catch (error) {
          if (!taskController.signal.aborted) throw error;
          const reason = taskController.signal.reason;
          if (reason instanceof MulticaTaskInterruptedError) return;
          throw reason;
        }
        if (taskController.signal.aborted) {
          const reason = taskController.signal.reason;
          if (reason instanceof MulticaTaskInterruptedError) return;
          throw reason;
        }
        const finalStatus = await this.getTaskStatus(task.id, signal);
        if (isTerminalTaskStatus(finalStatus)) return;
        try {
          await this.withAttempts(`Multica task ${task.id} completion`, async attemptSignal => await this.http.postJson(
            `/api/daemon/tasks/${encodeURIComponent(task.id)}/complete`,
            { output: response.content }, this.multica.token, attemptSignal,
          ), taskSignal);
        } catch (error) {
          if (
            signalWasAborted(taskController.signal)
            && taskController.signal.reason instanceof MulticaTaskInterruptedError
          ) return;
          if (signalWasAborted(signal)) return;
          let completionError = error;
          try {
            const status = await this.getTaskStatus(task.id, signal);
            if (isTerminalTaskStatus(status)) return;
          } catch (statusError) {
            if (statusError instanceof MulticaTaskInterruptedError || isAbortError(statusError)) return;
            completionError = combineErrors(
              `Multica task ${task.id} completion and status reconciliation failed`,
              [completionError, statusError],
            );
          }
          if (
            signalWasAborted(taskController.signal)
            && taskController.signal.reason instanceof MulticaTaskInterruptedError
          ) return;
          if (!signalWasAborted(signal)) {
            await this.failRuntime('completion-settlement', completionError, task.id);
          }
        }
      } finally {
        watcherController.abort(new DOMException('Multica task watcher stopped', 'AbortError'));
        await watcher;
      }
    } catch (error) {
      if (signalWasAborted(signal)) return;
      if (error instanceof MulticaTaskInterruptedError) return;
      if (error instanceof MulticaTaskStartReconciliationError) {
        await this.failRuntime('start-reconciliation', error, task.id);
        return;
      }
      const message = toErrorMessage(error);
      this.log.error('Multica task handling failed', { taskId: task.id, error: message });
      if (error instanceof MulticaWorkspaceBoundaryError) {
        await this.failRuntime('workspace-boundary', error, task.id);
        return;
      }
      try {
        await this.withAttempts(
          `Multica task ${task.id} failure settlement`,
          async attemptSignal => await this.http.postJson(
            `/api/daemon/tasks/${encodeURIComponent(task.id)}/fail`,
            { error: message, failure_reason: 'psfn_gateway_companion_error' },
            this.multica.token,
            attemptSignal,
          ),
          signal,
        );
      } catch (reportError) {
        if (isAbortError(reportError)) return;
        await this.failRuntime('failure-settlement', reportError, task.id);
      }
    }
  }

  private async startClaimedTask(taskId: string, signal: AbortSignal): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MULTICA_MAX_OPERATION_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      try {
        await this.http.postJson(
          `/api/daemon/tasks/${encodeURIComponent(taskId)}/start`,
          {},
          this.multica.token,
          signal,
        );
        return;
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error;
        lastError = error;
        const status = await this.reconcileClaimedTaskStart(taskId, signal);
        if (status === 'running') return;
        if (isTerminalTaskStatus(status)) {
          throw new MulticaTaskInterruptedError(
            `Multica task ${taskId} reached ${status} before companion execution`,
          );
        }
        if (status !== 'dispatched' && status !== 'waiting_local_directory') throw error;
        if (attempt < MULTICA_MAX_OPERATION_ATTEMPTS) {
          this.log.warn(`Multica task ${taskId} start was not committed; retrying`, {
            attempt,
            maxAttempts: MULTICA_MAX_OPERATION_ATTEMPTS,
            error: toErrorMessage(error),
          });
        }
      }
    }
    throw new Error(
      `Multica task ${taskId} start failed after ${MULTICA_MAX_OPERATION_ATTEMPTS} reconciled attempts: ${toErrorMessage(lastError)}`,
    );
  }

  private async reconcileClaimedTaskStart(taskId: string, signal: AbortSignal): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MULTICA_MAX_OPERATION_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await this.getTaskStatus(taskId, signal);
      } catch (error) {
        if (
          isAbortError(error)
          || signal.aborted
          || error instanceof MulticaTaskInterruptedError
        ) throw error;
        lastError = error;
        if (attempt < MULTICA_MAX_OPERATION_ATTEMPTS) {
          this.log.warn(`Multica task ${taskId} start status reconciliation failed; retrying`, {
            attempt,
            maxAttempts: MULTICA_MAX_OPERATION_ATTEMPTS,
            error: toErrorMessage(error),
          });
        }
      }
    }
    throw new MulticaTaskStartReconciliationError(
      `Multica task ${taskId} could not reconcile an ambiguous start after ${MULTICA_MAX_OPERATION_ATTEMPTS} attempts: ${toErrorMessage(lastError)}`,
    );
  }

  private async getTaskStatus(taskId: string, signal: AbortSignal): Promise<string> {
    try {
      return parseTaskStatusResponse(await this.http.requestJson(
        `/api/daemon/tasks/${encodeURIComponent(taskId)}/status`,
        { method: 'GET' },
        this.multica.token,
        signal,
      ));
    } catch (error) {
      if (error instanceof MulticaHttpError && error.status === 404) {
        throw new MulticaTaskInterruptedError(`Multica task ${taskId} no longer exists`);
      }
      throw error;
    }
  }

  private async watchTaskCancellation(
    taskId: string,
    taskController: AbortController,
    signal: AbortSignal,
  ): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      await waitForNextPoll(this.multica.pollIntervalMs, signal);
      if (signalWasAborted(signal)) return;
      try {
        const status = await this.getTaskStatus(taskId, signal);
        failures = 0;
        if (isTerminalTaskStatus(status)) {
          taskController.abort(new MulticaTaskInterruptedError(
            `Multica task ${taskId} reached ${status} during companion execution`,
          ));
          return;
        }
      } catch (error) {
        if (isAbortError(error) || signalWasAborted(signal)) return;
        if (error instanceof MulticaTaskInterruptedError) {
          taskController.abort(error);
          return;
        }
        failures += 1;
        this.log.warn('Multica task status check failed', {
          taskId,
          attempt: failures,
          maxAttempts: MULTICA_MAX_OPERATION_ATTEMPTS,
          error: toErrorMessage(error),
        });
        if (failures >= MULTICA_MAX_OPERATION_ATTEMPTS) {
          taskController.abort(new Error(
            `Multica task ${taskId} status checks failed after ${MULTICA_MAX_OPERATION_ATTEMPTS} attempts: ${toErrorMessage(error)}`,
          ));
          return;
        }
      }
    }
  }

  private assertTaskBoundary(task: MulticaClaimedTask, runtimeId: string): void {
    if (task.runtime_id !== runtimeId) {
      throw new MulticaWorkspaceBoundaryError(
        `Multica claimed task ${task.id} for runtime ${task.runtime_id}, expected ${runtimeId}`,
      );
    }
    if (task.workspace_id !== this.multica.workspaceId) {
      throw new MulticaWorkspaceBoundaryError(
        `Multica claimed task ${task.id} for workspace ${task.workspace_id}, expected ${this.multica.workspaceId}`,
      );
    }
  }

  private assertIssueBoundary(task: MulticaClaimedTask, issue: MulticaIssue): void {
    if (issue.id !== task.issue_id) {
      throw new MulticaWorkspaceBoundaryError(
        `Multica task ${task.id} requested issue ${task.issue_id}, received ${issue.id}`,
      );
    }
    if (issue.workspace_id !== this.multica.workspaceId) {
      throw new MulticaWorkspaceBoundaryError(
        `Multica issue ${issue.id} belongs to workspace ${issue.workspace_id}, expected ${this.multica.workspaceId}`,
      );
    }
  }

  private async getIssue(issueId: string, taskToken: string | undefined, signal: AbortSignal): Promise<MulticaIssue> {
    const token = taskToken?.trim();
    if (!token) throw new Error(`Multica task for issue ${issueId} did not include a task-scoped credential`);
    return parseIssueResponse(await this.http.requestJson(
      `/api/issues/${encodeURIComponent(issueId)}`, { method: 'GET' }, token, signal,
    ));
  }

  private async withAttempts<T>(
    operation: string,
    action: (attemptSignal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MULTICA_MAX_OPERATION_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      try {
        return await withMulticaOperationTimeout(action, this.requestTimeoutMs, signal);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        lastError = error;
        if (attempt < MULTICA_MAX_OPERATION_ATTEMPTS) {
          this.log.warn(`${operation} failed; retrying`, {
            attempt, maxAttempts: MULTICA_MAX_OPERATION_ATTEMPTS, error: toErrorMessage(error),
          });
        }
      }
    }
    throw new Error(`${operation} failed after ${MULTICA_MAX_OPERATION_ATTEMPTS} attempts: ${toErrorMessage(lastError)}`);
  }

  private async failRuntime(kind: string, error: unknown, taskId?: string): Promise<void> {
    this.terminalFailurePromise ??= this.terminateRuntime(kind, error, taskId);
    await this.terminalFailurePromise;
  }

  private async terminateRuntime(kind: string, error: unknown, taskId?: string): Promise<void> {
    this.running = false;
    this.runController?.abort();
    const shutdownSignal = AbortSignal.timeout(this.shutdownTimeoutMs);
    this.log.error('Multica channel runtime stopped after bounded failures', {
      kind, ...(taskId ? { taskId } : {}), error: toErrorMessage(error),
    });
    let terminalError = asError(error);
    try {
      await this.alertOperator(kind, 'Multica channel stopped', terminalError, taskId, shutdownSignal);
    } catch (alertError) {
      this.log.error('Multica terminal operator alert failed', {
        kind, error: toErrorMessage(alertError),
      });
      terminalError = combineErrors('Multica runtime and operator alert failed', [terminalError, alertError]);
    }
    const ownership = this.ownership;
    if (!ownership) {
      this.terminalError = terminalError;
      return;
    }
    try {
      if (ownership.lost.aborted) await this.abandonLostOwnership(ownership, ownership.lost.reason);
      else await this.cleanupOwnedRuntime(ownership, shutdownSignal);
    } catch (deregisterError) {
      this.log.error('Multica runtime deregistration failed after channel stop', {
        runtimeId: this.runtimeId, error: toErrorMessage(deregisterError),
      });
      terminalError = combineErrors('Multica runtime and deregistration failed', [
        terminalError,
        deregisterError,
      ]);
      try {
        await this.alertOperator(
          'deregistration',
          'Multica runtime could not deregister',
          deregisterError,
          undefined,
          shutdownSignal,
        );
      } catch (alertError) {
        this.log.error('Multica deregistration operator alert failed', {
          error: toErrorMessage(alertError),
        });
        terminalError = combineErrors('Multica runtime alerts failed', [terminalError, alertError]);
      }
    }
    this.terminalError = terminalError;
  }

  private async cleanupOwnedRuntime(
    ownership: MulticaRuntimeLeaseHandle,
    cleanupSignal = AbortSignal.timeout(this.shutdownTimeoutMs),
  ): Promise<void> {
    if (this.ownership !== ownership) return;
    const runtimeId = this.runtimeId;
    let cleanupError: unknown;
    try {
      if (runtimeId && !ownership.lost.aborted) {
        await this.deregisterRuntime(
          runtimeId,
          AbortSignal.any([ownership.lost, cleanupSignal]),
        );
      }
    } catch (error) {
      cleanupError = error;
    }
    if (this.ownership === ownership) this.ownership = null;
    if (ownership.lost.aborted && this.runtimeId === runtimeId) this.runtimeId = null;
    try {
      await ownership.release({ signal: cleanupSignal });
    } catch (error) {
      cleanupError = cleanupError
        ? combineErrors('Multica deregistration and ownership release failed', [cleanupError, error])
        : error;
    }
    if (cleanupError) throw cleanupError;
  }

  private async abandonLostOwnership(
    ownership: MulticaRuntimeLeaseHandle,
    reason: unknown,
  ): Promise<void> {
    if (this.ownership !== ownership) return;
    this.running = false;
    this.ownership = null;
    this.runtimeId = null;
    try {
      await ownership.release();
    } catch (error) {
      this.log.error('Multica lost ownership cleanup failed', { error: toErrorMessage(error) });
    }
    const ownershipError = new Error(`Multica runtime ownership was lost: ${toErrorMessage(reason)}`);
    try {
      await this.alertOperator('ownership', 'Multica channel lost runtime ownership', ownershipError);
    } catch (alertError) {
      this.log.error('Multica ownership-loss operator alert failed', { error: toErrorMessage(alertError) });
      this.terminalError = combineErrors('Multica ownership loss and operator alert failed', [
        ownershipError,
        alertError,
      ]);
      return;
    }
    this.terminalError = ownershipError;
  }

  private async watchOwnership(
    ownership: MulticaRuntimeLeaseHandle,
    controller: AbortController,
  ): Promise<void> {
    const signal = AbortSignal.any([ownership.lost, controller.signal]);
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    if (ownership.lost.aborted) {
      await this.abandonLostOwnership(ownership, ownership.lost.reason);
    }
  }

  private async deregisterRuntime(runtimeId: string, signal?: AbortSignal): Promise<void> {
    await this.withAttempts(
      `Multica runtime ${runtimeId} deregistration`,
      async attemptSignal => await this.http.postJson(
        '/api/daemon/deregister',
        { runtime_ids: [runtimeId] },
        this.multica.token,
        attemptSignal,
      ),
      signal,
    );
    if (this.runtimeId === runtimeId) this.runtimeId = null;
  }

  private async alertOperator(
    kind: string,
    title: string,
    error: unknown,
    taskId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const handler = this.operatorAlertHandler;
    if (!handler) {
      throw new Error(`Multica operator alert handler is unavailable for ${kind}`);
    }
    const disposition = kind === 'workspace-boundary'
      ? 'The crossed work item was rejected before companion ingress.'
      : `The channel stopped after ${MULTICA_MAX_OPERATION_ATTEMPTS} attempts and will not claim more work.`;
    await this.withAttempts(`Multica ${kind} operator alert`, async () => await handler({
      title,
      message: [
        `Multica gateway channel failure (${kind})${taskId ? ` for task ${taskId}` : ''}.`,
        toErrorMessage(error),
        disposition,
      ].join('\n'),
      idempotencyKey: `multica-channel:${this.multica.workspaceId}:${kind}${taskId ? `:${taskId}` : ''}`,
    }), signal);
  }

}
