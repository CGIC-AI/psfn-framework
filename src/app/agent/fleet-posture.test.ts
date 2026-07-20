import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { makeTestChargePolicyConfig } from '../../test-support/charge-policy.js';
import { resetRunChargeRollingWindowForTests } from '../../shared/telemetry/run-charge.js';
import { createAgentFleetPostureProvider } from './fleet-posture.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const NOW = Date.parse('2027-01-15T12:00:00.000Z');

describe('agent fleet posture provider', () => {
  it('reads only the local companion current-day fatigue view without model work', () => {
    resetRunChargeRollingWindowForTests();
    const listFatigueEvents = vi.fn(() => []);
    const provider = createAgentFleetPostureProvider({
      companionId: COMPANION_ID,
      chargePolicy: makeTestChargePolicyConfig(),
      fatigueHistory: {
        listFatigueEvents,
        recordFatigueEvent: vi.fn(),
      },
      now: () => NOW,
    });

    expect(provider()).toEqual({
      schemaVersion: 1,
      updatedAt: NOW,
      charge: { state: 'clear', utilizationPercent: 0 },
      fatigue: { state: 'clear', utilizationPercent: 0 },
    });
    expect(listFatigueEvents).toHaveBeenCalledWith({
      localCompanionId: COMPANION_ID,
      dayKey: '2027-01-15',
    });
  });
});
