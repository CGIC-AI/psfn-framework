import { describe, expect, it } from 'vitest';
import {
  evaluateWyomingDelegation,
  resolveWyomingRoutingMetadata,
} from './routing.js';

const TEST_COMPANION_ID = 'companion-test';

function makeMessage(overrides?: Record<string, unknown>) {
  return {
    id: 'msg-1',
    channelId: 'discord:general',
    channelType: 'discord',
    authorId: 'user-1',
    authorName: 'User',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  } as any;
}

describe('resolveWyomingRoutingMetadata', () => {
  it('returns explicit routing metadata from the message payload when present', () => {
    const message = makeMessage({
      routing: {
        wyoming: {
          siteId: 'ha-main',
          satelliteId: 'kitchen',
          presence: {
            kind: 'satellite',
            siteId: 'ha-main',
            satelliteId: 'kitchen',
            companionId: TEST_COMPANION_ID,
          },
          shardDelegation: {
            eligible: true,
          },
        },
      },
    });

    expect(resolveWyomingRoutingMetadata(message, TEST_COMPANION_ID)).toEqual({
      routing: {
        siteId: 'ha-main',
        satelliteId: 'kitchen',
        presence: {
          kind: 'satellite',
          siteId: 'ha-main',
          satelliteId: 'kitchen',
          companionId: TEST_COMPANION_ID,
        },
        shardDelegation: {
          eligible: true,
        },
      },
    });
  });

  it('infers routing metadata from legacy wyoming channel IDs', () => {
    const message = makeMessage({
      channelId: 'api:wyoming:ha-main:voice-pe:office',
      channelType: 'api',
    });

    expect(resolveWyomingRoutingMetadata(message, TEST_COMPANION_ID)).toEqual({
      routing: {
        siteId: 'ha-main',
        satelliteId: 'voice-pe:office',
        presence: {
          kind: 'satellite',
          siteId: 'ha-main',
          satelliteId: 'voice-pe:office',
          companionId: TEST_COMPANION_ID,
        },
      },
    });
  });

  it('returns undefined for non-wyoming channel payloads', () => {
    const message = makeMessage({
      channelId: 'api:chat:ha-main:office',
      channelType: 'api',
    });

    expect(resolveWyomingRoutingMetadata(message, TEST_COMPANION_ID)).toBeUndefined();
  });

  it('returns undefined for malformed wyoming channel IDs', () => {
    const message = makeMessage({
      channelId: 'api:wyoming:ha-main',
      channelType: 'api',
    });

    expect(resolveWyomingRoutingMetadata(message, TEST_COMPANION_ID)).toBeUndefined();
  });

  it('rejects conflicting active presence metadata', () => {
    const message = makeMessage({
      routing: {
        wyoming: {
          siteId: 'ha-main',
          satelliteId: 'kitchen',
          presence: {
            kind: 'emanation',
            emanationId: 'voice-node',
            companionId: TEST_COMPANION_ID,
            isPrimary: true,
          },
        },
      },
    });

    expect(resolveWyomingRoutingMetadata(message, TEST_COMPANION_ID)).toEqual({
      error: 'conflicting active emanation metadata',
    });
  });
});

describe('evaluateWyomingDelegation', () => {
  it('returns not_wyoming when routing metadata is unavailable', () => {
    const message = makeMessage();
    const decision = evaluateWyomingDelegation(message, {} as any, TEST_COMPANION_ID);

    expect(decision).toEqual({
      isWyoming: false,
      delegate: false,
      reason: 'not_wyoming',
    });
  });

  it('declines delegation when agent routing policy is disabled', () => {
    const message = makeMessage({
      channelId: 'api:wyoming:ha-main:kitchen',
      channelType: 'api',
    });

    const decision = evaluateWyomingDelegation(message, {
      wyomingShardRouting: { enabled: false },
    } as any, TEST_COMPANION_ID);

    expect(decision.isWyoming).toBe(true);
    expect(decision.delegate).toBe(false);
    expect(decision.reason).toBe('agent_policy_disabled');
    expect(decision.routing?.siteId).toBe('ha-main');
    expect(decision.routing?.satelliteId).toBe('kitchen');
    expect(decision.routing?.presence).toEqual({
      kind: 'satellite',
      siteId: 'ha-main',
      satelliteId: 'kitchen',
      companionId: TEST_COMPANION_ID,
    });
  });

  it('declines delegation when gateway marks routing ineligible', () => {
    const message = makeMessage({
      routing: {
        wyoming: {
          siteId: 'ha-main',
          satelliteId: 'office',
          presence: {
            kind: 'satellite',
            siteId: 'ha-main',
            satelliteId: 'office',
            companionId: TEST_COMPANION_ID,
          },
          shardDelegation: {
            eligible: false,
            reason: 'too_busy',
          },
        },
      },
    });

    const decision = evaluateWyomingDelegation(message, {
      wyomingShardRouting: { enabled: true },
    } as any, TEST_COMPANION_ID);

    expect(decision).toEqual({
      isWyoming: true,
      delegate: false,
      reason: 'too_busy',
      routing: {
        siteId: 'ha-main',
        satelliteId: 'office',
        presence: {
          kind: 'satellite',
          siteId: 'ha-main',
          satelliteId: 'office',
          companionId: TEST_COMPANION_ID,
        },
        shardDelegation: {
          eligible: false,
          reason: 'too_busy',
        },
      },
    });
  });

  it('rejects conflicting active presence at the routing boundary', () => {
    const message = makeMessage({
      routing: {
        wyoming: {
          siteId: 'ha-main',
          satelliteId: 'office',
          presence: {
            kind: 'embodiment',
            embodimentId: 'display',
            companionId: TEST_COMPANION_ID,
            isActive: true,
          },
        },
      },
    });

    expect(evaluateWyomingDelegation(message, {
      wyomingShardRouting: { enabled: true },
    } as any, TEST_COMPANION_ID)).toEqual({
      isWyoming: true,
      delegate: false,
      reason: 'conflicting active emanation metadata',
    });
  });

  it('delegates when both agent and gateway policies allow routing', () => {
    const message = makeMessage({
      routing: {
        wyoming: {
          siteId: 'ha-main',
          satelliteId: 'den',
          presence: {
            kind: 'satellite',
            siteId: 'ha-main',
            satelliteId: 'den',
            companionId: TEST_COMPANION_ID,
          },
          shardDelegation: {
            eligible: true,
          },
        },
      },
    });

    const decision = evaluateWyomingDelegation(message, {
      wyomingShardRouting: { enabled: true },
    } as any, TEST_COMPANION_ID);

    expect(decision).toEqual({
      isWyoming: true,
      delegate: true,
      reason: 'delegation_enabled',
      routing: {
        siteId: 'ha-main',
        satelliteId: 'den',
        presence: {
          kind: 'satellite',
          siteId: 'ha-main',
          satelliteId: 'den',
          companionId: TEST_COMPANION_ID,
        },
        shardDelegation: {
          eligible: true,
        },
      },
    });
  });
});
