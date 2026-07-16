import { getRequestContext } from '../../../primitives/llm/request-context.js';
import type { RetrievalAccessScope } from '../types.js';

export const COMPANION_SELF_REFLECTION_RETRIEVAL_PURPOSE =
  'heartbeat.reflection.memory_retrieval';

const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';

export function resolveAuthorizedRetrievalAccessScope(
  channelId: string,
  requestedScope: RetrievalAccessScope | undefined,
): RetrievalAccessScope {
  const accessScope = requestedScope ?? 'channel_participant';
  if (accessScope !== 'companion_self_reflection') {
    return accessScope;
  }

  const context = getRequestContext();
  const trustedHeartbeatReflection = channelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX)
    && channelId.length > INTERNAL_REFLECTION_CHANNEL_PREFIX.length
    && context?.channelId === channelId
    && context.requesterProvenance === 'self_directed'
    && context.callType === 'background'
    && context.originType === 'background'
    && context.purpose === COMPANION_SELF_REFLECTION_RETRIEVAL_PURPOSE
    && context.originStage === COMPANION_SELF_REFLECTION_RETRIEVAL_PURPOSE;

  if (!trustedHeartbeatReflection) {
    throw new Error(
      'companion_self_reflection memory access requires a trusted heartbeat reflection context',
    );
  }

  return accessScope;
}
