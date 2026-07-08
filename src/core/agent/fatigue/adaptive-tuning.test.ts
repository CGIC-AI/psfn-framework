import { describe, expect, it } from 'vitest';
import { makeTestFatiguePolicyConfig } from '../../../test-support/charge-policy.js';
import type { FatigueBudgetEvent } from '../../../shared/contracts/runtime.js';
import { buildFatigueTuningReport } from './adaptive-tuning.js';

function makeEvent(overrides: Partial<FatigueBudgetEvent> = {}): FatigueBudgetEvent {
  return {
    timestampMs: Date.parse('2027-01-15T12:00:00.000Z'),
    dayKey: '2027-01-15',
    localCompanionId: 'purrsephone',
    peerContactId: 'peer-mi',
    channelId: 'channel-a',
    triggeringAuthor: {
      role: 'machine_intelligence',
      contactId: 'peer-mi',
      isMachineIntelligence: true,
    },
    peer: {
      contactId: 'peer-mi',
      isMachineIntelligence: true,
    },
    amount: 1,
    decision: 'charged',
    reason: 'machine_intelligence_response',
    spentAfter: 1,
    remainingAllowance: 1,
    allowance: 5,
    softLimit: 2,
    softState: 'clear',
    hardState: 'available',
    details: {
      channelSetting: 'busy_human_group',
      intent: 'casual',
      enforcementDecision: 'allowed_charged',
    },
    ...overrides,
  };
}

function repeat(count: number, factory: (index: number) => FatigueBudgetEvent): FatigueBudgetEvent[] {
  return Array.from({ length: count }, (_, index) => factory(index));
}

describe('buildFatigueTuningReport', () => {
  it('recommends smaller busy-group allowance when reserve pressure appears', () => {
    const policy = makeTestFatiguePolicyConfig();
    const events = [
      ...repeat(4, index => makeEvent({
        timestampMs: Date.parse('2027-01-15T12:00:00.000Z') + index,
        details: {
          channelSetting: 'busy_human_group',
          enforcementDecision: 'allowed_charged',
        },
      })),
      ...repeat(2, index => makeEvent({
        timestampMs: Date.parse('2027-01-15T12:01:00.000Z') + index,
        decision: 'overcharge',
        reason: 'overcharge_recent_human_participation',
        details: {
          channelSetting: 'busy_human_group',
          enforcementDecision: 'overcharge_charged',
          recentHumanParticipation: true,
        },
      })),
    ];

    const report = buildFatigueTuningReport({
      events,
      policy,
      nowMs: 1,
      minEvents: 4,
    });

    const busy = report.recommendations.find(candidate => candidate.channelSetting === 'busy_human_group');
    expect(busy).toEqual(expect.objectContaining({
      action: 'decrease_busy_group_allowance',
      recommended: {
        maxSoftTarget: 1,
        maxHardCap: 4,
      },
    }));
    expect(busy?.reasons).toContain('busy_group_reserve_pressure');
  });

  it('recommends more room for quiet companion rooms only within operator bounds', () => {
    const policy = makeTestFatiguePolicyConfig();
    const current = policy.channelSettingLimits.quiet_companion_room;
    policy.channelSettingLimits.quiet_companion_room = {
      maxSoftTarget: 4,
      maxHardCap: 6,
    };
    const events = repeat(4, index => makeEvent({
      timestampMs: Date.parse('2027-01-15T12:00:00.000Z') + index,
      decision: index < 2 ? 'charged' : 'overcharge',
      reason: index < 2 ? 'machine_intelligence_response' : 'overcharge_work_intent_wrapup',
      details: {
        channelSetting: 'quiet_companion_room',
        intent: 'problem_solving',
        enforcementDecision: index < 2 ? 'allowed_charged' : 'overcharge_charged',
      },
    }));

    const report = buildFatigueTuningReport({
      events,
      policy,
      nowMs: 1,
      minEvents: 4,
      operatorBounds: {
        quiet_companion_room: {
          maxSoftTarget: 5,
          maxHardCap: 7,
        },
      },
    });

    const quiet = report.recommendations.find(candidate => candidate.channelSetting === 'quiet_companion_room');
    expect(quiet?.action).toBe('increase_companion_room_allowance');
    expect(quiet?.recommended).toEqual({
      maxSoftTarget: 5,
      maxHardCap: 7,
    });
    expect(quiet?.bounds.maxHardCap).toBe(7);
    policy.channelSettingLimits.quiet_companion_room = current;
  });

  it('keeps recommendations deterministic for the same telemetry', () => {
    const policy = makeTestFatiguePolicyConfig();
    const events = repeat(4, index => makeEvent({
      timestampMs: Date.parse('2027-01-15T12:00:00.000Z') + index,
      decision: index === 3 ? 'overcharge' : 'charged',
      reason: index === 3 ? 'overcharge_recent_human_participation' : 'machine_intelligence_response',
      details: {
        channelSetting: 'public_group',
        enforcementDecision: index === 3 ? 'overcharge_charged' : 'allowed_charged',
      },
    }));

    expect(buildFatigueTuningReport({ events, policy, nowMs: 123 })).toEqual(
      buildFatigueTuningReport({ events, policy, nowMs: 123 }),
    );
  });

  it('collects more data before recommending when telemetry is sparse', () => {
    const report = buildFatigueTuningReport({
      events: [makeEvent()],
      policy: makeTestFatiguePolicyConfig(),
      nowMs: 1,
      minEvents: 4,
    });

    const busy = report.recommendations.find(candidate => candidate.channelSetting === 'busy_human_group');
    expect(busy?.action).toBe('collect_more_data');
    expect(busy?.recommended).toEqual(busy?.current);
  });
});
