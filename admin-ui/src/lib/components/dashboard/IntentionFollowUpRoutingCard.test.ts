import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import IntentionFollowUpRoutingCard from './IntentionFollowUpRoutingCard.svelte';

describe('Garden intention follow-up routing projection', () => {
  it('renders effective horizon and bounded store evidence without companion content', () => {
    const body = render(IntentionFollowUpRoutingCard, {
      props: {
        routing: {
          horizonSource: 'effective_scheduler_config',
          nearTermHorizonMs: 259_200_000,
          evidenceLimit: 200,
          observedAtMs: Date.parse('2026-08-20T12:00:00.000Z'),
          handoff: {
            disposition: 'handoff',
            reason: 'active_pending_follow_up',
            available: true,
            observedCount: 2,
            earliestDueAtMs: Date.parse('2026-08-20T13:00:00.000Z'),
            atReadLimit: false,
          },
          scheduled: {
            disposition: 'scheduled',
            reason: 'pending_intention_scheduled_prompt',
            available: true,
            observedCount: 1,
            earliestDueAtMs: Date.parse('2026-09-20T12:00:00.000Z'),
            atReadLimit: false,
          },
        },
      },
    }).body;

    expect(body).toContain('Intention routing');
    expect(body).toContain('3 days');
    expect(body).toContain('Handoff');
    expect(body).toContain('2 observed');
    expect(body).toContain('Active pending follow-up store');
    expect(body).toContain('Scheduled');
    expect(body).toContain('1 observed');
    expect(body).toContain('Pending intention scheduler records');
    expect(body).toMatch(
      /Observed <time datetime="2026-08-20T12:00:00\.000Z"[^>]*>2026-08-20T12:00:00\.000Z<\/time>/u,
    );
    expect(body).toContain('2026-08-20T13:00:00.000Z');
    expect(body).toContain('2026-09-20T12:00:00.000Z');
    expect(body).not.toMatch(/content|channel|contact|author/iu);
  });

  it('labels unavailable evidence instead of implying an empty queue', () => {
    const body = render(IntentionFollowUpRoutingCard, {
      props: {
        routing: {
          horizonSource: 'unavailable',
          nearTermHorizonMs: null,
          evidenceLimit: 200,
          observedAtMs: Date.parse('2026-08-20T12:00:00.000Z'),
          handoff: {
            disposition: 'handoff',
            reason: 'active_pending_follow_up',
            available: false,
            observedCount: null,
            earliestDueAtMs: null,
            atReadLimit: false,
          },
          scheduled: {
            disposition: 'scheduled',
            reason: 'pending_intention_scheduled_prompt',
            available: false,
            observedCount: null,
            earliestDueAtMs: null,
            atReadLimit: false,
          },
        },
      },
    }).body;

    expect(body).toContain('Runtime horizon unavailable');
    expect(body.match(/Evidence unavailable/gu)).toHaveLength(2);
    expect(body).not.toContain('0 observed');
  });
});
