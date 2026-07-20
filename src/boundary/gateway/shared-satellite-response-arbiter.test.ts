import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { SatelliteSharedDevicePolicy } from '../../shared/contracts/satellite-registry.js';
import {
  SharedSatelliteResponseArbiter,
  type SharedSatelliteEligibility,
} from './shared-satellite-response-arbiter.js';

const PRIMARY = createCompanionId('11111111-1111-4111-8111-111111111111');
const PRODUCTIVITY = createCompanionId('22222222-2222-4222-8222-222222222222');
const CONVERSATION = 'contact:partner|thread:morning';

const policy: SatelliteSharedDevicePolicy = {
  primaryCompanionId: PRIMARY,
  observationRecipients: [
    { companionId: PRODUCTIVITY, scopes: ['presence'] },
  ],
  emanationMemberIds: [PRIMARY, PRODUCTIVITY],
  responseLease: { durationMs: 1_000, activeConversationTtlMs: 10_000 },
};

function eligible(
  companionId: typeof PRIMARY | typeof PRODUCTIVITY,
  overrides: Partial<SharedSatelliteEligibility> = {},
): SharedSatelliteEligibility {
  return {
    companionId,
    availabilityAllows: true,
    fatigueAllows: true,
    quietHoursAllows: true,
    restAllows: true,
    taskAllows: true,
    deviceAllows: true,
    ...overrides,
  };
}

