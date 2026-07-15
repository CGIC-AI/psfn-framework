import type { MemoryProvider, WikiRetrievalPort } from '../../core/agent/contracts.js';
import {
  hydrateStartupActiveMemoryContexts,
  type StartupMemoryHydrationSessionManager,
} from '../../faculties/memory/startup-hydration.js';
import {
  hydrateStartupActiveCoreMemoryBlocks,
  type StartupCoreMemoryHydrationSessionManager,
} from '../../faculties/core-memory/startup-hydration.js';
import {
  hydrateStartupWikiContexts,
  type StartupWikiHydrationSessionManager,
} from '../../faculties/wiki/startup-hydration.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('StartupContinuity');

type StartupContinuitySessionManager = StartupMemoryHydrationSessionManager
  & StartupCoreMemoryHydrationSessionManager
  & StartupWikiHydrationSessionManager;

function formatDegradedChannels(degraded: Array<{ channelId: string; error: string }>): string {
  return degraded
    .map(({ channelId, error }) => `${channelId}: ${error}`)
    .join('; ');
}

export async function hydrateStartupContinuity(options: {
  memoryProvider: MemoryProvider | null | undefined;
  wikiRetrieval: WikiRetrievalPort | null | undefined;
  sessionManager: StartupContinuitySessionManager;
}): Promise<void> {
  const activeMemory = await hydrateStartupActiveMemoryContexts(options);
  const activeCoreMemory = hydrateStartupActiveCoreMemoryBlocks(options);
  // mmo9.7.4: wiki is supplemental (opt-in, fail-closed to an empty block), so
  // priming it is best-effort — a degraded channel is logged, never fatal to
  // startup. A cold wiki lane simply refreshes off-path on the first turn.
  const wiki = await hydrateStartupWikiContexts({
    wikiRetrieval: options.wikiRetrieval,
    sessionManager: options.sessionManager,
  });
  if (wiki.degraded.length > 0) {
    log.warn('Startup wiki context hydration degraded on some channels (non-fatal)', {
      degraded: formatDegradedChannels(wiki.degraded),
    });
  }
  const failures: string[] = [];

  if (activeMemory.degraded.length > 0) {
    failures.push(`active memory [${formatDegradedChannels(activeMemory.degraded)}]`);
  }
  if (activeCoreMemory.degraded.length > 0) {
    failures.push(`active core memory [${formatDegradedChannels(activeCoreMemory.degraded)}]`);
  }
  if (failures.length === 0) return;

  throw new Error(`Startup continuity hydration failed: ${failures.join('; ')}`);
}
