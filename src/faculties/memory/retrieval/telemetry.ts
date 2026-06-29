import type { ContextManifestMemorySeed } from '../../../core/session/context-manifest.js';
import type { MemoryWithheldSummary } from '../withheld-summary.js';
import type { RetrievalTelemetry } from './types.js';

function hasCountEntries(record: Record<string, number | undefined> | undefined): boolean {
  return !!record && Object.values(record).some(count => count !== undefined && count > 0);
}

export function applyWithheldSummaryTelemetry(
  telemetry: RetrievalTelemetry,
  withheldSummary: MemoryWithheldSummary | undefined,
): void {
  telemetry.withheldCount = withheldSummary?.totalCount ?? 0;
  const reasonCounts = withheldSummary?.reasonCounts;
  if (hasCountEntries(reasonCounts)) {
    telemetry.withheldReasonCounts = { ...reasonCounts };
  }
  const relevanceBands = withheldSummary?.relevanceBands;
  if (hasCountEntries(relevanceBands)) {
    telemetry.withheldRelevanceBands = { ...relevanceBands };
  }
}

export function buildManifestSeedFromTelemetry(telemetry: RetrievalTelemetry): ContextManifestMemorySeed {
  return {
    reason: telemetry.reason,
    retrievalSource: telemetry.retrievalSource,
    candidateCount: telemetry.candidateCount,
    policyAllowedCount: telemetry.policyAllowedCount ?? 0,
    rankedCount: telemetry.rankedCount,
    returnedCount: telemetry.returnedCount,
    retrievalLimit: telemetry.retrievalLimit,
    retrievalBudgetPct: telemetry.retrievalBudgetPct,
    retrievalTokenBudget: telemetry.retrievalTokenBudget,
    retrievalLimitMode: telemetry.retrievalLimitMode,
    ...(telemetry.contactScopeRejectedCount !== undefined
      ? { contactScopeRejectedCount: telemetry.contactScopeRejectedCount }
      : {}),
    sensitivityRejectedCount: telemetry.sensitivityRejectedCount ?? 0,
    policyRejectedCount: telemetry.policyRejectedCount ?? 0,
    ...(telemetry.policyRejectedReasonTags
      ? { policyRejectedReasonTags: { ...telemetry.policyRejectedReasonTags } }
      : {}),
    ...(telemetry.withheldCount !== undefined ? { withheldCount: telemetry.withheldCount } : {}),
    ...(telemetry.withheldReasonCounts
      ? { withheldReasonCounts: { ...telemetry.withheldReasonCounts } }
      : {}),
    ...(telemetry.withheldRelevanceBands
      ? { withheldRelevanceBands: { ...telemetry.withheldRelevanceBands } }
      : {}),
    scoreRejectedCount: telemetry.scoreRejectedCount ?? 0,
    budgetCappedCount: telemetry.budgetCappedCount ?? 0,
    ...(telemetry.selectedTypes ? { selectedTypes: { ...telemetry.selectedTypes } } : {}),
    ...(telemetry.compositionalMode ? { compositionalMode: telemetry.compositionalMode } : {}),
  };
}
