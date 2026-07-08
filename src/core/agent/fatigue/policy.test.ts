import { describe, expect, it } from 'vitest';
import { makeTestFatiguePolicyConfig } from '../../../test-support/charge-policy.js';
import type { RelationshipType } from '../../contacts/types.js';
import type { EvaluateFatiguePolicyInput, FatiguePolicyChannelInput } from './policy.js';
import {
  evaluateFatiguePolicy,
  resolveFatigueRelationshipClass,
} from './policy.js';

const FATIGUE_POLICY = makeTestFatiguePolicyConfig();

function peer(overrides: Partial<EvaluateFatiguePolicyInput['peer']> = {}): EvaluateFatiguePolicyInput['peer'] {
  return {
    contactId: 'peer-mi',
    isMachineIntelligence: true,
    relationshipType: 'ai_companion',
    trustLevel: 'trusted',
    ...overrides,
  };
}

function channel(overrides: Partial<FatiguePolicyChannelInput> = {}): FatiguePolicyChannelInput {
  return {
    channelId: 'channel-a',
    type: 'dm',
    companionFocused: false,
    companionHosted: false,
    humanParticipantCount: 0,
    machineIntelligenceParticipantCount: 2,
    recentMessageCount: 1,
    recentHumanMessageCount: 0,
    ...overrides,
  };
}

function evaluate(overrides: Partial<EvaluateFatiguePolicyInput> = {}) {
  return evaluateFatiguePolicy({
    config: FATIGUE_POLICY,
    peer: peer(),
    channel: channel(),
    recentHumanParticipation: {
      messageCount: 0,
      participantCount: 0,
    },
    intent: 'casual',
    spent: 0,
    triggerAuthorKind: 'machine_intelligence',
    ...overrides,
  });
}

describe('fatigue relationship policy', () => {
  it('gives strangers and weak MI contacts smaller limits than trusted collaborators', () => {
    const stranger = evaluate({
      peer: peer({
        relationshipType: 'stranger',
        trustLevel: 'public',
      }),
    });
    const weak = evaluate({
      peer: peer({
        relationshipType: 'acquaintance',
        trustLevel: 'regular',
      }),
    });
    const known = evaluate({
      peer: peer({
        relationshipType: 'family',
        trustLevel: 'regular',
      }),
    });
    const friendly = evaluate({
      peer: peer({
        relationshipType: 'friend',
        trustLevel: 'regular',
      }),
    });
    const trusted = evaluate({
      peer: peer({
        relationshipType: 'ai_companion',
        trustLevel: 'trusted',
      }),
    });

    expect(stranger.relationshipClass).toBe('stranger_mi');
    expect(weak.relationshipClass).toBe('weak_mi');
    expect(known.relationshipClass).toBe('known_mi');
    expect(friendly.relationshipClass).toBe('friendly_mi');
    expect(trusted.relationshipClass).toBe('trusted_collaborator_mi');
    expect(stranger.softTarget).toBeLessThan(weak.softTarget);
    expect(weak.softTarget).toBeLessThan(known.softTarget);
    expect(known.softTarget).toBeLessThan(friendly.softTarget);
    expect(friendly.softTarget).toBeLessThan(trusted.softTarget);
    expect(stranger.hardCap).toBeLessThan(weak.hardCap);
    expect(weak.hardCap).toBeLessThan(known.hardCap);
    expect(known.hardCap).toBeLessThan(friendly.hardCap);
    expect(friendly.hardCap).toBeLessThan(trusted.hardCap);
  });

  it('treats non-MI peers as non-chargeable relationship context', () => {
    const result = evaluate({
      peer: peer({
        isMachineIntelligence: false,
        relationshipType: 'friend',
        trustLevel: 'trusted',
      }),
    });

    expect(result.relationshipClass).toBe('non_machine_intelligence');
    expect(result.softTarget).toBe(0);
    expect(result.hardCap).toBe(0);
    expect(result.state).toBe('normal');
    expect(result.spend).toEqual({
      spendsFatigue: false,
      amount: 0,
      reason: 'peer_not_machine_intelligence',
    });
  });

  it.each([
    ['stranger', 'public', 'stranger_mi'],
    ['acquaintance', 'regular', 'weak_mi'],
    ['family', 'regular', 'known_mi'],
    ['friend', 'regular', 'friendly_mi'],
    ['ai_companion', 'regular', 'collaborator_mi'],
    ['ai_companion', 'trusted', 'trusted_collaborator_mi'],
  ] as const)(
    'classifies %s/%s as %s',
    (relationshipType: RelationshipType, trustLevel, expected) => {
      expect(resolveFatigueRelationshipClass(peer({ relationshipType, trustLevel }))).toBe(expected);
    },
  );
});

