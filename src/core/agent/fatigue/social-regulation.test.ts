import { describe, expect, it } from 'vitest';

import { makeTestFatiguePolicyConfig } from '../../../test-support/charge-policy.js';
import type { FatigueBudgetState } from './fatigue-budget.js';
import { projectFatigueSocialRegulation } from './social-regulation.js';

function makeState(input: {
  normalSpent: number;
  overchargeSpent?: number;
  softLimit?: number;
  hardLimit?: number;
  root?: boolean;
}): FatigueBudgetState {
  const hardLimit = input.hardLimit ?? 6;
  const overchargeSpent = input.overchargeSpent ?? 0;
  const overchargeAllowance = 2;
  return {
    scope: {
      localCompanionId: 'local',
      peerContactId: 'peer',
      channelId: 'channel',
      dayKey: '2027-01-15',
    },
    spent: input.normalSpent + overchargeSpent,
    normalSpent: input.normalSpent,
    overchargeSpent,
    remainingAllowance: Math.max(0, hardLimit - input.normalSpent),
    allowance: hardLimit,
    softLimit: input.softLimit ?? 4,
    overchargeAllowance,
    remainingOvercharge: overchargeAllowance - overchargeSpent,
    softState: input.normalSpent >= (input.softLimit ?? 4) ? 'soft_limit_reached' : 'clear',
    hardState: input.normalSpent >= hardLimit ? 'exhausted' : 'available',
    ...(input.root
      ? {
          regulation: {
            rootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            relationshipPressure: input.normalSpent,
            rootNormalSpent: input.normalSpent,
            rootOverchargeSpent: overchargeSpent,
            contributingEventCount: input.normalSpent + overchargeSpent,
          },
        }
      : {}),
  };
}

describe('ICP fatigue social regulation projection', () => {
  const config = makeTestFatiguePolicyConfig();

  it('honors owner-disabled continuation evidence without accepting message text', () => {
    const projection = projectFatigueSocialRegulation({
      config: {
        ...config,
        socialRegulation: {
          ...config.socialRegulation,
          continuationEvidence: {
            recentHumanParticipation: false,
            activeWorkOrResearch: true,
            explicitPeerInvitation: false,
          },
        },
      },
      decision: 'allowed_charged',
      policyBaseState: 'soft_exhausted',
      intent: 'research',
      taskKind: 'research',
      hasRecentHumanParticipation: true,
      explicitPeerInvitation: true,
      stateBefore: makeState({ normalSpent: 4, root: true }),
      amount: 1,
    });

    expect(projection.continuationEvidence).toEqual(['active_work_or_research']);
  });

  it('progresses from normal through maturation, social charge, wrap, and final closeout', () => {
    const project = (
      stateBefore: FatigueBudgetState,
      policyBaseState: Parameters<typeof projectFatigueSocialRegulation>[0]['policyBaseState'],
      decision: Parameters<typeof projectFatigueSocialRegulation>[0]['decision'],
    ) => projectFatigueSocialRegulation({
      config,
      decision,
      policyBaseState,
      intent: 'casual',
      hasRecentHumanParticipation: false,
      stateBefore,
      amount: 1,
    });

    expect(project(makeState({ normalSpent: 0, root: true }), 'normal', 'allowed_charged').state)
      .toBe('normal');
    expect(project(makeState({ normalSpent: 2, root: true }), 'normal', 'allowed_charged').state)
      .toBe('conversation_maturing');
    expect(project(makeState({ normalSpent: 3, root: true }), 'nearing_limit', 'allowed_charged').state)
      .toBe('nearing_soft_allowance');
    const social = project(
      makeState({ normalSpent: 4, root: true }),
      'soft_exhausted',
      'wrap_up_charged',
    );
    expect(social).toMatchObject({
      state: 'charge_lane_active',
      chargeLane: 'companion_social',
      marginalChargeUnits: 1,
    });
    expect(project(
      makeState({ normalSpent: 5, root: true }),
      'wrap_up_allowed',
      'wrap_up_charged',
    ).state).toBe('wrap_up_allowed');
    expect(projectFatigueSocialRegulation({
      config,
      decision: 'overcharge_charged',
      policyBaseState: 'hard_exhausted',
      intent: 'work',
      taskKind: 'work',
      hasRecentHumanParticipation: false,
      stateBefore: makeState({ normalSpent: 6, overchargeSpent: 1, root: true }),
      amount: 1,
    })).toMatchObject({
      state: 'final_closeout',
      closeoutReserveRemainingBefore: 1,
      closeoutReserveRemainingAfterProjected: 0,
      continuationEvidence: ['active_work_or_research'],
    });
  });

  it('does not let prose-derived importance manufacture trusted continuation evidence', () => {
    const projection = projectFatigueSocialRegulation({
      config,
      decision: 'overcharge_charged',
      policyBaseState: 'hard_exhausted',
      intent: 'work',
      hasRecentHumanParticipation: false,
      stateBefore: makeState({ normalSpent: 6, root: true }),
      amount: 1,
    });
    expect(projection.continuationEvidence).toEqual([]);
    expect(projection.closeoutReserveRemainingAfterProjected).toBe(1);
  });

  it('retains legacy non-ICP fatigue guidance without entering the social charge lane', () => {
    const projection = projectFatigueSocialRegulation({
      config,
      decision: 'wrap_up_charged',
      policyBaseState: 'soft_exhausted',
      intent: 'casual',
      hasRecentHumanParticipation: false,
      stateBefore: makeState({ normalSpent: 4 }),
      amount: 1,
    });
    expect(projection.state).toBe('charge_lane_active');
    expect(projection.chargeLane).toBe('interactive');
    expect(projection.marginalChargeUnits).toBe(0);
  });
});
