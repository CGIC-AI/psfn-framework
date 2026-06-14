import type {
  ObserverEvalInput,
  ObserverEvalInputPayload,
  ObserverEvalLifecycleState,
  ObserverEvalLifecycleStatePayload,
  ObserverEvalReadonly,
  ObserverEvalSidecarDropReason,
  ObserverEvalSidecarFailureReason,
  ObserverEvalSidecarHealthSnapshot,
  ObserverEvalSidecarHealthSnapshotPayload,
  ObserverEvalSidecarLogger,
  ObserverEvalSidecarOverflowPolicy,
  ObserverEvalSidecarQueueConfig,
  ObserverEvalSidecarRuntime,
  ObserverEvalSidecarShutdownOptions,
} from './types.js';

const DEFAULT_MAX_QUEUED_TURNS = 32;
const DEFAULT_OBSERVER_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_RETRY_DELAY_MS = 0;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_OVERFLOW_POLICY: ObserverEvalSidecarOverflowPolicy = 'drop_newest';

interface ObserverEvalQueueOptions {
  maxQueuedTurns: number;
  observerTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  shutdownDrainTimeoutMs: number;
  overflowPolicy: ObserverEvalSidecarOverflowPolicy;
}

interface ObserverEvalQueueTask {
  input: ObserverEvalInput;
  turnId: ObserverEvalInputPayload['turn']['turnId'];
  requestId: string;
  channelId: string;
}

interface ObserverEvalSidecarQueueStats {
  accepted: number;
  completed: number;
  dropped: number;
  failed: number;
  timedOut: number;
  retried: number;
  lifecycleHookFailed: number;
  shutdownTimedOut: number;
  dropCounts: Partial<Record<ObserverEvalSidecarDropReason, number>>;
  failureCounts: Partial<Record<ObserverEvalSidecarFailureReason, number>>;
  lastDrop?: ObserverEvalSidecarHealthSnapshotPayload['lastDrop'];
  lastFailure?: ObserverEvalSidecarHealthSnapshotPayload['lastFailure'];
  lastLifecycleState?: ObserverEvalLifecycleState;
}

interface ObserverEvalAttemptSuccess {
  ok: true;
}

interface ObserverEvalAttemptFailure {
  ok: false;
  reason: ObserverEvalSidecarFailureReason;
  message: string;
}

type ObserverEvalAttemptResult = ObserverEvalAttemptSuccess | ObserverEvalAttemptFailure;

export function createObserverEvalInput(input: ObserverEvalInputPayload): ObserverEvalInput {
  return deepFreeze(structuredClone(input));
}

export class ObserverEvalSidecarQueue {
  private readonly options: ObserverEvalQueueOptions;
  private readonly stats: ObserverEvalSidecarQueueStats = {
    accepted: 0,
    completed: 0,
    dropped: 0,
    failed: 0,
    timedOut: 0,
    retried: 0,
    lifecycleHookFailed: 0,
    shutdownTimedOut: 0,
    dropCounts: {},
    failureCounts: {},
  };

  private readonly tasks: ObserverEvalQueueTask[] = [];
  private accepting = true;
  private shuttingDown = false;
  private processing = false;
  private runningTask: ObserverEvalQueueTask | null = null;
  private scheduledDrain: ReturnType<typeof setTimeout> | null = null;
  private readonly idleWaiters: Array<() => void> = [];
  private logger?: ObserverEvalSidecarLogger;

  constructor(
    private readonly runtime: ObserverEvalSidecarRuntime,
    logger: ObserverEvalSidecarLogger | undefined,
  ) {
    this.logger = logger;
    this.options = normalizeQueueOptions(runtime.config?.queue);
  }

  updateLogger(logger: ObserverEvalSidecarLogger | undefined): void {
    this.logger = logger;
  }