describe('fatigue channel setting policy', () => {
  it('defaults busy human group sidebars to soft target 2 and hard cap 5', () => {
    const result = evaluate({
      peer: peer({
        relationshipType: 'acquaintance',
        trustLevel: 'regular',
      }),
      channel: channel({
        type: 'group',
        humanParticipantCount: 5,
        machineIntelligenceParticipantCount: 2,
        recentMessageCount: 18,
        recentHumanMessageCount: 12,
      }),
    });

    expect(result.channelSetting).toBe('busy_human_group');
    expect(result.softTarget).toBe(2);
    expect(result.hardCap).toBe(5);
  });

  it('allows more room in DMs and quiet companion-focused rooms than busy groups', () => {
    const busy = evaluate({
      channel: channel({
        type: 'group',
        humanParticipantCount: 4,
        recentMessageCount: 14,
        recentHumanMessageCount: 8,
      }),
    });
    const quietRoom = evaluate({
      channel: channel({
        type: 'companion_room',
        companionFocused: true,
        humanParticipantCount: 0,
        recentMessageCount: 2,
      }),
    });
    const dm = evaluate();

    expect(busy.channelSetting).toBe('busy_human_group');
    expect(quietRoom.channelSetting).toBe('quiet_companion_room');
    expect(dm.channelSetting).toBe('dm');
    expect(busy.softTarget).toBeLessThan(quietRoom.softTarget);
    expect(quietRoom.softTarget).toBeLessThanOrEqual(dm.softTarget);
    expect(busy.hardCap).toBeLessThan(quietRoom.hardCap);
    expect(quietRoom.hardCap).toBeLessThanOrEqual(dm.hardCap);
  });

  it('gives a one-human companion-hosted room more leeway than a large public group', () => {
    const publicGroup = evaluate({
      channel: channel({
        type: 'public_group',
        humanParticipantCount: 2,
        machineIntelligenceParticipantCount: 2,
        recentMessageCount: 5,
        recentHumanMessageCount: 1,
      }),
    });
    const hostedRoom = evaluate({
      channel: channel({
        type: 'group',
        companionFocused: true,
        companionHosted: true,
        humanParticipantCount: 1,
        machineIntelligenceParticipantCount: 2,
        recentMessageCount: 3,
        recentHumanMessageCount: 1,
      }),
    });

    expect(publicGroup.channelSetting).toBe('public_group');
    expect(hostedRoom.channelSetting).toBe('one_human_companion_hosted');
    expect(publicGroup.softTarget).toBeLessThan(hostedRoom.softTarget);
    expect(publicGroup.hardCap).toBeLessThan(hostedRoom.hardCap);
  });
});

describe('fatigue intent policy', () => {
  it('allows more work, research, and problem-solving turns than casual or social chatter', () => {
    const friendlyPeer = peer({
      relationshipType: 'friend',
      trustLevel: 'regular',
    });
    const casual = evaluate({ peer: friendlyPeer, intent: 'casual' });
    const social = evaluate({ peer: friendlyPeer, intent: 'social' });
    const work = evaluate({ peer: friendlyPeer, intent: 'work' });
    const research = evaluate({ peer: friendlyPeer, intent: 'research' });
    const problemSolving = evaluate({ peer: friendlyPeer, intent: 'problem_solving' });

    expect(social.softTarget).toBeLessThan(casual.softTarget);
    expect(casual.softTarget).toBeLessThan(work.softTarget);
    expect(work.softTarget).toBeLessThanOrEqual(research.softTarget);
    expect(casual.hardCap).toBeLessThan(problemSolving.hardCap);
    expect(social.hardCap).toBeLessThan(research.hardCap);
  });
});

