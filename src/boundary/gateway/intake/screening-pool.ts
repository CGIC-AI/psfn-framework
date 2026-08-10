// ── Bounded asynchronous screening pool (psfn-framework-yxz0z.4) ──
//
// A generic, allocation-light bounded concurrency pool that drives the CogSec
// intake screening service. It is intentionally NOT coupled to screening
// internals: it schedules caller-supplied async `work` callbacks behind three
// invariants the bead requires, and a thin adapter
// (`createPooledIntakeScreeningService`) turns pool outcomes into screening
// results elsewhere in this package.
//
// INVARIANTS
// 1. Bounded overlap. At most `concurrency` works run at once. Independent
//    streams overlap up to that bound; there is no unbounded Promise.all
//    fanout anywhere — admission, ordering, and dispatch are driven by a single
//    synchronous scheduler tick over plain arrays.
// 2. Same-stream determinism. Items keyed by the same `streamKey` (one
//    companion's inbound message stream) START and FINISH strictly in
//    submission order. A later item in a stream never begins screening until
//    the earlier item's work has settled, so decisions and delivery stay
//    deterministic within a source stream.
// 3. Fair, non-starving dispatch. Each stream holds at most one running slot,
//    so the FIFO ready queue round-robins across streams — one companion
//    flooding the queue cannot push another companion's head item behind an
//    unbounded run of its own work.
//
// SAFETY
// - Bound queue/backpressure: total outstanding (queued + running) is capped at
//   `concurrency + maxQueueDepth`. Beyond the cap a new `run()` call
//   backpressures (its promise waits for an admission slot) and emits a
//   content-free `backpressure` telemetry event rather than allocating
//   unbounded queue memory.
// - Cancellation/deadlines: a per-item `signal` and `deadlineMs` abort an item
//   at any phase. A queued item is removed and rejected immediately; a running
//   item's CALLER is rejected promptly while the underlying work continues to
//   settlement (its slot stays held until then, so concurrency accounting never
//   lies and no quarantine hold is orphaned mid-write).
// - Worker crash/timeout isolation: a throwing `work` rejects only THAT item;
//   its slot and admission ticket are released in the same tick, so a crash can
//   never wedge a worker or corrupt another stream.
// - Restart cleanup: `dispose()` rejects every not-yet-started item and awaits
//   every running item to settle, leaving the pool fully drained (zero running,
//   zero queued) with no orphaned holds.
//
// The pool never inspects work payloads, so it introduces no shared mutable
// classifier state. Each stream's classifier stays single-threaded because the
// stream serializes its own access.

/** The item was cancelled via its `signal` before it could complete. */
export class ScreeningPoolCancelledError extends Error {
  public override readonly name = 'ScreeningPoolCancelledError';
  public constructor(message = 'Screening screening pool item was cancelled') {
    super(message);
  }
}

/** The item exceeded its `deadlineMs` before it could complete. */
export class ScreeningPoolDeadlineError extends Error {
  public override readonly name = 'ScreeningPoolDeadlineError';
  public constructor(message = 'Screening screening pool item exceeded its deadline') {
    super(message);
  }
}

/** `run()` was called after `dispose()` (or during disposal). */
export class ScreeningPoolDisposedError extends Error {
  public override readonly name = 'ScreeningPoolDisposedError';
  public constructor(message = 'Screening screening pool is disposed') {
    super(message);
  }
}

type ScreeningPoolRunOutcome = 'ok' | 'error' | 'cancelled' | 'deadline';

export interface ScreeningPoolTelemetryEvent {
  readonly kind: 'started' | 'completed' | 'backpressure';
  /** Stream key the item belongs to (a companion id at the adapter seam). */
  readonly streamKey: string;
  /** Configured worker concurrency. */
  readonly concurrency: number;
  /** Items whose `work` is currently executing (after this event). */
  readonly busyWorkers: number;
  /** Items admitted but still waiting for a worker / their stream turn. */
  readonly queueDepth: number;
  /** Items admitted-but-not-completed (queued + running). */
  readonly outstanding: number;
  /** 'started'/'completed': wall-clock wait from submit to worker acquire. */
  readonly waitMs?: number;
  /** 'completed': wall-clock duration the worker held the item. */
  readonly serviceMs?: number;
  /** 'completed': how the item resolved. */
  readonly outcome?: ScreeningPoolRunOutcome;
}

