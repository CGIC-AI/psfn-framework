import { beforeEach, describe, it, expect } from 'vitest';
import {
  buildResponseStylePromptState,
  buildTrustPromptState,
  evaluateMemoryPolicy,
  classifyChannelDisclosure,
  resolveChannelResponseStyle,
  channelsShareContinuity,
  getVisibilityDisclosureCeiling,
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
import {
  getDefaultTrustPolicy,
  resetRuntimeTrustPolicy,
  setRuntimeTrustPolicy,
} from './runtime-policy.js';
import {
  resetRuntimeChannelEnvelopeLabels,
  setRuntimeChannelEnvelopeLabels,
} from './runtime-channel-labels.js';
import type { ChannelClassificationOverride } from '../config/trust-policy-config.js';

// ── Helper ──

function ctx(overrides: Partial<PolicyContext>): PolicyContext {
  return {
    trustLevel: 'regular',
    channelPrivacy: 'invite_only',
    broadcast: false,
    memorySensitivity: 'public',
    ...overrides,
  };
}

function setVisibilityOverrides(overrides: {
  exact?: Record<string, ChannelClassificationOverride>;
  prefix?: Record<string, ChannelClassificationOverride>;
}): void {
  const defaultPolicy = getDefaultTrustPolicy();
  setRuntimeTrustPolicy({
    ...defaultPolicy,
    trustCeiling: {
      ...defaultPolicy.trustCeiling,
    },
    visibilityAllowed: {
      ...defaultPolicy.visibilityAllowed,
    },
    channelClassification: {
      ...defaultPolicy.channelClassification,
      privatePrefixes: [...defaultPolicy.channelClassification.privatePrefixes],
      broadcastPrefixes: [...defaultPolicy.channelClassification.broadcastPrefixes],
      visibilityOverrides: {
        exact: {
          ...defaultPolicy.channelClassification.visibilityOverrides.exact,
          ...(overrides.exact ?? {}),
        },
        prefix: {
          ...defaultPolicy.channelClassification.visibilityOverrides.prefix,
          ...(overrides.prefix ?? {}),
        },
      },
    },
  });
}

beforeEach(() => {
  resetRuntimeTrustPolicy();
  resetRuntimeChannelEnvelopeLabels();
});

describe('evaluateMemoryPolicy', () => {
  // ── Layer 1: Operator approval ──

  it('allows any memory when operator approval is set', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'public',
      channelPrivacy: 'public',
      broadcast: true,
      memorySensitivity: 'confidential',
      operatorApproval: true,
    }));
    expect(result.decision).toBe('allow');
    expect(result.layer).toBe('operator');
  });

  // ── Layer 2: Consent flags ──

  it('denies recall when explicit withhold boundary is set', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'private',
      memorySensitivity: 'public',
      disclosureBoundary: { withhold: true },
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('boundary');
    expect(result.reasonTag).toBe('boundary.withhold');
  });

  it('denies recall when explicit consent boundary is unmet', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'private',
      memorySensitivity: 'public',
      disclosureBoundary: { consentRequired: true, consentGranted: false },
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('boundary');
    expect(result.reasonTag).toBe('boundary.consent_required');
  });

  it('allows recall when explicit consent boundary is met', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'private',
      memorySensitivity: 'public',
      disclosureBoundary: { consentRequired: true, consentGranted: true },
    }));
    expect(result.decision).toBe('allow');
    expect(result.layer).toBe('default');
    expect(result.reasonTag).toBe('default.within_bounds');
  });

  it('denies recall when consent flags deny it', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'private',
      memorySensitivity: 'public',
      consentFlags: { allowRecall: false },
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('consent');
  });

  it('consent denial overrides primary trust in private channel', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'private',
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
      channelPrivacy: 'private',
      memorySensitivity: 'confidential',
    }));
    expect(result.decision).toBe('allow');
  });

  it('trusted can access personal but not intimate', () => {
    const personal = evaluateMemoryPolicy(ctx({
      trustLevel: 'trusted',
      channelPrivacy: 'private',
      memorySensitivity: 'personal',
    }));
    expect(personal.decision).toBe('allow');

    const intimate = evaluateMemoryPolicy(ctx({
      trustLevel: 'trusted',
      channelPrivacy: 'private',
      memorySensitivity: 'intimate',
    }));
    expect(intimate.decision).toBe('deny');
    expect(intimate.layer).toBe('trust');
  });

  it('regular can access personal but not intimate memories', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'regular',
      channelPrivacy: 'invite_only',
      memorySensitivity: 'personal',
    }));
    expect(result.decision).toBe('allow');

    const intimate = evaluateMemoryPolicy(ctx({
      trustLevel: 'regular',
      channelPrivacy: 'private',
      memorySensitivity: 'intimate',
    }));
    expect(intimate.decision).toBe('deny');
    expect(intimate.layer).toBe('trust');
  });

  it('public cannot access anything except public', () => {
    for (const sens of ['personal', 'intimate', 'confidential'] as const) {
      const result = evaluateMemoryPolicy(ctx({
        trustLevel: 'public',
        channelPrivacy: 'public',
        memorySensitivity: sens,
      }));
      expect(result.decision).toBe('deny');
    }
  });

  // ── Layer 4: Visibility gate ──

  it('broadcast channel blocks non-public even for primary trust', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'public',
      broadcast: true,
      memorySensitivity: 'personal',
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('visibility');
    expect(result.reasonTag).toBe('visibility.broadcast_restricted');
    expect(result.reason).toBe(
      "broadcast (channelPrivacy 'public') channels restrict 'personal' memory access",
    );
  });

  it('public channel blocks non-public even for trusted trust', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'trusted',
      channelPrivacy: 'public',
      memorySensitivity: 'personal',
    }));
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('visibility');
    expect(result.reasonTag).toBe('visibility.channel_restricted');
    expect(result.reason).toBe("channelPrivacy 'public' channels restrict 'personal' memory access");
  });

  it('invite-only channel blocks intimate/confidential', () => {
    const intimate = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'invite_only',
      memorySensitivity: 'intimate',
    }));
    expect(intimate.decision).toBe('deny');
    expect(intimate.layer).toBe('visibility');
    expect(intimate.reasonTag).toBe('visibility.channel_restricted');
    expect(intimate.reason).toBe("channelPrivacy 'invite_only' channels restrict 'intimate' memory access");

    const confidential = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'invite_only',
      memorySensitivity: 'confidential',
    }));
    expect(confidential.decision).toBe('deny');
    expect(confidential.layer).toBe('visibility');
    expect(confidential.reasonTag).toBe('visibility.channel_restricted');
  });

  it('invite-only allows personal for primary trust', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'invite_only',
      memorySensitivity: 'personal',
    }));
    expect(result.decision).toBe('allow');
  });

  // ── Layer 5: Default allow ──

  it('allows public memory in any context', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'public',
      channelPrivacy: 'public',
      broadcast: true,
      memorySensitivity: 'public',
    }));
    expect(result.decision).toBe('allow');
    expect(result.layer).toBe('default');
  });

  it('allows primary + private + confidential (full honne)', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'private',
      memorySensitivity: 'confidential',
    }));
    expect(result.decision).toBe('allow');
    expect(result.layer).toBe('default');
  });

  // ── Precedence verification ──

  it('consent denial beats operator approval being absent', () => {
    const result = evaluateMemoryPolicy(ctx({
      trustLevel: 'primary',
      channelPrivacy: 'private',
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
      channelPrivacy: 'private',
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
      channelPrivacy: 'private',
      memorySensitivity: 'personal',
      consentFlags: { deleteOnRequest: true },
    }));
    expect(result.decision).toBe('allow');
  });
});

