import type { SessionActivitySummary } from '../../persistence/sessions/store.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

const log = createComponentLogger('StartupCoreMemoryHydration');
const DEFAULT_RECENT_SESSION_LIMIT = 8;

export interface StartupCoreMemoryHydrationSessionManager {
  listRecentSessions(limit?: number): SessionActivitySummary[];
  renderActiveCoreMemoryBlock(channelId: string): string;
  isSessionRetiredOrQuarantined?(logicalSessionId: string): boolean;
}

export interface StartupCoreMemoryHydrationChannel {
  channelId: string;
  hasContent: boolean;
}

export interface StartupCoreMemoryHydrationResult {
  attempted: number;
  hydrated: number;
  channels: StartupCoreMemoryHydrationChannel[];
  degraded: Array<{ channelId: string; error: string }>;
}

/**
 * Warm the scoped core-memory blocks for recently active channels at boot.
 *
 * The CoreMemoryStore is disk-backed, so persisted scoped content survives a
 * restart; this pass resolves the correct ConversationScope for each recently
 * active channel and confirms the scoped block renders non-empty through the
 * real read path. That gives the first post-restart prompt a populated,
 * correctly-bound core-memory block while async memory (sleeptime/orient)
 * catches up, and surfaces channels whose persisted content is missing or keyed
 * under a stale scope so operators get a signal (see the core-memory scope
 * audit command).
 *
 * Read-only and synchronous: it never mutates core memory.
 */
export function hydrateStartupActiveCoreMemoryBlocks(options: {
  sessionManager: StartupCoreMemoryHydrationSessionManager;
  recentSessionLimit?: number;
}): StartupCoreMemoryHydrationResult {
  const limit = Math.max(1, options.recentSessionLimit ?? DEFAULT_RECENT_SESSION_LIMIT);
  const seen = new Set<string>();
  const channels: StartupCoreMemoryHydrationChannel[] = [];
  const degraded: StartupCoreMemoryHydrationResult['degraded'] = [];
  let attempted = 0;
  let hydrated = 0;

  for (const session of options.sessionManager.listRecentSessions(limit)) {
    const channelId = session.channelId.trim();
    if (!channelId || seen.has(channelId)) continue;
    if (options.sessionManager.isSessionRetiredOrQuarantined?.(channelId)) continue;
    seen.add(channelId);
    attempted += 1;
    try {
      const block = options.sessionManager.renderActiveCoreMemoryBlock(channelId);
      const hasContent = block.trim().length > 0;
      if (hasContent) hydrated += 1;
      channels.push({ channelId, hasContent });
    } catch (error) {
      degraded.push({ channelId, error: toErrorMessage(error) });
    }
  }

  if (attempted > 0 || degraded.length > 0) {
    log.info('Startup active core-memory hydration completed', {
      attempted,
      hydrated,
      degradedCount: degraded.length,
      channels,
      degraded,
    });
  }

  return { attempted, hydrated, channels, degraded };
}
