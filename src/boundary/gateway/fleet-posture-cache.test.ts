import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { GatewayFleetPostureCache } from './fleet-posture-cache.js';
import { FLEET_POSTURE_EXPIRY_TIMEOUT_MS } from '../../shared/telemetry/fleet-posture.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');
const NOW = Date.parse('2027-01-15T12:00:00.000Z');

function posture(percent: number) {
  return {
    schemaVersion: 1,
    updatedAt: NOW,
    charge: {
      state: percent === 100 ? 'exhausted' as const : 'pressured' as const,
      utilizationPercent: percent,
    },
    fatigue: { state: 'clear' as const, utilizationPercent: 0 },
  };
}

describe('gateway fleet posture connection cache', () => {
  it('attributes two summaries by connection and clears posture across disconnect/reconnect', () => {
    const cache = new GatewayFleetPostureCache<object>();
    const firstA = {};
    const connectionB = {};
    cache.bind(firstA, COMPANION_A);
    cache.bind(connectionB, COMPANION_B);
    cache.record(firstA, COMPANION_A, posture(25), NOW);
    cache.record(connectionB, COMPANION_B, posture(100), NOW);

    expect(cache.read(firstA, COMPANION_A)?.charge.utilizationPercent).toBe(25);
    expect(cache.read(connectionB, COMPANION_B)?.charge.utilizationPercent).toBe(100);
    expect(cache.read(firstA, COMPANION_B)).toBeUndefined();

    cache.unbind(firstA);
    const replacementA = {};
    cache.bind(replacementA, COMPANION_A);
    expect(cache.read(replacementA, COMPANION_A)).toBeUndefined();
    cache.record(replacementA, COMPANION_A, posture(50), NOW);
    expect(cache.read(replacementA, COMPANION_A)?.charge.utilizationPercent).toBe(50);
  });

  it('rejects spoofed bindings and widened payload identities without replacing valid posture', () => {
    const cache = new GatewayFleetPostureCache<object>();
    const connection = {};
    cache.bind(connection, COMPANION_A);
    cache.record(connection, COMPANION_A, posture(25), NOW);

    expect(() => cache.record(connection, COMPANION_B, posture(100), NOW))
      .toThrow(/authenticated companion connection/i);
    expect(() => cache.record(connection, COMPANION_A, {
      ...posture(100),
      companionId: COMPANION_B,
    }, NOW)).toThrow(/invalid or widened/i);
    expect(() => cache.record(connection, COMPANION_A, {
      ...posture(100),
      updatedAt: NOW - 1,
    }, NOW)).toThrow(/older/i);
    expect(() => cache.record(connection, COMPANION_A, posture(100), NOW))
      .toThrow(/conflicts/i);
    expect(cache.read(connection, COMPANION_A)?.charge.utilizationPercent).toBe(25);
  });

  it('expires old posture to unavailable instead of retaining metrics indefinitely', () => {
    const cache = new GatewayFleetPostureCache<object>();
    const connection = {};
    cache.bind(connection, COMPANION_A);
    cache.record(connection, COMPANION_A, posture(25), NOW);

    expect(cache.read(
      connection,
      COMPANION_A,
      NOW + FLEET_POSTURE_EXPIRY_TIMEOUT_MS,
    )).toBeDefined();
    expect(cache.read(
      connection,
      COMPANION_A,
      NOW + FLEET_POSTURE_EXPIRY_TIMEOUT_MS + 1,
    )).toBeUndefined();
    expect(cache.read(connection, COMPANION_A, NOW)).toBeUndefined();
  });
});
