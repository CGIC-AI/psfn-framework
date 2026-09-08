import { ParentTurnContinuationBudgetExceededError } from '../../agent/turn-limits.js';
import { classifyLLMError } from '../../../primitives/llm/error-classify.js';
import type { ToolCallOutcomeCounts } from '../../../shared/contracts/tool-call-outcome.js';
import {
  REFLECTION_DEGRADED_TAG,
  REFLECTION_EVIDENCE_DEGRADATION_PROMPT_LINES,
  REFLECTION_EVIDENCE_DEGRADATION_TAGS,
  REFLECTION_EVIDENCE_GROUNDING_DEGRADED_FLAG,
  REFLECTION_EVIDENCE_GROUNDING_DEGRADED_HEADING,
  resolveReflectionEvidenceDegradationCause,
  type ReflectionEvidenceDegradationCause,
} from '../../../shared/contracts/reflection-degradation.js';

export interface ReflectionEvidenceDegradation {
  cause: ReflectionEvidenceDegradationCause;
  /** Appended to the reflection prompt. Content-free; names no artifact. */
  promptSection: string;
  /** Persisted so the reflection carries an explicit degraded flag. */
  metacognitiveFlag: {
    flag: typeof REFLECTION_EVIDENCE_GROUNDING_DEGRADED_FLAG;
    confidence: number;
    evidence: string;
  };
  /** Journal tags, so a degraded run is filterable after the fact. */
  dailyJournalTags: readonly string[];
}

function buildDegradation(
  cause: ReflectionEvidenceDegradationCause,
): ReflectionEvidenceDegradation {
  const line = REFLECTION_EVIDENCE_DEGRADATION_PROMPT_LINES[cause];
  return Object.freeze({
    cause,
    promptSection: `${REFLECTION_EVIDENCE_GROUNDING_DEGRADED_HEADING}\n${line}`,
    metacognitiveFlag: Object.freeze({
      flag: REFLECTION_EVIDENCE_GROUNDING_DEGRADED_FLAG,
      confidence: 1,
      evidence: line,
    }),
    dailyJournalTags: Object.freeze([
      REFLECTION_DEGRADED_TAG,
      REFLECTION_EVIDENCE_DEGRADATION_TAGS[cause],
    ]),
  });
}

/**
 * The original bounded-timeout degradation (kept as its own export so the
 * exhaustion path and its tests keep one stable identity). Its tag remains
 * `evidence-grounding-unavailable`.
 */
export const REFLECTION_EVIDENCE_GROUNDING_DEGRADATION: ReflectionEvidenceDegradation =
  buildDegradation('grounding_exhausted');

/**
 * Degraded-evidence continuation for a grounding turn that COMPLETED
 * (psfn-framework-lpxg3.2). The bounded-timeout path above only fires when the
 * grounding turn throws; the common case is a turn that finishes while one of
 * its optional read-only lookups was withheld, unverdictable, or partial. That
 * shows up in the turn's content-free outcome census, and the reflection must
 * carry it explicitly rather than treat the gap as absence.
 *
 * Returns `null` when nothing was degraded.
 */
export function resolveCompletedGroundingDegradation(
  counts: ToolCallOutcomeCounts | undefined,
): ReflectionEvidenceDegradation | null {
  const cause = resolveReflectionEvidenceDegradationCause(counts);
  return cause === null ? null : buildDegradation(cause);
}

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