describe('fatigue state and overcharge policy', () => {
  it('returns deterministic state labels around soft target, wrap-up, and hard cap', () => {
    const weakGroup = {
      peer: peer({
        relationshipType: 'acquaintance',
        trustLevel: 'regular',
      }),
      channel: channel({
        type: 'group',
        humanParticipantCount: 5,
        recentMessageCount: 20,
        recentHumanMessageCount: 10,
      }),
    };

    expect(evaluate({ ...weakGroup, spent: 0 }).state).toBe('normal');
    expect(evaluate({ ...weakGroup, spent: 1 }).state).toBe('nearing_limit');
    expect(evaluate({ ...weakGroup, spent: 2 }).state).toBe('soft_exhausted');
    expect(evaluate({ ...weakGroup, spent: 4 }).state).toBe('wrap_up_allowed');
    expect(evaluate({ ...weakGroup, spent: 5 }).state).toBe('hard_exhausted');
  });

  it('makes recent human participation an overcharge eligibility input and reason after hard cap', () => {
    const result = evaluate({
      spent: 20,
      recentHumanParticipation: {
        messageCount: 2,
        participantCount: 1,
        latestMessageAgeMs: 60_000,
      },
    });

    expect(result.baseState).toBe('hard_exhausted');
    expect(result.state).toBe('overcharge_eligible');
    expect(result.overcharge.eligible).toBe(true);
    expect(result.overcharge.inputs).toEqual(expect.objectContaining({
      recentHumanMessageCount: 2,
      recentHumanParticipantCount: 1,
      hasRecentHumanParticipation: true,
      turnSpendsFatigue: true,
    }));
    expect(result.overcharge.reasons).toContain('recent_human_participation');
    expect(result.overcharge.inputs.reserveResponses).toBe(2);
  });

  it('allows work-like wrap-up as a deterministic overcharge trigger after hard cap', () => {
    const result = evaluate({
      spent: 20,
      intent: 'problem_solving',
    });

    expect(result.baseState).toBe('hard_exhausted');
    expect(result.state).toBe('overcharge_eligible');
    expect(result.overcharge.eligible).toBe(true);
    expect(result.overcharge.reasons).toEqual(['work_intent_wrapup']);
  });

  it('does not spend fatigue or grant overcharge for human-authored turns', () => {
    const result = evaluate({
      spent: 10,
      triggerAuthorKind: 'human',
      recentHumanParticipation: {
        messageCount: 2,
        participantCount: 1,
        latestMessageAgeMs: 60_000,
      },
    });

    expect(result.spend).toEqual({
      spendsFatigue: false,
      amount: 0,
      reason: 'human_authored_turn',
    });
    expect(result.state).toBe('soft_exhausted');
    expect(result.overcharge.eligible).toBe(false);
    expect(result.overcharge.blockedReasons).toContain('turn_does_not_spend_fatigue');
  });

  it('does not treat stale or missing human participation as overcharge eligible', () => {
    const stale = evaluate({
      spent: 10,
      recentHumanParticipation: {
        messageCount: 2,
        participantCount: 1,
        latestMessageAgeMs: 901_000,
      },
    });
    const missingAge = evaluate({
      spent: 10,
      recentHumanParticipation: {
        messageCount: 2,
        participantCount: 1,
      },
    });

    expect(stale.state).toBe('soft_exhausted');
    expect(stale.overcharge.blockedReasons).toContain('normal_allowance_not_exhausted');
    expect(missingAge.state).toBe('soft_exhausted');
    expect(missingAge.overcharge.blockedReasons).toContain('normal_allowance_not_exhausted');
  });

  it('keeps the hard cap closed without a qualifying overcharge trigger', () => {
    const result = evaluate({
      spent: 20,
    });

    expect(result.state).toBe('hard_exhausted');
    expect(result.overcharge.eligible).toBe(false);
    expect(result.overcharge.blockedReasons).toContain('no_qualifying_overcharge_trigger');
  });
});
