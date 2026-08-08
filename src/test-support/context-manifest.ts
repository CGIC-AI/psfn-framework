import type { ContextManifest } from '../core/session/context-manifest.js';

export function makeContextManifestFixture(): ContextManifest {
  return {
    channelId: 'test-channel',
    generatedAt: 1_700_000_000_000,
    session: {
      sourceEntryCount: 4,
      trimmedEntryCount: 0,
      maskedEntryCount: 0,
      compactedEntryCount: 0,
      finalEntryCount: 4,
      finalMessageCount: 4,
      compactionSummaryCount: 0,
      continuityEntryCount: 0,
      historySummaryEntryCount: 0,
    },
    memory: {
      includedCount: 1,
      includedTypes: { semantic: 1 },
      includedTokenCount: 120,
      reason: 'test',
      candidateCount: 1,
      policyAllowedCount: 1,
      rankedCount: 1,
      returnedCount: 1,
      excluded: {
        sensitivityRejectedCount: 0,
        policyRejectedCount: 0,
        scoreRejectedCount: 0,
        budgetCappedCount: 0,
      },
      retrieval: {
        mode: 'budget',
        budgetPct: 2,
        tokenBudget: 500,
        limit: 3,
      },
    },
    budgets: {
      contextWindow: 128_000,
      adaptive: {
        enabled: true,
        source: 'default',
        category: 'default',
      },
      sessionHistory: {
        mode: 'budget',
        budgetPct: 6,
        tokenBudget: 8_000,
        estimatedCount: 24,
        actualCount: 4,
        actualTokenCount: 420,
      },
      memoryRetrieval: {
        mode: 'budget',
        budgetPct: 2,
        tokenBudget: 500,
        estimatedCount: 3,
        actualCount: 1,
        actualTokenCount: 120,
      },
      sections: [
        { section: 'system_prompt', tokenCount: 250 },
        { section: 'memories', tokenCount: 120 },
        { section: 'session_history', tokenCount: 420 },
      ],
    },
    compaction: {
      triggered: false,
      eligible: false,
      thresholdPct: 70,
      tokenBudget: 90_000,
      totalTokensBefore: 790,
      totalTokensAfter: 790,
    },
  };
}
