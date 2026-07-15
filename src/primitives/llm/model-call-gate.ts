import {
  compareRuntimeLanePriority,
  resolveRuntimeLaneBudgetProfile,
  FOREGROUND_CHAT_RUNTIME_CLASS,
  type RuntimeLaneClass,
} from '../../core/agent/worker-lanes.js';

/**
 * Per-resource admission capacity. `capacity` is the total number of concurrent
 * in-flight model calls a shared endpoint tolerates; `reservedForegroundSlots`
 * are slots that non-foreground lanes may never occupy, so an interactive
 * (foreground) acquire never has to wait behind background work.
 *
 * Both default fail-closed (capacity 1, no reservation) so an unconfigured
 * shared/local endpoint keeps the original single-slot behavior.
 */
export interface ModelCallGateCapacity {
  capacity: number;
  reservedForegroundSlots: number;
}

export const DEFAULT_MODEL_CALL_GATE_CAPACITY: ModelCallGateCapacity = {
  capacity: 1,
  reservedForegroundSlots: 0,
};

export interface ModelCallGateRequest {
  resourceKey?: string | null;
  runtimeClass: RuntimeLaneClass;
  capacity?: ModelCallGateCapacity;
  signal?: AbortSignal;
}

export interface ModelCallPreemptionTelemetry {
  reason: 'higher_priority_acquire';
  resourceKey: string;
  preemptorRuntimeClass: RuntimeLaneClass;
  preemptedRuntimeClass: RuntimeLaneClass;
  waitedMs: number;
}

export interface ModelCallGateOptions {
  onPreemption?: (event: ModelCallPreemptionTelemetry) => void;
  now?: () => number;
}

/**
 * Thrown to a preempted model call so the caller can distinguish a
 * gate-initiated preemption from a caller/shutdown abort. Background handlers
 * map this to a supervisor defer (no attempt consumed); the LLM call is always
 * pre-effect-boundary, so abandoning it is supervisor-safe.
 */
export class ModelCallPreemptedError extends Error {
  constructor(
    readonly resourceKey: string,
    readonly preemptedRuntimeClass: RuntimeLaneClass,
    readonly preemptorRuntimeClass: RuntimeLaneClass,
  ) {
    super(
      `Model call on ${resourceKey} preempted (${preemptedRuntimeClass}) by higher-priority ${preemptorRuntimeClass}`,
    );
    this.name = 'ModelCallPreemptedError';
  }
}

interface ActiveCall {
  sequence: number;
  runtimeClass: RuntimeLaneClass;
  preemptable: boolean;
  preemptController: AbortController;
}

interface PendingAcquire {
  sequence: number;
  runtimeClass: RuntimeLaneClass;
  enqueuedAtMs: number;
  resolve: (slot: AcquiredSlot) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface ResourceQueue {
  capacity: number;
  reservedForegroundSlots: number;
  active: ActiveCall[];
  pending: PendingAcquire[];
}

interface AcquiredSlot {
  preemptController: AbortController;
  release: () => void;
}

function isForegroundLane(runtimeClass: RuntimeLaneClass): boolean {
  return runtimeClass === FOREGROUND_CHAT_RUNTIME_CLASS;
}

function isPreemptableLane(runtimeClass: RuntimeLaneClass): boolean {
  return resolveRuntimeLaneBudgetProfile(runtimeClass).preemptable;
}

export class ModelCallGate {
  private readonly queues = new Map<string, ResourceQueue>();
  private readonly onPreemption?: (event: ModelCallPreemptionTelemetry) => void;
  private readonly now: () => number;
  private nextSequence = 0;

  constructor(options: ModelCallGateOptions = {}) {
    if (options.onPreemption) this.onPreemption = options.onPreemption;
    this.now = options.now ?? Date.now;
  }

