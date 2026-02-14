import { describe, it, expect } from 'vitest';
import {
  evaluateMemoryPolicy,
  classifyChannel,
  channelsShareContinuity,
  getAllowedSensitivities,
} from './policy.js';
import type { PolicyContext } from './policy.js';
import {
  trustAtLeast,
  sensitivityAtMost,
  trustOrd,
  sensitivityOrd,
  TRUST_CEILING,
} from './types.js';

// ── Helper ──

function ctx(overrides: Partial<PolicyContext>): PolicyContext {
  return {
    trustLevel: 'regular',
    channelVisibility: 'semi_private',
    memorySensitivity: 'public',
    ...overrides,
  };
}

describe('evaluateMemoryPolicy', () => {
  // ── Layer 1: Operator approval ──

  it('allows any memory when operator approval is set', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'public',
      channelVisibility: 'broadcast',
      memorySensitivity: 'confidential',
      operatorApproval: true,
    }));
    expect(result.decision).toBe('allow');
    expect(result.layer).toBe('operator');
  });

  // ── Layer 2: Consent flags ──

  it('denies recall when consent flags deny it', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'private',
      memorySensitivity: 'public',
      consentFlags: { allowRecall: false },
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('consent');
  });

  it('consent denial overrides primary trust in private channel', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'private',
      memorySensitivity: 'intimate',
      consentFlags: { allowRecall: false },
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('consent');
  });

  // ── Layer 3: Trust ceiling ──

  it('primary can access confidential memories', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'private',
      memorySensitivity: 'confidential',
    }));
    expect(result.decision).toBe('allow');
  });

  it('trusted can access personal but not intimate', () => {
    const personal = evaluateMemoryPolicy(ctx({
      trustLevel: 'trusted',
      channelVisibility: 'private',
      memorySensitivity: 'personal',
    }));
    expect(personal.decision).toBe('allow');

    const intimate = evaluateMemoryPolicy(ctx({
      trustLevel: 'trusted',
      channelVisibility: 'private',
      memorySensitivity: 'intimate',
    }));
    expect(intimate.decision).toBe('deny');
    expect(intimate.layer).toBe('trust');
  });

  it('regular cannot access personal memories', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'regular',
      channelVisibility: 'semi_private',
      memorySensitivity: 'personal',
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('trust');
  });

  it('public cannot access anything except public', () => {
    for (const sens of ['personal', 'intimate', 'confidential'] as const) {
      const result = evaluateMemoryPolicy(ctx({
        trustLevel: 'public',
        channelVisibility: 'public',
        memorySensitivity: sens,
      }));
      expect(result.decision).toBe('deny');
    }
  });

  // ── Layer 4: Visibility gate ──

  it('broadcast channel blocks non-public even for primary trust', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'broadcast',
      memorySensitivity: 'personal',
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('visibility');
  });

  it('public channel blocks non-public even for trusted trust', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'trusted',
      channelVisibility: 'public',
      memorySensitivity: 'personal',
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('visibility');
  });

  it('semi-private channel blocks intimate/confidential', () => {
    const intimate = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'semi_private',
      memorySensitivity: 'intimate',
    }));
    expect(intimate.decision).toBe('deny');
    expect(intimate.layer).toBe('visibility');

    const confidential = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'semi_private',
      memorySensitivity: 'confidential',
    }));
    expect(confidential.decision).toBe('deny');
    expect(confidential.layer).toBe('visibility');
  });

  it('semi-private allows personal for primary trust', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'semi_private',
      memorySensitivity: 'personal',
    }));
    expect(result.decision).toBe('allow');
  });

  // ── Layer 5: Default allow ──

  it('allows public memory in any context', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'public',
      channelVisibility: 'broadcast',
      memorySensitivity: 'public',
    }));
    expect(result.decision).toBe('allow');
    expect(result.layer).toBe('default');
  });

  it('allows primary + private + confidential (full honne)', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'private',
      memorySensitivity: 'confidential',
    }));
    expect(result.decision).toBe('allow');
    expect(result.layer).toBe('default');
  });

  // ── Precedence verification ──

  it('consent denial beats operator approval being absent', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'private',
      memorySensitivity: 'public',
      consentFlags: { allowRecall: false },
      operatorApproval: false,
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('consent');
  });

  it('operator approval overrides consent denial', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'private',
      memorySensitivity: 'confidential',
      consentFlags: { allowRecall: false },
      operatorApproval: true,
    }));
    expect(result.decision).toBe('allow');
    expect(result.layer).toBe('operator');
  });

  it('consent flags with allowRecall undefined does not block', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelVisibility: 'private',
      memorySensitivity: 'personal',
      consentFlags: { deleteOnRequest: true },
    }));
    expect(result.decision).toBe('allow');
  });
});

