import { describe, expect, it } from 'vitest';
import { boundContextSummary, MAX_CONTEXT_SUMMARY_CHARS } from './context-summary.js';
import { parseDecisionResponse } from './appraisal/decision-parser.js';
import { DEFAULT_SYSTEM_PROMPT } from './appraisal/types.js';

describe('boundContextSummary', () => {
  it('keeps any summary up to the limit unchanged, collapsing whitespace', () => {
    expect(MAX_CONTEXT_SUMMARY_CHARS).toBe(1000);
    expect(boundContextSummary('  a\n\tshort   summary ')).toBe('a short summary');
    const exact = 'x'.repeat(MAX_CONTEXT_SUMMARY_CHARS);
    expect(boundContextSummary(exact)).toBe(exact);
  });

  it('truncates an over-long summary at a word boundary and marks the cut', () => {
    const words = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ');
    const bounded = boundContextSummary(words)!;
    expect(bounded.length).toBeLessThanOrEqual(MAX_CONTEXT_SUMMARY_CHARS);
    expect(bounded.endsWith('…')).toBe(true);
    const kept = bounded.slice(0, -1);
    expect(words.startsWith(`${kept} `)).toBe(true);
  });

  it('hard-cuts a single over-long word rather than dropping it', () => {
    const bounded = boundContextSummary('y'.repeat(MAX_CONTEXT_SUMMARY_CHARS + 50))!;
    expect(bounded).toHaveLength(MAX_CONTEXT_SUMMARY_CHARS);
    expect(bounded.endsWith('…')).toBe(true);
  });

  it('returns undefined for absent or blank input', () => {
    expect(boundContextSummary(undefined)).toBeUndefined();
    expect(boundContextSummary(null)).toBeUndefined();
    expect(boundContextSummary('   ')).toBeUndefined();
  });
});

describe('appraisal contextSummary bound', () => {
  it('states the limit in the appraisal prompt', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain(
      `Keep it to at most ${MAX_CONTEXT_SUMMARY_CHARS} characters; anything longer is truncated.`,
    );
  });

  it('keeps an over-long followUp decision, truncating only its contextSummary', () => {
    const parsed = parseDecisionResponse(JSON.stringify({
      decisions: [{
        type: 'followUp',
        priority: 'medium',
        reason: 'check back later',
        timing: 'soon',
        followUp: {
          content: 'Ask how the interview went.',
          contextSummary: 'They were nervous about the interview. '.repeat(60),
        },
      }],
    }), 4);
    expect(parsed.decisions).toHaveLength(1);
    const summary = parsed.decisions[0]?.followUp?.contextSummary;
    expect(summary?.length).toBeLessThanOrEqual(MAX_CONTEXT_SUMMARY_CHARS);
    expect(summary?.startsWith('They were nervous about the interview.')).toBe(true);
  });
});