interface ScreeningPoolStats {
  readonly concurrency: number;
  readonly maxQueueDepth: number;
  readonly busyWorkers: number;
  readonly queueDepth: number;
  readonly outstanding: number;
  readonly waitingForAdmission: number;
  readonly disposed: boolean;
}

interface ScreeningPoolRunOptions {
  /** Aborts the item at any phase; resolves the caller with a cancellation. */
  readonly signal?: AbortSignal;
  /** Hard wall-clock deadline (submit → settle) for this item, in milliseconds. */
  readonly deadlineMs?: number;
}

interface ScreeningPoolWorkContext {
  /**
   * Abort signal the work MAY observe. Fires on caller cancellation or
   * deadline. The pool never forces the underlying promise to reject, so the
   * work decides how cooperative it wants to be; the CALLER is rejected
   * promptly regardless.
   */
  readonly signal: AbortSignal;
}

export interface ScreeningPoolOptions {
  /** Worker concurrency; the adapter validates the owner-file 2..4 bound. */
  readonly concurrency: number;
  /** Maximum admitted-but-not-running items before admission backpressures. */
  readonly maxQueueDepth: number;
  readonly now?: () => number;
  /** Content-free observer. A throwing observer is isolated from scheduling. */
  readonly onTelemetry?: (event: ScreeningPoolTelemetryEvent) => void;
}

interface WorkOutcome<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: unknown;
}

interface PoolItem {
  readonly streamKey: string;
  readonly work: (ctx: ScreeningPoolWorkContext) => Promise<unknown>;
  readonly submitTime: number;
  readonly deadlineMs: number | undefined;
  /** Resolves/rejects the caller-facing promise from a work outcome. */
  settle: (outcome: WorkOutcome<unknown>) => void;
  controller: AbortController;
  state: 'admitting' | 'queued' | 'running' | 'settled';
  outcome: ScreeningPoolRunOutcome;
  startTime: number;
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
}

function classifyOutcome(error: unknown): ScreeningPoolRunOutcome {
  if (error instanceof ScreeningPoolDeadlineError) return 'deadline';
  if (error instanceof ScreeningPoolCancelledError) return 'cancelled';
  if (error instanceof ScreeningPoolDisposedError) return 'cancelled';
  return 'error';
}

export interface ScreeningPool {
  run<T>(
    streamKey: string,
    work: (ctx: ScreeningPoolWorkContext) => Promise<T>,
    options?: ScreeningPoolRunOptions,
  ): Promise<T>;
  dispose(): Promise<void>;
  stats(): ScreeningPoolStats;
}

/**
 * Bounded asynchronous screening pool. See the module header for the three
 * scheduling invariants and the safety properties. The pool is single-threaded
 * (Node event loop) — all state mutation happens inside `tick()` or the
 * synchronous prologue of `run()`, so no locks are required.
 */
