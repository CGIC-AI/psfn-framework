const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ActiveLLMRequest {
  readonly controller: AbortController;
  readonly cancellationId: string;
}

function normalizeCancellationId(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !CANONICAL_UUID_PATTERN.test(raw)) {
    throw new Error('LLM cancellationId must be a canonical UUID when provided');
  }
  return raw.toLowerCase();
}

/**
 * Owns the cancellable LLM requests for one authenticated gateway connection.
 *
 * `run` invokes the operation synchronously after reserving its identity. This
 * matters because gateway JSON-RPC frames can dispatch concurrently: a cancel
 * frame that follows the request on the ordered transport must always observe
 * the reservation, even while auditing or provider admission later awaits.
 */
export class GatewayLLMRequestCancellation {
  private readonly activeRequests = new Set<ActiveLLMRequest>();
  private readonly activeByCancellationId = new Map<string, ActiveLLMRequest>();

  run<T>(
    rawCancellationId: unknown,
    operation: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    let cancellationId: string | undefined;
    try {
      cancellationId = normalizeCancellationId(rawCancellationId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!cancellationId) {
      try {
        return Promise.resolve(operation(undefined));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (cancellationId && this.activeByCancellationId.has(cancellationId)) {
      return Promise.reject(
        new Error(`LLM cancellationId "${cancellationId}" is already active on this connection`),
      );
    }

    const active: ActiveLLMRequest = {
      controller: new AbortController(),
      cancellationId,
    };
    this.activeRequests.add(active);
    this.activeByCancellationId.set(cancellationId, active);

    let pending: Promise<T>;
    try {
      pending = operation(active.controller.signal);
    } catch (error) {
      this.release(active);
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (kind: 'resolve' | 'reject', value: unknown): void => {
        if (settled) return;
        settled = true;
        active.controller.signal.removeEventListener('abort', onAbort);
        if (kind === 'resolve') {
          resolve(value as T);
        } else {
          reject(value);
        }
      };
      const onAbort = (): void => {
        finish('reject', active.controller.signal.reason);
      };

      active.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (active.controller.signal.aborted) {
        onAbort();
      }
      Promise.resolve(pending).then(
        result => finish('resolve', result),
        error => finish('reject', error),
      );
    }).finally(() => {
      this.release(active);
    });
  }

  cancel(rawCancellationId: unknown): boolean {
    const cancellationId = normalizeCancellationId(rawCancellationId);
    if (!cancellationId) {
      throw new Error('llm.cancel requires cancellationId');
    }
    const active = this.activeByCancellationId.get(cancellationId);
    if (!active) return false;

    this.release(active);
    active.controller.abort(new Error('Gateway LLM request cancelled by its owning connection'));
    return true;
  }

  abortAll(): number {
    const activeRequests = [...this.activeRequests];
    this.activeRequests.clear();
    this.activeByCancellationId.clear();
    for (const active of activeRequests) {
      active.controller.abort(new Error('Gateway LLM request cancelled because its connection closed'));
    }
    return activeRequests.length;
  }

  private release(active: ActiveLLMRequest): void {
    this.activeRequests.delete(active);
    if (
      this.activeByCancellationId.get(active.cancellationId) === active
    ) {
      this.activeByCancellationId.delete(active.cancellationId);
    }
  }
}
