// E3.2/E3.3 — envelope-keyed channel classification tests.
// Covers the contract precedence (channel-owned label > operator override >
// derived default), the executed broadcast split, the demotion of prefix
// heuristics to derived-default inputs, and continuity/mirroring equivalence
// for equivalently-labeled channels. E3.3 deleted the transitional single-axis
// ChannelVisibility projection: the {channelPrivacy, broadcast} pair IS the
// classification. Contract: docs/context-envelope.md.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyChannelDisclosure,
  classifyChannelEnvelope,
  channelsShareContinuity,
  getAllowedSensitivities,
  getVisibilityDisclosureCeiling,
  resolveChannelEnvelopeClassification,
  visibilitiesShareContinuity,
  type ChannelDisclosureContext,
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

const PRIVATE_PAIR: ChannelDisclosureContext = { channelPrivacy: 'private', broadcast: false };
const INVITE_ONLY_PAIR: ChannelDisclosureContext = { channelPrivacy: 'invite_only', broadcast: false };
const PUBLIC_PAIR: ChannelDisclosureContext = { channelPrivacy: 'public', broadcast: false };
const BROADCAST_PAIR: ChannelDisclosureContext = { channelPrivacy: 'public', broadcast: true };

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
      exact: { 'discord:friends-room': { privacy: 'public', broadcast: false } },
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
    expect(classifyChannelDisclosure('discord:friends-room')).toEqual(INVITE_ONLY_PAIR);
  });

  it('lets a channel-owned label beat the broadcast prefix heuristic (demoted to derived tier)', () => {
    setRuntimeChannelEnvelopeLabels({
      'twitter:main': { privacy: 'private' },
    });
    expect(classifyChannelDisclosure('twitter:main')).toEqual(PRIVATE_PAIR);
    expect(classifyChannelEnvelope('twitter:main').source).toBe('channel_label');
  });

  it('lets a channel-owned label beat adapter-declared ChannelMeta privacy', () => {
    setRuntimeChannelEnvelopeLabels({
      'api:session-9': { privacy: 'public' },
    });
    expect(classifyChannelDisclosure('api:session-9', { privacyLevel: 'private' })).toEqual(PUBLIC_PAIR);
  });

  it('executes the broadcast split for channel labels: public + broadcast flag is the classification', () => {
    setRuntimeChannelEnvelopeLabels({
      'social:announcements': { privacy: 'public', broadcast: true },
    });
    const envelope = classifyChannelEnvelope('social:announcements');
    expect(envelope).toMatchObject({
      privacy: 'public',
      broadcast: true,
      source: 'channel_label',
    });
    expect(classifyChannelDisclosure('social:announcements')).toEqual(BROADCAST_PAIR);
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
    expect(classifyChannelDisclosure('twitter:dm-mirror')).toEqual(PUBLIC_PAIR);
  });

  it('resolves operator broadcast overrides as the envelope pair', () => {
    setRuntimeTrustPolicy(policyWithOverrides({
      exact: { 'room:megaphone': { privacy: 'public', broadcast: true } },
    }));
    const envelope = classifyChannelEnvelope('room:megaphone');
    expect(envelope).toMatchObject({
      privacy: 'public',
      broadcast: true,
      source: 'operator_override',
    });
    expect(classifyChannelDisclosure('room:megaphone')).toEqual(BROADCAST_PAIR);
  });

  it('keeps longest-prefix operator override resolution', () => {
    setRuntimeTrustPolicy(policyWithOverrides({
      prefix: {
        'room:': { privacy: 'public', broadcast: false },
        'room:staff': { privacy: 'private', broadcast: false },
      },
    }));
    expect(classifyChannelDisclosure('room:staff-only')).toEqual(PRIVATE_PAIR);
    expect(classifyChannelDisclosure('room:lobby')).toEqual(PUBLIC_PAIR);
  });

  it('surfaces contactTracking and needsReview from the channel label without gating on them', () => {
    setRuntimeChannelEnvelopeLabels({
      'room:new-place': { privacy: 'invite_only', contactTracking: 'approval', needsReview: true },
    });
    const envelope = classifyChannelEnvelope('room:new-place');
    expect(envelope.contactTracking).toBe('approval');
    expect(envelope.needsReview).toBe(true);
    expect(classifyChannelDisclosure('room:new-place')).toEqual(INVITE_ONLY_PAIR);
  });

  it('defaults contactTracking to auto when unlabeled', () => {
    expect(classifyChannelEnvelope('room:unlabeled').contactTracking).toBe('auto');
  });
});

describe('deliveryStyle resolution at classification (E3.3)', () => {
  it('uses the channel-owned deliveryStyle label when present', () => {
    setRuntimeChannelEnvelopeLabels({
      'room:styled': { privacy: 'public', deliveryStyle: 'expressive' },
    });
    const envelope = classifyChannelEnvelope('room:styled');
    expect(envelope.deliveryStyle).toBe('expressive');
    expect(envelope.deliveryStyleSource).toBe('channel_label');
  });

  it('derives the default style once from the final pair (private → expressive, else concise)', () => {
    expect(classifyChannelEnvelope('dm:alice', { isDirectMessage: true })).toMatchObject({
      deliveryStyle: 'expressive',
      deliveryStyleSource: 'derived_default',
    });
    expect(classifyChannelEnvelope('room:townsquare')).toMatchObject({
      deliveryStyle: 'concise',
      deliveryStyleSource: 'derived_default',
    });
    // Broadcast ⇒ public ⇒ concise.
    expect(classifyChannelEnvelope('twitter:main')).toMatchObject({
      deliveryStyle: 'concise',
      deliveryStyleSource: 'derived_default',
    });
  });
});

