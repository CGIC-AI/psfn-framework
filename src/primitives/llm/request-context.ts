import { AsyncLocalStorage } from 'node:async_hooks';
import type { CorrelationMetadata } from '../../shared/contracts/runtime.js';

const requestContextStorage = new AsyncLocalStorage<Partial<CorrelationMetadata>>();

export function runWithRequestContext<T>(
  metadata: Partial<CorrelationMetadata>,
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStorage.run(metadata, fn);
}

export function getRequestContext(): Partial<CorrelationMetadata> | undefined {
  return requestContextStorage.getStore();
}