  enqueue(inputPayload: ObserverEvalInputPayload): ObserverEvalLifecycleState {
    if (!this.accepting) {
      return this.recordDrop(inputPayload, 'shutting_down');
    }

    if (!this.hasCapacityForNewTask()) {
      return this.recordDrop(inputPayload, 'queue_full');
    }

    const task: ObserverEvalQueueTask = {
      input: createObserverEvalInput(inputPayload),
      turnId: inputPayload.turn.turnId,
      requestId: inputPayload.turn.requestId,
      channelId: inputPayload.turn.channelId,
    };
    this.tasks.push(task);
    this.stats.accepted += 1;

    const state = this.emitLifecycle({
      status: 'enabled',
      observedAt: Date.now(),
      ...this.sidecarIdPayload(),
      reason: 'queued',
      queue: this.lifecycleQueueSnapshot(),
    });
    this.scheduleDrain();
    return state;
  }

  async drainNow(): Promise<void> {
    this.clearScheduledDrain();
    await this.drain();
  }

  async shutdown(options: ObserverEvalSidecarShutdownOptions): Promise<ObserverEvalSidecarHealthSnapshot> {
    this.accepting = false;
    this.shuttingDown = true;
    this.clearScheduledDrain();

    if (options.drain === false) {
      this.recordPendingDrops('shutting_down');
      this.resolveIdleIfNeeded();
      return this.getHealthSnapshot();
    }

    const timeoutMs = normalizeNonNegativeInteger(options.timeoutMs, this.options.shutdownDrainTimeoutMs);
    const drainPromise = this.drain();
    if (this.isIdle()) {
      await drainPromise;
      return this.getHealthSnapshot();
    }

    const shutdownResult = await raceShutdownDrain(drainPromise, timeoutMs);
    if (shutdownResult === 'timeout') {
      this.stats.shutdownTimedOut += 1;
      this.recordPendingDrops('shutdown_timeout');
      this.emitLifecycle({
        status: 'degraded',
        observedAt: Date.now(),
        ...this.sidecarIdPayload(),
        reason: 'shutdown_timeout',
        queue: this.lifecycleQueueSnapshot(),
      });
    }

    return this.getHealthSnapshot();
  }

  getHealthSnapshot(): ObserverEvalSidecarHealthSnapshot {
    return createHealthSnapshot({
      status: this.currentStatus(),
      observedAt: Date.now(),
      ...this.sidecarIdPayload(),
      enabled: this.runtime.config?.enabled === true,
      available: Boolean(this.runtime.observer),
      accepting: this.accepting,
      queue: {
        queuedCount: this.tasks.length,
        runningCount: this.runningTask ? 1 : 0,
        maxQueuedTurns: this.options.maxQueuedTurns,
        overflowPolicy: this.options.overflowPolicy,
        shuttingDown: this.shuttingDown,
      },
      counts: {
        accepted: this.stats.accepted,
        completed: this.stats.completed,
        dropped: this.stats.dropped,
        failed: this.stats.failed,
        timedOut: this.stats.timedOut,
        retried: this.stats.retried,
        lifecycleHookFailed: this.stats.lifecycleHookFailed,
        shutdownTimedOut: this.stats.shutdownTimedOut,
      },
      dropCounts: { ...this.stats.dropCounts },
      failureCounts: { ...this.stats.failureCounts },
      ...(this.stats.lastDrop ? { lastDrop: { ...this.stats.lastDrop } } : {}),
      ...(this.stats.lastFailure ? { lastFailure: { ...this.stats.lastFailure } } : {}),
      ...(this.stats.lastLifecycleState ? { lastLifecycleState: this.stats.lastLifecycleState } : {}),
    });
  }

  recordLifecycleHookFailure(): void {
    this.stats.lifecycleHookFailed += 1;
  }

  recordLifecycleState(state: ObserverEvalLifecycleState): void {
    this.stats.lastLifecycleState = state;
  }

  private hasCapacityForNewTask(): boolean {
    if (this.tasks.length < this.options.maxQueuedTurns) {
      return true;
    }
    return this.options.maxQueuedTurns === 0
      && this.tasks.length === 0
      && this.runningTask === null;
  }