describe('classifyChannel', () => {
  it('classifies API channels as private', () => {
    expect(classifyChannel('api:session123')).toBe('private');
  });

  it('classifies SillyTavern channels as private', () => {
    expect(classifyChannel('sillytavern:default')).toBe('private');
  });

  it('classifies OpenWebUI channels as private', () => {
    expect(classifyChannel('openwebui:chat1')).toBe('private');
  });

  it('classifies shard channels as private', () => {
    expect(classifyChannel('shard:abc-123')).toBe('private');
  });

  it('classifies internal channels as private', () => {
    expect(classifyChannel('internal:scheduler')).toBe('private');
  });

  it('classifies twitter channels as broadcast', () => {
    expect(classifyChannel('twitter:timeline')).toBe('broadcast');
  });

  it('classifies social channels as broadcast', () => {
    expect(classifyChannel('social:mastodon')).toBe('broadcast');
  });

  it('classifies unknown channels as semi_private (guild default)', () => {
    expect(classifyChannel('1234567890')).toBe('semi_private');
    expect(classifyChannel('guild:general')).toBe('semi_private');
  });
});

describe('channelsShareContinuity', () => {
  it('private channels share continuity', () => {
    expect(channelsShareContinuity('api:session1', 'sillytavern:chat')).toBe(true);
  });

  it('private and semi_private do not share', () => {
    expect(channelsShareContinuity('api:session1', '1234567890')).toBe(false);
  });

  it('two semi_private channels do not share', () => {
    expect(channelsShareContinuity('1234567890', '9876543210')).toBe(false);
  });

  it('broadcast and private do not share', () => {
    expect(channelsShareContinuity('twitter:timeline', 'api:session1')).toBe(false);
  });
});

describe('getAllowedSensitivities', () => {
  it('primary + private = all levels', () => {
    const allowed = getAllowedSensitivities('primary', 'private');
    expect(allowed).toEqual(['public', 'personal', 'intimate', 'confidential']);
  });

  it('primary + semi_private = public + personal only', () => {
    const allowed = getAllowedSensitivities('primary', 'semi_private');
    expect(allowed).toEqual(['public', 'personal']);
  });

  it('primary + broadcast = public only', () => {
    const allowed = getAllowedSensitivities('primary', 'broadcast');
    expect(allowed).toEqual(['public']);
  });

  it('trusted + private = public + personal', () => {
    const allowed = getAllowedSensitivities('trusted', 'private');
    expect(allowed).toEqual(['public', 'personal']);
  });

  it('regular + private = public only (trust ceiling limits)', () => {
    const allowed = getAllowedSensitivities('regular', 'private');
    expect(allowed).toEqual(['public']);
  });

  it('public + public = public only', () => {
    const allowed = getAllowedSensitivities('public', 'public');
    expect(allowed).toEqual(['public']);
  });
});

describe('type ordering helpers', () => {
  it('trustAtLeast works correctly', () => {
    expect(trustAtLeast('primary', 'primary')).toBe(true);
    expect(trustAtLeast('primary', 'public')).toBe(true);
    expect(trustAtLeast('regular', 'trusted')).toBe(false);
    expect(trustAtLeast('public', 'regular')).toBe(false);
  });

  it('sensitivityAtMost works correctly', () => {
    expect(sensitivityAtMost('public', 'personal')).toBe(true);
    expect(sensitivityAtMost('personal', 'personal')).toBe(true);
    expect(sensitivityAtMost('intimate', 'personal')).toBe(false);
    expect(sensitivityAtMost('confidential', 'public')).toBe(false);
  });

  it('trustOrd returns correct ordering', () => {
    expect(trustOrd('primary')).toBeGreaterThan(trustOrd('trusted'));
    expect(trustOrd('trusted')).toBeGreaterThan(trustOrd('regular'));
    expect(trustOrd('regular')).toBeGreaterThan(trustOrd('public'));
  });

  it('sensitivityOrd returns correct ordering', () => {
    expect(sensitivityOrd('confidential')).toBeGreaterThan(sensitivityOrd('intimate'));
    expect(sensitivityOrd('intimate')).toBeGreaterThan(sensitivityOrd('personal'));
    expect(sensitivityOrd('personal')).toBeGreaterThan(sensitivityOrd('public'));
  });

  it('TRUST_CEILING has correct structure', () => {
    expect(TRUST_CEILING.primary).toHaveLength(4);
    expect(TRUST_CEILING.trusted).toHaveLength(2);
    expect(TRUST_CEILING.regular).toHaveLength(1);
    expect(TRUST_CEILING.public).toHaveLength(1);
  });
});