describe('classifyChannelDisclosure', () => {
  it('prioritizes exact visibility overrides over prefix overrides', () => {
    setVisibilityOverrides({
      exact: { 'guild:ops-room': { privacy: 'public', broadcast: true } },
      prefix: { 'guild:': { privacy: 'private', broadcast: false } },
    });

    expect(classifyChannelDisclosure('guild:ops-room')).toEqual({ channelPrivacy: 'public', broadcast: true });
  });

  it('applies prefix visibility overrides when exact override is absent', () => {
    setVisibilityOverrides({
      prefix: { 'guild:ops-': { privacy: 'private', broadcast: false } },
    });

    expect(classifyChannelDisclosure('guild:ops-briefing')).toEqual({ channelPrivacy: 'private', broadcast: false });
  });

  it('uses overrides before DM metadata and legacy prefix heuristics', () => {
    setVisibilityOverrides({
      exact: { '1234567890': { privacy: 'public', broadcast: true } },
      prefix: { 'api:': { privacy: 'public', broadcast: false } },
    });

    expect(classifyChannelDisclosure('1234567890', { isDirectMessage: true }))
      .toEqual({ channelPrivacy: 'public', broadcast: true });
    expect(classifyChannelDisclosure('api:session123'))
      .toEqual({ channelPrivacy: 'public', broadcast: false });
  });

  it('falls back to existing classification heuristics when no override matches', () => {
    setVisibilityOverrides({
      exact: { 'guild:ops-room': { privacy: 'private', broadcast: false } },
      prefix: { 'guild:ops-': { privacy: 'private', broadcast: false } },
    });

    expect(classifyChannelDisclosure('api:session123')).toEqual({ channelPrivacy: 'private', broadcast: false });
    expect(classifyChannelDisclosure('twitter:timeline')).toEqual({ channelPrivacy: 'public', broadcast: true });
    expect(classifyChannelDisclosure('1234567890')).toEqual({ channelPrivacy: 'invite_only', broadcast: false });
  });

  it('uses explicit privacy metadata for non-broadcast heuristic channels', () => {
    expect(classifyChannelDisclosure('api:session123', { privacyLevel: 'public' }))
      .toEqual({ channelPrivacy: 'public', broadcast: false });
    expect(classifyChannelDisclosure('1234567890', { privacyLevel: 'private' }))
      .toEqual({ channelPrivacy: 'private', broadcast: false });
  });

  it('does not let explicit privacy metadata weaken hard broadcast channels', () => {
    expect(classifyChannelDisclosure('twitter:timeline', { privacyLevel: 'private' }))
      .toEqual({ channelPrivacy: 'public', broadcast: true });
  });

  it('classifies API channels as private', () => {
    expect(classifyChannelDisclosure('api:session123')).toEqual({ channelPrivacy: 'private', broadcast: false });
  });

  it('classifies SillyTavern channels as private', () => {
    expect(classifyChannelDisclosure('sillytavern:default')).toEqual({ channelPrivacy: 'private', broadcast: false });
  });

  it('classifies OpenWebUI channels as private', () => {
    expect(classifyChannelDisclosure('openwebui:chat1')).toEqual({ channelPrivacy: 'private', broadcast: false });
  });

  it('classifies shard channels as private', () => {
    expect(classifyChannelDisclosure('shard:abc-123')).toEqual({ channelPrivacy: 'private', broadcast: false });
  });

  it('classifies subagent channels as private', () => {
    expect(classifyChannelDisclosure('subagent:abc-123')).toEqual({ channelPrivacy: 'private', broadcast: false });
  });

  it('classifies internal channels as private', () => {
    expect(classifyChannelDisclosure('internal:scheduler')).toEqual({ channelPrivacy: 'private', broadcast: false });
  });

  it('classifies twitter channels as public broadcast surfaces', () => {
    expect(classifyChannelDisclosure('twitter:timeline')).toEqual({ channelPrivacy: 'public', broadcast: true });
  });

  it('classifies social channels as public broadcast surfaces', () => {
    expect(classifyChannelDisclosure('social:mastodon')).toEqual({ channelPrivacy: 'public', broadcast: true });
  });

  it('classifies unknown channels as invite_only (guild default)', () => {
    expect(classifyChannelDisclosure('1234567890')).toEqual({ channelPrivacy: 'invite_only', broadcast: false });
    expect(classifyChannelDisclosure('guild:general')).toEqual({ channelPrivacy: 'invite_only', broadcast: false });
  });

  it('classifies Discord DMs as private when isDirectMessage metadata is set', () => {
    // Numeric Discord channel ID with DM metadata → private
    expect(classifyChannelDisclosure('1234567890', { isDirectMessage: true }))
      .toEqual({ channelPrivacy: 'private', broadcast: false });
  });

  it('classifies Discord guild channels as invite_only when isDirectMessage is false', () => {
    // Numeric Discord channel ID with guild metadata → invite_only
    expect(classifyChannelDisclosure('1234567890', { isDirectMessage: false }))
      .toEqual({ channelPrivacy: 'invite_only', broadcast: false });
  });

  it('classifies Discord guild channels as invite_only when no metadata', () => {
    // No metadata at all — backward compatible default
    expect(classifyChannelDisclosure('1234567890')).toEqual({ channelPrivacy: 'invite_only', broadcast: false });
    expect(classifyChannelDisclosure('1234567890', undefined)).toEqual({ channelPrivacy: 'invite_only', broadcast: false });
    expect(classifyChannelDisclosure('1234567890', {})).toEqual({ channelPrivacy: 'invite_only', broadcast: false });
  });
});

