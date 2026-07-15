import type { StartupSessionMetadata } from '../session/manager.js';
import type { SessionEntry } from '../session/types.js';

/**
 * Materialize the session index's latest row only when its role proves that
 * the indexed timestamp is conversational. System/tool rows deliberately
 * return null: their recency says nothing about partner/conversation recency.
 */
export function conversationalEntryFromSessionMetadata(
  session: StartupSessionMetadata | null,
): SessionEntry | null {
  if (
    !session
    || (session.lastRole !== 'user' && session.lastRole !== 'assistant')
    || !Number.isFinite(session.timestamp)
  ) {
    return null;
  }
  return {
    id: 0,
    channelId: session.sessionId,
    role: session.lastRole,
    content: '',
    timestamp: session.timestamp,
  };
}

/** True when the index proves that no session entry is newer than `cutoffMs`. */
export function latestSessionActivityAtOrBefore(
  session: StartupSessionMetadata | null,
  cutoffMs: number,
): boolean {
  return Boolean(
    session
    && Number.isFinite(session.timestamp)
    && Number.isFinite(cutoffMs)
    && session.timestamp <= cutoffMs,
  );
}