export function createScreeningPool(options: ScreeningPoolOptions): ScreeningPool {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error(
      `Screening pool concurrency must be a positive integer (got ${String(options.concurrency)})`,
    );
  }
  if (!Number.isInteger(options.maxQueueDepth) || options.maxQueueDepth < 1) {
    throw new Error(
      `Screening pool maxQueueDepth must be a positive integer (got ${String(options.maxQueueDepth)})`,
    );
  }
  const concurrency = options.concurrency;
  const maxQueueDepth = options.maxQueueDepth;
  const now = options.now ?? Date.now;
  const onTelemetry = options.onTelemetry;

  // Admission capacity: a work counts against outstanding from the moment it is
  // admitted (queued) until its underlying promise settles. Queued + running is
  // therefore bounded by concurrency + maxQueueDepth.
  const admissionCapacity = concurrency + maxQueueDepth;

  // admitting = items whose run() was called but have not been admitted yet
  // (admission backpressure). FIFO submission order.
  const admitting: PoolItem[] = [];
  // queued = admitted items waiting for their stream turn and a worker. FIFO.
  const queued: PoolItem[] = [];
  // running = items whose work is executing.
  const running = new Set<PoolItem>();
  // Streams with a currently-running item (per-stream serial invariant).
  const streamRunning = new Set<string>();
  // In-flight work settlements awaited by dispose() for a clean drain.
  const draining = new Set<Promise<unknown>>();

  let disposed = false;

  function emit(event: ScreeningPoolTelemetryEvent): void {
    if (!onTelemetry) return;
    try {
      onTelemetry(event);
    } catch {
      // A throwing telemetry observer must never affect scheduling.
    }
  }

  function stats(): ScreeningPoolStats {
    return {
      concurrency,
      maxQueueDepth,
      busyWorkers: running.size,
      queueDepth: queued.length,
      outstanding: queued.length + running.size,
      waitingForAdmission: admitting.length,
      disposed,
    };
  }

  function armDeadline(item: PoolItem): void {
    if (item.deadlineMs === undefined) return;
    item.deadlineTimer = setTimeout(() => {
      item.controller.abort(new ScreeningPoolDeadlineError());
    }, item.deadlineMs);
  }

  function disarmDeadline(item: PoolItem): void {
    if (item.deadlineTimer !== undefined) {
      clearTimeout(item.deadlineTimer);
      item.deadlineTimer = undefined;
    }
  }

  function rejectItem(item: PoolItem, error: unknown): void {
    if (item.state === 'settled') return;
    item.state = 'settled';
    item.outcome = classifyOutcome(error);
    disarmDeadline(item);
    item.settle({ ok: false, error });
  }

  /**
   * The single scheduler entry point. It (1) admits backpressured items as
   * outstanding capacity frees, (2) dispatches runnable queued items to free
   * workers under the per-stream-serial + fair-queue rule, and (3) is re-run
   * after every state change. It never awaits — it runs to completion
   * synchronously so the invariants hold atomically per tick.
   */
  function tick(): void {
    // 1. Admit: promote admitting → queued while outstanding capacity exists.
    while (admitting.length > 0 && queued.length + running.size < admissionCapacity) {
      const item = admitting.shift();
      if (!item) break;
      item.state = 'queued';
      queued.push(item);
    }
    // Any admitting item left over is backpressured; surface it once via
    // telemetry (it still resolves in submission order when capacity frees).
    const headAdmitting = admitting[0];
    if (headAdmitting) {
      emit({
        kind: 'backpressure',
        streamKey: headAdmitting.streamKey,
        concurrency,
        busyWorkers: running.size,
        queueDepth: queued.length,
        outstanding: queued.length + running.size,
      });
    }

    // 2. Dispatch: walk queued in FIFO order and start every runnable item.
    // An item is runnable when (a) a worker is free AND (b) its stream is not
    // already running. Because queued is FIFO by admission (≈ submission), each
    // stream's items are encountered oldest-first, so per-stream order holds.
    // Because each stream holds at most one running slot, a flooding stream
    // cannot jump ahead of another stream's head item — the ready queue round-
    // robins across streams (fairness).
    for (let i = 0; i < queued.length && running.size < concurrency;) {
      const item = queued[i];
      if (!item) break;
      if (streamRunning.has(item.streamKey)) {
        i += 1;
        continue;
      }
      queued.splice(i, 1);
      startWork(item);
      // Do not advance i: the splice shifted everything down; re-evaluate.
    }
  }

  function startWork(item: PoolItem): void {
    item.state = 'running';
    item.startTime = now();
    running.add(item);
    streamRunning.add(item.streamKey);
    emit({
      kind: 'started',
      streamKey: item.streamKey,
      concurrency,
      busyWorkers: running.size,
      queueDepth: queued.length,
      outstanding: queued.length + running.size,
      waitMs: Math.max(0, item.startTime - item.submitTime),
    });

    // If the caller already aborted/deadlined while queued, reject promptly but
    // STILL run the work so the slot/accounting is released on real settlement.
    const alreadyAborted = item.controller.signal.aborted;

    let workPromise: Promise<unknown>;
    try {
      workPromise = item.work({ signal: item.controller.signal });
    } catch (error) {
      workPromise = Promise.reject(error);
    }

    const settled: Promise<void> = workPromise
      .then((value): WorkOutcome<unknown> => ({ ok: true, value }))
      .catch((error: unknown): WorkOutcome<unknown> => ({ ok: false, error }))
      .then((outcome) => {
        completeWork(item, outcome);
      });
    draining.add(settled);
    settled.finally(() => draining.delete(settled)).catch(() => {
      // completeWork never throws; this only guards against re-entrant rejects.
    });

    if (alreadyAborted) {
      const reason = item.controller.signal.reason;
      rejectItem(
        item,
        reason instanceof Error ? reason : new ScreeningPoolCancelledError(),
      );
    }
  }

  function completeWork(item: PoolItem, outcome: WorkOutcome<unknown>): void {
    running.delete(item);
    streamRunning.delete(item.streamKey);
    disarmDeadline(item);
    const serviceMs = Math.max(0, now() - item.startTime);
    if (item.state !== 'settled') {
      item.state = 'settled';
      item.outcome = outcome.ok ? 'ok' : classifyOutcome(outcome.error);
      item.settle(outcome);
    }
    emit({
      kind: 'completed',
      streamKey: item.streamKey,
      concurrency,
      busyWorkers: running.size,
      queueDepth: queued.length,
      outstanding: queued.length + running.size,
      serviceMs,
      outcome: item.outcome,
    });
    tick();
  }

  function onGovernanceAbort(item: PoolItem): void {
    const reason = item.controller.signal.reason;
    const error = reason instanceof Error ? reason : new ScreeningPoolCancelledError();
    if (item.state === 'admitting') {
      const index = admitting.indexOf(item);
      if (index >= 0) admitting.splice(index, 1);
      rejectItem(item, error);
      tick();
      return;
    }
    if (item.state === 'queued') {
      const index = queued.indexOf(item);
      if (index >= 0) queued.splice(index, 1);
      rejectItem(item, error);
      tick();
      return;
    }
    if (item.state === 'running') {
      // Caller is rejected promptly; the slot stays held until the work settles
      // (handled in completeWork). No concurrency accounting is fudged and no
      // quarantine hold is orphaned mid-write.
      rejectItem(item, error);
    }
  }

  function run<T>(
    streamKey: string,
    work: (ctx: ScreeningPoolWorkContext) => Promise<T>,
    runOptions?: ScreeningPoolRunOptions,
  ): Promise<T> {
    if (disposed) {
      return Promise.reject(new ScreeningPoolDisposedError());
    }
    const callerSignal = runOptions?.signal;
    if (callerSignal?.aborted) {
      return Promise.reject(
        callerSignal.reason instanceof Error
          ? callerSignal.reason
          : new ScreeningPoolCancelledError(),
      );
    }

    const controller = new AbortController();
    const item: PoolItem = {
      streamKey,
      work: work as (ctx: ScreeningPoolWorkContext) => Promise<unknown>,
      submitTime: now(),
      deadlineMs: runOptions?.deadlineMs,
      // Assigned synchronously below from the executor; typed definite via cast.
      settle: undefined as unknown as (outcome: WorkOutcome<unknown>) => void,
      controller,
      state: 'admitting',
      outcome: 'error',
      startTime: 0,
      deadlineTimer: undefined,
    };

    const callerPromise = new Promise<T>((resolve, reject) => {
      item.settle = (outcome) => {
        if (outcome.ok) {
          resolve(outcome.value as T);
        } else {
          reject(outcome.error);
        }
      };
    });

    // Governance: caller signal + per-item deadline both flow through the one
    // controller, so a single abort listener covers every phase. A bare caller
    // abort (e.g. a DOMException 'AbortError') is normalized to the pool's typed
    // cancellation so the adapter can classify it; an explicit deadline reason
    // is preserved.
    const onCallerAbort = (): void => {
      const callerReason = callerSignal?.reason;
      const reason = callerReason instanceof ScreeningPoolDeadlineError
        || callerReason instanceof ScreeningPoolDisposedError
        ? callerReason
        : new ScreeningPoolCancelledError(
          callerReason instanceof Error ? callerReason.message : undefined,
        );
      controller.abort(reason);
    };
    if (callerSignal) {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    armDeadline(item);
    item.controller.signal.addEventListener('abort', () => onGovernanceAbort(item), {
      once: true,
    });

    admitting.push(item);
    tick();

    return callerPromise;
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    // Reject every not-yet-started item. Running items keep their slots until
    // their work settles (awaited below) so no quarantine hold is orphaned.
    while (admitting.length > 0) {
      const item = admitting.shift();
      if (item) rejectItem(item, new ScreeningPoolDisposedError());
    }
    while (queued.length > 0) {
      const item = queued.shift();
      if (item) rejectItem(item, new ScreeningPoolDisposedError());
    }
    if (running.size === 0) return;
    // Drain all in-flight work. The work has its own internal timeouts (L2/L3
    // policy), so this resolves in bounded time without a hard kill that could
    // orphan a quarantine hold mid-write.
    await Promise.allSettled([...draining]);
  }

  return { run, dispose, stats };
}
