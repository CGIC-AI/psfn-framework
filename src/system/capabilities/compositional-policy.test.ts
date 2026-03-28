import { describe, expect, it } from 'vitest';
import {
  cloneCompositionalPolicyConfig,
  evaluateCompositionalPolicy,
  evaluateCompositionalPolicyForChannelId,
  normalizeCompositionalPolicyConfig,
  resolveCompositionalChannelType,
} from './compositional-policy.js';

describe('compositional policy', () => {
  it('normalizes invalid policy payloads to a disabled fail-closed default', () => {
    expect(normalizeCompositionalPolicyConfig(null)).toEqual({
      enabled: false,
      allowedTiers: [],
      allowedChannelTypes: [],
      allowedPurposes: [],
    });

    expect(normalizeCompositionalPolicyConfig({
      enabled: 'yes',
      allowedTiers: ['autonomous', 'bogus'],
      allowedChannelTypes: ['api', 'bogus'],
      allowedPurposes: ['retrieval', 'bogus'],
    })).toEqual({
      enabled: false,
      allowedTiers: ['autonomous'],
      allowedChannelTypes: ['api'],
      allowedPurposes: ['retrieval'],
    });
  });

  it('clones policy objects without aliasing arrays', () => {
    const original = normalizeCompositionalPolicyConfig({
      enabled: true,
      allowedTiers: ['autonomous'],
      allowedChannelTypes: ['api'],
      allowedPurposes: ['retrieval'],
    });

    const cloned = cloneCompositionalPolicyConfig(original);
    cloned.allowedTiers.push('custom');

    expect(original.allowedTiers).toEqual(['autonomous']);
    expect(cloned.allowedTiers).toEqual(['autonomous', 'custom']);
  });

  it('fails closed unless tier, channel, and purpose are all explicitly allowed', () => {
    const policy = normalizeCompositionalPolicyConfig({
      enabled: true,
      allowedTiers: ['autonomous'],
      allowedChannelTypes: ['api'],
      allowedPurposes: ['retrieval'],
    });

    expect(evaluateCompositionalPolicy({
      policy,
      capabilityTier: 'autonomous',
      channelType: 'api',
      purpose: 'retrieval',
    })).toMatchObject({ allowed: true, reason: 'allowed' });

    expect(evaluateCompositionalPolicy({
      policy,
      capabilityTier: 'apprentice',
      channelType: 'api',
      purpose: 'retrieval',
    })).toMatchObject({ allowed: false, reason: 'tier_not_allowed' });

    expect(evaluateCompositionalPolicy({
      policy,
      capabilityTier: 'autonomous',
      channelType: 'discord',
      purpose: 'retrieval',
    })).toMatchObject({ allowed: false, reason: 'channel_type_not_allowed' });

    expect(evaluateCompositionalPolicy({
      policy,
      capabilityTier: 'autonomous',
      channelType: 'api',
      purpose: 'think',
    })).toMatchObject({ allowed: false, reason: 'purpose_not_allowed' });
  });

  it('resolves channel ids fail-closed for compositional policy evaluation', () => {
    const policy = normalizeCompositionalPolicyConfig({
      enabled: true,
      allowedTiers: ['autonomous'],
      allowedChannelTypes: ['api'],
      allowedPurposes: ['extraction'],
    });

    expect(resolveCompositionalChannelType('api:session-42')).toBe('api');
    expect(resolveCompositionalChannelType('shard:session-42')).toBeUndefined();

    expect(evaluateCompositionalPolicyForChannelId({
      policy,
      capabilityTier: 'autonomous',
      channelId: 'api:session-42',
      purpose: 'extraction',
    })).toMatchObject({ allowed: true, reason: 'allowed' });

    expect(evaluateCompositionalPolicyForChannelId({
      policy,
      capabilityTier: 'autonomous',
      channelId: 'shard:session-42',
      purpose: 'extraction',
    })).toMatchObject({ allowed: false, reason: 'channel_type_not_allowed' });
  });
});