  private scheduleDrain(): void {
    if (this.scheduledDrain) {
      return;
    }

    this.scheduledDrain = setTimeout(() => {
      this.scheduledDrain = null;
      void this.drain();
    }, 0);
  }

  private clearScheduledDrain(): void {
    if (!this.scheduledDrain) {
      return;
    }

    clearTimeout(this.scheduledDrain);
    this.scheduledDrain = null;
  }

  private async drain(): Promise<void> {
    if (this.processing) {
      await this.waitForIdle();
      return;
    }

    this.processing = true;
    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift();
        if (!task) {
          continue;
        }

        this.runningTask = task;
        await this.executeTask(task);
        this.runningTask = null;
      }
    } finally {
      this.processing = false;
      this.runningTask = null;
      this.resolveIdleIfNeeded();
    }
  }

  private async executeTask(task: ObserverEvalQueueTask): Promise<void> {
    let attempt = 0;
    for (;;) {
      const result = await this.runAttempt(task);
      if (result.ok) {
        this.stats.completed += 1;
        return;
      }

      if (attempt < this.options.maxRetries) {
        this.stats.retried += 1;
        this.logger?.debug('Observer eval sidecar retrying observation', {
          sidecarId: this.runtime.config?.sidecarId ?? null,
          turnId: task.turnId,
          requestId: task.requestId,
          channelId: task.channelId,
          reason: result.reason,
          attempt,
        });
        await delay(this.options.retryDelayMs);
        attempt += 1;
        continue;
      }

      this.recordFailure(task, result, attempt);
      return;
    }
  }

  private async runAttempt(task: ObserverEvalQueueTask): Promise<ObserverEvalAttemptResult> {
    const observer = this.runtime.observer;
    if (!observer) {
      return {
        ok: false,
        reason: 'observer_unavailable',
        message: 'observer_not_configured',
      };
    }

    try {
      const work = Promise.resolve().then(() => observer.observeTurn(task.input));
      await withTimeout(work, this.options.observerTimeoutMs);
      return { ok: true };
    } catch (error) {
      if (error instanceof ObserverEvalTimeoutError) {
        return {
          ok: false,
          reason: 'observer_timeout',
          message: error.message,
        };
      }
      return {
        ok: false,
        reason: 'observer_failed',
        message: toErrorMessage(error),
      };
    }
  }

  private recordDrop(
    inputPayload: ObserverEvalInputPayload,
    reason: ObserverEvalSidecarDropReason,
  ): ObserverEvalLifecycleState {
    this.stats.dropped += 1;
    this.incrementDropCount(reason);
    this.stats.lastDrop = {
      reason,
      turnId: inputPayload.turn.turnId,
      requestId: inputPayload.turn.requestId,
      observedAt: Date.now(),
    };
    this.logger?.debug('Observer eval sidecar observation dropped', {
      sidecarId: this.runtime.config?.sidecarId ?? null,
      turnId: inputPayload.turn.turnId,
      requestId: inputPayload.turn.requestId,
      channelId: inputPayload.turn.channelId,
      reason,
    });
    return this.emitLifecycle({
      status: 'degraded',
      observedAt: Date.now(),
      ...this.sidecarIdPayload(),
      reason,
      queue: this.lifecycleQueueSnapshot(),
      drop: {
        reason,
        droppedCount: this.stats.dropped,
      },
    });
  }

  private recordPendingDrops(reason: ObserverEvalSidecarDropReason): void {
    while (this.tasks.length > 0) {
      const task = this.tasks.shift();
      if (!task) {
        continue;
      }
      this.stats.dropped += 1;
      this.incrementDropCount(reason);
      this.stats.lastDrop = {
        reason,
        turnId: task.turnId,
        requestId: task.requestId,
        observedAt: Date.now(),
      };
    }
  }

  private recordFailure(
    task: ObserverEvalQueueTask,
    result: ObserverEvalAttemptFailure,
    attempt: number,
  ): void {
    if (result.reason === 'observer_timeout') {
      this.stats.timedOut += 1;
    } else {
      this.stats.failed += 1;
    }
    this.incrementFailureCount(result.reason);
    this.stats.lastFailure = {
      reason: result.reason,
      turnId: task.turnId,
      requestId: task.requestId,
      message: result.message,
      attempt,
      observedAt: Date.now(),
    };
    this.logger?.debug('Observer eval sidecar degraded', {
      sidecarId: this.runtime.config?.sidecarId ?? null,
      turnId: task.turnId,
      requestId: task.requestId,
      channelId: task.channelId,
      reason: result.reason,
      error: result.message,
    });
    this.emitLifecycle({
      status: 'degraded',
      observedAt: Date.now(),
      ...this.sidecarIdPayload(),
      reason: result.reason,
      error: { message: result.message },
      queue: this.lifecycleQueueSnapshot(),
    });
  }

  private emitLifecycle(state: ObserverEvalLifecycleStatePayload): ObserverEvalLifecycleState {
    return notifyObserverEvalLifecycle(
      this.runtime,
      state,
      this.logger,
      () => this.recordLifecycleHookFailure(),
      lifecycleState => this.recordLifecycleState(lifecycleState),
    );
  }

  private lifecycleQueueSnapshot(): NonNullable<ObserverEvalLifecycleStatePayload['queue']> {
    return {
      acceptedCount: this.stats.accepted,
      queuedCount: this.tasks.length,
      runningCount: this.runningTask ? 1 : 0,
      maxQueuedTurns: this.options.maxQueuedTurns,
    };
  }

  private sidecarIdPayload(): Pick<ObserverEvalLifecycleStatePayload, 'sidecarId'> {
    const sidecarId = this.runtime.config?.sidecarId;
    return sidecarId ? { sidecarId } : {};
  }

  private currentStatus(): ObserverEvalLifecycleStatePayload['status'] {
    if (this.runtime.config?.enabled !== true) {
      return 'disabled';
    }
    if (
      this.stats.dropped > 0
      || this.stats.failed > 0
      || this.stats.timedOut > 0
      || this.stats.shutdownTimedOut > 0
    ) {
      return 'degraded';
    }
    if (!this.runtime.observer || this.shuttingDown) {
      return 'unavailable';
    }
    return 'enabled';
  }

  private isIdle(): boolean {
    return this.tasks.length === 0 && this.runningTask === null && !this.processing;
  }

  private waitForIdle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.idleWaiters.push(resolve);
    });
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdle()) {
      return;
    }
    while (this.idleWaiters.length > 0) {
      const resolve = this.idleWaiters.shift();
      resolve?.();
    }
  }

  private incrementDropCount(reason: ObserverEvalSidecarDropReason): void {
    this.stats.dropCounts[reason] = (this.stats.dropCounts[reason] ?? 0) + 1;
  }

  private incrementFailureCount(reason: ObserverEvalSidecarFailureReason): void {
    this.stats.failureCounts[reason] = (this.stats.failureCounts[reason] ?? 0) + 1;
  }
}