  async run<T>(
    request: ModelCallGateRequest,
    execute: (preemptSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!request.resourceKey) {
      // Ungated (cloud/non-contended) providers still receive a gate-owned
      // signal so callers can compose a single uniform transport signal.
      return execute(new AbortController().signal);
    }

    const slot = await this.acquire({
      resourceKey: request.resourceKey,
      runtimeClass: request.runtimeClass,
      capacity: request.capacity ?? DEFAULT_MODEL_CALL_GATE_CAPACITY,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    try {
      return await execute(slot.preemptController.signal);
    } catch (error) {
      // A gate-initiated preemption surfaces as a transport abort. Normalize it
      // to the typed error so the caller can map it to a supervisor defer
      // rather than a failed/retried attempt.
      const reason = slot.preemptController.signal.aborted
        ? slot.preemptController.signal.reason
        : undefined;
      if (reason instanceof ModelCallPreemptedError) {
        throw reason;
      }
      throw error;
    } finally {
      slot.release();
    }
  }

  private async acquire(request: {
    resourceKey: string;
    runtimeClass: RuntimeLaneClass;
    capacity: ModelCallGateCapacity;
    signal?: AbortSignal;
  }): Promise<AcquiredSlot> {
    if (request.signal?.aborted) {
      throw createAbortError();
    }

    const resourceKey = request.resourceKey;
    const queue = this.ensureQueue(resourceKey, request.capacity);
    // Capacity/reservation is a stable per-endpoint property; keep the queue
    // aligned to the latest resolved config without shrinking below in-flight.
    queue.capacity = Math.max(
      normalizePositiveCapacity(request.capacity.capacity),
      queue.active.length,
    );
    queue.reservedForegroundSlots = clampReservation(
      request.capacity.reservedForegroundSlots,
      queue.capacity,
    );

    const enqueuedAtMs = this.now();

    if (this.canGrantImmediately(queue, request.runtimeClass)) {
      return this.grant(resourceKey, queue, request.runtimeClass);
    }

    const victim = this.selectPreemptionVictim(queue, request.runtimeClass);
    if (victim) {
      this.preempt(resourceKey, queue, victim, request.runtimeClass, 0);
      return this.grant(resourceKey, queue, request.runtimeClass);
    }

    return await new Promise<AcquiredSlot>((resolve, reject) => {
      const pending: PendingAcquire = {
        sequence: this.nextSequence += 1,
        runtimeClass: request.runtimeClass,
        enqueuedAtMs,
        resolve,
        reject,
        cleanup: () => undefined,
      };

      if (request.signal) {
        const onAbort = () => {
          const nextQueue = this.queues.get(resourceKey);
          if (nextQueue) {
            const index = nextQueue.pending.indexOf(pending);
            if (index >= 0) {
              nextQueue.pending.splice(index, 1);
              this.deleteQueueIfIdle(resourceKey, nextQueue);
            }
          }
          reject(createAbortError());
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
        pending.cleanup = () => request.signal?.removeEventListener('abort', onAbort);
      }

      queue.pending.push(pending);
    });
  }

  private ensureQueue(resourceKey: string, capacity: ModelCallGateCapacity): ResourceQueue {
    const existing = this.queues.get(resourceKey);
    if (existing) {
      return existing;
    }
    const normalizedCapacity = normalizePositiveCapacity(capacity.capacity);
    const created: ResourceQueue = {
      capacity: normalizedCapacity,
      reservedForegroundSlots: clampReservation(
        capacity.reservedForegroundSlots,
        normalizedCapacity,
      ),
      active: [],
      pending: [],
    };
    this.queues.set(resourceKey, created);
    return created;
  }

  private effectiveCapacity(queue: ResourceQueue, runtimeClass: RuntimeLaneClass): number {
    if (isForegroundLane(runtimeClass)) {
      return queue.capacity;
    }
    return Math.max(0, queue.capacity - queue.reservedForegroundSlots);
  }

  private canGrantImmediately(queue: ResourceQueue, runtimeClass: RuntimeLaneClass): boolean {
    return queue.active.length < this.effectiveCapacity(queue, runtimeClass);
  }

  /**
   * The lowest-priority preemptable active call that the acquirer strictly
   * outranks, or null when preemption is not permitted. A non-preemptable lane
   * (foreground_chat, post_turn_appraisal) is never a victim.
   */
  private selectPreemptionVictim(
    queue: ResourceQueue,
    runtimeClass: RuntimeLaneClass,
  ): ActiveCall | null {
    let victim: ActiveCall | null = null;
    for (const call of queue.active) {
      if (!call.preemptable) continue;
      // Strictly higher priority than the candidate victim (lower priority number
      // wins); the acquirer must strictly outrank the victim to preempt it.
      if (compareRuntimeLanePriority(runtimeClass, call.runtimeClass) >= 0) continue;
      if (!victim || compareRuntimeLanePriority(call.runtimeClass, victim.runtimeClass) > 0) {
        victim = call;
      }
    }
    return victim;
  }

  private preempt(
    resourceKey: string,
    queue: ResourceQueue,
    victim: ActiveCall,
    preemptorRuntimeClass: RuntimeLaneClass,
    waitedMs: number,
  ): void {
    const index = queue.active.indexOf(victim);
    if (index >= 0) {
      queue.active.splice(index, 1);
    }
    this.onPreemption?.({
      reason: 'higher_priority_acquire',
      resourceKey,
      preemptorRuntimeClass,
      preemptedRuntimeClass: victim.runtimeClass,
      waitedMs,
    });
    if (!victim.preemptController.signal.aborted) {
      victim.preemptController.abort(
        new ModelCallPreemptedError(resourceKey, victim.runtimeClass, preemptorRuntimeClass),
      );
    }
  }

  private grant(
    resourceKey: string,
    queue: ResourceQueue,
    runtimeClass: RuntimeLaneClass,
  ): AcquiredSlot {
    const active: ActiveCall = {
      sequence: this.nextSequence += 1,
      runtimeClass,
      preemptable: isPreemptableLane(runtimeClass),
      preemptController: new AbortController(),
    };
    queue.active.push(active);
    return {
      preemptController: active.preemptController,
      release: this.createRelease(resourceKey, active),
    };
  }

  private createRelease(resourceKey: string, active: ActiveCall): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const queue = this.queues.get(resourceKey);
      if (!queue) return;
      const index = queue.active.indexOf(active);
      if (index >= 0) {
        queue.active.splice(index, 1);
      }
      this.drain(resourceKey, queue);
    };
  }

  private drain(resourceKey: string, queue: ResourceQueue): void {
    for (;;) {
      const nextIndex = this.selectNextGrantablePendingIndex(queue);
      if (nextIndex < 0) {
        this.deleteQueueIfIdle(resourceKey, queue);
        return;
      }
      const next = queue.pending.splice(nextIndex, 1)[0]!;
      next.cleanup();
      next.resolve(this.grant(resourceKey, queue, next.runtimeClass));
    }
  }

  private deleteQueueIfIdle(resourceKey: string, queue: ResourceQueue): void {
    if (queue.active.length === 0 && queue.pending.length === 0) {
      this.queues.delete(resourceKey);
    }
  }

  /**
   * Highest-priority pending acquire that currently fits within its lane's
   * effective capacity. Draining never preempts — preemption is an acquire-time
   * decision — so a parked lane waits for a slot to free.
   */
  private selectNextGrantablePendingIndex(queue: ResourceQueue): number {
    let bestIndex = -1;
    for (let index = 0; index < queue.pending.length; index += 1) {
      const candidate = queue.pending[index]!;
      if (!this.canGrantImmediately(queue, candidate.runtimeClass)) continue;
      if (bestIndex < 0) {
        bestIndex = index;
        continue;
      }
      const current = queue.pending[bestIndex]!;
      const priorityDelta = compareRuntimeLanePriority(
        candidate.runtimeClass,
        current.runtimeClass,
      );
      if (priorityDelta < 0) {
        bestIndex = index;
        continue;
      }
      if (priorityDelta === 0 && candidate.sequence < current.sequence) {
        bestIndex = index;
      }
    }
    return bestIndex;
  }
}

function normalizePositiveCapacity(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    return DEFAULT_MODEL_CALL_GATE_CAPACITY.capacity;
  }
  return capacity;
}

function clampReservation(reserved: number, capacity: number): number {
  if (!Number.isSafeInteger(reserved) || reserved < 0) {
    return 0;
  }
  // Never reserve the whole endpoint away from non-foreground work.
  return Math.min(reserved, Math.max(0, capacity - 1));
}

function createAbortError(): Error {
  const error = new Error('LLM call aborted while waiting for a constrained model resource');
  error.name = 'AbortError';
  return error;
}
