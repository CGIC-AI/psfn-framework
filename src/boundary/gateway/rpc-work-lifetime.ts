import { AsyncLocalStorage } from 'node:async_hooks';

const operations = new AsyncLocalStorage<Set<Promise<void>>>();

/** A cancellation response may settle before its underlying operation stops. */
export function retainGatewayRpcOperation<T>(pending: Promise<T>): Promise<T> {
  const current = operations.getStore();
  if (current) {
    // Observe completion without retaining results or changing caller rejection.
    const completed = pending.then(() => undefined, () => undefined);
    current.add(completed);
    void completed.then(() => current.delete(completed));
  }
  return pending;
}

export async function withGatewayRpcWorkLifetime(operation: () => Promise<void>): Promise<void> {
  const current = new Set<Promise<void>>();
  await operations.run(current, async () => {
    try { await operation(); }
    finally {
      while (current.size > 0) await Promise.all(current);
    }
  });
}
