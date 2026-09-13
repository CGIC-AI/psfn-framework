import type { StartupSessionMetadata } from '../session/manager.js';
import { isInternalSessionId } from '../session/session-id.js';

export interface FreeTimeActivityPort {
  /** The session owner confirms real role-user activity within the window. */
  listRecentlyActiveChannels(input: {
    lookbackMs: number;
    nowMs?: number;
  }): readonly Pick<StartupSessionMetadata, 'sessionId'>[];
}

/** Activity only gates timing; no external session or transcript becomes free-time context. */
export function hasRecentFreeTimePartnerActivity(
  sessions: FreeTimeActivityPort,
  input: { lookbackMs: number; nowMs: number },
): boolean {
  return sessions.listRecentlyActiveChannels(input).some(session => (
    !isInternalSessionId(session.sessionId)
  ));
}