describe('SharedSatelliteResponseArbiter', () => {
  it('grants primary first and only advances after deterministic no-op release', () => {
    const audit = vi.fn();
    const arbiter = new SharedSatelliteResponseArbiter({ now: () => 100, audit });
    const eligibility = [eligible(PRIMARY), eligible(PRODUCTIVITY)];
    const primary = arbiter.acquire({
      satelliteId: 'sat-1', conversationKey: CONVERSATION, policy, eligibility,
    });
    expect(primary).toMatchObject({
      acquired: true,
      lease: { companionId: PRIMARY, priority: 'primary' },
    });
    const collision = arbiter.acquire({
      satelliteId: 'sat-1', conversationKey: CONVERSATION, policy, eligibility,
    });
    expect(collision).toEqual({ acquired: false, reason: 'lease_held' });
    if (!primary.acquired) throw new Error('expected lease');
    arbiter.complete(primary.lease.leaseId, 'no_op');
    const next = arbiter.acquire({
      satelliteId: 'sat-1',
      conversationKey: CONVERSATION,
      policy,
      eligibility,
      excludedCompanionIds: new Set([PRIMARY]),
    });
    expect(next).toMatchObject({
      acquired: true,
      lease: { companionId: PRODUCTIVITY, priority: 'emanation_member' },
    });
    expect(audit.mock.calls.map(([event]) => event.action)).toEqual([
      'acquired', 'no_op', 'released', 'acquired',
    ]);
  });

  it('honors explicit address and active conversation before primary', () => {
    let now = 100;
    const arbiter = new SharedSatelliteResponseArbiter({ now: () => now });
    const eligibility = [eligible(PRIMARY), eligible(PRODUCTIVITY)];
    const addressed = arbiter.acquire({
      satelliteId: 'sat-1',
      conversationKey: CONVERSATION,
      policy,
      eligibility,
      explicitAddressedCompanionId: PRODUCTIVITY,
    });
    expect(addressed).toMatchObject({
      acquired: true,
      lease: { companionId: PRODUCTIVITY, priority: 'explicit_address' },
    });
    if (!addressed.acquired) throw new Error('expected lease');
    arbiter.complete(addressed.lease.leaseId, 'speech');
    now = 200;
    expect(arbiter.acquire({
      satelliteId: 'sat-2',
      conversationKey: CONVERSATION,
      policy,
      eligibility,
    })).toMatchObject({
      acquired: true,
      lease: { companionId: PRODUCTIVITY, priority: 'active_conversation' },
    });
  });

  it.each([
    'availabilityAllows',
    'fatigueAllows',
    'quietHoursAllows',
    'restAllows',
    'taskAllows',
    'deviceAllows',
  ] as const)('closes %s before acquisition', (gate) => {
    const arbiter = new SharedSatelliteResponseArbiter();
    const result = arbiter.acquire({
      satelliteId: 'sat-1',
      conversationKey: CONVERSATION,
      policy,
      eligibility: [
        eligible(PRIMARY, { [gate]: false }),
        eligible(PRODUCTIVITY, { [gate]: false }),
      ],
    });
    expect(result).toEqual({ acquired: false, reason: 'no_eligible_member' });
  });

  it('audits timeout and releases the holder for the next member', () => {
    let now = 0;
    const audit = vi.fn();
    const arbiter = new SharedSatelliteResponseArbiter({ now: () => now, audit });
    const first = arbiter.acquire({
      satelliteId: 'sat-1',
      conversationKey: CONVERSATION,
      policy,
      eligibility: [eligible(PRIMARY), eligible(PRODUCTIVITY)],
    });
    expect(first.acquired).toBe(true);
    now = 1_000;
    expect(arbiter.currentHolder('sat-1')).toBeUndefined();
    expect(audit.mock.calls.map(([event]) => event.action)).toEqual([
      'acquired', 'timed_out', 'released',
    ]);
  });

  it('audits a structured decline without fabricating speech', () => {
    const audit = vi.fn();
    const arbiter = new SharedSatelliteResponseArbiter({ audit });
    const acquisition = arbiter.acquire({
      satelliteId: 'sat-1',
      conversationKey: CONVERSATION,
      policy,
      eligibility: [eligible(PRIMARY), eligible(PRODUCTIVITY)],
    });
    if (!acquisition.acquired) throw new Error('expected lease');

    arbiter.complete(acquisition.lease.leaseId, 'decline', 'intentional_no_reply');

    expect(audit.mock.calls.map(([event]) => event.action)).toEqual([
      'acquired', 'declined', 'released',
    ]);
    expect(arbiter.resolveActiveConversation(CONVERSATION)).toBeUndefined();
  });

  it('does not transfer active authority across exact partner conversation lineages', () => {
    const arbiter = new SharedSatelliteResponseArbiter();
    const eligibility = [eligible(PRIMARY), eligible(PRODUCTIVITY)];
    const addressed = arbiter.acquire({
      satelliteId: 'sat-1',
      conversationKey: CONVERSATION,
      policy,
      eligibility,
      explicitAddressedCompanionId: PRODUCTIVITY,
    });
    if (!addressed.acquired) throw new Error('expected lease');
    arbiter.complete(addressed.lease.leaseId, 'speech');

    expect(arbiter.acquire({
      satelliteId: 'sat-2',
      conversationKey: 'contact:other-partner|thread:morning',
      policy,
      eligibility,
    })).toMatchObject({
      acquired: true,
      lease: { companionId: PRIMARY, priority: 'primary' },
    });
  });

  it('audits an explicit timeout before the lease deadline', () => {
    const audit = vi.fn();
    const arbiter = new SharedSatelliteResponseArbiter({ now: () => 100, audit });
    const acquisition = arbiter.acquire({
      satelliteId: 'sat-1',
      conversationKey: CONVERSATION,
      policy,
      eligibility: [eligible(PRIMARY)],
    });
    if (!acquisition.acquired) throw new Error('expected lease');

    expect(arbiter.timeout(acquisition.lease.leaseId)).toBe(true);
    expect(audit.mock.calls.map(([event]) => event.action)).toEqual([
      'acquired', 'timed_out', 'released',
    ]);
  });

  it('clears a timed-out active owner so the next eligible member can acquire', () => {
    const arbiter = new SharedSatelliteResponseArbiter({ now: () => 100 });
    const eligibility = [eligible(PRIMARY), eligible(PRODUCTIVITY)];
    const addressed = arbiter.acquire({
      satelliteId: 'sat-1',
      conversationKey: CONVERSATION,
      policy,
      eligibility,
      explicitAddressedCompanionId: PRODUCTIVITY,
    });
    if (!addressed.acquired) throw new Error('expected addressed lease');
    arbiter.complete(addressed.lease.leaseId, 'speech');

    const active = arbiter.acquire({
      satelliteId: 'sat-1',
      conversationKey: CONVERSATION,
      policy,
      eligibility,
    });
    expect(active).toMatchObject({
      acquired: true,
      lease: { companionId: PRODUCTIVITY, priority: 'active_conversation' },
    });
    if (!active.acquired) throw new Error('expected active-conversation lease');

    arbiter.timeout(active.lease.leaseId);

    expect(arbiter.resolveActiveConversation(CONVERSATION)).toBeUndefined();
    expect(arbiter.acquire({
      satelliteId: 'sat-1',
      conversationKey: CONVERSATION,
      policy,
      eligibility,
      excludedCompanionIds: new Set([PRODUCTIVITY]),
    })).toMatchObject({
      acquired: true,
      lease: { companionId: PRIMARY, priority: 'primary' },
    });
  });
});