describe('derived-default tier (byte-parity with the pre-envelope hierarchy)', () => {
  it('classifies direct messages private', () => {
    expect(classifyChannelDisclosure('dm:alice', { isDirectMessage: true })).toEqual(PRIVATE_PAIR);
    expect(classifyChannelEnvelope('dm:alice', { isDirectMessage: true }).source).toBe('derived_default');
  });

  it('keeps demoted prefix heuristics as derived inputs for unlabeled channels', () => {
    expect(classifyChannelDisclosure('api:session-1')).toEqual(PRIVATE_PAIR);
    expect(classifyChannelDisclosure('internal:heartbeat')).toEqual(PRIVATE_PAIR);
    expect(classifyChannelDisclosure('subagent:worker-1')).toEqual(PRIVATE_PAIR);
    expect(classifyChannelDisclosure('twitter:main')).toEqual(BROADCAST_PAIR);
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
    expect(classifyChannelDisclosure('room:somewhere', { privacyLevel: 'public' })).toEqual(PUBLIC_PAIR);
    expect(classifyChannelDisclosure('room:somewhere', { privacyLevel: 'private' })).toEqual(PRIVATE_PAIR);
    // E3.3: adapters declare ChannelPrivacy only — ChannelMeta can never set
    // the broadcast flag; a broadcast classification comes from labels,
    // operator overrides, or the demoted broadcastPrefixes heuristic.
    expect(classifyChannelEnvelope('room:somewhere', { privacyLevel: 'public' }).broadcast).toBe(false);
    expect(classifyChannelDisclosure('social:somewhere')).toEqual(BROADCAST_PAIR);
  });
});

// Per-contact privacy exclusion from classification is asserted end-to-end in
// src/core/agent/substrate-agent/runtime-context.test.ts: a contact store
// labeling a conversation channel 'private' neither surfaces
// channelPrivacyLevel on the resolved author context nor changes
// classifyChannelEnvelope's output for that channel.

describe('continuity and mirroring equivalence for equivalently-labeled channels', () => {
  it('classifies a labeled invite_only channel identically to a derived invite_only channel across the continuity gates', () => {
    setRuntimeChannelEnvelopeLabels({
      'labeled:room': { privacy: 'invite_only' },
    });
    const labeled = classifyChannelDisclosure('labeled:room');
    const derived = classifyChannelDisclosure('room:derived-default');
    expect(labeled).toEqual(INVITE_ONLY_PAIR);
    expect(derived).toEqual(INVITE_ONLY_PAIR);

    // visibilitiesShareContinuity consumes exactly the classification pair.
    for (const target of [PRIVATE_PAIR, INVITE_ONLY_PAIR, PUBLIC_PAIR, BROADCAST_PAIR]) {
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
    expect(visibilitiesShareContinuity(PRIVATE_PAIR, INVITE_ONLY_PAIR)).toBe(false);
    expect(visibilitiesShareContinuity(INVITE_ONLY_PAIR, PRIVATE_PAIR)).toBe(true);
    expect(visibilitiesShareContinuity(INVITE_ONLY_PAIR, INVITE_ONLY_PAIR)).toBe(true);
    expect(visibilitiesShareContinuity(INVITE_ONLY_PAIR, PUBLIC_PAIR)).toBe(false);
    expect(visibilitiesShareContinuity(PUBLIC_PAIR, INVITE_ONLY_PAIR)).toBe(true);
    expect(visibilitiesShareContinuity(BROADCAST_PAIR, INVITE_ONLY_PAIR)).toBe(true);
  });

  it('gates a broadcast pair exactly like the public row across the continuity surfaces', () => {
    for (const other of [PRIVATE_PAIR, INVITE_ONLY_PAIR, PUBLIC_PAIR, BROADCAST_PAIR]) {
      expect(visibilitiesShareContinuity(BROADCAST_PAIR, other)).toBe(visibilitiesShareContinuity(PUBLIC_PAIR, other));
      expect(visibilitiesShareContinuity(other, BROADCAST_PAIR)).toBe(visibilitiesShareContinuity(other, PUBLIC_PAIR));
    }
    expect(getVisibilityDisclosureCeiling(BROADCAST_PAIR)).toBe(getVisibilityDisclosureCeiling(PUBLIC_PAIR));
  });

  it('treats a labeled public+broadcast channel identically to a prefix-derived broadcast channel', () => {
    setRuntimeChannelEnvelopeLabels({
      'labeled:megaphone': { privacy: 'public', broadcast: true },
    });
    const labeled = classifyChannelDisclosure('labeled:megaphone');
    const derived = classifyChannelDisclosure('twitter:main');
    expect(labeled).toEqual(BROADCAST_PAIR);
    expect(derived).toEqual(BROADCAST_PAIR);
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
