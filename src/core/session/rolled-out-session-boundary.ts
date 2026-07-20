/**
 * Logical-session-bound cutoff for chat entries that have left the live tail.
 * Keeping the values together prevents a time-only lookup from widening into
 * other logical sessions that happen to share a physical channel.
 */
export interface RolledOutSessionBoundary {
  readonly sessionId: string;
  readonly beforeMs: number;
}

export function createRolledOutSessionBoundary(
  sessionId: string,
  beforeMs: number,
): RolledOutSessionBoundary {
  const normalizedSessionId = sessionId.trim();
  if (normalizedSessionId.length === 0) {
    throw new Error('Rolled-out session boundary requires a logical session id');
  }
  if (!Number.isSafeInteger(beforeMs) || beforeMs <= 0 || Number.isNaN(new Date(beforeMs).getTime())) {
    throw new Error('Rolled-out session boundary requires a positive valid timestamp');
  }
  return { sessionId: normalizedSessionId, beforeMs };
}

export function cloneRolledOutSessionBoundary(
  boundary: RolledOutSessionBoundary,
): RolledOutSessionBoundary {
  return createRolledOutSessionBoundary(boundary.sessionId, boundary.beforeMs);
}
