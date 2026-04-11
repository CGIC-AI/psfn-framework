export interface BackgroundCompletionDeliveryQueueEntry {
  continuationId: string;
  deliverySessionId: string;
}

export interface BackgroundCompletionDeliveryQueueEnqueueResult {
  queueDepth: number;
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

  enqueue(entry: TEntry): BackgroundCompletionDeliveryQueueEnqueueResult {
    this.cancel(entry.continuationId);
    const existing = this.bySession.get(entry.deliverySessionId) ?? [];
    const next = [...existing, entry];
    this.bySession.set(entry.deliverySessionId, next);
    this.byContinuation.set(entry.continuationId, entry.deliverySessionId);
    return {
      queueDepth: next.length,
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

  dequeue(deliverySessionId: string): TEntry[] {
    const existing = this.bySession.get(deliverySessionId);
    if (!existing || existing.length === 0) {
      return [];
    }
    this.bySession.delete(deliverySessionId);
    for (const entry of existing) {
      if (this.byContinuation.get(entry.continuationId) === deliverySessionId) {
        this.byContinuation.delete(entry.continuationId);
      }
    }
    return existing;
  }

  sizeForSession(deliverySessionId: string): number {
    const existing = this.bySession.get(deliverySessionId);
    return existing ? existing.length : 0;
  }
}