export function createStaticHealthSnapshot(
  runtime: ObserverEvalSidecarRuntime | null,
): ObserverEvalSidecarHealthSnapshot {
  const enabled = runtime?.config?.enabled === true;
  const available = Boolean(runtime?.observer);
  const queueOptions = normalizeQueueOptions(runtime?.config?.queue);
  const status: ObserverEvalLifecycleStatePayload['status'] = !enabled
    ? 'disabled'
    : available
      ? 'enabled'
      : 'unavailable';

  return createHealthSnapshot({
    status,
    observedAt: Date.now(),
    ...(runtime?.config?.sidecarId ? { sidecarId: runtime.config.sidecarId } : {}),
    enabled,
    available,
    accepting: enabled && available,
    queue: {
      queuedCount: 0,
      runningCount: 0,
      maxQueuedTurns: queueOptions.maxQueuedTurns,
      overflowPolicy: queueOptions.overflowPolicy,
      shuttingDown: false,
    },
    counts: {
      accepted: 0,
      completed: 0,
      dropped: 0,
      failed: 0,
      timedOut: 0,
      retried: 0,
      lifecycleHookFailed: 0,
      shutdownTimedOut: 0,
    },
    dropCounts: {},
    failureCounts: {},
  });
}

export function notifyObserverEvalLifecycle(
  sidecarRuntime: ObserverEvalSidecarRuntime | null | undefined,
  state: ObserverEvalLifecycleStatePayload,
  logger: ObserverEvalSidecarLogger | undefined,
  onHookFailure?: () => void,
  onLifecycleState?: (state: ObserverEvalLifecycleState) => void,
): ObserverEvalLifecycleState {
  const readonlyState = deepFreeze(structuredClone(state));
  onLifecycleState?.(readonlyState);

  try {
    const hookResult = sidecarRuntime?.onLifecycleState?.(readonlyState);
    if (hookResult && typeof hookResult === 'object' && 'catch' in hookResult) {
      void hookResult.catch((error: unknown) => {
        onHookFailure?.();
        logger?.debug('Observer eval sidecar lifecycle hook failed', {
          status: state.status,
          sidecarId: state.sidecarId ?? null,
          error: toErrorMessage(error),
        });
      });
    }
  } catch (error) {
    onHookFailure?.();
    logger?.debug('Observer eval sidecar lifecycle hook failed', {
      status: state.status,
      sidecarId: state.sidecarId ?? null,
      error: toErrorMessage(error),
    });
  }

  return readonlyState;
}

