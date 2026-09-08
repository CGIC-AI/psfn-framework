// The Blind Reviewer section renders the gate's cumulative savings counter
// (bead psfn-framework-33xah) and nothing more about it: a count and the time
// of the last refusal. The counter is the only durable evidence that "an
// unchanged or undersized batch costs zero model calls" still holds in a live
// deployment, so a section that quietly stopped rendering it would take that
// evidence with it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('Blind Reviewer gate-savings section', () => {
  it('renders the cumulative counter from the projection', () => {
    expect(pageSource).toContain('Model calls avoided by the gate');
    expect(pageSource).toContain('{blindReview.gate.modelCallsAvoided}');
  });

  it('shows never rather than the epoch before the gate has refused a call', () => {
    expect(pageSource).toContain("blindReview.gate.modelCallsAvoidedAtMs === 0");
    expect(pageSource).toContain('formatTimestamp(blindReview.gate.modelCallsAvoidedAtMs)');
    // Same treatment the neighbouring timestamp cells already give a zero.
    expect(pageSource).toContain("blindReview.updatedAtMs === 0 ? 'never'");
  });

  it('carries only the count and its timestamp, never a per-reason breakdown', () => {
    // The gate's skip reasons name evidence properties. The section reports
    // what the gate saved, not which batches it was refusing.
    for (const reason of ['undersized_content', 'unchanged_digest']) {
      expect(pageSource).not.toContain(`modelCallsAvoided.${reason}`);
    }
    expect(pageSource).not.toContain('modelCallsAvoidedByReason');
  });
});