describe('prompt-facing trust/style state', () => {
  it('emits one-hot trust state variables for prompt templates', () => {
    // {{runtime_trust_level}} was removed as an exact duplicate of the
    // session-stable {{trust_level}} macro (E2.5).
    expect(buildTrustPromptState('trusted')).toEqual({
      runtime_trust_is_primary: 'false',
      runtime_trust_is_trusted: 'true',
      runtime_trust_is_regular: 'false',
      runtime_trust_is_public: 'false',
    });
  });

  it('emits one-hot response-style state variables for prompt templates', () => {
    expect(buildResponseStylePromptState('expressive')).toEqual({
      runtime_response_style: 'expressive',
      runtime_response_style_name: 'Expressive',
      runtime_response_style_is_concise: 'false',
      runtime_response_style_is_expressive: 'true',
    });
  });
});

describe('resolveChannelResponseStyle', () => {
  it('resolves Discord DMs as expressive', () => {
    expect(resolveChannelResponseStyle('1234567890', {
      channelType: 'discord_text',
      meta: { isDirectMessage: true },
    })).toBe('expressive');
  });

  it('resolves Discord guild and voice channels as concise', () => {
    expect(resolveChannelResponseStyle('1234567890', {
      channelType: 'discord_text',
      meta: { isDirectMessage: false },
    })).toBe('concise');
    expect(resolveChannelResponseStyle('discord-voice:guild:user', {
      channelType: 'discord_voice',
    })).toBe('concise');
  });

  it('resolves API and WebUI channels as expressive', () => {
    expect(resolveChannelResponseStyle('api:session123', {
      channelType: 'api',
    })).toBe('expressive');
    expect(resolveChannelResponseStyle('openwebui:chat-1', {
      channelType: 'webui',
    })).toBe('expressive');
  });

  it('uses explicit privacy metadata to keep API response style aligned with disclosure class', () => {
    expect(resolveChannelResponseStyle('api:session123', {
      channelType: 'api',
      meta: { privacyLevel: 'public' },
    })).toBe('concise');
    // Adapters can no longer declare 'broadcast' via ChannelMeta (E3.3); a
    // broadcast classification comes from broadcastPrefixes and derives
    // concise (broadcast ⇒ public ⇒ concise).
    expect(resolveChannelResponseStyle('twitter:campaign', {})).toBe('concise');
    expect(resolveChannelResponseStyle('twitter:campaign', {
      meta: { privacyLevel: 'public' },
    })).toBe('concise');
  });

  it('lets a channel-owned deliveryStyle label win over channel-type heuristics and privacy defaults', () => {
    setRuntimeChannelEnvelopeLabels({
      'telegram:5635268079': { deliveryStyle: 'expressive' },
      'api:styled-session': { privacy: 'private', deliveryStyle: 'concise' },
    });

    // Label beats the telegram channel-type heuristic (concise).
    expect(resolveChannelResponseStyle('telegram:5635268079', {
      channelType: 'telegram',
    })).toBe('expressive');

    // Label beats the private-privacy derived default (expressive).
    expect(resolveChannelResponseStyle('api:styled-session', {
      channelType: 'api',
    })).toBe('concise');

    // Operator overrides still win over the channel label.
    expect(resolveChannelResponseStyle('telegram:5635268079', {
      channelType: 'telegram',
      overrides: { exact: { 'telegram:5635268079': 'concise' } },
    })).toBe('concise');
  });

  it('resolves Telegram and internal channels as concise', () => {
    expect(resolveChannelResponseStyle('telegram:5635268079', {
      channelType: 'telegram',
    })).toBe('concise');
    expect(resolveChannelResponseStyle('telegram:5635268079', {
      channelType: 'telegram_dm',
      meta: { isDirectMessage: true },
    })).toBe('concise');
    expect(resolveChannelResponseStyle('internal:heartbeat', {
      channelType: 'internal',
    })).toBe('concise');
  });

  it('resolves API voice channels as concise', () => {
    expect(resolveChannelResponseStyle('api-voice:conn-1', {
      channelType: 'api',
      meta: { isDirectMessage: true },
    })).toBe('concise');
    expect(resolveChannelResponseStyle('api:voice-session', {
      channelType: 'api_voice',
      meta: { isDirectMessage: true },
    })).toBe('concise');
  });

  it('supports exact, prefix, channelType, and default overrides', () => {
    expect(resolveChannelResponseStyle('channel:exact-1', {
      channelType: 'discord_text',
      overrides: {
        exact: { 'channel:exact-1': 'expressive' },
      },
    })).toBe('expressive');

    expect(resolveChannelResponseStyle('ops:build-17', {
      channelType: 'discord_text',
      overrides: {
        prefix: { 'ops:': 'expressive' },
      },
    })).toBe('expressive');

    expect(resolveChannelResponseStyle('any-channel', {
      channelType: 'telegram',
      overrides: {
        channelType: { telegram: 'expressive' },
      },
    })).toBe('expressive');

    expect(resolveChannelResponseStyle('unknown-channel', {
      channelType: 'terminal',
      overrides: {
        defaultStyle: 'expressive',
      },
    })).toBe('expressive');
  });
});

