// E3.2 — envelope-keyed channel classification tests.
// Covers the contract precedence (channel-owned label > operator override >
// derived default), the executed broadcast split, the demotion of prefix
// heuristics to derived-default inputs, and continuity/mirroring equivalence
// for equivalently-labeled channels. Contract: docs/context-envelope.md.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyChannel,
  classifyChannelEnvelope,
  channelsShareContinuity,
  getAllowedSensitivities,
  getVisibilityDisclosureCeiling,
  resolveChannelEnvelopeClassification,
  visibilitiesShareContinuity,
} from './policy.js';
import {
  getDefaultTrustPolicy,
  resetRuntimeTrustPolicy,
  setRuntimeTrustPolicy,
} from './runtime-policy.js';
import {
  resetRuntimeChannelEnvelopeLabels,
  setRuntimeChannelEnvelopeLabels,
} from './runtime-channel-labels.js';
import type { TrustPolicyConfig } from '../config/trust-policy-config.js';

function policyWithOverrides(overrides: Partial<TrustPolicyConfig['channelClassification']['visibilityOverrides']>): TrustPolicyConfig {
  const base = getDefaultTrustPolicy();
  return {
    ...base,
    channelClassification: {
      ...base.channelClassification,
      visibilityOverrides: {
        exact: {},
        prefix: {},
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  resetRuntimeTrustPolicy();
  resetRuntimeChannelEnvelopeLabels();
});

afterEach(() => {
  resetRuntimeTrustPolicy();
  resetRuntimeChannelEnvelopeLabels();
});

describe('classifyChannelEnvelope precedence', () => {
  it('resolves the channel-owned label above operator overrides and derived defaults', () => {
    setRuntimeTrustPolicy(policyWithOverrides({
      exact: { 'discord:friends-room': 'public' },
    }));
    setRuntimeChannelEnvelopeLabels({
      'discord:friends-room': { privacy: 'invite_only' },
    });

    const envelope = classifyChannelEnvelope('discord:friends-room');
    expect(envelope).toMatchObject({
      privacy: 'invite_only',
      broadcast: false,
      source: 'channel_label',
    });
    expect(classifyChannel('discord:friends-room')).toBe('invite_only');
  });

  it('lets a channel-owned label beat the broadcast prefix heuristic (demoted to derived tier)', () => {
    setRuntimeChannelEnvelopeLabels({
      'twitter:main': { privacy: 'private' },
    });
    expect(classifyChannel('twitter:main')).toBe('private');
    expect(classifyChannelEnvelope('twitter:main').source).toBe('channel_label');
  });

  it('lets a channel-owned label beat adapter-declared ChannelMeta privacy', () => {
    setRuntimeChannelEnvelopeLabels({
      'api:session-9': { privacy: 'public' },
    });
    expect(classifyChannel('api:session-9', { privacyLevel: 'private' })).toBe('public');
  });

  it('executes the broadcast split for channel labels: public + broadcast flag projects to broadcast', () => {
    setRuntimeChannelEnvelopeLabels({
      'social:announcements': { privacy: 'public', broadcast: true },
    });
    const envelope = classifyChannelEnvelope('social:announcements');
    expect(envelope).toMatchObject({
      privacy: 'public',
      broadcast: true,
      source: 'channel_label',
    });
    expect(classifyChannel('social:announcements')).toBe('broadcast');
  });

  it('treats a bare broadcast=true label as a public broadcast surface (contract rule)', () => {
    setRuntimeChannelEnvelopeLabels({
      'mastodon:feed': { broadcast: true },
    });
    expect(classifyChannelEnvelope('mastodon:feed')).toMatchObject({
      privacy: 'public',
      broadcast: true,
      source: 'channel_label',
    });
  });

  it('pins broadcast=false from the channel label over the demoted broadcast prefix', () => {
    setRuntimeChannelEnvelopeLabels({
      'twitter:dm-mirror': { broadcast: false },
    });
    const envelope = classifyChannelEnvelope('twitter:dm-mirror');
    expect(envelope.broadcast).toBe(false);
    expect(envelope.privacy).toBe('public');
    expect(classifyChannel('twitter:dm-mirror')).toBe('public');
  });

  it('maps operator broadcast overrides through the envelope migration pair', () => {
    setRuntimeTrustPolicy(policyWithOverrides({
      exact: { 'room:megaphone': 'broadcast' },
    }));
    const envelope = classifyChannelEnvelope('room:megaphone');
    expect(envelope).toMatchObject({
      privacy: 'public',
      broadcast: true,
      source: 'operator_override',
    });
    expect(classifyChannel('room:megaphone')).toBe('broadcast');
  });

  it('keeps longest-prefix operator override resolution', () => {
    setRuntimeTrustPolicy(policyWithOverrides({
      prefix: {
        'room:': 'public',
        'room:staff': 'private',
      },
    }));
    expect(classifyChannel('room:staff-only')).toBe('private');
    expect(classifyChannel('room:lobby')).toBe('public');
  });

  it('surfaces contactTracking and needsReview from the channel label without gating on them', () => {
    setRuntimeChannelEnvelopeLabels({
      'room:new-place': { privacy: 'invite_only', contactTracking: 'approval', needsReview: true },
    });
    const envelope = classifyChannelEnvelope('room:new-place');
    expect(envelope.contactTracking).toBe('approval');
    expect(envelope.needsReview).toBe(true);
    expect(classifyChannel('room:new-place')).toBe('invite_only');
  });

  it('defaults contactTracking to auto when unlabeled', () => {
    expect(classifyChannelEnvelope('room:unlabeled').contactTracking).toBe('auto');
  });
});

describe('derived-default tier (byte-parity with the pre-envelope hierarchy)', () => {
  it('classifies direct messages private', () => {
    expect(classifyChannel('dm:alice', { isDirectMessage: true })).toBe('private');
    expect(classifyChannelEnvelope('dm:alice', { isDirectMessage: true }).source).toBe('derived_default');
  });

  it('keeps demoted prefix heuristics as derived inputs for unlabeled channels', () => {
    expect(classifyChannel('api:session-1')).toBe('private');
    expect(classifyChannel('internal:heartbeat')).toBe('private');
    expect(classifyChannel('subagent:worker-1')).toBe('private');
    expect(classifyChannel('twitter:main')).toBe('broadcast');
    expect(classifyChannelEnvelope('twitter:main')).toMatchObject({
      privacy: 'public',
      broadcast: true,
      source: 'derived_default',
    });
  });

  it('falls back to invite_only for unlabeled non-DM channels', () => {
    const envelope = classifyChannelEnvelope('room:townsquare');
    expect(envelope).toMatchObject({
      privacy: 'invite_only',
      broadcast: false,
      source: 'derived_default',
    });
  });

  it('still honors adapter-declared ChannelMeta privacy inside the derived tier', () => {
    expect(classifyChannel('room:somewhere', { privacyLevel: 'public' })).toBe('public');
    expect(classifyChannelEnvelope('room:somewhere', { privacyLevel: 'broadcast' })).toMatchObject({
      privacy: 'public',
      broadcast: true,
    });
  });
});

// Per-contact privacy exclusion from classification is asserted end-to-end in
// src/core/agent/substrate-agent/runtime-context.test.ts: a contact store
// labeling a conversation channel 'private' neither surfaces
// channelPrivacyLevel on the resolved author context nor changes
// classifyChannel's output for that channel.

describe('continuity and mirroring equivalence for equivalently-labeled channels', () => {
  it('classifies a labeled invite_only channel identically to a derived invite_only channel across the continuity gates', () => {
    setRuntimeChannelEnvelopeLabels({
      'labeled:room': { privacy: 'invite_only' },
    });
    const labeled = classifyChannel('labeled:room');
    const derived = classifyChannel('room:derived-default');
    expect(labeled).toBe('invite_only');
    expect(derived).toBe('invite_only');

    // visibilitiesShareContinuity consumes exactly the classification output.
    for (const target of ['private', 'invite_only', 'public', 'broadcast'] as const) {
      expect(visibilitiesShareContinuity(labeled, target)).toBe(visibilitiesShareContinuity(derived, target));
      expect(visibilitiesShareContinuity(target, labeled)).toBe(visibilitiesShareContinuity(target, derived));
    }

    // channelsShareContinuity (mirroring gate) sees identical behavior.
    expect(channelsShareContinuity('labeled:room', 'room:derived-default')).toBe(true);
    expect(channelsShareContinuity('room:derived-default', 'labeled:room')).toBe(true);
    expect(channelsShareContinuity('labeled:room', 'dm:someone')).toBe(
      channelsShareContinuity('room:derived-default', 'dm:someone'),
    );

    // Disclosure surfaces match too.
    expect(getVisibilityDisclosureCeiling(labeled)).toBe(getVisibilityDisclosureCeiling(derived));
    expect(getAllowedSensitivities('trusted', labeled)).toEqual(getAllowedSensitivities('trusted', derived));
  });

  it('keeps invite_only continuity direction exactly as the old semi_private semantics', () => {
    // From the contract's continuity table (docs/context-envelope.md).
    expect(visibilitiesShareContinuity('private', 'invite_only')).toBe(false);
    expect(visibilitiesShareContinuity('invite_only', 'private')).toBe(true);
    expect(visibilitiesShareContinuity('invite_only', 'invite_only')).toBe(true);
    expect(visibilitiesShareContinuity('invite_only', 'public')).toBe(false);
    expect(visibilitiesShareContinuity('public', 'invite_only')).toBe(true);
    expect(visibilitiesShareContinuity('broadcast', 'invite_only')).toBe(true);
  });

  it('treats a labeled public+broadcast channel identically to a prefix-derived broadcast channel', () => {
    setRuntimeChannelEnvelopeLabels({
      'labeled:megaphone': { privacy: 'public', broadcast: true },
    });
    const labeled = classifyChannel('labeled:megaphone');
    const derived = classifyChannel('twitter:main');
    expect(labeled).toBe('broadcast');
    expect(derived).toBe('broadcast');
    expect(getVisibilityDisclosureCeiling(labeled)).toBe(getVisibilityDisclosureCeiling(derived));
    expect(channelsShareContinuity('labeled:megaphone', 'twitter:main')).toBe(true);
  });
});

describe('resolveChannelEnvelopeClassification (pure form)', () => {
  it('classifies against explicit owner-file inputs without runtime globals', () => {
    const trustPolicy = getDefaultTrustPolicy();
    const labeled = resolveChannelEnvelopeClassification('room:x', undefined, {
      label: { privacy: 'public' },
      trustPolicy,
    });
    expect(labeled).toMatchObject({ privacy: 'public', broadcast: false, source: 'channel_label' });

    const unlabeled = resolveChannelEnvelopeClassification('room:x', undefined, { trustPolicy });
    expect(unlabeled).toMatchObject({ privacy: 'invite_only', source: 'derived_default' });
  });
});
