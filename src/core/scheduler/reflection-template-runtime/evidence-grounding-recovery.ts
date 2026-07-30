import { ParentTurnContinuationBudgetExceededError } from '../../agent/turn-limits.js';
import { classifyLLMError } from '../../../primitives/llm/error-classify.js';
import {
  REFLECTION_DEGRADED_TAG,
  REFLECTION_EVIDENCE_GROUNDING_DEGRADED_FLAG,
  REFLECTION_EVIDENCE_GROUNDING_DEGRADED_HEADING,
  REFLECTION_EVIDENCE_GROUNDING_UNAVAILABLE_TAG,
} from '../../../shared/contracts/reflection-degradation.js';

export const REFLECTION_EVIDENCE_GROUNDING_DEGRADATION = Object.freeze({
  promptSection: `${REFLECTION_EVIDENCE_GROUNDING_DEGRADED_HEADING}\n`
    + 'Optional read-only tool grounding was unavailable for this run. '
    + 'Continue from the bounded starter evidence already present; do not infer missing evidence.',
  metacognitiveFlag: Object.freeze({
    flag: REFLECTION_EVIDENCE_GROUNDING_DEGRADED_FLAG,
    confidence: 1,
    evidence: 'Optional read-only evidence grounding was unavailable; reflection used bounded starter evidence.',
  }),
  dailyJournalTags: Object.freeze([
    REFLECTION_DEGRADED_TAG,
    REFLECTION_EVIDENCE_GROUNDING_UNAVAILABLE_TAG,
  ]),
});

/**
 * Evidence grounding is optional only when its bounded execution time is
 * exhausted. Unknown, cancellation, policy, configuration, and contention
 * errors remain terminal so the scheduler can retry or surface the failure.
 */
export function isRecoverableEvidenceGroundingExhaustion(error: unknown): boolean {
  if (error instanceof ParentTurnContinuationBudgetExceededError) {
    return true;
  }
  return classifyLLMError(error).category === 'timeout';
}

