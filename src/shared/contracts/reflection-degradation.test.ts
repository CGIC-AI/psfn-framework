import { describe, expect, it } from 'vitest';
import { createEmptyToolCallOutcomeCounts } from './tool-call-outcome.js';
import {
  REFLECTION_EVIDENCE_DEGRADATION_CAUSES,
  REFLECTION_EVIDENCE_DEGRADATION_PROMPT_LINES,
  REFLECTION_EVIDENCE_DEGRADATION_TAGS,
  resolveReflectionEvidenceDegradationCause,
  strongerReflectionEvidenceDegradationCause,
} from './reflection-degradation.js';

describe('reflection evidence degradation causes (psfn-framework-lpxg3.2)', () => {
  it('gives every cause a distinct tag and a prompt line that forbids inference', () => {
    const tags = REFLECTION_EVIDENCE_DEGRADATION_CAUSES
      .map(cause => REFLECTION_EVIDENCE_DEGRADATION_TAGS[cause]);
    expect(new Set(tags).size).toBe(REFLECTION_EVIDENCE_DEGRADATION_CAUSES.length);
    for (const cause of REFLECTION_EVIDENCE_DEGRADATION_CAUSES) {
      const line = REFLECTION_EVIDENCE_DEGRADATION_PROMPT_LINES[cause];
      expect(line).toMatch(/do not infer|do not extrapolate/i);
      expect(line).toMatch(/continue from/i);
    }
  });

  it('reads nothing degraded from a clean or absent census', () => {
    expect(resolveReflectionEvidenceDegradationCause(undefined)).toBeNull();
    expect(resolveReflectionEvidenceDegradationCause({
      ...createEmptyToolCallOutcomeCounts(),
      success: 3,
    })).toBeNull();
  });

  it('degrades on a failed, denied, or skipped optional read', () => {
    // The grounding turn absorbed these; if the reflection did not learn the
    // evidence is missing here, it would reason as if the read came back empty.
    for (const counts of [
      { execution_failure: 2 },
      { policy_denial: 1 },
      { dependency_skip: 1 },
    ]) {
      expect(resolveReflectionEvidenceDegradationCause({
        ...createEmptyToolCallOutcomeCounts(),
        success: 1,
        ...counts,
      })).toBe('read_failed');
    }
  });

  it('leaves a clean run with skipped duplicates undegraded', () => {
    expect(resolveReflectionEvidenceDegradationCause({
      ...createEmptyToolCallOutcomeCounts(),
      success: 2,
      duplicate_skip: 1,
    })).toBeNull();
  });

  it('reports the strongest evidence loss when several occur in one run', () => {
    expect(resolveReflectionEvidenceDegradationCause({
      ...createEmptyToolCallOutcomeCounts(),
      partial_result: 3,
      content_withheld: 1,
      screening_unavailable: 1,
    })).toBe('screening_unavailable');
    expect(resolveReflectionEvidenceDegradationCause({
      ...createEmptyToolCallOutcomeCounts(),
      partial_result: 3,
      content_withheld: 1,
    })).toBe('content_withheld');
    expect(resolveReflectionEvidenceDegradationCause({
      ...createEmptyToolCallOutcomeCounts(),
      partial_result: 3,
      execution_failure: 1,
    })).toBe('read_failed');
    expect(resolveReflectionEvidenceDegradationCause({
      ...createEmptyToolCallOutcomeCounts(),
      partial_result: 1,
    })).toBe('partial_result');
  });

  it('ranks an exhausted grounding above every completed-run cause', () => {
    expect(strongerReflectionEvidenceDegradationCause('grounding_exhausted', 'content_withheld'))
      .toBe('grounding_exhausted');
    expect(strongerReflectionEvidenceDegradationCause('partial_result', 'content_withheld'))
      .toBe('content_withheld');
    expect(strongerReflectionEvidenceDegradationCause(null, 'partial_result'))
      .toBe('partial_result');
    expect(strongerReflectionEvidenceDegradationCause(null, null)).toBeNull();
  });
});
