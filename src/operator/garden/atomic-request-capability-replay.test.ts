import { describe, expect, it } from 'vitest';
import type {
  RequestCapabilityReplayConsumption,
  RequestCapabilityReplayOutcome,
} from '../../boundary/fleet-auth/request-capability-replay.js';
import { AtomicRequestCapabilityReplayPort } from './atomic-request-capability-replay.js';

function consumption(overrides: Partial<RequestCapabilityReplayConsumption> = {}):
RequestCapabilityReplayConsumption {
  return {
    issuer: 'fleet-auth',
    jti: 'one-use-capability',
    capabilityDigest: 'a'.repeat(64),
    targetDigest: 'b'.repeat(64),
    bodyDigest: 'c'.repeat(64),
    audienceDigest: 'd'.repeat(64),
    companionDigest: 'e'.repeat(64),
    actionDigest: 'f'.repeat(64),
    resourceDigest: '1'.repeat(64),
    parentDigest: '2'.repeat(64),
    decisionDigest: '3'.repeat(64),
    authorityVersionsDigest: '4'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
    consumeResult: {
      schemaVersion: 1,
      decision: 'allow',
      requestId: 'request-1',
      decisionId: 'decision-1',
      targetDigest: 'b'.repeat(64),
      audience: 'operator:11111111-1111-4111-8111-111111111111',
      companionId: '11111111-1111-4111-8111-111111111111',
      parentDigest: '2'.repeat(64),
      authorityVersionsDigest: '4'.repeat(64),
      expiresAt: Math.floor((Date.now() + 60_000) / 1_000),
    },
    ...overrides,
  };
}

describe('AtomicRequestCapabilityReplayPort', () => {
  it('allows exactly one of many simultaneous consumes for one issuer+jti', async () => {
    const replay = new AtomicRequestCapabilityReplayPort();
    const input = consumption();
    const outcomes = await Promise.all(
      Array.from({ length: 32 }, () => replay.consume(input)),
    );

    expect(outcomes.filter(outcome => outcome.outcome === 'consumed')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.outcome === 'replayed')).toHaveLength(31);
  });

  it('serializes mismatched simultaneous consumes behind the winning value', async () => {
    const replay = new AtomicRequestCapabilityReplayPort();
    const outcomes: RequestCapabilityReplayOutcome[] = await Promise.all([
      replay.consume(consumption()),
      replay.consume(consumption({ capabilityDigest: '9'.repeat(64) })),
    ]);

    expect(outcomes.map(outcome => outcome.outcome).sort()).toEqual(['consumed', 'mismatch']);
  });
});
