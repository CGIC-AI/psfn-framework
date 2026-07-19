export interface StartupHydrationChannelSessionManager {
  resolveStartupSessionMetadata(
    behavior?: 'reuse_latest_session',
  ): { sessionId: string } | null;
  listRecentSessions(limit?: number): Array<{ channelId: string }>;
  listSessionRoutes?(): Array<{ activeLogicalSessionId: string }>;
  isSessionRetiredOrQuarantined?(logicalSessionId: string): boolean;
}

export function collectHydrationChannelIds(
  sessionManager: StartupHydrationChannelSessionManager,
  recentSessionLimit: number,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (channelId: string | undefined): void => {
    const normalized = channelId?.trim();
    if (!normalized || seen.has(normalized)) return;
    if (sessionManager.isSessionRetiredOrQuarantined?.(normalized)) return;
    seen.add(normalized);
    ids.push(normalized);
  };
  for (const route of sessionManager.listSessionRoutes?.() ?? []) {
    add(route.activeLogicalSessionId);
  }
  add(sessionManager.resolveStartupSessionMetadata('reuse_latest_session')?.sessionId);
  for (const session of sessionManager.listRecentSessions(recentSessionLimit)) {
    add(session.channelId);
  }
  return ids.slice(0, Math.max(1, recentSessionLimit));
}
