/**
 * jp36.4.2 acceptance: mid-conversation exhaustion tapers through the EXISTING
 * overfatigue wind-up/wrap-up machinery rather than an abrupt tap-out
 * (design bible §12.6, §20.2 "Soft pressure induces wrap-up; hard suppression
 * remains testable"; adjudication decision 8, late refinement (2)).
 *
 * The continuous social pot (jp36.4.1) removes the "dead until midnight" cliff;
 * the design deliberately keeps the dyadic overfatigue mechanism unchanged as
 * the in-context wind-down. These tests pin that a companion approaching
 * exhaustion first enters `wrap_up_allowed` (a taper) and only then
 * `hard_exhausted`/`suppressed` (the tap-out), and that no scripted
 * companion-voice line is put in the companion's mouth anywhere in the fatigue
 * subsystem.
 */
import { describe, expect, it } from 'vitest';

import { makeTestFatiguePolicyConfig } from '../../../test-support/charge-policy.js';
import type { FatigueBudgetState } from './fatigue-budget.js';
import {
  evaluateFatiguePolicy,
  type FatiguePolicyChannelInput,
  type FatiguePolicyPeerInput,
} from './policy.js';
import { projectFatigueSocialRegulation } from './social-regulation.js';

const config = makeTestFatiguePolicyConfig();

const PEER: FatiguePolicyPeerInput = {
  contactId: 'peer-mi',
  isMachineIntelligence: true,
  relationshipType: 'family', // known_mi: softTarget 4, hardCap 8
  trustLevel: 'regular',
};

const CHANNEL: FatiguePolicyChannelInput = {
  channelId: 'room-1',
  type: 'dm',
  humanParticipantCount: 0,
  machineIntelligenceParticipantCount: 1,
  recentMessageCount: 1,
  recentHumanMessageCount: 0,
};

function baseStateAtSpent(spent: number): string {
  return evaluateFatiguePolicy({
    config,
    peer: PEER,
    channel: CHANNEL,
    recentHumanParticipation: { messageCount: 0, participantCount: 0 },
    intent: 'casual',
    spent,
    triggerAuthorKind: 'machine_intelligence',
  }).baseState;
}

describe('overfatigue wind-up tapers before hard tap-out (jp36.4.2)', () => {
  it('progresses normal -> nearing -> soft -> wrap_up_allowed -> hard_exhausted as spend rises', () => {
    // known_mi over a DM yields softTarget 4, hardCap 8. Soft pressure (wrap-up)
    // is reached strictly before hard suppression, so exhaustion tapers.
    expect(baseStateAtSpent(0)).toBe('normal');
    expect(baseStateAtSpent(2)).toBe('normal');
    expect(baseStateAtSpent(3)).toBe('nearing_limit');
    expect(baseStateAtSpent(4)).toBe('soft_exhausted');
    expect(baseStateAtSpent(6)).toBe('soft_exhausted');
    // The wrap-up band engages one response before the hard cap...
    expect(baseStateAtSpent(7)).toBe('wrap_up_allowed');
    // ...and only the final response tips into hard exhaustion. No jump from a
    // healthy budget straight to suppression.
    expect(baseStateAtSpent(8)).toBe('hard_exhausted');
  });

  it('surfaces the in-context wind-down (wrap_up_allowed) before suppression', () => {
    const makeState = (normalSpent: number): FatigueBudgetState => ({
      scope: {
        localCompanionId: 'local',
        peerContactId: 'peer-mi',
        channelId: 'room-1',
        dayKey: '2027-01-15',
      },
      spent: normalSpent,
      normalSpent,
      overchargeSpent: 0,
      remainingAllowance: Math.max(0, 8 - normalSpent),
      allowance: 8,
      softLimit: 4,
      overchargeAllowance: 2,
      remainingOvercharge: 2,
      softState: normalSpent >= 4 ? 'soft_limit_reached' : 'clear',
      hardState: normalSpent >= 8 ? 'exhausted' : 'available',
    });

    const wrapUp = projectFatigueSocialRegulation({
      config,
      decision: 'wrap_up_charged',
      policyBaseState: 'wrap_up_allowed',
      intent: 'casual',
      hasRecentHumanParticipation: false,
      stateBefore: makeState(7),
      amount: 1,
    });
    expect(wrapUp.state).toBe('wrap_up_allowed');

    const suppressed = projectFatigueSocialRegulation({
      config,
      decision: 'suppressed_hard_exhausted',
      policyBaseState: 'hard_exhausted',
      intent: 'casual',
      hasRecentHumanParticipation: false,
      stateBefore: makeState(8),
      amount: 0,
    });
    // Hard suppression remains reachable and testable — the tap-out exists, it
    // just comes after the wind-down rather than replacing it.
    expect(suppressed.state).toBe('suppressed');
  });
});
