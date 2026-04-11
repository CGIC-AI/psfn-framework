import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyBroadcastDraft,
  isExplicitBroadcastApprovalToken,
  resolveBroadcastVisibilityScope,
} from './broadcast-safety.js';

describe('classifyBroadcastDraft', () => {
  it('returns non-risky for neutral public copy', () => {
    const result = classifyBroadcastDraft('Shipping update: v2.1.0 is live with faster indexing.');

    expect(result.risky).toBe(false);
    expect(result.signals).toEqual([]);
  });

  it('flags private risk for direct-contact details', () => {
    const result = classifyBroadcastDraft('Reach me at owner@example.com or call +1 (555) 123-4567.');

    expect(result.risky).toBe(true);
    expect(result.signals).toContain('private');
    expect(result.matches.private.join(' ')).toContain('owner@example.com');
  });

  it('flags sensitive and off-brand signals', () => {
    const result = classifyBroadcastDraft(
      'I can give legal advice here and you are an idiot if you disagree.',
    );

    expect(result.risky).toBe(true);
    expect(result.signals).toEqual(expect.arrayContaining(['sensitive', 'off_brand']));
  });
});

describe('broadcast approval token handling', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires explicit approval-token prefix when no allowlist is configured', () => {
    expect(isExplicitBroadcastApprovalToken('approve:ops-12345678')).toBe(true);
    expect(isExplicitBroadcastApprovalToken('token-123')).toBe(false);
  });

  it('uses configured token allowlist when provided', () => {
    vi.stubEnv('BROADCAST_APPROVAL_TOKENS', 'ops-alpha,ops-beta');
    expect(isExplicitBroadcastApprovalToken('ops-alpha')).toBe(true);
    expect(isExplicitBroadcastApprovalToken('approve:ops-alpha')).toBe(false);
  });

  it('resolves broadcast scope to approved_private_context only with explicit token', () => {
    expect(resolveBroadcastVisibilityScope('twitter:timeline')).toBe('public_only');
    expect(resolveBroadcastVisibilityScope('twitter:timeline', {
      broadcastApprovalToken: 'approve:operator-12345678',
    })).toBe('approved_private_context');
    expect(resolveBroadcastVisibilityScope('api:session-1')).toBeNull();
  });
});
