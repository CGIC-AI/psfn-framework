import { describe, expect, it } from 'vitest';

import {
  staggerFleetScheduleWithinWindow,
} from './fleet-maintenance-coordinator.js';

const COMPANIONS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const;

describe('fleet maintenance coordinator', () => {
  it('places lightweight work deterministically inside its existing semantic window', () => {
    const window = {
      windowStartMs: Date.parse('2026-08-29T11:00:00.000Z'),
      windowEndMs: Date.parse('2026-08-29T12:00:00.000Z'),
    };

    expect(COMPANIONS.map(companionId => staggerFleetScheduleWithinWindow({
      companionId,
      fleetCompanionIds: COMPANIONS,
      ...window,
    }))).toEqual([
      { manifestOrdinal: 0, scheduledAtMs: Date.parse('2026-08-29T11:00:00.000Z') },
      { manifestOrdinal: 1, scheduledAtMs: Date.parse('2026-08-29T11:20:00.000Z') },
      { manifestOrdinal: 2, scheduledAtMs: Date.parse('2026-08-29T11:40:00.000Z') },
    ]);
  });
});