describe('channelsShareContinuity', () => {
  it('private channels share continuity', () => {
    expect(channelsShareContinuity('api:session1', 'sillytavern:chat')).toBe(true);
  });

  it('lower-ceiling invite_only channels can flow into private channels', () => {
    expect(channelsShareContinuity('1234567890', 'api:session1')).toBe(true);
  });

  it('higher-ceiling private channels do not flow into invite_only channels', () => {
    expect(channelsShareContinuity('api:session1', '1234567890')).toBe(false);
  });

  it('public-ceiling broadcast channels can flow into private channels', () => {
    expect(channelsShareContinuity('twitter:timeline', 'api:session1')).toBe(true);
  });
});

describe('getVisibilityDisclosureCeiling', () => {
  it('returns the highest sensitivity allowed for the disclosure pair', () => {
    expect(getVisibilityDisclosureCeiling({ channelPrivacy: 'private', broadcast: false })).toBe('confidential');
    expect(getVisibilityDisclosureCeiling({ channelPrivacy: 'invite_only', broadcast: false })).toBe('personal');
    expect(getVisibilityDisclosureCeiling({ channelPrivacy: 'public', broadcast: false })).toBe('public');
    // Broadcast surfaces share the public row exactly.
    expect(getVisibilityDisclosureCeiling({ channelPrivacy: 'public', broadcast: true })).toBe('public');
  });
});

