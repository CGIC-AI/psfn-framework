// E3.2 — channel-envelope migration planner tests (synthetic observations).

import { describe, expect, it } from 'vitest';
import {
  planChannelEnvelopeMigration,
  type ChannelEnvelopeObservation,
} from './channel-envelope-migration.js';
import { getDefaultTrustPolicy } from './runtime-policy.js';
import type { TrustPolicyConfig } from '../config/trust-policy-config.js';

function observation(partial: Partial<ChannelEnvelopeObservation> & { channelId: string }): ChannelEnvelopeObservation {
  return {
    storedVisibilities: [],
    sources: ['test'],
    ...partial,
  };
}

const trustPolicy = getDefaultTrustPolicy();

describe('planChannelEnvelopeMigration', () => {
  it('seeds broadcast-prefixed channels with the executed broadcast split (public + broadcast flag)', () => {
    const plan = planChannelEnvelopeMigration({
      observations: [observation({ channelId: 'twitter:main' })],
      trustPolicy,
      existingLabels: {},
    });
    expect(plan.entries).toEqual([
      expect.objectContaining({
        channelId: 'twitter:main',
        action: 'seed',
        label: { privacy: 'public', broadcast: true },
        evidence: ['broadcast_prefix'],
      }),
    ]);
  });

  it('seeds private-prefixed channels as private', () => {
    const plan = planChannelEnvelopeMigration({
      observations: [observation({ channelId: 'internal:heartbeat' })],
      trustPolicy,
      existingLabels: {},
    });
    expect(plan.entries[0]).toMatchObject({
      action: 'seed',
      label: { privacy: 'private' },
      evidence: ['private_prefix'],
    });
  });

  it('seeds unanimous stored-visibility evidence', () => {
    const plan = planChannelEnvelopeMigration({
      observations: [
        observation({ channelId: 'room:friends', storedVisibilities: ['invite_only', 'invite_only'] }),
      ],
      trustPolicy,
      existingLabels: {},
    });
    expect(plan.entries[0]).toMatchObject({
      action: 'seed',
      label: { privacy: 'invite_only' },
      evidence: ['stored_visibility'],
    });
  });

  it('maps stored broadcast stamps through the envelope migration pair', () => {
    const plan = planChannelEnvelopeMigration({
      observations: [
        observation({ channelId: 'megaphone-1', storedVisibilities: ['broadcast'] }),
      ],
      trustPolicy,
      existingLabels: {},
    });
    expect(plan.entries[0]).toMatchObject({
      action: 'seed',
      label: { privacy: 'public', broadcast: true },
    });
  });

  it('seeds direct-message evidence as private', () => {
    const plan = planChannelEnvelopeMigration({
      observations: [observation({ channelId: '882299100011', isDirectMessage: true })],
      trustPolicy,
      existingLabels: {},
    });
    expect(plan.entries[0]).toMatchObject({
      action: 'seed',
      label: { privacy: 'private' },
      evidence: ['direct_message'],
    });
  });

  it('reports conflicting evidence as ambiguous with fail-closed invite_only + needsReview (no guessing)', () => {
    const plan = planChannelEnvelopeMigration({
      observations: [
        observation({ channelId: 'room:contested', storedVisibilities: ['private', 'public'] }),
      ],
      trustPolicy,
      existingLabels: {},
    });
    expect(plan.entries[0]).toMatchObject({
      action: 'seed_ambiguous',
      label: { privacy: 'invite_only', needsReview: true },
    });
    expect(plan.entries[0]?.reason).toContain('conflicting');
  });

  it('reports evidence-free channels as ambiguous with fail-closed invite_only + needsReview', () => {
    const plan = planChannelEnvelopeMigration({
      observations: [observation({ channelId: 'room:mystery' })],
      trustPolicy,
      existingLabels: {},
    });
    expect(plan.entries[0]).toMatchObject({
      action: 'seed_ambiguous',
      label: { privacy: 'invite_only', needsReview: true },
    });
    expect(plan.counts.seed_ambiguous).toBe(1);
  });

  it('skips channels that already carry an owned label', () => {
    const plan = planChannelEnvelopeMigration({
      observations: [observation({ channelId: 'room:labeled', storedVisibilities: ['public'] })],
      trustPolicy,
      existingLabels: { 'room:labeled': { privacy: 'invite_only' } },
    });
    expect(plan.entries[0]).toMatchObject({ action: 'skip_existing_label' });
    expect(plan.counts.seed).toBe(0);
  });

  it('still seeds a channel whose existing label only sets contactTracking', () => {
    const plan = planChannelEnvelopeMigration({
      observations: [observation({ channelId: 'room:tracked', storedVisibilities: ['public'] })],
      trustPolicy,
      existingLabels: { 'room:tracked': { contactTracking: 'approval' } },
    });
    expect(plan.entries[0]).toMatchObject({ action: 'seed', label: { privacy: 'public' } });
  });

  it('skips channels owned by operator overrides instead of duplicating them into channels.json', () => {
    const withOverrides: TrustPolicyConfig = {
      ...trustPolicy,
      channelClassification: {
        ...trustPolicy.channelClassification,
        visibilityOverrides: {
          exact: { 'room:exact': 'public' },
          prefix: { 'ops:': 'private' },
        },
      },
    };
    const plan = planChannelEnvelopeMigration({
      observations: [
        observation({ channelId: 'room:exact' }),
        observation({ channelId: 'ops:war-room' }),
      ],
      trustPolicy: withOverrides,
      existingLabels: {},
    });
    expect(plan.entries.map(entry => entry.action)).toEqual([
      'skip_operator_override',
      'skip_operator_override',
    ]);
  });

  it('merges duplicate observations across sources and sorts entries by channel id', () => {
    const plan = planChannelEnvelopeMigration({
      observations: [
        observation({ channelId: 'room:b', storedVisibilities: ['invite_only'], sources: ['session_journal'] }),
        observation({ channelId: 'room:a', storedVisibilities: [], sources: ['session_journal'] }),
        observation({ channelId: 'room:b', storedVisibilities: ['invite_only'], sources: ['contact_channel_activity'] }),
      ],
      trustPolicy,
      existingLabels: {},
    });
    expect(plan.entries.map(entry => entry.channelId)).toEqual(['room:a', 'room:b']);
    const merged = plan.entries[1];
    expect(merged.sources).toEqual(['session_journal', 'contact_channel_activity']);
    expect(merged.action).toBe('seed');
  });
});
