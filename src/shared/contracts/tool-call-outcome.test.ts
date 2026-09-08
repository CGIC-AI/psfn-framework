import { describe, expect, it } from 'vitest';
import {
  blocksSequentialDependents,
  classifyExecutedToolCallOutcome,
  countToolCallOutcomes,
  createEmptyToolCallOutcomeCounts,
  DEGRADED_EVIDENCE_TOOL_CALL_OUTCOMES,
  isDegradedEvidenceToolCallOutcome,
  isToolCallErrorOutcome,
  PARTIAL_TOOL_RESULT_DETAILS_KEY,
  TOOL_CALL_OUTCOMES,
} from './tool-call-outcome.js';

describe('degraded-evidence tool-call outcomes (psfn-framework-lpxg3.2)', () => {
  it('names every degraded outcome in the canonical taxonomy and the empty census', () => {
    const counts = createEmptyToolCallOutcomeCounts();
    for (const outcome of DEGRADED_EVIDENCE_TOOL_CALL_OUTCOMES) {
      expect(TOOL_CALL_OUTCOMES).toContain(outcome);
      expect(counts[outcome]).toBe(0);
    }
    expect(Object.keys(counts).sort()).toEqual([...TOOL_CALL_OUTCOMES].sort());
  });

  it('treats a hold and a partial read as non-failures and a missing verdict as a failure', () => {
    expect(isToolCallErrorOutcome('content_withheld')).toBe(false);
    expect(isToolCallErrorOutcome('partial_result')).toBe(false);
    expect(isToolCallErrorOutcome('screening_unavailable')).toBe(true);
    expect(isToolCallErrorOutcome('execution_failure')).toBe(true);
    expect(isToolCallErrorOutcome('success')).toBe(false);
  });

  it('classifies degraded outcomes as degraded and ordinary ones as not', () => {
    expect(isDegradedEvidenceToolCallOutcome('content_withheld')).toBe(true);
    expect(isDegradedEvidenceToolCallOutcome('screening_unavailable')).toBe(true);
    expect(isDegradedEvidenceToolCallOutcome('partial_result')).toBe(true);
    expect(isDegradedEvidenceToolCallOutcome('policy_denial')).toBe(false);
    expect(isDegradedEvidenceToolCallOutcome('success')).toBe(false);
  });

  it('halts required dependents on degraded evidence and releases optional ones', () => {
    for (const outcome of ['content_withheld', 'screening_unavailable'] as const) {
      expect(blocksSequentialDependents(outcome, 'required')).toBe(true);
      expect(blocksSequentialDependents(outcome, 'optional')).toBe(false);
    }
    expect(blocksSequentialDependents('partial_result', 'required')).toBe(false);
  });

  it('keeps real failures terminal no matter what the consumer declared', () => {
    for (const outcome of ['execution_failure', 'policy_denial', 'validation_rejection'] as const) {
      expect(blocksSequentialDependents(outcome, 'required')).toBe(true);
      expect(blocksSequentialDependents(outcome, 'optional')).toBe(true);
    }
  });

  it('reads a partial result only from a tool-declared structural signal', () => {
    expect(classifyExecutedToolCallOutcome({
      details: { [PARTIAL_TOOL_RESULT_DETAILS_KEY]: true },
      isError: false,
    })).toBe('partial_result');
    // Free text is never evidence of partiality.
    expect(classifyExecutedToolCallOutcome({
      details: { note: 'result was truncated and partial' },
      isError: false,
    })).toBe('success');
    // A declared partial never outranks an actual failure.
    expect(classifyExecutedToolCallOutcome({
      details: { [PARTIAL_TOOL_RESULT_DETAILS_KEY]: true },
      isError: true,
    })).toBe('execution_failure');
  });

  it('counts explicit degraded outcomes in a turn census', () => {
    expect(countToolCallOutcomes([
      { outcome: 'success' },
      { outcome: 'content_withheld' },
      { outcome: 'content_withheld' },
      { outcome: 'partial_result' },
      { outcome: 'screening_unavailable' },
    ])).toMatchObject({
      success: 1,
      content_withheld: 2,
      partial_result: 1,
      screening_unavailable: 1,
    });
  });
});
