import { describe, expect, it, vi } from 'vitest';
import { runConcernFollowUpOutreachOnce, type ConcernFollowUpOutreachDeps } from './concern-follow-up-outreach.js';
import type { ActiveConcern } from './concerns.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-23T15:00:00.000Z');

function concern(overrides: Partial<ActiveConcern> = {}): ActiveConcern {
  return {
    id: 'concern-1',
    text: 'Mo had a job interview',
    priority: 'medium',
    source: 'appraisal',
    status: 'active',
    contactId: 'contact-human',
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    expiresAt: new Date(NOW + 24 * HOUR).toISOString(),
    nextReviewAt: new Date(NOW - HOUR).toISOString(),
    ...overrides,
  } as ActiveConcern;
}

function deps(
  concerns: ActiveConcern[],
  decision: Awaited<ReturnType<ConcernFollowUpOutreachDeps['consentEvaluator']['evaluate']>>,
  overrides: Partial<ConcernFollowUpOutreachDeps> = {},
) {
  const transitionConcernStatus = vi.fn(async () => concerns[0]!);
  const evaluate = vi.fn(async () => decision);
  return {
    transitionConcernStatus,
    evaluate,
    deps: {
      concerns: { list: async () => concerns, transitionConcernStatus },
      consentEvaluator: { evaluate },
      resolveDeliveryChannel: async () => ({
        channelId: 'dm-primary', channelType: 'discord' as const, contactName: 'Mo', companionTarget: false,
      }),
      deferDelayMs: 3 * HOUR,
      maxPerRun: 1,
      ...overrides,
    } satisfies ConcernFollowUpOutreachDeps,
  };
}

describe('due concern follow-up outreach', () => {
  it('asks only about due concerns with a contact and produces concern-provenance outbound', async () => {
    const harness = deps([
      concern(),
      concern({ id: 'not-due', nextReviewAt: new Date(NOW + HOUR).toISOString() }),
      concern({ id: 'no-contact', contactId: undefined }),
    ], { action: 'message', content: 'How did the interview go?' });
    const result = await runConcernFollowUpOutreachOnce(harness.deps, NOW);
    expect(harness.evaluate).toHaveBeenCalledOnce();
    expect(harness.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-human',
      reason: 'You meant to follow up with them about this: Mo had a job interview',
    }));
    expect(result.produced).toEqual([expect.objectContaining({
      concernId: 'concern-1',
      candidate: expect.objectContaining({
        payload: expect.objectContaining({ content: 'How did the interview go?', concernIds: ['concern-1'] }),
      }),
    })]);
    // Held durably before the turn, then cleared once she answered.
    expect(harness.transitionConcernStatus.mock.calls.map(([, input]) => input)).toEqual([
      { status: 'active', nextReviewAt: new Date(NOW + 3 * HOUR).toISOString() },
      { status: 'active', clearNextReview: true },
    ]);
  });

  it('re-queues on later and stops asking when there is no private route', async () => {
    const later = deps([concern()], { action: 'defer' });
    await expect(runConcernFollowUpOutreachOnce(later.deps, NOW)).resolves.toMatchObject({ deferred: ['concern-1'] });
    expect(later.transitionConcernStatus).toHaveBeenCalledOnce();

    const noRoute = deps([concern()], { action: 'decline' }, { resolveDeliveryChannel: async () => null });
    await expect(runConcernFollowUpOutreachOnce(noRoute.deps, NOW)).resolves.toMatchObject({
      blocked: [{ concernId: 'concern-1', reason: 'no_delivery_channel' }],
    });
    expect(noRoute.evaluate).not.toHaveBeenCalled();
  });

  it('waits out quiet hours without asking', async () => {
    const quiet = deps([concern()], { action: 'decline' }, {
      quietHours: { enabled: true, startLocalTime: '14:00', endLocalTime: '20:00', timeZone: 'UTC' },
    });
    await expect(runConcernFollowUpOutreachOnce(quiet.deps, NOW)).resolves.toMatchObject({ asked: 0 });
    expect(quiet.transitionConcernStatus).not.toHaveBeenCalled();
  });
});
