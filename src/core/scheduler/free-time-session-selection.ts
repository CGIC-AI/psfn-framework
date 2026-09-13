import type { SessionActivitySummary } from '../../persistence/sessions/store.js';
import type { StartupSessionMetadata } from '../session/manager.js';
import { isInternalSessionId } from '../session/session-id.js';

export interface FreeTimeSessionMetadataPort {
  listRecentSessions(limit?: number): readonly Pick<
    SessionActivitySummary, 'sessionId' | 'channelId' | 'channelType' | 'lastActivityAt' | 'lastRole'
  >[];
}

/** Internal work must not hide the conversation used by the existing idle gates. */
export function resolveFreeTimeSessionMetadata(
  sessions: FreeTimeSessionMetadataPort,
): StartupSessionMetadata | null {
  const latest = sessions.listRecentSessions(Number.MAX_SAFE_INTEGER).find(session => (
    !isInternalSessionId(session.sessionId) && !isInternalSessionId(session.channelId)
  ));
  if (!latest) return null;
  // Keep the latest external session, even when its privacy/activity gate will
  // close. An older private session must never bypass those existing gates.
  return {
    sessionId: latest.sessionId,
    timestamp: latest.lastActivityAt,
    lastRole: latest.lastRole,
    ...(latest.channelType ? { channelType: latest.channelType } : {}),
  };
}
