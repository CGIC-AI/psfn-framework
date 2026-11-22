import {
  getRequestContext,
  isCompanionSelfCreationContext,
  isCompanionSelfReflectionContext,
} from '../../../primitives/llm/request-context.js';
import type { RetrievalAccessScope } from '../types.js';

// Telemetry/routing compatibility value consumed by persisted retrieval records.
export const COMPANION_SELF_REFLECTION_RETRIEVAL_PURPOSE =
  'heartbeat.reflection.memory_retrieval';
export const COMPANION_SELF_CREATION_RETRIEVAL_PURPOSE =
  'free_time.creation.memory_retrieval';

export function resolveAuthorizedRetrievalAccessScope(
  channelId: string,
  requestedScope: RetrievalAccessScope | undefined,
): RetrievalAccessScope {
  const accessScope = requestedScope ?? 'channel_participant';
  if (accessScope !== 'companion_self_reflection') {
    if (accessScope !== 'companion_self_creation') return accessScope;

    const context = getRequestContext();
    if (context?.channelId !== channelId || !isCompanionSelfCreationContext(context)) {
      throw new Error(
        'companion_self_creation memory access requires a trusted audience=self free-time context',
      );
    }
    return accessScope;
  }

  const context = getRequestContext();
  if (context?.channelId !== channelId || !isCompanionSelfReflectionContext(context)) {
    throw new Error(
      'companion_self_reflection memory access requires a trusted private reflection context',
    );
  }

  return accessScope;
}
