import { describe, expect, it } from 'vitest';
import { isStreamEligible } from './eligibility.js';
import type { EligibilityCriterion, TurnPreparation } from './types.js';

function eligiblePrep(overrides: Partial<TurnPreparation> = {}): TurnPreparation {
  return {
    turnId: 'turn-1',
    cancellationId: 'cancel-1',
    toolDispatch: 'tool_free',
    hasAttachmentInput: false,
    isVisionTurn: false,
    broadcast: false,
    fatigueSuppressed: false,
    liveGeneration: true,
    risk: {
      trustLevel: 0.9,
      trustThreshold: 0.5,
      hasPendingPaidDeliverable: false,
      contactContext: 'dm_known_contact',
    },
    ...overrides,
  };
}

describe('isStreamEligible', () => {
  it('is eligible when every criterion holds', () => {
    const result = isStreamEligible(eligiblePrep());
    expect(result.eligible).toBe(true);
    expect(result.failed).toEqual([]);
  });

  const singleFailures: ReadonlyArray<[string, Partial<TurnPreparation>, EligibilityCriterion]> = [
    ['E1: tool-capable dispatch', { toolDispatch: 'tool_capable' }, 'E1_tool_free'],
    ['E2: attachment input', { hasAttachmentInput: true }, 'E2_no_vision_attachment'],
    ['E2: vision turn', { isVisionTurn: true }, 'E2_no_vision_attachment'],
    ['E3: broadcast channel', { broadcast: true }, 'E3_not_broadcast'],
    ['E4: fatigue-suppressed', { fatigueSuppressed: true }, 'E4_not_fatigue_suppressed'],
    ['E6: not live generation', { liveGeneration: false }, 'E6_live_generation'],
    ['E5: trust below threshold', {
      risk: {
        trustLevel: 0.2,
        trustThreshold: 0.5,
        hasPendingPaidDeliverable: false,
        contactContext: 'dm_known_contact',
      },
    }, 'E5_not_high_risk'],
    ['E5: pending paid deliverable', {
      risk: {
        trustLevel: 0.9,
        trustThreshold: 0.5,
        hasPendingPaidDeliverable: true,
        contactContext: 'dm_known_contact',
      },
    }, 'E5_not_high_risk'],
    ['E5: group known context', {
      risk: {
        trustLevel: 0.9,
        trustThreshold: 0.5,
        hasPendingPaidDeliverable: false,
        contactContext: 'group_known',
      },
    }, 'E5_not_high_risk'],
    ['E5: unknown contact', {
      risk: {
        trustLevel: 0.9,
        trustThreshold: 0.5,
        hasPendingPaidDeliverable: false,
        contactContext: 'unknown_contact',
      },
    }, 'E5_not_high_risk'],
  ];

  it.each(singleFailures)('is ineligible for %s', (_label, overrides, criterion) => {
    const result = isStreamEligible(eligiblePrep(overrides));
    expect(result.eligible).toBe(false);
    expect(result.failed).toEqual([criterion]);
  });

  it('reports trust exactly at threshold as low-risk (boundary inclusive)', () => {
    const result = isStreamEligible(eligiblePrep({
      risk: {
        trustLevel: 0.5,
        trustThreshold: 0.5,
        hasPendingPaidDeliverable: false,
        contactContext: 'dm_known_contact',
      },
    }));
    expect(result.eligible).toBe(true);
  });

  it('collects all failing criteria in deterministic E1..E6 order', () => {
    const result = isStreamEligible(eligiblePrep({
      toolDispatch: 'tool_capable',
      isVisionTurn: true,
      broadcast: true,
      fatigueSuppressed: true,
      liveGeneration: false,
      risk: {
        trustLevel: 0,
        trustThreshold: 0.5,
        hasPendingPaidDeliverable: true,
        contactContext: 'unknown_contact',
      },
    }));
    expect(result.eligible).toBe(false);
    expect(result.failed).toEqual([
      'E1_tool_free',
      'E2_no_vision_attachment',
      'E3_not_broadcast',
      'E4_not_fatigue_suppressed',
      'E5_not_high_risk',
      'E6_live_generation',
    ]);
  });

  it('is total: never throws on adversarial numeric inputs', () => {
    expect(() => isStreamEligible(eligiblePrep({
      risk: {
        trustLevel: Number.NaN,
        trustThreshold: Number.NaN,
        hasPendingPaidDeliverable: false,
        contactContext: 'dm_known_contact',
      },
    }))).not.toThrow();
  });
});
