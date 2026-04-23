export interface BackgroundCompletionDeliveryQueueEntry {
  continuationId: string;
  deliverySessionId: string;
}

export interface BackgroundCompletionDeliveryQueueEnqueueResult {
  queueDepth: number;
  droppedContinuationIds: string[];
}

export interface BackgroundCompletionDeliveryQueueCancelResult {
  cancelled: boolean;
  queueDepth: number;
}

// This queue is for one-shot deferred continuation completions that can be delivered after the
// next foreground turn for the same session. It is not a general background watcher registry.
export class BackgroundCompletionDeliveryQueue<
  TEntry extends BackgroundCompletionDeliveryQueueEntry,
> {
  private readonly bySession = new Map<string, TEntry[]>();
  private readonly byContinuation = new Map<string, string>();

  enqueue(
    entry: TEntry,
    options: { maxDepth?: number } = {},
  ): BackgroundCompletionDeliveryQueueEnqueueResult {
    this.cancel(entry.continuationId);
    const existing = this.bySession.get(entry.deliverySessionId) ?? [];
    const next = [...existing, entry];
    const maxDepth = typeof options.maxDepth === 'number' && Number.isFinite(options.maxDepth)
      ? Math.max(1, Math.floor(options.maxDepth))
      : null;
    const dropped = maxDepth !== null && next.length > maxDepth
      ? next.slice(0, next.length - maxDepth)
      : [];
    const kept = dropped.length > 0 ? next.slice(dropped.length) : next;
    this.bySession.set(entry.deliverySessionId, kept);
    this.byContinuation.set(entry.continuationId, entry.deliverySessionId);
    for (const trimmed of dropped) {
      if (this.byContinuation.get(trimmed.continuationId) === entry.deliverySessionId) {
        this.byContinuation.delete(trimmed.continuationId);
      }
    }
    return {
      queueDepth: kept.length,
      droppedContinuationIds: dropped.map((trimmed) => trimmed.continuationId),
    };
  }

  cancel(
    continuationId: string,
    deliverySessionIdHint?: string,
  ): BackgroundCompletionDeliveryQueueCancelResult {
    const trackedSessionId = this.byContinuation.get(continuationId) ?? null;
    const sessionId = trackedSessionId ?? deliverySessionIdHint ?? null;
    if (!sessionId) {
      return {
        cancelled: false,
        queueDepth: 0,
      };
    }

    const existing = this.bySession.get(sessionId);
    if (!existing || existing.length === 0) {
      this.byContinuation.delete(continuationId);
      return {
        cancelled: false,
        queueDepth: 0,
      };
    }

    const next = existing.filter((entry) => entry.continuationId !== continuationId);
    const cancelled = next.length !== existing.length;
    if (next.length > 0) {
      this.bySession.set(sessionId, next);
    } else {
      this.bySession.delete(sessionId);
    }
    if (this.byContinuation.get(continuationId) === sessionId) {
      this.byContinuation.delete(continuationId);
    }
    return {
      cancelled,
      queueDepth: next.length,
    };
  }

  dequeue(deliverySessionId: string, limit?: number): TEntry[] {
    const existing = this.bySession.get(deliverySessionId);
    if (!existing || existing.length === 0) {
      return [];
    }
    const boundedLimit = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : null;
    const dequeued = boundedLimit === null ? existing : existing.slice(0, boundedLimit);
    const remaining = boundedLimit === null ? [] : existing.slice(boundedLimit);
    if (remaining.length > 0) {
      this.bySession.set(deliverySessionId, remaining);
    } else {
      this.bySession.delete(deliverySessionId);
    }
    for (const entry of dequeued) {
      if (this.byContinuation.get(entry.continuationId) === deliverySessionId) {
        this.byContinuation.delete(entry.continuationId);
      }
    }
    return dequeued;
  }

  sizeForSession(deliverySessionId: string): number {
    const existing = this.bySession.get(deliverySessionId);
    return existing ? existing.length : 0;
  }
}