function normalizeQueueOptions(config: ObserverEvalSidecarQueueConfig | undefined): ObserverEvalQueueOptions {
  return {
    maxQueuedTurns: normalizeNonNegativeInteger(config?.maxQueuedTurns, DEFAULT_MAX_QUEUED_TURNS),
    observerTimeoutMs: normalizeNonNegativeInteger(config?.observerTimeoutMs, DEFAULT_OBSERVER_TIMEOUT_MS),
    maxRetries: normalizeNonNegativeInteger(config?.maxRetries, DEFAULT_MAX_RETRIES),
    retryDelayMs: normalizeNonNegativeInteger(config?.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
    shutdownDrainTimeoutMs: normalizeNonNegativeInteger(
      config?.shutdownDrainTimeoutMs,
      DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
    ),
    overflowPolicy: config?.overflowPolicy ?? DEFAULT_OVERFLOW_POLICY,
  };
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  work.catch(() => undefined);

  if (timeoutMs <= 0) {
    const timeout = Promise.resolve().then(() => {
      throw new ObserverEvalTimeoutError(timeoutMs);
    });
    return Promise.race([work, timeout]);
  }

  let rejectTimeout!: (reason?: unknown) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeoutHandle = setTimeout(() => {
    rejectTimeout(new ObserverEvalTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function delay(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise(resolve => {
    setTimeout(resolve, delayMs);
  });
}

async function raceShutdownDrain(
  drainPromise: Promise<void>,
  timeoutMs: number,
): Promise<'drained' | 'timeout'> {
  if (timeoutMs <= 0) {
    return 'timeout';
  }

  let resolveTimeout!: (value: 'timeout') => void;
  const timeoutPromise = new Promise<'timeout'>(resolve => {
    resolveTimeout = resolve;
  });
  const timeoutHandle = setTimeout(() => {
    resolveTimeout('timeout');
  }, timeoutMs);

  const result = await Promise.race([
    drainPromise.then((): 'drained' => 'drained'),
    timeoutPromise,
  ]);

  clearTimeout(timeoutHandle);
  return result;
}

function createHealthSnapshot(
  snapshot: ObserverEvalSidecarHealthSnapshotPayload,
): ObserverEvalSidecarHealthSnapshot {
  return deepFreeze(structuredClone(snapshot));
}

function deepFreeze<T>(value: T): ObserverEvalReadonly<T> {
  if (value === null || typeof value !== 'object') {
    return value as ObserverEvalReadonly<T>;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }

  return Object.freeze(value) as ObserverEvalReadonly<T>;
}

class ObserverEvalTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`observer timed out after ${timeoutMs}ms`);
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
