import {
  compareRuntimeLanePriority,
  type RuntimeLaneClass,
} from '../../core/agent/worker-lanes.js';

export interface ModelCallGateRequest {
  resourceKey?: string | null;
  runtimeClass: RuntimeLaneClass;
  signal?: AbortSignal;
}

interface PendingAcquire {
  sequence: number;
  runtimeClass: RuntimeLaneClass;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface ResourceQueue {
  active: boolean;
  pending: PendingAcquire[];
}

export class ModelCallGate {
  private readonly queues = new Map<string, ResourceQueue>();
  private nextSequence = 0;

  async run<T>(
    request: ModelCallGateRequest,
    execute: () => Promise<T>,
  ): Promise<T> {
    if (!request.resourceKey) {
      return execute();
    }

    const release = await this.acquire(request);
    try {
      return await execute();
    } finally {
      release();
    }
  }

  private async acquire(request: Required<Pick<ModelCallGateRequest, 'resourceKey' | 'runtimeClass'>> & {
    signal?: AbortSignal;
  }): Promise<() => void> {
    if (request.signal?.aborted) {
      throw createAbortError();
    }

    const queue = this.ensureQueue(request.resourceKey);
    if (!queue.active && queue.pending.length === 0) {
      queue.active = true;
      return this.createRelease(request.resourceKey);
    }

    return await new Promise<() => void>((resolve, reject) => {
      const pending: PendingAcquire = {
        sequence: this.nextSequence += 1,
        runtimeClass: request.runtimeClass,
        resolve,
        reject,
        cleanup: () => undefined,
      };

      if (request.signal) {
        const onAbort = () => {
          const nextQueue = this.queues.get(request.resourceKey);
          if (!nextQueue) {
            reject(createAbortError());
            return;
          }
          const index = nextQueue.pending.indexOf(pending);
          if (index >= 0) {
            nextQueue.pending.splice(index, 1);
            this.deleteQueueIfIdle(request.resourceKey, nextQueue);
          }
          reject(createAbortError());
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
        pending.cleanup = () => request.signal?.removeEventListener('abort', onAbort);
      }

      queue.pending.push(pending);
    });
  }

  private ensureQueue(resourceKey: string): ResourceQueue {
    const existing = this.queues.get(resourceKey);
    if (existing) {
      return existing;
    }
    const created: ResourceQueue = {
      active: false,
      pending: [],
    };
    this.queues.set(resourceKey, created);
    return created;
  }

  private createRelease(resourceKey: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const queue = this.queues.get(resourceKey);
      if (!queue) return;
      queue.active = false;
      this.drain(resourceKey, queue);
    };
  }

  private drain(resourceKey: string, queue: ResourceQueue): void {
    if (queue.active) {
      return;
    }

    const nextIndex = this.selectNextPendingIndex(queue.pending);
    if (nextIndex < 0) {
      this.deleteQueueIfIdle(resourceKey, queue);
      return;
    }

    const next = queue.pending.splice(nextIndex, 1)[0]!;
    queue.active = true;
    next.cleanup();
    next.resolve(this.createRelease(resourceKey));
  }

  private deleteQueueIfIdle(resourceKey: string, queue: ResourceQueue): void {
    if (!queue.active && queue.pending.length === 0) {
      this.queues.delete(resourceKey);
    }
  }

  private selectNextPendingIndex(pending: readonly PendingAcquire[]): number {
    if (pending.length === 0) {
      return -1;
    }

    let bestIndex = 0;
    for (let index = 1; index < pending.length; index += 1) {
      const candidate = pending[index]!;
      const current = pending[bestIndex]!;
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

function createAbortError(): Error {
  const error = new Error('LLM call aborted while waiting for a constrained model resource');
  error.name = 'AbortError';
  return error;
}