describe('getAllowedSensitivities', () => {
  it('primary + private = all levels', () => {
    const allowed = getAllowedSensitivities('primary', { channelPrivacy: 'private', broadcast: false });
    expect(allowed).toEqual(['public', 'personal', 'intimate', 'confidential']);
  });

  it('primary + invite_only = public + personal only', () => {
    const allowed = getAllowedSensitivities('primary', { channelPrivacy: 'invite_only', broadcast: false });
    expect(allowed).toEqual(['public', 'personal']);
  });

  it('primary + broadcast pair = public only (identical to the public row)', () => {
    const allowed = getAllowedSensitivities('primary', { channelPrivacy: 'public', broadcast: true });
    expect(allowed).toEqual(['public']);
    expect(allowed).toEqual(getAllowedSensitivities('primary', { channelPrivacy: 'public', broadcast: false }));
  });

  it('trusted + private = public + personal', () => {
    const allowed = getAllowedSensitivities('trusted', { channelPrivacy: 'private', broadcast: false });
    expect(allowed).toEqual(['public', 'personal']);
  });

  it('regular + private = public + personal', () => {
    const allowed = getAllowedSensitivities('regular', { channelPrivacy: 'private', broadcast: false });
    expect(allowed).toEqual(['public', 'personal']);
  });

  it('public + public = public only', () => {
    const allowed = getAllowedSensitivities('public', { channelPrivacy: 'public', broadcast: false });
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
    expect(TRUST_CEILING.regular).toHaveLength(2);
    expect(TRUST_CEILING.public).toHaveLength(1);
  });
});
