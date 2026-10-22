// Inline active-memory retrieval (psfn-framework-d5e0p.20).
//
// In `inline` mode a foreground turn awaits the active-context refresh for its
// own message instead of answering from the context refreshed for the previous
// message. The refresh is the same sticky merge the background lane runs, so a
// fresh result never replaces the set wholesale. The wait is bounded: when the
// budget elapses the turn proceeds on the last-good context and the refresh
// keeps running for the next turn, which is exactly the background behaviour.

import type { ActiveMemoryContextSnapshot } from '../../../../faculties/memory/active-context.js';
import type { ActiveMemoryRetrievalMode, SubstrateConfig } from '../../../../system/config/runtime-config-contracts.js';

type InlineActiveMemoryOutcome = 'fresh' | 'timeout' | 'failed' | 'not_requested';

export interface InlineActiveMemoryResult {
  outcome: InlineActiveMemoryOutcome;
  waitMs: number;
}

export const INLINE_ACTIVE_MEMORY_NOT_REQUESTED: InlineActiveMemoryResult = Object.freeze({
  outcome: 'not_requested',
  waitMs: 0,
});

export function resolveActiveMemoryRetrievalMode(
  config: Pick<SubstrateConfig, 'activeMemoryRetrievalMode'>,
): ActiveMemoryRetrievalMode {
  return config.activeMemoryRetrievalMode === 'inline' ? 'inline' : 'background';
}

/** Inline mode has no safe implicit wait: a missing or invalid budget rejects. */
export function requireActiveMemoryInlineBudgetMs(
  config: Pick<SubstrateConfig, 'activeMemoryInlineBudgetMs'>,
): number {
  const budgetMs = config.activeMemoryInlineBudgetMs;
  if (typeof budgetMs !== 'number' || !Number.isInteger(budgetMs) || budgetMs <= 0) {
    throw new Error(
      `Invalid activeMemoryInlineBudgetMs for inline active memory: expected a positive integer, got ${String(budgetMs)}`,
    );
  }
  return budgetMs;
}

const BUDGET_ELAPSED = Symbol('inline-active-memory-budget');

/**
 * Wait for the scheduled refresh up to `budgetMs`. Rejections are not handled
 * here: the caller's refresh promise already carries the logging/degradation
 * handler, so a rejection only classifies the outcome as `failed`.
 */
export async function awaitInlineActiveMemoryRefresh(
  refresh: Promise<ActiveMemoryContextSnapshot | null>,
  budgetMs: number,
): Promise<InlineActiveMemoryResult> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof BUDGET_ELAPSED>((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_ELAPSED), budgetMs);
  });
  try {
    const settled = await Promise.race([
      refresh.then(
        snapshot => (snapshot?.refreshStatus === 'ready' ? 'fresh' as const : 'failed' as const),
        () => 'failed' as const,
      ),
      budget,
    ]);
    return {
      outcome: settled === BUDGET_ELAPSED ? 'timeout' : settled,
      waitMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
