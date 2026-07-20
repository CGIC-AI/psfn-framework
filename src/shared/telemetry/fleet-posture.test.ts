import { describe, expect, it } from 'vitest';
import type { FatigueBudgetEvent } from '../contracts/runtime.js';
import { makeTestChargePolicyConfig } from '../../test-support/charge-policy.js';
import {
  buildFleetCompanionPosture,
  parseFleetCompanionPosture,
} from './fleet-posture.js';
import { createCompanionId } from '../routing/companion-id.js';

const NOW = Date.parse('2027-01-15T12:00:00.000Z');
const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');

function fatigueEvent(overrides: Partial<FatigueBudgetEvent> = {}): FatigueBudgetEvent {
  return {
    timestampMs: NOW - 1_000,
    dayKey: '2027-01-15',
    localCompanionId: COMPANION_ID,
    peerContactId: 'private-peer',
    channelId: 'private-channel',
    triggeringAuthor: {
      role: 'machine_intelligence',
      contactId: 'private-peer',
      displayName: 'Private peer name',
      isMachineIntelligence: true,
    },
    peer: {
      contactId: 'private-peer',
      displayName: 'Private peer name',
      isMachineIntelligence: true,
    },
    amount: 1,
    decision: 'charged',
    reason: 'machine_intelligence_response',
    spentAfter: 2,
    remainingAllowance: 1,
    allowance: 3,
    softLimit: 2,
    softState: 'soft_limit_reached',
    hardState: 'available',
    requestId: 'private-request',
    turnId: 'private-turn',
    callType: 'chat',
    purpose: 'assistant_response',
    details: {
      prompt: 'private prompt',
      policyRationale: 'private rationale',
    },
    ...overrides,
  };
}

describe('fleet companion posture contract', () => {
  it('builds capped deterministic charge and fatigue posture without private content', () => {
    const chargePolicy = makeTestChargePolicyConfig();
    const summary = buildFleetCompanionPosture({
      companionId: COMPANION_ID,
      chargePolicy,
      rollingCharge: {
        windowMs: 86_400_000,
        spentByLane: {
          interactive: 6,
          companion_social: 99,
        },
        entryCount: 2,
      },
      fatigueEvents: [
        fatigueEvent(),
        fatigueEvent({
          timestampMs: NOW - 500,
          spentAfter: 9,
          remainingAllowance: 0,
          hardState: 'exhausted',
        }),
        fatigueEvent({
          localCompanionId: '22222222-2222-4222-8222-222222222222',
          hardState: 'available',
          softState: 'clear',
        }),
      ],
      nowMs: NOW,
    });

    expect(summary).toEqual({
      schemaVersion: 1,
      updatedAt: NOW,
      charge: { state: 'exhausted', utilizationPercent: 100 },
      fatigue: { state: 'exhausted', utilizationPercent: 100 },
    });
    const serialized = JSON.stringify(summary);
    for (const forbidden of [
      COMPANION_ID,
      'private-peer',
      'private-channel',
      'private-request',
      'private-turn',
      'private prompt',
      'private rationale',
      'contact',
      'policy',
      'prompt',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('rejects widened labels, percentages, timestamps, identities, and private fields', () => {
    const valid = {
      schemaVersion: 1,
      updatedAt: NOW,
      charge: { state: 'pressured', utilizationPercent: 25 },
      fatigue: { state: 'clear', utilizationPercent: 0 },
    };
    expect(parseFleetCompanionPosture(valid, NOW)).toEqual(valid);

    for (const invalid of [
      { ...valid, companionId: COMPANION_ID },
      { ...valid, prompt: 'private' },
      { ...valid, updatedAt: NOW + 1 },
      { ...valid, charge: { state: 'critical', utilizationPercent: 25 } },
      { ...valid, charge: { state: 'pressured', utilizationPercent: 101 } },
      { ...valid, fatigue: { ...valid.fatigue, rawLedgerEvent: {} } },
    ]) {
      expect(() => parseFleetCompanionPosture(invalid, NOW)).toThrow(/posture/i);
    }
  });

  it('fails safely toward the worse posture when one scope has equal-timestamp events', () => {
    const summary = buildFleetCompanionPosture({
      companionId: COMPANION_ID,
      chargePolicy: makeTestChargePolicyConfig(),
      rollingCharge: {
        windowMs: 86_400_000,
        spentByLane: {},
        entryCount: 0,
      },
      fatigueEvents: [
        fatigueEvent({
          timestampMs: NOW - 1_000,
          spentAfter: 0,
          remainingAllowance: 3,
          softState: 'clear',
          hardState: 'available',
        }),
        fatigueEvent({
          timestampMs: NOW - 1_000,
          spentAfter: 3,
          remainingAllowance: 0,
          softState: 'soft_limit_reached',
          hardState: 'exhausted',
        }),
      ],
      nowMs: NOW,
    });

    expect(summary.fatigue).toEqual({
      state: 'exhausted',
      utilizationPercent: 100,
    });
  });
});
