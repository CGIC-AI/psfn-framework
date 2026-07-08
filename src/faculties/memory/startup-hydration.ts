import type { MemoryProvider } from '../../core/agent/contracts.js';
import type { StartupSessionMetadata } from '../../core/session/manager.js';
import type { SourceChannelSessionRoute } from '../../core/session/session-routes.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SessionActivitySummary } from '../../persistence/sessions/store.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

const log = createComponentLogger('StartupMemoryHydration');
const DEFAULT_RECENT_SESSION_LIMIT = 4;
const DEFAULT_RECENT_MESSAGE_LIMIT = 18;
const MAX_HYDRATION_CONTEXT_CHARS = 6_000;

export interface StartupMemoryHydrationSessionManager {
  resolveStartupSessionMetadata(behavior?: 'reuse_latest_session'): StartupSessionMetadata | null;
  listRecentSessions(limit?: number): SessionActivitySummary[];
  getRecentMessages(channelId: string, limit?: number): SessionEntry[];
  listSessionRoutes?(): SourceChannelSessionRoute[];
  isSessionRetiredOrQuarantined?(logicalSessionId: string): boolean;
}

export interface StartupMemoryHydrationResult {
  attempted: number;
  hydrated: number;
  degraded: Array<{
    channelId: string;
    error: string;
  }>;
}

function buildHydrationContextText(entries: readonly SessionEntry[]): string {
  const lines = entries
    .filter(entry => entry.role === 'user' || entry.role === 'assistant')
    .map((entry) => {
      const speaker = entry.authorName?.trim()
        || (entry.role === 'assistant' ? 'assistant' : 'user');
      return `${speaker}: ${entry.content.replace(/\s+/g, ' ').trim()}`;
    })
    .filter(line => line.trim().length > 0);
  const context = lines.join('\n');
  if (context.length <= MAX_HYDRATION_CONTEXT_CHARS) {
    return context;
  }
  return context.slice(context.length - MAX_HYDRATION_CONTEXT_CHARS);
}

function collectHydrationChannelIds(
  sessionManager: StartupMemoryHydrationSessionManager,
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

export async function hydrateStartupActiveMemoryContexts(options: {
  memoryProvider: MemoryProvider | null | undefined;
  sessionManager: StartupMemoryHydrationSessionManager;
  recentSessionLimit?: number;
  recentMessageLimit?: number;
}): Promise<StartupMemoryHydrationResult> {
  const refresh = options.memoryProvider?.refreshActiveMemoryContext?.bind(options.memoryProvider);
  if (!refresh) {
    return { attempted: 0, hydrated: 0, degraded: [] };
  }

  const channelIds = collectHydrationChannelIds(
    options.sessionManager,
    options.recentSessionLimit ?? DEFAULT_RECENT_SESSION_LIMIT,
  );
  let attempted = 0;
  let hydrated = 0;
  const degraded: StartupMemoryHydrationResult['degraded'] = [];

  for (const channelId of channelIds) {
    const entries = options.sessionManager.getRecentMessages(
      channelId,
      options.recentMessageLimit ?? DEFAULT_RECENT_MESSAGE_LIMIT,
    );
    const contextText = buildHydrationContextText(entries);
    if (!contextText.trim()) continue;
    attempted += 1;
    try {
      const snapshot = await refresh({
        contextText,
        channelId,
        trustLevel: 'regular',
      });
      if (snapshot?.contextBlock.trim()) {
        hydrated += 1;
      }
    } catch (error) {
      degraded.push({
        channelId,
        error: toErrorMessage(error),
      });
    }
  }

  if (attempted > 0 || degraded.length > 0) {
    log.info('Startup active memory hydration completed', {
      attempted,
      hydrated,
      degradedCount: degraded.length,
      degraded,
    });
  }

  return {
    attempted,
    hydrated,
    degraded,
  };
}
