import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_LOG_REFUSAL_PATTERNS,
  COMPACTION_REFUSAL_PATTERNS,
  matchesRefusalPatterns,
} from './refusal-patterns.js';

describe('refusal patterns', () => {
  it('matches shared refusal phrasings for compaction tagging', () => {
    expect(matchesRefusalPatterns(
      'I cannot help with bypassing license checks.',
      COMPACTION_REFUSAL_PATTERNS,
    )).toBe(true);
    expect(matchesRefusalPatterns(
      'We refuse to provide that.',
      COMPACTION_REFUSAL_PATTERNS,
    )).toBe(true);
    expect(matchesRefusalPatterns(
      'I am unable to assist with this.',
      COMPACTION_REFUSAL_PATTERNS,
    )).toBe(true);
  });

  it('preserves boundary-log-specific refusal extensions', () => {
    const supportRefusal = 'I cannot support that request.';
    expect(matchesRefusalPatterns(supportRefusal, COMPACTION_REFUSAL_PATTERNS)).toBe(false);
    expect(matchesRefusalPatterns(supportRefusal, BOUNDARY_LOG_REFUSAL_PATTERNS)).toBe(true);

    const policyRefusal = 'That is against policy and safety constraints.';
    expect(matchesRefusalPatterns(policyRefusal, COMPACTION_REFUSAL_PATTERNS)).toBe(false);
    expect(matchesRefusalPatterns(policyRefusal, BOUNDARY_LOG_REFUSAL_PATTERNS)).toBe(true);
  });
});
