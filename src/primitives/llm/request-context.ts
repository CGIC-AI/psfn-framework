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

const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';

/** Companion-owned private work is authorized by its audience and provenance,
 * not the telemetry purpose used by a particular model or tool call. */
export function isCompanionSelfReflectionContext(
  context: Partial<CorrelationMetadata> | undefined,
): boolean {
  return context?.channelId?.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX) === true
    && context.channelId.length > INTERNAL_REFLECTION_CHANNEL_PREFIX.length
    && context.requesterProvenance === 'self_directed'
    && context.requestAudience === 'self';
}
