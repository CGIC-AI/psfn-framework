import { AsyncLocalStorage } from 'node:async_hooks';
import { SearchAbortedError } from './regex-search.js';

const CANCELLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function cancellationId(raw: unknown): string {
  if (typeof raw !== 'string' || !CANCELLATION_ID_PATTERN.test(raw)) {
    throw new Error('fs search cancellationId must be a canonical UUID');
  }
  return raw.toLowerCase();
}

/** Owns searches for one authenticated connection, including legacy callers without IDs. */
export class FilesystemSearchCancellation {
  private readonly context = new AsyncLocalStorage<AbortSignal>();
  private readonly active = new Map<string | symbol, { controller: AbortController; pending: Promise<unknown> }>();
  private closed = false;

  get signal(): AbortSignal | undefined {
    return this.context.getStore();
  }

  run<T>(rawId: unknown, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new SearchAbortedError());
    const id = rawId === undefined ? Symbol() : cancellationId(rawId);
    if (this.active.has(id)) return Promise.reject(new Error('fs search cancellationId is already active'));
    const controller = new AbortController();
    // Reserve before auditing/policy can yield so an ordered cancel cannot
    // overtake admission. The context carries trusted signal authority only.
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new SearchAbortedError();
      return this.context.run(controller.signal, operation);
    }).finally(() => { this.active.delete(id); });
    this.active.set(id, { controller, pending });
    return pending;
  }

  cancel(rawId: unknown): boolean {
    const request = this.active.get(cancellationId(rawId));
    if (!request) return false;
    request.controller.abort();
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    const requests = [...this.active.values()];
    for (const request of requests) request.controller.abort();
    // Each caller owns its operation's rejection. Shutdown joins every one,
    // including worker termination, before releasing connection resources.
    await Promise.allSettled(requests.map(request => request.pending));
  }
}
