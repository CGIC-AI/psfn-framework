import type { ToolCallOutcomeCounts } from './tool-call-outcome.js';

export const REFLECTION_EVIDENCE_GROUNDING_DEGRADED_FLAG =
  'reflection_evidence_grounding_degraded';
export const REFLECTION_EVIDENCE_GROUNDING_UNAVAILABLE_TAG =
  'evidence-grounding-unavailable';
export const REFLECTION_DEGRADED_TAG = 'degraded';
export const REFLECTION_EVIDENCE_GROUNDING_DEGRADED_HEADING =
  '[Evidence Grounding Degraded]';

/**
 * Why a protected reflection ran on less evidence than it asked for
 * (psfn-framework-lpxg3.2). Each cause is a distinct, honest statement:
 *
 * - `grounding_exhausted`: the bounded grounding step itself ran out of time or
 *   turn budget, so no evidence note exists.
 * - `content_withheld`: grounding ran, and intake screening admitted nothing
 *   from at least one optional read.
 * - `screening_unavailable`: the screener failed, so at least one optional read
 *   has no verdict and was withheld fail-closed.
 * - `partial_result`: at least one optional read delivered part of what was
 *   asked for.
 *
 * None of them licenses inference about the missing evidence: the whole point
 * of naming the cause is that the reflection can say "I could not see this"
 * instead of treating silence as absence or as fact.
 */
export const REFLECTION_EVIDENCE_DEGRADATION_CAUSES = [
  'grounding_exhausted',
  'content_withheld',
  'screening_unavailable',
  'partial_result',
] as const;

export type ReflectionEvidenceDegradationCause =
  typeof REFLECTION_EVIDENCE_DEGRADATION_CAUSES[number];

export const REFLECTION_EVIDENCE_DEGRADATION_TAGS: Readonly<
  Record<ReflectionEvidenceDegradationCause, string>
> = Object.freeze({
  grounding_exhausted: REFLECTION_EVIDENCE_GROUNDING_UNAVAILABLE_TAG,
  content_withheld: 'evidence-content-withheld',
  screening_unavailable: 'evidence-screening-unavailable',
  partial_result: 'evidence-partial',
});

/**
 * The single sentence added to the reflection prompt for each cause. Every one
 * is content-free (it never names the withheld artifact) and every one repeats
 * the same instruction: continue from what IS present, do not infer what is
 * missing.
 */
export const REFLECTION_EVIDENCE_DEGRADATION_PROMPT_LINES: Readonly<
  Record<ReflectionEvidenceDegradationCause, string>
> = Object.freeze({
  grounding_exhausted:
    'Optional read-only tool grounding was unavailable for this run. '
    + 'Continue from the bounded starter evidence already present; do not infer missing evidence.',
  content_withheld:
    'An optional read-only lookup was held by intake screening for this run, so its content is not present. '
    + 'Continue from the bounded starter evidence already present; treat the held material as unseen, '
    + 'not as absent and not as known, and do not infer what it contained.',
  screening_unavailable:
    'Intake screening could not reach a verdict for an optional read-only lookup, so its content was withheld. '
    + 'Continue from the bounded starter evidence already present; do not infer what the withheld read contained.',
  partial_result:
    'An optional read-only lookup returned only part of what was requested. '
    + 'Continue from the evidence actually present and say so where it is incomplete; '
    + 'do not extrapolate the missing part.',
});

/**
 * Precedence when a single grounding run hits several causes: the reflection
 * carries ONE cause, and the strongest evidence loss wins. A missing verdict
 * (`screening_unavailable`) outranks a decided hold, which outranks a partial
 * read, because each states less about what was there than the one before it.
 */
const CAUSE_PRECEDENCE: readonly ReflectionEvidenceDegradationCause[] = [
  'grounding_exhausted',
  'screening_unavailable',
  'content_withheld',
  'partial_result',
];

/**
 * The degraded-evidence cause implied by one completed grounding turn's
 * content-free outcome census, or `null` when nothing was degraded.
 *
 * Only degraded-evidence outcomes count. An ordinary tool failure is NOT
 * silently reclassified as degraded evidence here: it stays a failure for the
 * caller that owns it.
 */
export function resolveReflectionEvidenceDegradationCause(
  counts: ToolCallOutcomeCounts | undefined,
): ReflectionEvidenceDegradationCause | null {
  if (!counts) return null;
  if (counts.screening_unavailable > 0) return 'screening_unavailable';
  if (counts.content_withheld > 0) return 'content_withheld';
  if (counts.partial_result > 0) return 'partial_result';
  return null;
}

/** Whichever of two observed causes states the greater evidence loss. */
export function strongerReflectionEvidenceDegradationCause(
  left: ReflectionEvidenceDegradationCause | null,
  right: ReflectionEvidenceDegradationCause | null,
): ReflectionEvidenceDegradationCause | null {
  if (!left) return right;
  if (!right) return left;
  return CAUSE_PRECEDENCE.indexOf(left) <= CAUSE_PRECEDENCE.indexOf(right) ? left : right;
}
