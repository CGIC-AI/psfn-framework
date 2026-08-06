import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import RuleMatchProvenance from './RuleMatchProvenance.svelte';

describe('Garden L1 rule-match provenance', () => {
  it('renders rule ids with bounded match evidence in a security row', () => {
    const rendered = render(RuleMatchProvenance, {
      props: {
        matches: [{
          ruleId: 'persona_mutation_request',
          kind: 'phrase',
          startOffset: 12,
          endOffset: 37,
          excerpt: 'change your persona now',
        }],
      },
    });

    expect(rendered.body).toContain('L1 rules:');
    expect(rendered.body).toContain('persona_mutation_request');
    expect(rendered.body).toContain('phrase · 12..37');
    expect(rendered.body).toContain('change your persona now');
  });

  it('renders no provenance row for an existing envelope without the optional field', () => {
    expect(render(RuleMatchProvenance).body).not.toContain('L1 rules:');
  });

  it('surfaces isolated malformed provenance without rendering untrusted evidence', () => {
    const rendered = render(RuleMatchProvenance, {
      props: { matches: [], unavailable: true },
    });

    expect(rendered.body).toContain('L1 rule-match provenance is unavailable');
    expect(rendered.body).toContain('release is disabled');
    expect(rendered.body).not.toContain('L1 rules:');
  });

  it('states when bounded evidence omits additional rule matches', () => {
    const rendered = render(RuleMatchProvenance, {
      props: {
        matches: [{
          ruleId: 'injection_ignore_instructions',
          kind: 'phrase',
          startOffset: 0,
          endOffset: 32,
          excerpt: 'ignore all previous instructions',
        }],
        totalCount: 39,
        truncated: true,
      },
    });

    expect(rendered.body).toContain('Showing 1 of 39 rule matches');
    expect(rendered.body).toContain('additional evidence omitted by the safety cap');
  });
});
