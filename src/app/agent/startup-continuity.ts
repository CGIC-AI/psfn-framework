import type { MemoryProvider } from '../../core/agent/contracts.js';
import {
  hydrateStartupActiveMemoryContexts,
  type StartupMemoryHydrationSessionManager,
} from '../../faculties/memory/startup-hydration.js';
import {
  hydrateStartupActiveCoreMemoryBlocks,
  type StartupCoreMemoryHydrationSessionManager,
} from '../../faculties/core-memory/startup-hydration.js';

type StartupContinuitySessionManager = StartupMemoryHydrationSessionManager
  & StartupCoreMemoryHydrationSessionManager;

function formatDegradedChannels(degraded: Array<{ channelId: string; error: string }>): string {
  return degraded
    .map(({ channelId, error }) => `${channelId}: ${error}`)
    .join('; ');
}

export async function hydrateStartupContinuity(options: {
  memoryProvider: MemoryProvider | null | undefined;
  sessionManager: StartupContinuitySessionManager;
}): Promise<void> {
  const activeMemory = await hydrateStartupActiveMemoryContexts(options);
  const activeCoreMemory = hydrateStartupActiveCoreMemoryBlocks(options);
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
