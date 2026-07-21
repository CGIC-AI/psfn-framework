import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { FREE_TIME_CHANNEL_PREFIX } from '../../../core/session/session-id.js';
import type { RetrievalAccessScope } from '../types.js';

// Telemetry/routing compatibility value consumed by persisted retrieval records.
export const COMPANION_SELF_REFLECTION_RETRIEVAL_PURPOSE =
  'heartbeat.reflection.memory_retrieval';
export const COMPANION_SELF_CREATION_RETRIEVAL_PURPOSE =
  'free_time.creation.memory_retrieval';

const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';
// Any workspace-resolved free-time continuity session (lane-independent) shares
// this canonical partition prefix; the specific segment is not part of the
// self-creation trust check.
const INTERNAL_FREE_TIME_CHANNEL_PREFIX = FREE_TIME_CHANNEL_PREFIX;

export function resolveAuthorizedRetrievalAccessScope(
  channelId: string,
  requestedScope: RetrievalAccessScope | undefined,
): RetrievalAccessScope {
  const accessScope = requestedScope ?? 'channel_participant';
  if (accessScope !== 'companion_self_reflection') {
    if (accessScope !== 'companion_self_creation') return accessScope;

    const context = getRequestContext();
    const trustedSelfCreation = channelId.startsWith(INTERNAL_FREE_TIME_CHANNEL_PREFIX)
      && channelId.length > INTERNAL_FREE_TIME_CHANNEL_PREFIX.length
      && context?.channelId === channelId
      && context.requesterProvenance === 'self_directed'
      && context.requestAudience === 'self'
      && context.callType === 'background'
      && context.originType === 'background'
      && context.purpose === COMPANION_SELF_CREATION_RETRIEVAL_PURPOSE
      && context.originStage === COMPANION_SELF_CREATION_RETRIEVAL_PURPOSE;
    if (!trustedSelfCreation) {
      throw new Error(
        'companion_self_creation memory access requires a trusted audience=self free-time context',
      );
    }
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
