import type {
  AdaptiveContextBudgetProfile,
  ContextBudgetTurnCategory,
} from '../../shared/context-budget.js';
import type { MemoryWithheldReasonCounts } from '../../faculties/memory/withheld-summary.js';

export type ContextManifestCompositionalMode =
  | 'disabled_policy'
  | 'llm_unavailable'
  | 'insufficient_candidates'
  | 'malformed_or_failed'
  | 'applied';

export interface ContextManifestMemorySeed {
  reason?: string;
  retrievalSource?: 'embedding' | 'lexical_fallback';
  candidateCount?: number;
  policyAllowedCount?: number;
  rankedCount?: number;
  returnedCount?: number;
  retrievalLimit?: number;
  retrievalBudgetPct?: number;
  retrievalTokenBudget?: number;
  retrievalLimitMode?: 'budget' | 'hard_limit';
  contactScopeRejectedCount?: number;
  sensitivityRejectedCount?: number;
  policyRejectedCount?: number;
  policyRejectedReasonTags?: Record<string, number>;
  withheldCount?: number;
  withheldReasonCounts?: MemoryWithheldReasonCounts;
  scoreRejectedCount?: number;
  budgetCappedCount?: number;
  selectedTypes?: Record<string, number>;
  compositionalMode?: ContextManifestCompositionalMode;
}

export type ContextManifestSection =
  | 'system_prompt'
  | 'orientation'
  | 'memories'
  | 'compaction_summary'
  | 'continuity'
  | 'session_history';

export interface ContextManifestSectionUsage {
  section: ContextManifestSection;
  tokenCount: number;
}

export interface ContextManifestBudgetSummary {
  mode: 'budget' | 'hard_limit';
  budgetPct: number;
  tokenBudget: number;
  estimatedCount: number;
  hardLimit?: number;
  actualCount: number;
  actualTokenCount: number;
}

export interface ContextManifestAdaptiveBudgetSummary
  extends Pick<AdaptiveContextBudgetProfile, 'enabled' | 'source'> {
  category: ContextBudgetTurnCategory;
}

export interface ContextManifestMemorySummary {
  includedCount: number;
  includedTypes: Record<string, number>;
  includedTokenCount: number;
  reason: string;
  retrievalSource?: 'embedding' | 'lexical_fallback';
  candidateCount: number;
  policyAllowedCount: number;
  rankedCount: number;
  returnedCount: number;
  excluded: {
    contactScopeRejectedCount?: number;
    sensitivityRejectedCount: number;
    policyRejectedCount: number;
    policyRejectedReasonTags?: Record<string, number>;
    withheldCount?: number;
    withheldReasonCounts?: MemoryWithheldReasonCounts;
    scoreRejectedCount: number;
    budgetCappedCount: number;
  };
  retrieval: {
    mode: 'budget' | 'hard_limit';
    budgetPct: number;
    tokenBudget: number;
    limit: number;
    compositionalMode?: ContextManifestCompositionalMode;
  };
}

export interface ContextManifestSessionSummary {
  sourceEntryCount: number;
  trimmedEntryCount: number;
  maskedEntryCount: number;
  compactedEntryCount: number;
  intentionAppraisalArtifactCount?: number;
  finalEntryCount: number;
  finalMessageCount: number;
  compactionSummaryCount: number;
  continuityEntryCount: number;
}

export interface ContextManifestCompactionSummary {
  triggered: boolean;
  thresholdPct: number;
  tokenBudget: number;
  totalTokensBefore: number;
  totalTokensAfter: number;
}

export interface ContextManifest {
  channelId: string;
  generatedAt: number;
  session: ContextManifestSessionSummary;
  memory: ContextManifestMemorySummary;
  budgets: {
    contextWindow: number;
    adaptive: ContextManifestAdaptiveBudgetSummary;
    sessionHistory: ContextManifestBudgetSummary;
    memoryRetrieval: ContextManifestBudgetSummary;
    sections: ContextManifestSectionUsage[];
  };
  compaction: ContextManifestCompactionSummary;
}
