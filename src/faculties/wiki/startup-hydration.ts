import type { WikiRetrievalPort } from '../../core/agent/contracts.js';
import type { StartupSessionMetadata } from '../../core/session/manager.js';
import type { SourceChannelSessionRoute } from '../../core/session/session-routes.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SessionActivitySummary } from '../../persistence/sessions/store.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { WikiStartupHydrationSettings } from '../../system/config/runtime-config-contracts.js';

const log = createComponentLogger('StartupWikiHydration');

/**
 * The subset of the session manager the wiki hydration hook needs. Structurally
 * identical to `StartupMemoryHydrationSessionManager`, kept local so the wiki
 * faculty does not depend on the memory faculty for a startup seam.
 */
export interface StartupWikiHydrationSessionManager {
  resolveStartupSessionMetadata(behavior?: 'reuse_latest_session'): StartupSessionMetadata | null;
  listRecentSessions(limit?: number): SessionActivitySummary[];
  getRecentMessages(channelId: string, limit?: number): SessionEntry[];
  listSessionRoutes?(): SourceChannelSessionRoute[];
  isSessionRetiredOrQuarantined?(logicalSessionId: string): boolean;
}

export interface StartupWikiHydrationResult {
  attempted: number;
  hydrated: number;
  degraded: Array<{
    channelId: string;
    error: string;
  }>;
}

function buildHydrationContextText(
  entries: readonly SessionEntry[],
  maxContextChars: number,
): string {
  const lines = entries
    .filter(entry => entry.role === 'user' || entry.role === 'assistant')
    .map((entry) => {
      const speaker = entry.authorName?.trim()
        || (entry.role === 'assistant' ? 'assistant' : 'user');
      return `${speaker}: ${entry.content.replace(/\s+/g, ' ').trim()}`;
    })
    .filter(line => line.trim().length > 0);
  const context = lines.join('\n');
  if (context.length <= maxContextChars) {
    return context;
  }
  return context.slice(context.length - maxContextChars);
}

function collectHydrationChannelIds(
  sessionManager: StartupWikiHydrationSessionManager,
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

/**
 * mmo9.7.4: prime the wiki cached-snapshot cache at startup so the first turn
 * on a recently-active channel serves a warm block instead of a cold miss —
 * mirroring `hydrateStartupActiveMemoryContexts`. Best-effort per channel: a
 * refresh failure is recorded and never blocks startup. `isDirectMessage` is
 * left undefined here, priming the DM-class lane (the deterministic gate's
 * default class); a first group turn keys a different lane and cold-refreshes
 * off-path, exactly as active-memory does with a different trust/scope.
 */
export async function hydrateStartupWikiContexts(options: {
  wikiRetrieval: WikiRetrievalPort | null | undefined;
  sessionManager: StartupWikiHydrationSessionManager;
  tuning: WikiStartupHydrationSettings;
}): Promise<StartupWikiHydrationResult> {
  const refresh = options.wikiRetrieval?.refreshWikiContextBlock.bind(options.wikiRetrieval);
  if (!refresh) {
    return { attempted: 0, hydrated: 0, degraded: [] };
  }

  const channelIds = collectHydrationChannelIds(
    options.sessionManager,
    options.tuning.recentSessionLimit,
  );
  let attempted = 0;
  let hydrated = 0;
  const degraded: StartupWikiHydrationResult['degraded'] = [];

  for (const channelId of channelIds) {
    const entries = options.sessionManager.getRecentMessages(
      channelId,
      options.tuning.recentMessageLimit,
    );
    const contextText = buildHydrationContextText(
      entries,
      options.tuning.maxContextChars,
    );
    if (!contextText.trim()) continue;
    attempted += 1;
    try {
      const snapshot = await refresh({
        channelId,
        queryText: contextText,
        isDirectMessage: undefined,
        focusActive: false,
      });
      if (snapshot?.block.trim()) {
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
    log.info('Startup wiki context hydration completed', {
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
